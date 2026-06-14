// vitest port of the original e2e.verify.mjs (67 checks). Runs against
// SUI_MODE=mock (the default) — no chain dependencies. Tests within each
// describe block are order-dependent: they share mutable in-memory state
// (requests, buckets, agentCap, circuitBreaker) the same way the original
// script did, so they must run sequentially in declaration order.
import { describe, expect, it } from "vitest";
import * as orch from "../src/orchestrator.js";
import { evaluatePolicy } from "../src/policyEngine.js";
import { canTransition } from "../src/stateMachine.js";
import { heuristicParse } from "../src/intentParser.js";
import {
  addMember, agentCap, agentCapAllows, buckets, circuitBreaker, memberByAddress, policy, requests, resetCircuitBreaker, vendors, vetoConfig,
} from "../src/store.js";
import {
  backtestPolicy, buildAuditExport, detectAnomalies, forecastBurn, vendorIntel, verifyAuditExport,
} from "../src/intelligence.js";
import { heuristicCompile } from "../src/policyAuthoring.js";
import { answerQuestion } from "../src/askAgent.js";
import type { WorkflowRequest } from "../src/types.js";

describe("policy engine", () => {
  const bucket = buckets.find((b) => b.category === "software");
  const base = { category: "software", vendor: "0xf16a", vendorName: "Figma", urgency: "normal" as const };

  it("auto-approves <= $250", () => {
    expect(evaluatePolicy({ ...base, amount: 100 }, policy, bucket).requiredApprovals).toBe(0);
  });
  it("1 approver above threshold", () => {
    expect(evaluatePolicy({ ...base, amount: 300 }, policy, bucket).requiredApprovals).toBe(1);
  });
  it("2 approvers >= $2000", () => {
    expect(evaluatePolicy({ ...base, amount: 2500 }, policy, bucket).requiredApprovals).toBe(2);
  });
  it("denylisted vendor blocked", () => {
    expect(evaluatePolicy({ ...base, amount: 100, vendor: "0xbadbad" }, policy, bucket).allowed).toBe(false);
  });
  it("per-request cap blocked", () => {
    expect(evaluatePolicy({ ...base, amount: 99999 }, policy, bucket).allowed).toBe(false);
  });
});

describe("state machine", () => {
  it("approval transition", () => {
    expect(canTransition("PendingApproval", "Approved")).toBe(true);
  });
  it("no illegal jump to Executed", () => {
    expect(canTransition("Submitted", "Executed")).toBe(false);
  });
  it("retry path exists", () => {
    expect(canTransition("Failed", "ScheduledForExecution")).toBe(true);
  });
});

describe("intent parser (heuristic)", () => {
  it("headline demo sentence parses", () => {
    const p = heuristicParse("Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly.");
    expect(p.category).toBe("software");
    expect(p.amount).toBe(300);
    expect(p.vendorName).toBe("Figma");
  });
  it("missing fields flagged, not guessed", () => {
    expect(heuristicParse("pay someone for that thing").missingFields.length).toBeGreaterThan(0);
  });
});

describe("intelligence layer", () => {
  it("first-time vendor detected", () => {
    const anomalies = detectAnomalies(
      { amount: 5000, vendor: "0xnew", vendorName: "NewCo", category: "software", urgency: "high", requester: "0xa11ce" },
      [],
    );
    expect(anomalies.some((a) => a.factor === "first-time-vendor")).toBe(true);
  });
  it("urgency+amount pressure pattern detected", () => {
    const anomalies = detectAnomalies(
      { amount: 5000, vendor: "0xnew", vendorName: "NewCo", category: "software", urgency: "high", requester: "0xa11ce" },
      [],
    );
    expect(anomalies.some((a) => a.factor === "urgency-pressure")).toBe(true);
  });
  it("AgentCap blocks amounts above per-request authority", () => {
    expect(agentCapAllows(300).allowed).toBe(false);
  });
  it("AgentCap permits small autonomous spend", () => {
    expect(agentCapAllows(100).allowed).toBe(true);
  });
  it("burn forecast covers all buckets", () => {
    expect(forecastBurn(buckets, []).length).toBe(buckets.length);
  });
  it("NL policy: auto-approve threshold compiled from English", () => {
    const patch = heuristicCompile("Auto approve anything up to $300", { ...policy });
    expect(patch.autoApproveMax).toBe(300);
  });
  it("NL policy: per-request cap compiled from English", () => {
    const patch = heuristicCompile("never pay more than $5,000 in a single request, hard limit", { ...policy });
    expect(patch.perRequestCap).toBe(5000);
  });
});

