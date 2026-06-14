import { createHash } from "node:crypto";
import { evaluatePolicy } from "./policyEngine.js";
import type { BudgetBucket, PolicyEvaluation, PolicySet, TimelineEvent, WorkflowRequest } from "./types.js";

/**
 * Intelligence layer: anomaly scoring, counterfactual "path to yes",
 * maker-checker auditing, burn forecasting, reasoning receipts.
 * All deterministic — explainable line by line in front of a judge.
 */

// === Anomaly-based risk scoring ===

export interface AnomalyFactor {
  factor: string;
  detail: string;
  weight: number;
}

export function detectAnomalies(
  req: Pick<WorkflowRequest, "amount" | "vendor" | "vendorName" | "category" | "urgency" | "requester">,
  history: WorkflowRequest[],
  policySet?: PolicySet
): AnomalyFactor[] {
  const factors: AnomalyFactor[] = [];
  const executed = history.filter((h) => h.state === "Executed" || h.state === "Closed");

  // Vendor trust: a first-time payee carries the most risk, but that risk
  // decays as the agent builds an executed track record with the vendor —
  // rather than dropping to zero the moment a single payment clears.
  const vendorHistory = executed.filter((h) => h.vendor === req.vendor);
  const vendorPaymentCount = vendorHistory.length;
  if (vendorPaymentCount === 0) {
    factors.push({
      factor: "first-time-vendor",
      detail: `No prior executed payments to ${req.vendorName}. New payees carry elevated risk.`,
      weight: 15,
    });
  } else if (vendorPaymentCount < 3) {
    factors.push({
      factor: "limited-vendor-history",
      detail: `Only ${vendorPaymentCount} prior executed payment${vendorPaymentCount > 1 ? "s" : ""} to ${req.vendorName} — the agent is still building a track record with this vendor.`,
      weight: vendorPaymentCount === 1 ? 8 : 4,
    });
  }

  if (vendorPaymentCount > 0) {
    // Amount deviation vs vendor history. With few prior payments the
    // average is unreliable, so allow more headroom before flagging a
    // deviation; tighten the multiple as the track record grows.
    const avg = vendorHistory.reduce((s, h) => s + h.amount, 0) / vendorPaymentCount;
    const deviationMultiple = vendorPaymentCount < 3 ? 5 : 3;
    if (req.amount > avg * deviationMultiple) {
      factors.push({
        factor: "amount-deviation",
        detail: `$${req.amount} is ${(req.amount / avg).toFixed(1)}x the historical average ($${Math.round(avg)}) for ${req.vendorName} (based on ${vendorPaymentCount} prior payment${vendorPaymentCount > 1 ? "s" : ""}).`,
        weight: 20,
      });
    }

    // Duplicate-payment detection: similar amount, same vendor + category,
    // already executed within ~a billing cycle. The most common ops waste:
    // paying for the same subscription twice.
    const cycleAgo = Date.now() - 35 * 24 * 3600 * 1000;
    const dup = vendorHistory.find(
      (h) =>
        h.category === req.category &&
        new Date(h.createdAt).getTime() > cycleAgo &&
        Math.abs(h.amount - req.amount) / h.amount <= 0.2
    );
    if (dup) {
      factors.push({
        factor: "possible-duplicate",
        detail: `${req.vendorName} was already paid $${dup.amount} for ${dup.category} on ${dup.createdAt.slice(0, 10)} (${dup.id}) — this $${req.amount} request looks like a duplicate subscription or double payment.`,
        weight: 20,
      });
    }
  }

  // Category velocity: many requests in same category recently
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const recentSameCategory = history.filter(
    (h) => h.category === req.category && new Date(h.createdAt).getTime() > dayAgo
  );
  if (recentSameCategory.length >= 5) {
    factors.push({
      factor: "category-velocity",
      detail: `${recentSameCategory.length} ${req.category} requests in the last 24h — unusual volume.`,
      weight: 10,
    });
  }

  // Requester velocity
  const recentSameRequester = history.filter(
    (h) => h.requester === req.requester && new Date(h.createdAt).getTime() > dayAgo
  );
  if (recentSameRequester.length >= 6) {
    factors.push({
      factor: "requester-velocity",
      detail: `Requester filed ${recentSameRequester.length} requests in 24h.`,
      weight: 10,
    });
  }

  // Threshold structuring (anti-smurfing): a cluster of same-vendor
  // requests each individually under the auto-approve threshold, whose
  // cumulative total clearly exceeds it. The classic exploit against
  // auto-approval rules — we red-team our own policy.
  if (policySet && req.amount <= policySet.autoApproveMax) {
    const cluster = history.filter(
      (h) =>
        h.vendor === req.vendor &&
        h.state !== "Cancelled" &&
        h.amount <= policySet.autoApproveMax &&
        new Date(h.createdAt).getTime() > dayAgo
    );
    const cumulative = cluster.reduce((s, h) => s + h.amount, 0) + req.amount;
    if (cluster.length + 1 >= 3 && cumulative > policySet.autoApproveMax * 2) {
      factors.push({
        factor: "threshold-structuring",
        detail: `${cluster.length + 1} requests to ${req.vendorName} totaling $${cumulative} in 24h, each individually under the $${policySet.autoApproveMax} auto-approve threshold — pattern consistent with payment structuring. Cluster escalated for human review.`,
        weight: 35,
      });
    }
  }

  // High urgency + high amount is a classic pressure pattern
  if (req.urgency === "high" && req.amount > 500) {
    factors.push({
      factor: "urgency-pressure",
      detail: "High urgency combined with a large amount matches a common social-engineering pattern.",
      weight: 15,
    });
  }

  return factors;
}

