import { db, loadKv, saveKv } from "./db.js";
import type { BudgetBucket, Member, PolicySet, WorkflowRequest } from "./types.js";

/** Store backed by SQLite (db.ts). Object shapes mirror the onchain Move
 *  objects so the indexer (chain events -> DB) is mechanical. */

export const members: Member[] = [
  { address: "0xa11ce", name: "Alice (PM)", role: "requester" },
  { address: "0xb0b", name: "Bob (Finance Lead)", role: "finance-admin" },
  { address: "0xca41", name: "Carol (Approver)", role: "approver" },
  { address: "0xd3f0", name: "Dave (Ops Executor)", role: "executor" },
];

export const policy: PolicySet = {
  autoApproveMax: 250,
  dualApprovalMin: 2000,
  perRequestCap: 10000,
  allowedCategories: ["software", "contractor", "events", "reimbursements"],
  vendorAllowlist: [],
  vendorDenylist: ["0xbadbad"],
};

export const buckets: BudgetBucket[] = [
  { id: "bkt-software", name: "Software & SaaS", category: "software", limit: 5000, spent: 1240 },
  { id: "bkt-contractor", name: "Contractors", category: "contractor", limit: 20000, spent: 8500 },
  { id: "bkt-events", name: "Events", category: "events", limit: 3000, spent: 2900 },
  { id: "bkt-reimb", name: "Reimbursements", category: "reimbursements", limit: 4000, spent: 610 },
];

export const vendors = [
  { address: "0xf16a", name: "Figma" },
  { address: "0x0710", name: "Notion" },
  { address: "0x51ac", name: "Slack" },
  { address: "0x617b", name: "GitHub" },
  { address: "0xc0de", name: "DevShop LLC" },
  { address: "0xbadbad", name: "ShadyVendor Inc" },
];

/** Mirror of the onchain AgentCap object: the agent's own delegated,
 *  revocable spending authority. The agent may autonomously execute only
 *  within these bounds; everything else needs humans. */
export const agentCap = {
  agentId: "opsflow-agent-v1",
  maxPerRequest: 250,
  dailyLimit: 1000,
  spentToday: 0,
  dayStarted: new Date().toISOString().slice(0, 10),
  revoked: false,
};

export function agentCapAllows(amount: number): { allowed: boolean; reason: string } {
  const today = new Date().toISOString().slice(0, 10);
  if (agentCap.dayStarted !== today) {
    agentCap.dayStarted = today;
    agentCap.spentToday = 0;
  }
  if (agentCap.revoked) return { allowed: false, reason: "AgentCap has been revoked by an admin." };
  if (amount > agentCap.maxPerRequest) return { allowed: false, reason: `$${amount} exceeds the agent's per-request authority of $${agentCap.maxPerRequest}.` };
  if (agentCap.spentToday + amount > agentCap.dailyLimit) {
    return { allowed: false, reason: `Agent's daily autonomous limit ($${agentCap.dailyLimit}) would be exceeded ($${agentCap.spentToday} already spent today).` };
  }
  return { allowed: true, reason: `Within agent authority: ≤$${agentCap.maxPerRequest}/request, $${agentCap.dailyLimit - agentCap.spentToday} left today.` };
}

/** Circuit breaker: the agent's self-policing reflex. If too many
 *  incidents (policy blocks, chain failures, auditor disagreements,
 *  rejections) pile up in a short window, the agent revokes its OWN
 *  AgentCap and waits for a human to re-issue authority. */
export const circuitBreaker = {
  windowMs: 10 * 60 * 1000,
  maxIncidents: 3,
  incidents: [] as { at: number; code: string; requestId: string }[],
  tripped: false,
  trippedAt: null as string | null,
  reason: null as string | null,
};

export function recordIncident(code: string, requestId: string): { justTripped: boolean; reason: string | null } {
  const now = Date.now();
  circuitBreaker.incidents.push({ at: now, code, requestId });
  circuitBreaker.incidents = circuitBreaker.incidents.filter((i) => now - i.at <= circuitBreaker.windowMs);

  if (!circuitBreaker.tripped && !agentCap.revoked && circuitBreaker.incidents.length >= circuitBreaker.maxIncidents) {
    circuitBreaker.tripped = true;
    circuitBreaker.trippedAt = new Date(now).toISOString();
    circuitBreaker.reason =
      `Circuit breaker tripped: ${circuitBreaker.incidents.length} incidents within ${circuitBreaker.windowMs / 60000} minutes ` +
      `(${circuitBreaker.incidents.map((i) => `${i.code}@${i.requestId}`).join(", ")}). ` +
      `The agent revoked its own AgentCap and suspended autonomous execution until an admin re-issues authority.`;
    agentCap.revoked = true;
    return { justTripped: true, reason: circuitBreaker.reason };
  }
  return { justTripped: false, reason: null };
}

/** Optimistic execution: high-risk payments wait in a timed challenge
 *  window during which any approver can veto. Onchain this maps to a
 *  timelock on the execute call. */
export const vetoConfig = {
  windowMs: Number(process.env.VETO_WINDOW_MS ?? 45_000),
  riskThreshold: 60,
};

