import { evaluatePolicy } from "./policyEngine.js";
import {
  auditorReview, detectAnomalies, escalateForAnomalies, pathToYes, reasoningHash,
} from "./intelligence.js";
import { assertTransition } from "./stateMachine.js";
import { explainPlan, parseIntent } from "./intentParser.js";
import { buildReceipt, chain } from "./sui.js";
import {
  agentCap, agentCapAllows, bucketForCategory, buckets, memberByAddress, members, nextId, policy, recordIncident, requests, vendorByName, vetoConfig,
} from "./store.js";
import type { ReasoningStep, TimelineEvent, WorkflowRequest } from "./types.js";

function now(): string { return new Date().toISOString(); }

function log(req: WorkflowRequest, e: Omit<TimelineEvent, "at">): void {
  req.timeline.push({ at: now(), ...e });
}

function think(req: WorkflowRequest, s: ReasoningStep): void {
  req.reasoning.push(s);
}

/** Report an incident to the circuit breaker. If this incident trips it,
 *  the agent self-suspends: its own AgentCap is revoked and the
 *  self-suspension is recorded in the request's audit trail. */
function reportIncident(req: WorkflowRequest, code: string): void {
  const trip = recordIncident(code, req.id);
  if (trip.justTripped && trip.reason) {
    log(req, { actor: "agent", kind: "exception", message: trip.reason });
    think(req, {
      step: "Circuit breaker: self-suspension",
      detail: trip.reason,
      outcome: "block",
    });
  }
}

function setState(req: WorkflowRequest, to: WorkflowRequest["state"], actor = "agent"): void {
  assertTransition(req.state, to); // deterministic guard — throws on illegal moves
  log(req, { actor, kind: "state", message: `${req.state} → ${to}` });
  req.state = to;
}

export interface CreateInput {
  requester: string;
  naturalLanguage?: string;
  structured?: {
    title: string; category: string; amount: number;
    vendorName: string; description: string; urgency?: "low" | "normal" | "high";
  };
}

/** Intake -> parse -> policy check -> route. The full loop minus human approval. */
export async function createRequest(input: CreateInput): Promise<WorkflowRequest> {
  const requester = memberByAddress(input.requester);
  if (!requester) throw new Error("Unknown requester address");

  const id = nextId();
  const req: WorkflowRequest = {
    id,
    title: "", category: "", amount: 0,
    vendor: "", vendorName: "", description: "",
    urgency: "normal",
    requester: requester.address,
    requesterName: requester.name,
    department: "Product",
    state: "Draft",
    createdAt: now(),
    approvals: [],
    requiredApprovals: 0,
    timeline: [],
    reasoning: [],
  };

  if (input.naturalLanguage) {
    think(req, { step: "Reading request", detail: `Interpreting: "${input.naturalLanguage.slice(0, 90)}${input.naturalLanguage.length > 90 ? "…" : ""}"`, outcome: "info" });
    const parsed = await parseIntent(input.naturalLanguage);
    think(req, {
      step: "Extracting structure",
      detail: `category=${parsed.category ?? "?"} · amount=${parsed.amount !== null ? `$${parsed.amount}` : "?"} · vendor=${parsed.vendorName ?? "?"} · urgency=${parsed.urgency} (confidence ${(parsed.confidence * 100).toFixed(0)}%)`,
      outcome: parsed.missingFields.length ? "warn" : "pass",
    });
    log(req, {
      actor: "agent", kind: "parsed",
      message: `Parsed intent: category=${parsed.category ?? "?"}, amount=${parsed.amount ?? "?"}, vendor=${parsed.vendorName ?? "?"}, urgency=${parsed.urgency} (confidence ${(parsed.confidence * 100).toFixed(0)}%)`,
    });
    req.title = parsed.title;
    req.category = parsed.category ?? "";
    req.amount = parsed.amount ?? 0;
    req.vendorName = parsed.vendorName ?? "";
    req.description = parsed.description;
    req.urgency = parsed.urgency;
    req.missingFields = parsed.missingFields;
  } else if (input.structured) {
    const s = input.structured;
    Object.assign(req, {
      title: s.title, category: s.category, amount: s.amount,
      vendorName: s.vendorName, description: s.description, urgency: s.urgency ?? "normal",
    });
    req.missingFields = [];
  } else {
    throw new Error("Provide naturalLanguage or structured input");
  }

  const vendor = vendorByName(req.vendorName);
  if (vendor) req.vendor = vendor.address;
  else if (req.vendorName) req.missingFields = [...(req.missingFields ?? []), "vendor (unknown — not in vendor directory)"];

  requests.set(id, req);
  log(req, { actor: requester.name, kind: "submitted", message: `Request submitted: "${req.title}"` });
  setState(req, "Submitted", requester.name);

  // Missing info -> clarification loop instead of guessing.
  if (req.missingFields && req.missingFields.length > 0) {
    think(req, {
      step: "Clarification needed",
      detail: `Cannot proceed without: ${req.missingFields.join(", ")}. Financial fields are never guessed.`,
      outcome: "warn",
    });
    setState(req, "PendingPolicyCheck");
    setState(req, "PendingClarification");
    log(req, {
      actor: "agent", kind: "clarification",
      message: `Need clarification on: ${req.missingFields.join(", ")}. The agent does not guess on financial fields.`,
    });
    return req;
  }

  await runPolicyCheck(req);
  return req;
}

