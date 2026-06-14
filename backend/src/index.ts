import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askAgent } from "./askAgent.js";
import { recentEvents, startIndexer } from "./indexer.js";
import { backtestPolicy, buildAuditExport, forecastBurn, pathToYes, vendorIntel } from "./intelligence.js";
import { evaluatePolicy } from "./policyEngine.js";
import * as orch from "./orchestrator.js";
import { applyPolicy, proposePolicy } from "./policyAuthoring.js";
import { addMember, agentCap, buckets, circuitBreaker, members, persistState, policy, requests, resetAll, resetCircuitBreaker, vendors } from "./store.js";
import { chain, chainConfig, chainObjectGraph, explorerUrl } from "./sui.js";

const app = express();
app.use(cors());
app.use(express.json());

// Persist after every mutating call so a server restart resumes from the
// same state, including in-place mutations the orchestrator makes to
// already-stored WorkflowRequest objects (see store.ts: RequestStore.persistAll).
const wrap = (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res)
      .catch((e: Error) => res.status(400).json({ error: e.message }))
      .finally(() => persistState());

// === Reference data ===
app.get("/api/meta", (_req, res) => {
  res.json({ members, policy, buckets, vendors, agentCap, circuitBreaker, suiMode: chain.mode, chainConfig: chainConfig(), chainObjectGraph: chainObjectGraph() });
});

app.get("/api/forecast", (_req, res) => {
  res.json(forecastBurn(buckets, [...requests.values()]));
});

app.get("/api/vendors/intel", (_req, res) => {
  res.json(vendorIntel(vendors, [...requests.values()]));
});

// === Onchain event indexer (testnet/mainnet; empty in mock mode) ===
app.get("/api/chain-events", (req, res) => {
  res.json(recentEvents(Number(req.query.limit ?? 100)));
});

// === Natural-language policy authoring (with backtest evidence) ===
app.post("/api/policy/propose", wrap(async (req, res) => {
  const proposal = await proposePolicy(req.body.instruction, policy);
  const backtest = backtestPolicy(proposal.patch, policy, [...requests.values()], buckets);
  res.json({ ...proposal, backtest });
}));

// === Dry-run simulator: test a hypothetical request, create nothing ===
app.post("/api/policy/dryrun", wrap(async (req, res) => {
  const { category, amount, vendorName } = req.body;
  const vendor = vendors.find((v) => v.name.toLowerCase() === String(vendorName ?? "").toLowerCase());
  const bucket = buckets.find((b) => b.category === category);
  const evaluation = evaluatePolicy(
    { category, amount: Number(amount), vendor: vendor?.address ?? "0xunknown", vendorName: vendorName ?? "Unknown", urgency: "normal" },
    policy, bucket
  );
  const approverNames = members.filter((m) => m.role === "approver" || m.role === "finance-admin").map((m) => m.name);
  const paths = pathToYes(
    { amount: Number(amount), category, vendor: vendor?.address ?? "0xunknown", vendorName: vendorName ?? "Unknown" },
    evaluation, policy, buckets, approverNames
  );
  res.json({ evaluation, paths });
}));

app.post("/api/policy/apply", wrap(async (req, res) => {
  const by = members.find((m) => m.address === req.body.by);
  if (!by || by.role !== "finance-admin") throw new Error("Only a finance-admin can apply policy changes (AdminCap holder onchain)");
  applyPolicy(req.body.patch, policy);
  res.json({ applied: true, policy });
}));

// === AgentCap: delegated autonomous authority ===
app.post("/api/agent-cap", wrap(async (req, res) => {
  const by = members.find((m) => m.address === req.body.by);
  if (!by || by.role !== "finance-admin") throw new Error("Only a finance-admin can change the agent's authority");
  if (typeof req.body.maxPerRequest === "number") agentCap.maxPerRequest = req.body.maxPerRequest;
  if (typeof req.body.dailyLimit === "number") agentCap.dailyLimit = req.body.dailyLimit;
  if (typeof req.body.revoked === "boolean") {
    agentCap.revoked = req.body.revoked;
    // Re-issuing authority clears the circuit breaker (fresh start).
    if (!req.body.revoked) resetCircuitBreaker();
  }
  res.json({ agentCap, circuitBreaker });
}));

// === Org membership: register a new approver/executor (e.g. a zkLogin
// address) so it shows up in the persona picker and passes onchain
// can_approve/can_execute checks. ===
const ROLE_IDS: Record<string, number> = { requester: 0, approver: 1, "finance-admin": 2, executor: 3 };
app.post("/api/org/members", wrap(async (req, res) => {
  const by = members.find((m) => m.address === req.body.by);
  if (!by || by.role !== "finance-admin") throw new Error("Only a finance-admin can register org members");
  const { address, name, role } = req.body;
  const roleId = ROLE_IDS[role];
  if (address === undefined || !name || roleId === undefined) throw new Error("address, name and a valid role are required");
  const tx = await chain.setMemberRole({ address, role: roleId });
  if (!tx.ok) throw new Error(`Onchain set_member_role failed: ${tx.error}`);
  addMember({ address, name, role });
  res.json({ members, txDigest: tx.digest });
}));