describe("full workflow loop", () => {
  let r: WorkflowRequest;

  it("threshold breach routes to PendingApproval", async () => {
    r = await orch.createRequest({
      requester: "0xa11ce",
      naturalLanguage: "Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly.",
    });
    expect(r.state).toBe("PendingApproval");
    expect(r.requiredApprovals).toBe(1);
    expect(r.reasoning.length).toBeGreaterThanOrEqual(5);
    expect(r.auditorVerdict?.agree).toBe(true);
    expect(r.approvalPaths?.some((p) => p.option === "obtain-approvals")).toBe(true);
  });

  it("requester cannot self-approve", async () => {
    await expect(orch.approve(r.id, "0xa11ce", "")).rejects.toThrow(/cannot approve|Self-approval/);
  });

  it("executor role cannot approve", async () => {
    await expect(orch.approve(r.id, "0xd3f0", "")).rejects.toThrow(/cannot approve/);
  });

  it("approver approval moves to Approved", async () => {
    const r2 = await orch.approve(r.id, "0xca41", "lgtm");
    expect(r2.state).toBe("Approved");
  });

  it("execution completes with a receipt and debits the budget bucket", async () => {
    const before = buckets.find((b) => b.category === "software")!.spent;
    const r3 = await orch.execute(r.id, "0xd3f0");
    expect(r3.state).toBe("Executed");
    expect(r3.receipt && r3.receipt.txDigest.length).toBeGreaterThan(20);
    expect(r3.receipt?.reasoningHash?.length).toBe(64);
    expect(r3.receipt?.currency).toBe("SUI");
    expect(buckets.find((b) => b.category === "software")!.spent).toBe(before + 300);
    expect(r3.timeline.length).toBeGreaterThanOrEqual(8);
  });

  it("small request auto-approves AND executes autonomously under AgentCap", async () => {
    const a = await orch.createRequest({
      requester: "0xa11ce",
      naturalLanguage: "Renew Notion subscription $96 monthly",
    });
    expect(a.state).toBe("Executed");
    expect(a.receipt?.executor).toBe("agent");
  });

  it("denied vendor escalates with exception and offers alternatives", async () => {
    const b = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Pay ShadyVendor", category: "contractor", amount: 1500, vendorName: "ShadyVendor Inc", description: "x" },
    });
    expect(b.state).toBe("Escalated");
    expect(b.exception?.code).toBe("POLICY_BLOCKED");
    expect(b.approvalPaths?.some((p) => p.option === "alternative-vendor")).toBe(true);
  });

  it("request above agent authority needs a human; chain failure + retry recovers", async () => {
    const f = await orch.createRequest({
      requester: "0xa11ce",
      naturalLanguage: "Purchase GitHub team plan upgrade, $400 monthly for engineering",
    });
    expect(f.state).toBe("PendingApproval");
    await orch.approve(f.id, "0xca41", "ok");
    const f2 = await orch.execute(f.id, "0xd3f0", { simulateFailure: true });
    expect(f2.state).toBe("Failed");
    expect(f2.exception?.code).toBe("CHAIN_FAILURE");
    const f3 = await orch.retry(f.id, "0xd3f0");
    expect(f3.state).toBe("Executed");
  });

  it("ambiguous request asks for clarification, then auto-executes once clarified", async () => {
    const c = await orch.createRequest({ requester: "0xa11ce", naturalLanguage: "we need to pay for the thing" });
    expect(c.state).toBe("PendingClarification");
    const c2 = await orch.clarify(c.id, { category: "software", amount: 50, vendorName: "GitHub" });
    expect(c2.state).toBe("Executed");
  });

  it("with AgentCap revoked, an auto-approved request WAITS for a human executor", async () => {
    agentCap.revoked = true;
    const g = await orch.createRequest({ requester: "0xa11ce", naturalLanguage: "Renew Slack $120 monthly" });
    expect(g.state).toBe("Approved");
    agentCap.revoked = false;
  });
});