export async function clarify(
  id: string,
  fields: { category?: string; amount?: number; vendorName?: string }
): Promise<WorkflowRequest> {
  const req = mustGet(id);
  if (req.state !== "PendingClarification") throw new Error("Request is not awaiting clarification");
  if (fields.category) req.category = fields.category;
  if (fields.amount) req.amount = fields.amount;
  if (fields.vendorName) {
    req.vendorName = fields.vendorName;
    const v = vendorByName(fields.vendorName);
    if (v) req.vendor = v.address;
  }
  req.missingFields = [];
  log(req, { actor: req.requesterName, kind: "clarification", message: `Clarification provided: ${JSON.stringify(fields)}` });
  setState(req, "Submitted", req.requesterName);
  await runPolicyCheck(req);
  return req;
}

async function runPolicyCheck(req: WorkflowRequest): Promise<void> {
  setState(req, "PendingPolicyCheck", "policy-engine");
  const bucket = bucketForCategory(req.category);
  const evaluation = evaluatePolicy(req, policy, bucket);
  req.policyEvaluation = evaluation;

  for (const r of evaluation.firedRules) {
    log(req, { actor: "policy-engine", kind: "policy", message: r.detail, rule: `${r.rule} [${r.outcome}]` });
    think(req, { step: `Policy: ${r.rule}`, detail: r.detail, outcome: r.outcome as "pass" | "warn" | "block" });
  }

  // Anomaly detection over org history — can only ESCALATE, never relax.
  const history = [...requests.values()].filter((h) => h.id !== req.id);
  const anomalies = detectAnomalies(req, history, policy);
  req.anomalies = anomalies;
  const anomalyScore = anomalies.reduce((s, a) => s + a.weight, 0);
  for (const a of anomalies) {
    think(req, { step: `Anomaly: ${a.factor}`, detail: a.detail, outcome: "warn" });
    log(req, { actor: "policy-engine", kind: "policy", message: a.detail, rule: `anomaly:${a.factor} [+${a.weight} risk]` });
  }
  evaluation.riskScore = Math.min(100, evaluation.riskScore + anomalyScore);

  if (evaluation.allowed) {
    const esc = escalateForAnomalies(evaluation.requiredApprovals, anomalyScore);
    if (esc.escalated) {
      evaluation.requiredApprovals = esc.required;
      think(req, {
        step: "Approval tier escalated",
        detail: `Anomaly score ${anomalyScore} raised the requirement to ${esc.required} approval(s). Anomalies never lower scrutiny.`,
        outcome: "warn",
      });
      log(req, { actor: "policy-engine", kind: "policy", message: `Anomalies escalated approval requirement to ${esc.required}.`, rule: "anomaly-escalation [warn]" });
    }
  }

  // Maker-checker: independent auditor pass must agree before humans act.
  const verdict = auditorReview(req, evaluation, policy, bucket);
  req.auditorVerdict = verdict;
  think(req, {
    step: "Auditor second-pass",
    detail: verdict.agree
      ? `Independent auditor re-derived the decision and agrees (${verdict.checks.length} checks).`
      : `Auditor DISAGREES with the proposed plan: ${verdict.checks.filter((c) => !c.ok).map((c) => c.detail).join(" ")}`,
    outcome: verdict.agree ? "pass" : "block",
  });
  if (!verdict.agree) {
    req.exception = { code: "AUDITOR_DISAGREEMENT", detail: verdict.checks.filter((c) => !c.ok).map((c) => c.detail).join(" "), at: now() };
    setState(req, "Escalated", "auditor-agent");
    log(req, { actor: "auditor-agent", kind: "escalation", message: "Maker-checker failed: auditor and proposer disagree. Escalated for human review." });
    reportIncident(req, "AUDITOR_DISAGREEMENT");
    return;
  }

  // Counterfactuals: how could this request reach yes?
  const approverNames = members.filter((m) => (m.role === "approver" || m.role === "finance-admin") && m.address !== req.requester).map((m) => m.name);
  req.approvalPaths = pathToYes(req, evaluation, policy, buckets, approverNames);

  // Mirror evaluation onchain (WorkflowRequest object created + policy event).
  // Best-effort: offchain state machine stays authoritative — a chain
  // failure here is logged and reported to the circuit breaker but never
  // blocks the deterministic offchain decision below.
  const submitTx = await chain.submitRequest({
    title: req.title, category: req.category, amount: req.amount, vendor: req.vendor, description: req.description,
  });
  if (submitTx.ok) {
    req.chainObjectId = submitTx.objectId;
    log(req, { actor: "agent", kind: "execution", message: `WorkflowRequest object recorded on Sui (${chain.mode}) — tx ${submitTx.digest.slice(0, 12)}…` });

    const evalTx = await chain.evaluatePolicy({ chainObjectId: req.chainObjectId, category: req.category });
    if (evalTx.ok) {
      log(req, { actor: "agent", kind: "execution", message: `Policy evaluated onchain (${chain.mode}) — tx ${evalTx.digest.slice(0, 12)}…` });
    } else {
      log(req, { actor: "agent", kind: "exception", message: `Onchain policy evaluation failed (${chain.mode}): ${evalTx.error}.` });
      reportIncident(req, "CHAIN_EVAL_FAILED");
    }
  } else {
    log(req, { actor: "agent", kind: "exception", message: `Onchain submit failed (${chain.mode}): ${submitTx.error}. Continuing with offchain state only.` });
    reportIncident(req, "CHAIN_SUBMIT_FAILED");
  }

  if (!evaluation.allowed) {
    req.exception = {
      code: "POLICY_BLOCKED",
      detail: evaluation.firedRules.filter((r) => r.outcome === "block").map((r) => r.detail).join(" "),
      at: now(),
    };
    setState(req, "Escalated", "policy-engine");
    log(req, { actor: "policy-engine", kind: "escalation", message: "Request blocked by policy and escalated for human review." });
    reportIncident(req, "POLICY_BLOCKED");
    think(req, {
      step: "Decision: blocked",
      detail: `Policy blocks this request. ${req.approvalPaths?.length ? `Computed ${req.approvalPaths.length} alternative path(s) to approval.` : ""}`,
      outcome: "block",
    });
    return;
  }

  req.requiredApprovals = evaluation.requiredApprovals;
  if (bucket) {
    req.executionPlan = {
      bucketId: bucket.id,
      vendor: req.vendor,
      amount: req.amount,
      summary: explainPlan({
        title: req.title, amount: req.amount, category: req.category,
        vendorName: req.vendorName, requiredApprovals: evaluation.requiredApprovals, bucketName: bucket.name,
      }),
    };
    req.agentExplanation = req.executionPlan.summary;
  }

  if (evaluation.requiredApprovals === 0) {
    setState(req, "Approved", "policy-engine");
    log(req, { actor: "policy-engine", kind: "approval", message: "Auto-approved under policy (amount ≤ auto-approve threshold).", rule: "approval-threshold [pass]" });

    // Autonomous execution: only within the agent's own onchain authority.
    const cap = agentCapAllows(req.amount);
    think(req, {
      step: "AgentCap check",
      detail: cap.reason,
      outcome: cap.allowed ? "pass" : "warn",
    });
    if (cap.allowed) {
      think(req, { step: "Decision: autonomous execution", detail: "Auto-approved AND within delegated authority — executing without human involvement.", outcome: "pass" });
      log(req, { actor: "agent", kind: "execution", message: `Executing autonomously under AgentCap (${agentCap.agentId}).` });
      agentCap.spentToday += req.amount;
      await executeInternal(req, "agent");
    } else {
      think(req, { step: "Decision: human executor needed", detail: `Auto-approved, but outside agent authority: ${cap.reason}`, outcome: "info" });
    }
  } else {
    setState(req, "PendingApproval", "policy-engine");
    think(req, {
      step: "Decision: route to humans",
      detail: `Requires ${evaluation.requiredApprovals} approval(s). Routed to the approval inbox.`,
      outcome: "info",
    });
  }
}

