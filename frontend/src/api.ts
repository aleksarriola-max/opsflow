const BASE = "/api";

async function j<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
}

export const api = {
  meta: () => fetch(`${BASE}/meta`).then((r) => j<Meta>(r)),
  requests: () => fetch(`${BASE}/requests`).then((r) => j<WorkflowRequest[]>(r)),
  request: (id: string) => fetch(`${BASE}/requests/${id}`).then((r) => j<WorkflowRequest>(r)),
  create: (body: object) =>
    fetch(`${BASE}/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<WorkflowRequest>(r)),
  action: (id: string, action: string, body: object = {}) =>
    fetch(`${BASE}/requests/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<WorkflowRequest>(r)),
  seed: () => fetch(`${BASE}/seed`, { method: "POST" }).then((r) => j<object>(r)),
  forecast: () => fetch(`${BASE}/forecast`).then((r) => j<BurnForecast[]>(r)),
  proposePolicy: (instruction: string) =>
    fetch(`${BASE}/policy/propose`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction }) }).then((r) => j<PolicyProposal>(r)),
  applyPolicy: (patch: object, by: string) =>
    fetch(`${BASE}/policy/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ patch, by }) }).then((r) => j<object>(r)),
  setAgentCap: (body: object) =>
    fetch(`${BASE}/agent-cap`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<object>(r)),
  dryrun: (body: { category: string; amount: number; vendorName: string }) =>
    fetch(`${BASE}/policy/dryrun`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<DryRunResult>(r)),
  vendorIntel: () => fetch(`${BASE}/vendors/intel`).then((r) => j<VendorIntel[]>(r)),
  auditExportUrl: (id: string) => `${BASE}/requests/${id}/audit-export`,
  ask: (id: string, question: string) =>
    fetch(`${BASE}/requests/${id}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) }).then((r) => j<{ answer: string; grounding: string[] }>(r)),
  org: {
    addMember: (body: { by: string; address: string; name: string; role: string }) =>
      fetch(`${BASE}/org/members`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => j<{ members: Member[]; txDigest: string }>(r)),
  },
};

export interface DryRunResult {
  evaluation: { allowed: boolean; requiredApprovals: number; riskScore: number; firedRules: { rule: string; outcome: string; detail: string }[] };
  paths: { option: string; detail: string }[];
}

export interface VendorIntel {
  address: string; name: string; executedCount: number; totalSpend: number;
  avgAmount: number; lastPaid: string | null; categories: string[];
}

export interface BurnForecast {
  bucketId: string; name: string; dailyBurn: number;
  daysToExhaustion: number | null; exhaustionDate: string | null;
  status: "healthy" | "warning" | "critical";
}

export interface PolicyProposal {
  patch: object;
  changes: { field: string; from: string; to: string; effect: string }[];
  warnings: string[];
  backtest?: { total: number; changed: { id: string; title: string; amount: number; before: string; after: string }[] };
}

export interface Member { address: string; name: string; role: string }
export interface BudgetBucket { id: string; name: string; category: string; limit: number; spent: number }
export interface Meta {
  members: Member[];
  policy: { autoApproveMax: number; dualApprovalMin: number; perRequestCap: number; allowedCategories: string[]; vendorDenylist: string[] };
  buckets: BudgetBucket[];
  vendors: { address: string; name: string }[];
  agentCap: { agentId: string; maxPerRequest: number; dailyLimit: number; spentToday: number; revoked: boolean };
  circuitBreaker: { windowMs: number; maxIncidents: number; incidents: { at: number; code: string; requestId: string }[]; tripped: boolean; trippedAt: string | null; reason: string | null };
  suiMode: string;
  /** Package + Org object IDs for building approve/reject txs client-side
   *  (zkLogin/Enoki path). `null` in mock mode. */
  chainConfig: { packageId: string; orgId: string } | null;
  /** The org's real onchain object graph (package, org, policy, AgentCap,
   *  budget buckets), with Explorer links — available whenever the org was
   *  deployed to testnet/mainnet, regardless of the current SUI_MODE. */
  chainObjectGraph: ChainObjectGraph | null;
}
export interface ChainObjectGraph {
  network: "testnet" | "mainnet";
  packageId: string;
  orgId: string;
  policyId?: string;
  agentCapId?: string;
  adminCapId?: string;
  buckets: { category: string; id: string }[];
  explorerBaseUrl: string;
}
export interface TimelineEvent { at: string; actor: string; kind: string; message: string; rule?: string }
export interface WorkflowRequest {
  id: string; title: string; category: string; amount: number;
  vendor: string; vendorName: string; description: string;
  urgency: string; requester: string; requesterName: string; department: string;
  state: string; createdAt: string;
  /** Onchain object ID of the WorkflowRequest shared object (testnet/mainnet only). */
  chainObjectId?: string;
  policyEvaluation?: { allowed: boolean; requiredApprovals: number; riskScore: number; firedRules: { rule: string; outcome: string; detail: string }[]; budgetOk: boolean };
  executionPlan?: { bucketId: string; vendor: string; amount: number; summary: string };
  approvals: { approver: string; approverName: string; at: string; note: string; txDigest?: string }[];
  requiredApprovals: number;
  receipt?: { txDigest: string; executor: string; amount: number; vendor: string; at: string; network: string; currency: string; reasoningHash?: string };
  exception?: { code: string; detail: string; at: string };
  timeline: TimelineEvent[];
  agentExplanation?: string;
  missingFields?: string[];
  explorerUrl?: string | null;
  reasoning: { step: string; detail: string; outcome: "info" | "pass" | "warn" | "block" }[];
  vetoDeadline?: string;
  anomalies?: { factor: string; detail: string; weight: number }[];
  approvalPaths?: { option: string; detail: string }[];
  auditorVerdict?: { agree: boolean; checks: { check: string; ok: boolean; detail: string }[] };
}
