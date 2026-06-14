import type { BudgetBucket, PolicyEvaluation, PolicySet, WorkflowRequest } from "./types.js";

/**
 * Deterministic policy evaluator. The LLM never touches this —
 * it can propose plans, but only this code decides what is allowed.
 */
export function evaluatePolicy(
  req: Pick<WorkflowRequest, "amount" | "category" | "vendor" | "vendorName" | "urgency">,
  policy: PolicySet,
  bucket: BudgetBucket | undefined
): PolicyEvaluation {
  const fired: PolicyEvaluation["firedRules"] = [];
  let blocked = false;
  let risk = 10;

  // Rule: category allowed
  if (!policy.allowedCategories.includes(req.category)) {
    fired.push({
      rule: "category-allowlist",
      outcome: "block",
      detail: `Category "${req.category}" is not in the allowed list (${policy.allowedCategories.join(", ")}).`,
    });
    blocked = true;
  } else {
    fired.push({ rule: "category-allowlist", outcome: "pass", detail: `Category "${req.category}" is allowed.` });
  }

  // Rule: vendor deny/allow
  if (policy.vendorDenylist.includes(req.vendor)) {
    fired.push({ rule: "vendor-denylist", outcome: "block", detail: `Vendor ${req.vendorName} is explicitly denied.` });
    blocked = true;
    risk += 40;
  } else if (policy.vendorAllowlist.length > 0 && !policy.vendorAllowlist.includes(req.vendor)) {
    fired.push({
      rule: "vendor-allowlist",
      outcome: "block",
      detail: `Vendor ${req.vendorName} is not on the allowlist. Add the vendor or escalate to an admin.`,
    });
    blocked = true;
    risk += 25;
  } else {
    fired.push({ rule: "vendor-rules", outcome: "pass", detail: `Vendor ${req.vendorName} passes vendor rules.` });
  }

  // Rule: per-request cap
  if (req.amount > policy.perRequestCap) {
    fired.push({
      rule: "per-request-cap",
      outcome: "block",
      detail: `Amount $${req.amount} exceeds the per-request cap of $${policy.perRequestCap}.`,
    });
    blocked = true;
    risk += 30;
  }

  // Rule: budget headroom
  let budgetOk = true;
  if (!bucket) {
    fired.push({ rule: "budget-bucket", outcome: "block", detail: `No budget bucket exists for category "${req.category}".` });
    blocked = true;
    budgetOk = false;
  } else if (bucket.spent + req.amount > bucket.limit) {
    fired.push({
      rule: "budget-headroom",
      outcome: "block",
      detail: `Bucket "${bucket.name}" has $${bucket.limit - bucket.spent} remaining; request needs $${req.amount}.`,
    });
    blocked = true;
    budgetOk = false;
    risk += 30;
  } else {
    fired.push({
      rule: "budget-headroom",
      outcome: "pass",
      detail: `Bucket "${bucket.name}" has $${bucket.limit - bucket.spent} remaining — sufficient.`,
    });
  }

  // Rule: approval threshold
  let requiredApprovals: 0 | 1 | 2 = 0;
  if (req.amount > policy.autoApproveMax) {
    requiredApprovals = req.amount >= policy.dualApprovalMin ? 2 : 1;
    risk += requiredApprovals === 2 ? 30 : 15;
    fired.push({
      rule: "approval-threshold",
      outcome: "warn",
      detail:
        requiredApprovals === 2
          ? `Amount $${req.amount} ≥ $${policy.dualApprovalMin}: two approvals required.`
          : `Amount $${req.amount} > auto-approve max $${policy.autoApproveMax}: one approval required.`,
    });
  } else {
    fired.push({
      rule: "approval-threshold",
      outcome: "pass",
      detail: `Amount $${req.amount} ≤ $${policy.autoApproveMax}: eligible for auto-approval.`,
    });
  }

  if (req.urgency === "high") risk += 10;

  return {
    allowed: !blocked,
    requiredApprovals: blocked ? 2 : requiredApprovals,
    riskScore: Math.min(100, risk),
    firedRules: fired,
    budgetOk,
  };
}