export async function approve(id: string, approverAddr: string, note: string, txDigest?: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  const approver = memberByAddress(approverAddr);
  if (!approver) throw new Error("Unknown approver");
  if (approver.role !== "approver" && approver.role !== "finance-admin") {
    throw new Error(`${approver.name} has role "${approver.role}" and cannot approve`);
  }
  if (approver.address === req.requester) throw new Error("Self-approval is not allowed");
  if (req.state !== "PendingApproval") throw new Error(`Request is in ${req.state}, not PendingApproval`);
  if (req.approvals.some((a) => a.approver === approverAddr)) throw new Error("Duplicate approval");

  // If the frontend already signed+executed workflow::approve itself (e.g.
  // via a zkLogin/Enoki wallet), don't re-execute onchain — just record it.
  const tx = txDigest ? { digest: txDigest, ok: true } : await chain.approve({ chainObjectId: req.chainObjectId, note });
  req.approvals.push({ approver: approverAddr, approverName: approver.name, at: now(), note, ...(txDigest ? { txDigest } : {}) });
  if (tx.ok) {
    log(req, { actor: approver.name, kind: "approval", message: `Approved (${req.approvals.length}/${req.requiredApprovals})${note ? `: "${note}"` : ""} — tx ${tx.digest.slice(0, 12)}…` });
  } else {
    log(req, { actor: approver.name, kind: "approval", message: `Approved (${req.approvals.length}/${req.requiredApprovals})${note ? `: "${note}"` : ""} (onchain mirror failed: ${tx.error})` });
    reportIncident(req, "CHAIN_APPROVE_FAILED");
  }

  if (req.approvals.length >= req.requiredApprovals) {
    setState(req, "Approved", approver.name);
  }
  return req;
}