describe("self-policing: structuring detection", () => {
  it("first sub-threshold request executes autonomously", async () => {
    const s1 = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma plugin pack A", category: "software", amount: 200, vendorName: "Figma", description: "a" },
    });
    expect(s1.state).toBe("Executed");
  });

  it("second identical payment flagged as possible duplicate and escalated before money moves", async () => {
    const s2 = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma plugin pack B", category: "software", amount: 200, vendorName: "Figma", description: "b" },
    });
    expect(s2.anomalies?.some((a) => a.factor === "possible-duplicate")).toBe(true);
    expect(s2.state).toBe("PendingApproval");
  });

  it("third request flagged as threshold structuring and escalated", async () => {
    const s3 = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma plugin pack C", category: "software", amount: 200, vendorName: "Figma", description: "c" },
    });
    expect(s3.anomalies?.some((a) => a.factor === "threshold-structuring")).toBe(true);
    expect(s3.state).toBe("PendingApproval");
  });
});

describe("self-policing: circuit breaker", () => {
  it("third incident in window trips the circuit breaker and the agent self-suspends", async () => {
    // Two incidents already occurred earlier in this run (POLICY_BLOCKED + CHAIN_FAILURE).
    const t = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Another shady payment", category: "contractor", amount: 900, vendorName: "ShadyVendor Inc", description: "x" },
    });
    expect(t.state).toBe("Escalated");
    expect(circuitBreaker.tripped).toBe(true);
    expect(agentCap.revoked).toBe(true);
    expect(t.reasoning.some((s) => s.step.includes("Circuit breaker"))).toBe(true);
  });

  it("while self-suspended, even tiny requests wait for humans", async () => {
    const h = await orch.createRequest({ requester: "0xa11ce", naturalLanguage: "Renew Notion $40 monthly" });
    expect(h.state).toBe("Approved");
  });

  it("admin re-issuing authority clears the breaker", () => {
    agentCap.revoked = false;
    resetCircuitBreaker();
    expect(circuitBreaker.tripped).toBe(false);
    expect(circuitBreaker.incidents.length).toBe(0);
  });
});

describe("backtest, simulator inputs, vendor intel, duplicates", () => {
  it("backtest finds outcome changes against history", () => {
    const all = [...requests.values()];
    const bt = backtestPolicy({ autoApproveMax: 500 }, policy, all, buckets);
    expect(bt.changed.length).toBeGreaterThanOrEqual(1);
  });

  it("vendor intel aggregates payment memory", () => {
    const all = [...requests.values()];
    const vi = vendorIntel(vendors, all);
    const figma = vi.find((v) => v.name === "Figma")!;
    expect(figma.executedCount).toBeGreaterThanOrEqual(2);
    expect(figma.totalSpend).toBeGreaterThanOrEqual(500);
  });

  it("duplicate payment detected from vendor memory", async () => {
    const d = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma seats again", category: "software", amount: 310, vendorName: "Figma", description: "dup" },
    });
    expect(d.anomalies?.some((a) => a.factor === "possible-duplicate")).toBe(true);
  });

  it("audit export hash chain verifies and detects tampering", () => {
    const all = [...requests.values()];
    const executedReq = all.find((r) => r.state === "Executed")!;
    const exp = buildAuditExport(executedReq);
    expect(exp.head.length).toBe(64);
    expect(verifyAuditExport(exp)).toBe(true);
    exp.chain[0].event.message = "tampered";
    expect(verifyAuditExport(exp)).toBe(false);
  });
});

describe("optimistic execution: veto window", () => {
  vetoConfig.windowMs = 400;

  it("dual-approval request pends, then enters a veto window on execution", async () => {
    const v = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Big contractor invoice", category: "contractor", amount: 2500, vendorName: "DevShop LLC", description: "milestone" },
    });
    expect(v.state).toBe("PendingApproval");
    expect(v.requiredApprovals).toBe(2);
    await orch.approve(v.id, "0xca41", "ok1");
    await orch.approve(v.id, "0xb0b", "ok2");
    const v2 = await orch.execute(v.id, "0xd3f0");
    expect(v2.state).toBe("ScheduledForExecution");
    expect(!!v2.vetoDeadline).toBe(true);

    const v3 = await orch.veto(v.id, "0xca41", "supplier dispute");
    expect(v3.state).toBe("Escalated");
    expect(v3.exception?.code).toBe("VETOED");
  }, 20000);

  it("unchallenged veto window elapses and the payment executes", async () => {
    const w = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Big contractor invoice 2", category: "contractor", amount: 2500, vendorName: "DevShop LLC", description: "milestone 2" },
    });
    await orch.approve(w.id, "0xca41", "ok1");
    await orch.approve(w.id, "0xb0b", "ok2");
    await orch.execute(w.id, "0xd3f0");
    await new Promise((res) => setTimeout(res, 2500)); // window (400ms) + mock chain latency (<=1s)
    expect(w.state).toBe("Executed");
    expect(!!w.receipt).toBe(true);
  }, 20000);

  it("cancelling during a veto window defuses the pending timer", async () => {
    const x = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Big contractor invoice 3", category: "contractor", amount: 2500, vendorName: "DevShop LLC", description: "m3" },
    });
    await orch.approve(x.id, "0xca41", "ok1");
    await orch.approve(x.id, "0xb0b", "ok2");
    await orch.execute(x.id, "0xd3f0");
    const x2 = await orch.cancel(x.id, "0xa11ce");
    expect(x2.state).toBe("Cancelled");
    expect(!!x2.vetoDeadline).toBe(false);
    await new Promise((res) => setTimeout(res, 2000));
    expect(x.state).toBe("Cancelled");
    expect(!!x.receipt).toBe(false);
  }, 20000);
});