/** Anomalies can escalate the approval tier — never lower it.
 *  A single weak signal (e.g. first-time vendor alone) does not escalate;
 *  combined signals (score ≥ 30) add one approval tier. */
export function escalateForAnomalies(
  baseRequired: 0 | 1 | 2,
  anomalyScore: number
): { required: 0 | 1 | 2; escalated: boolean } {
  if (anomalyScore >= 30 && baseRequired < 2) return { required: (baseRequired + 1) as 1 | 2, escalated: true };
  return { required: baseRequired, escalated: false };
}

// === Counterfactual "path to yes" ===

export interface ApprovalPath {
  option: string;
  detail: string;
}

export function pathToYes(
  req: Pick<WorkflowRequest, "amount" | "category" | "vendor" | "vendorName">,
  evaluation: PolicyEvaluation,
  policy: PolicySet,
  buckets: BudgetBucket[],
  approverNames: string[]
): ApprovalPath[] {
  const paths: ApprovalPath[] = [];
  const blocks = evaluation.firedRules.filter((r) => r.outcome === "block");

  if (blocks.length === 0) {
    if (evaluation.requiredApprovals > 0) {
      paths.push({
        option: "obtain-approvals",
        detail: `Obtain ${evaluation.requiredApprovals} approval${evaluation.requiredApprovals > 1 ? "s" : ""} (eligible: ${approverNames.join(", ")}).`,
      });
      if (req.amount > policy.autoApproveMax) {
        paths.push({
          option: "reduce-amount",
          detail: `Reduce the amount to $${policy.autoApproveMax} or less to qualify for auto-approval.`,
        });
      }
    }
    return paths;
  }

  for (const b of blocks) {
    if (b.rule === "per-request-cap") {
      paths.push({
        option: "split-request",
        detail: `Split into smaller requests of at most $${policy.perRequestCap} each, or ask an admin to raise the cap.`,
      });
    }
    if (b.rule === "budget-headroom" || b.rule === "budget-bucket") {
      const alt = buckets.find((bk) => bk.category !== req.category && bk.limit - bk.spent >= req.amount);
      const current = buckets.find((bk) => bk.category === req.category);
      if (current) {
        paths.push({
          option: "reduce-to-headroom",
          detail: `Reduce the amount to $${current.limit - current.spent} (remaining headroom in "${current.name}").`,
        });
      }
      if (alt) {
        paths.push({
          option: "recategorize",
          detail: `If legitimately reclassifiable, the "${alt.name}" bucket has $${alt.limit - alt.spent} of headroom (requires admin sign-off).`,
        });
      }
      paths.push({ option: "raise-budget", detail: "Ask a finance-admin to raise the bucket limit onchain." });
    }
    if (b.rule === "vendor-denylist") {
      paths.push({
        option: "alternative-vendor",
        detail: `${req.vendorName} is denied. Choose an alternative vendor, or ask an admin to remove the deny rule with justification.`,
      });
    }
    if (b.rule === "vendor-allowlist") {
      paths.push({
        option: "allowlist-vendor",
        detail: `Ask a finance-admin to add ${req.vendorName} to the vendor allowlist.`,
      });
    }
    if (b.rule === "category-allowlist") {
      paths.push({
        option: "recategorize",
        detail: `Pick one of the allowed categories: ${policy.allowedCategories.join(", ")}.`,
      });
    }
  }
  return paths;
}