export function resetCircuitBreaker(): void {
  circuitBreaker.incidents = [];
  circuitBreaker.tripped = false;
  circuitBreaker.trippedAt = null;
  circuitBreaker.reason = null;
}

/** Map-like store backed by SQLite. `requests` are mutated in place by the
 *  orchestrator after the initial `set()` (state transitions, approvals,
 *  receipts, ...); `persistAll()` re-serializes every cached request and is
 *  called once per API request (see index.ts) so those mutations land on
 *  disk without threading a save call through every mutation site. */
class RequestStore {
  private cache = new Map<string, WorkflowRequest>();

  constructor() {
    const rows = db.prepare("SELECT data FROM requests ORDER BY created_at ASC").all() as { data: string }[];
    for (const row of rows) {
      const r = JSON.parse(row.data) as WorkflowRequest;
      this.cache.set(r.id, r);
    }
  }

  get(id: string): WorkflowRequest | undefined {
    return this.cache.get(id);
  }

  set(id: string, req: WorkflowRequest): this {
    this.cache.set(id, req);
    this.persistOne(req);
    return this;
  }

  values(): IterableIterator<WorkflowRequest> {
    return this.cache.values();
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    db.exec("DELETE FROM requests");
  }

  private persistOne(req: WorkflowRequest): void {
    db.prepare(
      `INSERT INTO requests (id, state, created_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`,
    ).run(req.id, req.state, req.createdAt, JSON.stringify(req));
  }

  persistAll(): void {
    for (const req of this.cache.values()) this.persistOne(req);
  }
}

export const requests = new RequestStore();

let counter = 0;
export function nextId(): string {
  counter += 1;
  return `req-${String(counter).padStart(4, "0")}`;
}

const BUCKET_BASELINES = buckets.map((b) => ({ id: b.id, spent: b.spent }));
const MEMBER_BASELINES: Member[] = members.map((m) => ({ ...m }));

/** Register (or update) an org member — e.g. a zkLogin-derived address
 *  granted a role via chain.setMemberRole(). */
export function addMember(member: Member): void {
  const existing = members.find((m) => m.address === member.address);
  if (existing) {
    existing.name = member.name;
    existing.role = member.role;
  } else {
    members.push(member);
  }
}

/** Snapshot the mutable singletons (policy, agentCap, circuitBreaker, bucket
 *  spend, id counter) plus every request to SQLite. Called once per API
 *  request (index.ts) so a server restart resumes from the same state. */
export function persistState(): void {
  saveKv("policy", policy);
  saveKv("agentCap", agentCap);
  saveKv("circuitBreaker", circuitBreaker);
  saveKv("buckets", buckets.map((b) => ({ id: b.id, spent: b.spent })));
  saveKv("members", members);
  saveKv("counter", counter);
  requests.persistAll();
}

/** Restore the mutable singletons from a previous run, if any. Mutates the
 *  exported objects/arrays in place so existing references stay valid. */
function loadState(): void {
  const savedPolicy = loadKv<PolicySet>("policy");
  if (savedPolicy) Object.assign(policy, savedPolicy);

  const savedAgentCap = loadKv<typeof agentCap>("agentCap");
  if (savedAgentCap) Object.assign(agentCap, savedAgentCap);

  const savedBreaker = loadKv<typeof circuitBreaker>("circuitBreaker");
  if (savedBreaker) Object.assign(circuitBreaker, savedBreaker);

  const savedBuckets = loadKv<{ id: string; spent: number }[]>("buckets");
  if (savedBuckets) {
    for (const saved of savedBuckets) {
      const b = buckets.find((x) => x.id === saved.id);
      if (b) b.spent = saved.spent;
    }
  }

  const savedMembers = loadKv<Member[]>("members");
  if (savedMembers) {
    members.length = 0;
    members.push(...savedMembers);
  }

  const savedCounter = loadKv<number>("counter");
  if (savedCounter !== undefined) counter = savedCounter;
}
loadState();

/** Demo reset: wipe requests and restore every mutable system to its seed
 *  state. Lets the live demo be re-run any number of times. */
export function resetAll(): void {
  requests.clear();
  counter = 0;
  for (const base of BUCKET_BASELINES) {
    const b = buckets.find((x) => x.id === base.id);
    if (b) b.spent = base.spent;
  }
  agentCap.maxPerRequest = 250;
  agentCap.dailyLimit = 1000;
  agentCap.spentToday = 0;
  agentCap.revoked = false;
  agentCap.dayStarted = new Date().toISOString().slice(0, 10);
  policy.autoApproveMax = 250;
  policy.dualApprovalMin = 2000;
  policy.perRequestCap = 10000;
  policy.vendorAllowlist = [];
  policy.vendorDenylist = ["0xbadbad"];
  members.length = 0;
  members.push(...MEMBER_BASELINES.map((m) => ({ ...m })));
  resetCircuitBreaker();
  persistState();
}

export function bucketForCategory(category: string): BudgetBucket | undefined {
  return buckets.find((b) => b.category === category);
}

export function vendorByName(name: string | null): { address: string; name: string } | undefined {
  if (!name) return undefined;
  return vendors.find((v) => v.name.toLowerCase() === name.toLowerCase());
}

export function memberByAddress(addr: string): Member | undefined {
  return members.find((m) => m.address === addr);
}
