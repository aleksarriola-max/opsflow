// OpsFlow shared types.
export type WorkflowState =
  | "Draft"
  | "Submitted"
  | "PendingPolicyCheck"
  | "PendingClarification"
  | "PendingApproval"
  | "Approved"
  | "ScheduledForExecution"
  | "Executing"
  | "Executed"
  | "Failed"
  | "Escalated"
  | "Cancelled"
  | "Closed";

export type Role = "requester" | "approver" | "finance-admin" | "executor";

export interface Member {
  address: string;
  name: string;
  role: Role;
}

export interface PolicySet {
  autoApproveMax: number; // <= this auto-approves
  dualApprovalMin: number; // >= this needs 2 approvers
  perRequestCap: number;
  allowedCategories: string[];
  vendorAllowlist: string[]; // empty = any
  vendorDenylist: string[];
}

export interface BudgetBucket {
  id: string;
  name: string;
  category: string;
  limit: number;
  spent: number;
}

export interface ApprovalRecord {
  approver: string;
  approverName: string;
  at: string;
  note: string;
  /** Set when the approver signed the approve/reject tx themselves
   *  (e.g. via a zkLogin/Enoki wallet) rather than the backend's signer. */
  txDigest?: string;
}

export interface ExecutionReceipt {
  txDigest: string;
  executor: string;
  amount: number;
  vendor: string;
  at: string;
  network: "mock" | "testnet" | "mainnet";
  /** Ticker of the asset paid out, e.g. "SUI" or "USDC" (SUI_PAYMENT_COIN_TYPE). */
  currency: string;
  /** sha256 over parsed intent + fired rules + plan + approvals:
   *  cryptographically anchors WHY the money moved. */
  reasoningHash?: string;
}

export interface ExceptionRecord {
  code: string;
  detail: string;
  at: string;
}

export interface TimelineEvent {
  at: string;
  actor: string; // "agent" | "policy-engine" | member name
  kind:
    | "submitted" | "parsed" | "policy" | "clarification" | "approval"
    | "rejection" | "execution" | "receipt" | "exception" | "state"
    | "escalation" | "retry";
  message: string;
  rule?: string; // which policy rule fired
}

export interface PolicyEvaluation {
  allowed: boolean;
  requiredApprovals: 0 | 1 | 2;
  riskScore: number; // 0-100
  firedRules: { rule: string; outcome: "pass" | "warn" | "block"; detail: string }[];
  budgetOk: boolean;
}

export interface ExecutionPlan {
  bucketId: string;
  vendor: string;
  amount: number;
  summary: string; // human readable, LLM-generated
}

export interface ReasoningStep {
  step: string;
  detail: string;
  outcome: "info" | "pass" | "warn" | "block";
}

export interface WorkflowRequest {
  id: string;
  /** Onchain object ID of the WorkflowRequest shared object (testnet/mainnet only). */
  chainObjectId?: string;
  title: string;
  category: string;
  amount: number;
  vendor: string;
  vendorName: string;
  description: string;
  urgency: "low" | "normal" | "high";
  requester: string;
  requesterName: string;
  department: string;
  state: WorkflowState;
  createdAt: string;
  policyEvaluation?: PolicyEvaluation;
  executionPlan?: ExecutionPlan;
  approvals: ApprovalRecord[];
  requiredApprovals: number;
  receipt?: ExecutionReceipt;
  exception?: ExceptionRecord;
  timeline: TimelineEvent[];
  agentExplanation?: string;
  missingFields?: string[];
  /** Live agent decision trace, rendered as an animated stream in the UI. */
  reasoning: ReasoningStep[];
  /** If set and in the future, the request sits in a veto window before executing. */
  vetoDeadline?: string;
  anomalies?: { factor: string; detail: string; weight: number }[];
  approvalPaths?: { option: string; detail: string }[];
  auditorVerdict?: { agree: boolean; checks: { check: string; ok: boolean; detail: string }[] };
}

export interface ParsedIntent {
  title: string;
  category: string | null;
  amount: number | null;
  vendorName: string | null;
  urgency: "low" | "normal" | "high";
  description: string;
  missingFields: string[];
  confidence: number;
}