export async function reject(id: string, approverAddr: string, reason: string, txDigest?: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  const approver = memberByAddress(approverAddr);
  if (!approver || (approver.role !== "approver" && approver.role !== "finance-admin")) {
    throw new Error("Not an approver");
  }
  if (req.state !== "PendingApproval") throw new Error(`Request is in ${req.state}, not PendingApproval`);
  const tx = txDigest ? { digest: txDigest, ok: true } : await chain.reject({ chainObjectId: req.chainObjectId, reason });
  req.exception = { code: "REJECTED", detail: reason, at: now() };
  log(req, { actor: approver.name, kind: "rejection", message: `Rejected: "${reason}"${tx.ok ? ` — tx ${tx.digest.slice(0, 12)}…` : ""}` });
  setState(req, "Escalated", approver.name);
  reportIncident(req, "REJECTED");
  if (!tx.ok) reportIncident(req, "CHAIN_REJECT_FAILED");
  return req;
}

export async function execute(id: string, executorAddr: string, opts?: { simulateFailure?: boolean }): Promise<WorkflowRequest> {
  const req = mustGet(id);
  const executor = memberByAddress(executorAddr);
  if (!executor || (executor.role !== "executor" && executor.role !== "finance-admin")) {
    throw new Error("Not an executor");
  }
  if (req.state !== "Approved" && req.state !== "Escalated" && req.state !== "Failed") {
    throw new Error(`Request is in ${req.state}; execution requires Approved`);
  }
  return executeInternal(req, executorAddr, opts);
}