// === Maker-checker: auditor second pass ===

export interface AuditVerdict {
  agree: boolean;
  checks: { check: string; ok: boolean; detail: string }[];
}

/**
 * The auditor independently re-derives what the plan *should* be from the
 * raw fields and diffs it against the proposer's plan + evaluation.
 * Two systems must agree before a human is asked to act.
 */
export function auditorReview(
  req: WorkflowRequest,
  evaluation: PolicyEvaluation,
  policy: PolicySet,
  bucket: BudgetBucket | undefined
): AuditVerdict {
  const checks: AuditVerdict["checks"] = [];

  // Re-derive approval tier independently
  let expected: 0 | 1 | 2 = 0;
  if (req.amount > policy.autoApproveMax) expected = req.amount >= policy.dualApprovalMin ? 2 : 1;
  const blocked =
    req.amount > policy.perRequestCap ||
    policy.vendorDenylist.includes(req.vendor) ||
    (policy.vendorAllowlist.length > 0 && !policy.vendorAllowlist.includes(req.vendor)) ||
    !policy.allowedCategories.includes(req.category) ||
    !bucket || bucket.spent + req.amount > bucket.limit;

  checks.push({
    check: "approval-tier-rederivation",
    ok: blocked ? !evaluation.allowed : evaluation.requiredApprovals >= expected,
    detail: blocked
      ? `Auditor expects BLOCKED; proposer says allowed=${evaluation.allowed}.`
      : `Auditor expects ≥${expected} approvals; proposer requires ${evaluation.requiredApprovals}.`,
  });

  checks.push({
    check: "amount-consistency",
    ok: req.amount > 0 && Number.isFinite(req.amount),
    detail: `Amount $${req.amount} is a valid positive figure.`,
  });

  checks.push({
    check: "payee-resolution",
    ok: !!req.vendor,
    detail: req.vendor
      ? `Vendor "${req.vendorName}" resolves to onchain address ${req.vendor}.`
      : `Vendor "${req.vendorName}" does not resolve to a known address.`,
  });

  const planMatches =
    !req.executionPlan ||
    (req.executionPlan.amount === req.amount && req.executionPlan.vendor === req.vendor);
  checks.push({
    check: "plan-field-match",
    ok: planMatches,
    detail: planMatches
      ? "Execution plan amount and payee match the approved request exactly."
      : "MISMATCH between execution plan and request fields — possible tampering or parse drift.",
  });

  return { agree: checks.every((c) => c.ok), checks };
}

// === Budget burn forecasting ===

export interface BurnForecast {
  bucketId: string;
  name: string;
  dailyBurn: number;
  daysToExhaustion: number | null;
  exhaustionDate: string | null;
  status: "healthy" | "warning" | "critical";
}

export function forecastBurn(buckets: BudgetBucket[], _history: WorkflowRequest[], periodDays = 30): BurnForecast[] {
  return buckets.map((b) => {
    // Demo data spans minutes, not weeks — assume current spend (which
    // already includes executed requests) accrued over the period.
    const dailyBurn = b.spent / periodDays;
    const remaining = b.limit - b.spent;
    const days = dailyBurn > 0 ? Math.floor(remaining / dailyBurn) : null;
    const date = days !== null ? new Date(Date.now() + days * 864e5).toISOString().slice(0, 10) : null;
    return {
      bucketId: b.id,
      name: b.name,
      dailyBurn: Math.round(dailyBurn * 100) / 100,
      daysToExhaustion: days,
      exhaustionDate: date,
      status: days !== null && days < 7 ? "critical" : days !== null && days < 21 ? "warning" : "healthy",
    };
  });
}

// === Policy backtesting ===

export interface BacktestChange {
  id: string;
  title: string;
  amount: number;
  before: string;
  after: string;
}