// === Requests ===
app.get("/api/requests", (_req, res) => {
  res.json([...requests.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get("/api/requests/:id", (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) { res.status(404).json({ error: "not found" }); return; }
  res.json({ ...r, explorerUrl: r.receipt ? explorerUrl(r.receipt.txDigest) : null });
});

app.post("/api/requests", wrap(async (req, res) => {
  const r = await orch.createRequest(req.body);
  res.json(r);
}));

app.post("/api/requests/:id/clarify", wrap(async (req, res) => {
  res.json(await orch.clarify(req.params.id, req.body));
}));

app.post("/api/requests/:id/approve", wrap(async (req, res) => {
  res.json(await orch.approve(req.params.id, req.body.approver, req.body.note ?? "", req.body.txDigest));
}));

app.post("/api/requests/:id/reject", wrap(async (req, res) => {
  res.json(await orch.reject(req.params.id, req.body.approver, req.body.reason ?? "", req.body.txDigest));
}));

app.post("/api/requests/:id/execute", wrap(async (req, res) => {
  res.json(await orch.execute(req.params.id, req.body.executor, { simulateFailure: !!req.body.simulateFailure }));
}));

app.post("/api/requests/:id/ask", wrap(async (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) throw new Error("not found");
  res.json(await askAgent(r, String(req.body.question ?? "")));
}));

app.post("/api/requests/:id/veto", wrap(async (req, res) => {
  res.json(await orch.veto(req.params.id, req.body.by, req.body.reason ?? "Challenged during veto window"));
}));

app.get("/api/requests/:id/audit-export", (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) { res.status(404).json({ error: "not found" }); return; }
  res.setHeader("content-disposition", `attachment; filename="${r.id}-audit.json"`);
  res.json(buildAuditExport(r));
});

app.post("/api/requests/:id/retry", wrap(async (req, res) => {
  res.json(await orch.retry(req.params.id, req.body.executor));
}));

app.post("/api/requests/:id/escalate", wrap(async (req, res) => {
  res.json(await orch.escalate(req.params.id));
}));

app.post("/api/requests/:id/cancel", wrap(async (req, res) => {
  res.json(await orch.cancel(req.params.id, req.body.by));
}));

app.post("/api/requests/:id/close", wrap(async (req, res) => {
  res.json(await orch.close(req.params.id));
}));

// === Demo reset: wipe requests, restore budgets/policy/agent to seed state ===
app.post("/api/reset", wrap(async (_req, res) => {
  resetAll();
  res.json({ reset: true });
}));

// === Demo seed ===
app.post("/api/seed", wrap(async (_req, res) => {
  if (requests.size > 0) { res.json({ seeded: false, reason: "already has data" }); return; }
  // 1. Small request -> auto-approved, then executed autonomously by the
  // agent itself under its AgentCap delegated authority.
  const a = await orch.createRequest({
    requester: "0xa11ce",
    naturalLanguage: "Renew our Notion subscription, $96 monthly for the product team",
  });
  if (a.state === "Approved") await orch.execute(a.id, "0xd3f0"); // only if agent authority did not cover it
  // 2. The headline demo: threshold breach -> pending approval
  await orch.createRequest({
    requester: "0xa11ce",
    naturalLanguage: "Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly.",
  });
  // 3. Blocked by policy: denied vendor
  await orch.createRequest({
    requester: "0xa11ce",
    structured: {
      title: "Pay ShadyVendor Inc for consulting",
      category: "contractor", amount: 1500,
      vendorName: "ShadyVendor Inc",
      description: "One-off consulting invoice #4411",
    },
  });
  // 4. Budget headroom failure: events bucket nearly empty
  await orch.createRequest({
    requester: "0xa11ce",
    structured: {
      title: "Sponsor local dev meetup",
      category: "events", amount: 800,
      vendorName: "DevShop LLC",
      description: "Community sponsorship, includes booth",
    },
  });
  res.json({ seeded: true, count: requests.size });
}));

// === Production: serve the built frontend from this same process ===
// One URL, one deploy. Build with `cd frontend && npm run build` first
// (or let the Dockerfile do it). Override location with FRONTEND_DIST.
const distDir = process.env.FRONTEND_DIST
  ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) { next(); return; }
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`serving frontend from ${distDir}`);
}

const PORT = Number(process.env.PORT ?? 4000);
app.listen(PORT, () => {
  console.log(`ops-agent backend on http://localhost:${PORT} (sui mode: ${chain.mode})`);
});

startIndexer();