/** Pending veto-window timers, keyed by request id. */
const vetoTimers = new Map<string, NodeJS.Timeout>();

/** Shared execution core. executorAddr === "agent" means autonomous
 *  execution under AgentCap (authority already verified by caller).
 *  High-risk payments enter a timed veto window before money moves. */
async function executeInternal(req: WorkflowRequest, executorAddr: string, opts?: { simulateFailure?: boolean }): Promise<WorkflowRequest> {
  const actorName = executorAddr === "agent" ? "agent" : memberByAddress(executorAddr)?.name ?? executorAddr;
  setState(req, "ScheduledForExecution", actorName);

  const highRisk =
    (req.policyEvaluation?.riskScore ?? 0) >= vetoConfig.riskThreshold || req.requiredApprovals >= 2;
  const isRetry = req.timeline.some((t) => t.kind === "retry");
  if (highRisk && !isRetry && executorAddr !== "agent") {
    req.vetoDeadline = new Date(Date.now() + vetoConfig.windowMs).toISOString();
    const secs = Math.round(vetoConfig.windowMs / 1000);
    log(req, {
      actor: "agent", kind: "execution",
      message: `High-risk payment: optimistic execution with a ${secs}s veto window (until ${req.vetoDeadline}). Any approver can veto before funds move.`,
    });
    think(req, {
      step: "Veto window opened",
      detail: `Risk ${req.policyEvaluation?.riskScore ?? "?"} / ${req.requiredApprovals} approvals required — execution delayed ${secs}s so approvers can challenge it.`,
      outcome: "warn",
    });
    vetoTimers.set(req.id, setTimeout(() => {
      vetoTimers.delete(req.id);
      if (req.state === "ScheduledForExecution") {
        log(req, { actor: "agent", kind: "execution", message: "Veto window elapsed with no challenge — proceeding to execution." });
        void finishExecution(req, executorAddr, opts);
      }
    }, vetoConfig.windowMs));
    return req;
  }

  return finishExecution(req, executorAddr, opts);
}

/** An approver challenges a payment during its veto window. */
export async function veto(id: string, byAddr: string, reason: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  const by = memberByAddress(byAddr);
  if (!by || (by.role !== "approver" && by.role !== "finance-admin")) throw new Error("Only approvers can veto");
  if (req.state !== "ScheduledForExecution" || !req.vetoDeadline) throw new Error("Request is not in a veto window");
  if (new Date(req.vetoDeadline).getTime() < Date.now()) throw new Error("Veto window has already closed");

  const timer = vetoTimers.get(id);
  if (timer) { clearTimeout(timer); vetoTimers.delete(id); }
  req.vetoDeadline = undefined;
  req.exception = { code: "VETOED", detail: `Vetoed by ${by.name} during the challenge window: "${reason}"`, at: now() };
  log(req, { actor: by.name, kind: "rejection", message: `VETO during challenge window: "${reason}". Funds never moved.` });
  setState(req, "Escalated", by.name);
  reportIncident(req, "VETOED");
  return req;
}