describe("ask the agent (grounded Q&A)", () => {
  const all = () => [...requests.values()];

  it("explains a block from the fired rules", () => {
    const blocked = all().find((r) => r.exception?.code === "POLICY_BLOCKED")!;
    const aBlocked = answerQuestion(blocked, "Why was this blocked?");
    expect(/denylist|denied|blocked/i.test(aBlocked.answer)).toBe(true);
    expect(aBlocked.grounding.some((g) => g.startsWith("rule:"))).toBe(true);
  });

  it("explains the approval requirement with the real count", () => {
    const pending = all().find((r) => r.state === "PendingApproval")!;
    const aPending = answerQuestion(pending, "Why does this need approval?");
    expect(/approval/i.test(aPending.answer)).toBe(true);
    expect(aPending.answer.includes(`${pending.requiredApprovals} approval`)).toBe(true);
  });

  it("cites the real tx digest and reasoning hash as proof", () => {
    const executed = all().find((r) => r.state === "Executed" && r.receipt?.reasoningHash)!;
    const aProof = answerQuestion(executed, "Show me the proof this executed onchain");
    expect(aProof.answer.includes(executed.receipt!.txDigest)).toBe(true);
    expect(/reasoning hash/i.test(aProof.answer)).toBe(true);
  });

  it("gives an actionable next step", () => {
    const pending = all().find((r) => r.state === "PendingApproval")!;
    const aNext = answerQuestion(pending, "What should I do next?");
    expect(/Approval Inbox|approval/i.test(aNext.answer)).toBe(true);
  });

  it("reports the real risk score", () => {
    const blocked = all().find((r) => r.exception?.code === "POLICY_BLOCKED")!;
    const aRisk = answerQuestion(blocked, "What is the risk here?");
    expect(/risk score is \d+/i.test(aRisk.answer)).toBe(true);
  });
});

describe("zkLogin: externally-signed approve/reject + org membership", () => {
  it("approve with a frontend-supplied txDigest skips the mock chain and records the digest", async () => {
    const p = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma annual plan", category: "software", amount: 300, vendorName: "Figma", description: "zk approve" },
    });
    expect(p.state).toBe("PendingApproval");

    const p2 = await orch.approve(p.id, "0xca41", "approved via zkLogin", "ZKDIGESTAPPROVE");
    expect(p2.approvals[0].txDigest).toBe("ZKDIGESTAPPROVE");
    if (p2.requiredApprovals === 1) expect(p2.state).toBe("Approved");
  });

  it("reject with a frontend-supplied txDigest skips the mock chain and logs the digest", async () => {
    const q = await orch.createRequest({
      requester: "0xa11ce",
      structured: { title: "Figma annual plan 2", category: "software", amount: 300, vendorName: "Figma", description: "zk reject" },
    });
    expect(q.state).toBe("PendingApproval");

    const q2 = await orch.reject(q.id, "0xca41", "duplicate request", "ZKDIGESTREJECT");
    expect(q2.state).toBe("Escalated");
    expect(q2.timeline.some((t) => t.kind === "rejection" && t.message.includes("ZKDIGESTRE"))).toBe(true);
  });

  it("addMember registers a new org member visible to memberByAddress", () => {
    addMember({ address: "0xZK1", name: "Zoe (zkLogin)", role: "approver" });
    const m = memberByAddress("0xZK1");
    expect(m?.role).toBe("approver");
  });

  it("addMember updates the role of an existing member instead of duplicating", () => {
    addMember({ address: "0xZK1", name: "Zoe (zkLogin)", role: "finance-admin" });
    expect(memberByAddress("0xZK1")?.role).toBe("finance-admin");
  });
});