function outcomeLabel(e: PolicyEvaluation): string {
  if (!e.allowed) return "blocked";
  if (e.requiredApprovals === 0) return "auto-approved";
  return `${e.requiredApprovals} approval${e.requiredApprovals > 1 ? "s" : ""}`;
}

/** Re-evaluate every historical request under a proposed policy patch and
 *  report which outcomes would change. Evidence, not vibes, for every
 *  policy edit. (Evaluated against current budget state — approximate.) */
export function backtestPolicy(
  patch: Partial<PolicySet>,
  current: PolicySet,
  history: WorkflowRequest[],
  buckets: BudgetBucket[]
): { total: number; changed: BacktestChange[] } {
  const proposed: PolicySet = { ...current, ...patch };
  const changed: BacktestChange[] = [];
  for (const h of history) {
    const bucket = buckets.find((b) => b.category === h.category);
    const before = outcomeLabel(evaluatePolicy(h, current, bucket));
    const after = outcomeLabel(evaluatePolicy(h, proposed, bucket));
    if (before !== after) {
      changed.push({ id: h.id, title: h.title, amount: h.amount, before, after });
    }
  }
  return { total: history.length, changed };
}

// === Verifiable audit export ===

export interface AuditExport {
  requestId: string;
  exportedAt: string;
  chain: { event: TimelineEvent; hash: string }[];
  head: string;
  reasoningHash: string | null;
  receiptDigest: string | null;
  verification: string;
}

function linkHash(prev: string, event: TimelineEvent): string {
  return createHash("sha256").update(prev + JSON.stringify(event)).digest("hex");
}

/** Hash-chain the full audit timeline: each event's hash commits to all
 *  prior history. Tamper with any event and every later hash breaks. */
export function buildAuditExport(req: WorkflowRequest): AuditExport {
  let prev = "genesis:" + req.id;
  const chain = req.timeline.map((event) => {
    prev = linkHash(prev, event);
    return { event, hash: prev };
  });
  return {
    requestId: req.id,
    exportedAt: new Date().toISOString(),
    chain,
    head: prev,
    reasoningHash: req.receipt?.reasoningHash ?? null,
    receiptDigest: req.receipt?.txDigest ?? null,
    verification:
      "Recompute: h0 = sha256('genesis:'+requestId + JSON(event0)); hN = sha256(hN-1 + JSON(eventN)). " +
      "The final hash must equal `head`. Any edit to any event breaks every subsequent hash.",
  };
}

export function verifyAuditExport(exp: AuditExport): boolean {
  let prev = "genesis:" + exp.requestId;
  for (const link of exp.chain) {
    prev = linkHash(prev, link.event);
    if (prev !== link.hash) return false;
  }
  return prev === exp.head;
}

// === Vendor intelligence ===

export interface VendorIntel {
  address: string;
  name: string;
  executedCount: number;
  totalSpend: number;
  avgAmount: number;
  lastPaid: string | null;
  categories: string[];
}

export function vendorIntel(
  vendors: { address: string; name: string }[],
  history: WorkflowRequest[]
): VendorIntel[] {
  return vendors.map((v) => {
    const paid = history.filter(
      (h) => h.vendor === v.address && (h.state === "Executed" || h.state === "Closed")
    );
    const total = paid.reduce((s, h) => s + h.amount, 0);
    return {
      address: v.address,
      name: v.name,
      executedCount: paid.length,
      totalSpend: total,
      avgAmount: paid.length ? Math.round(total / paid.length) : 0,
      lastPaid: paid.length ? paid[paid.length - 1].createdAt : null,
      categories: [...new Set(paid.map((h) => h.category))],
    };
  });
}

// === Verifiable reasoning receipts ===

/** Hash of parsed intent + policy evaluation + plan: stored in the receipt,
 *  anchoring *why* money moved into the audit trail. */
export function reasoningHash(req: WorkflowRequest): string {
  const material = JSON.stringify({
    id: req.id,
    parsed: { title: req.title, category: req.category, amount: req.amount, vendor: req.vendor },
    evaluation: req.policyEvaluation?.firedRules.map((r) => `${r.rule}:${r.outcome}`),
    plan: req.executionPlan && { bucket: req.executionPlan.bucketId, amount: req.executionPlan.amount, vendor: req.executionPlan.vendor },
    approvals: req.approvals.map((a) => a.approver),
  });
  return createHash("sha256").update(material).digest("hex");
}