async function finishExecution(req: WorkflowRequest, executorAddr: string, opts?: { simulateFailure?: boolean }): Promise<WorkflowRequest> {
  const actorName = executorAddr === "agent" ? "agent" : memberByAddress(executorAddr)?.name ?? executorAddr;
  req.vetoDeadline = undefined;

  const bucket = bucketForCategory(req.category);
  if (!bucket || bucket.spent + req.amount > bucket.limit) {
    setState(req, "Executing", actorName);
    req.exception = { code: "BUDGET_RACE", detail: "Budget headroom disappeared before execution.", at: now() };
    setState(req, "Failed", "agent");
    log(req, { actor: "agent", kind: "exception", message: "Execution aborted: budget check failed at execution time." });
    reportIncident(req, "BUDGET_RACE");
    return req;
  }

  setState(req, "Executing", actorName);
  log(req, { actor: "agent", kind: "execution", message: `Building Sui transaction: pay ${req.vendorName} $${req.amount} from "${bucket.name}".` });

  // Computed BEFORE execution so it can travel onchain as intent_hash.
  const intentHash = reasoningHash(req);
  const tx = await chain.execute({
    chainObjectId: req.chainObjectId,
    category: req.category,
    amount: req.amount,
    vendor: req.vendor,
    intentHash,
    executorAddr,
    simulateFailure: opts?.simulateFailure,
  });
  if (!tx.ok) {
    req.exception = { code: "CHAIN_FAILURE", detail: tx.error ?? "Unknown chain error", at: now() };
    setState(req, "Failed", "agent");
    log(req, { actor: "agent", kind: "exception", message: `Onchain execution failed: ${tx.error}. Retry or escalate from the Exceptions view.` });
    reportIncident(req, "CHAIN_FAILURE");
    return req;
  }

  bucket.spent += req.amount;
  req.receipt = buildReceipt(tx.digest, executorAddr, req.amount, req.vendor);
  req.receipt.reasoningHash = intentHash;
  log(req, { actor: "agent", kind: "receipt", message: `Payment executed on Sui (${chain.mode}). Digest: ${tx.digest}` });
  log(req, { actor: "agent", kind: "receipt", message: `Reasoning hash anchored in receipt: ${req.receipt.reasoningHash.slice(0, 16)}… (sha256 of intent + fired rules + plan + approvals)` });
  setState(req, "Executed", "agent");
  return req;
}

export async function retry(id: string, executorAddr: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  if (req.state !== "Failed") throw new Error("Only failed requests can be retried");
  log(req, { actor: "agent", kind: "retry", message: "Retrying execution after failure." });
  return execute(id, executorAddr);
}

export async function escalate(id: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  setState(req, "Escalated");
  log(req, { actor: "agent", kind: "escalation", message: "Escalated to finance-admin for manual review." });
  return req;
}

export async function cancel(id: string, byAddr: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  const by = memberByAddress(byAddr);
  if (!by) throw new Error("Unknown member");
  if (by.address !== req.requester && by.role !== "finance-admin") {
    throw new Error("Only the requester or a finance-admin can cancel");
  }
  // Cancelling during a veto window must defuse the pending execution timer.
  const timer = vetoTimers.get(id);
  if (timer) { clearTimeout(timer); vetoTimers.delete(id); }
  req.vetoDeadline = undefined;
  const tx = await chain.cancel({ chainObjectId: req.chainObjectId });
  if (!tx.ok) {
    log(req, { actor: "agent", kind: "exception", message: `Onchain cancel failed (${chain.mode}): ${tx.error}.` });
    reportIncident(req, "CHAIN_CANCEL_FAILED");
  }
  setState(req, "Cancelled", by.name);
  return req;
}

export async function close(id: string): Promise<WorkflowRequest> {
  const req = mustGet(id);
  setState(req, "Closed");
  return req;
}

function mustGet(id: string): WorkflowRequest {
  const req = requests.get(id);
  if (!req) throw new Error(`Request ${id} not found`);
  return req;
}
