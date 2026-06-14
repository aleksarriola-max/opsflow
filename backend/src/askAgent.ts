import { members, policy } from "./store.js";
import type { WorkflowRequest } from "./types.js";

/**
 * "Ask the agent": natural-language Q&A about any request, answered
 * deterministically from the recorded decision data — policy rules fired,
 * anomalies, approvals, receipts, exceptions. The answer is grounded in the
 * audit trail, never invented. If ANTHROPIC_API_KEY is set, the grounded
 * answer is rephrased conversationally; the facts never change.
 */

export interface AgentAnswer {
  answer: string;
  grounding: string[]; // which recorded facts the answer was built from
}

function approverNames(req: WorkflowRequest): string {
  return members
    .filter((m) => (m.role === "approver" || m.role === "finance-admin") && m.address !== req.requester)
    .map((m) => m.name)
    .join(" or ");
}

export function answerQuestion(req: WorkflowRequest, question: string): AgentAnswer {
  const q = question.toLowerCase();
  const grounding: string[] = [];
  const parts: string[] = [];

  const blocks = req.policyEvaluation?.firedRules.filter((r) => r.outcome === "block") ?? [];
  const warns = req.policyEvaluation?.firedRules.filter((r) => r.outcome === "warn") ?? [];

  const wantsWhyNegative = /why.*(block|reject|escalat|deni|fail|stuck|veto)|what went wrong|what happened to/.test(q);
  const wantsWhyApproval = /why.*(approv|pending|waiting|human|sign)|who needs to/.test(q);
  const wantsWho = /who can|who should|who approves|whose/.test(q);
  const wantsRisk = /risk|anomal|suspicious|score|flag/.test(q);
  const wantsNext = /next|what (do|should) (i|we)|how (do|can) (i|we)|unstick|fix|proceed/.test(q);
  const wantsProof = /receipt|proof|hash|digest|verify|onchain|transaction/.test(q);
  const wantsDuplicate = /duplicate|already paid|double/.test(q);

  if (wantsWhyNegative || (blocks.length > 0 && !wantsWhyApproval && !wantsProof && !wantsRisk && !wantsWho && !wantsNext && !wantsDuplicate)) {
    if (req.exception) {
      parts.push(`This request hit a hard stop (${req.exception.code}): ${req.exception.detail}`);
      grounding.push(`exception:${req.exception.code}`);
    }
    for (const b of blocks) {
      parts.push(`Rule "${b.rule}" blocked it: ${b.detail}`);
      grounding.push(`rule:${b.rule}`);
    }
    if (req.approvalPaths?.length) {
      parts.push(`Paths to approval: ${req.approvalPaths.map((p) => p.detail).join(" OR ")}`);
      grounding.push("approval-paths");
    }
    if (parts.length === 0) parts.push(`Nothing blocked this request — it is currently in state "${req.state}".`);
  } else if (wantsWhyApproval) {
    const thr = req.policyEvaluation?.firedRules.find((r) => r.rule.startsWith("approval-threshold"));
    if (thr) { parts.push(thr.detail); grounding.push("rule:approval-threshold"); }
    for (const w of warns.filter((x) => !x.rule.startsWith("approval-threshold"))) {
      parts.push(w.detail);
      grounding.push(`rule:${w.rule}`);
    }
    if ((req.anomalies?.length ?? 0) > 0) {
      parts.push(`Anomaly factors also raised scrutiny: ${req.anomalies!.map((a) => a.factor).join(", ")}.`);
      grounding.push("anomalies");
    }
    parts.push(`It needs ${req.requiredApprovals} approval(s); ${req.approvals.length} given so far. Eligible: ${approverNames(req)}.`);
    grounding.push("approval-state");
  } else if (wantsWho) {
    parts.push(`${approverNames(req)} can approve. The requester (${req.requesterName}) cannot — self-approval is blocked, and executor-role members cannot approve either.`);
    grounding.push("roles");
  } else if (wantsRisk) {
    parts.push(`Risk score is ${req.policyEvaluation?.riskScore ?? "not evaluated"} / 100.`);
    grounding.push("risk-score");
    for (const a of req.anomalies ?? []) {
      parts.push(`${a.factor} (+${a.weight}): ${a.detail}`);
      grounding.push(`anomaly:${a.factor}`);
    }
    if ((req.anomalies?.length ?? 0) === 0) parts.push("No anomaly factors fired — the score comes from policy thresholds alone.");
  } else if (wantsDuplicate) {
    const dup = req.anomalies?.find((a) => a.factor === "possible-duplicate");
    parts.push(dup ? dup.detail : "No duplicate-payment pattern was detected for this request.");
    grounding.push(dup ? "anomaly:possible-duplicate" : "anomalies");
  } else if (wantsProof) {
    if (req.receipt) {
      parts.push(
        `Executed on Sui (${req.receipt.network}) by ${req.receipt.executor === "agent" ? "the agent autonomously under AgentCap" : req.receipt.executor}. ` +
        `Tx digest ${req.receipt.txDigest}. Reasoning hash ${req.receipt.reasoningHash?.slice(0, 16)}… commits to the parsed intent, fired rules, plan and approvals. ` +
        `Use "Export verifiable audit" for the full hash chain.`
      );
      grounding.push("receipt");
    } else {
      parts.push(`No receipt yet — the request is in state "${req.state}" and has not executed.`);
      grounding.push("state");
    }
  } else if (wantsNext) {
    const next: Record<string, string> = {
      PendingClarification: `Provide the missing fields (${req.missingFields?.join(", ")}) on the request page.`,
      PendingApproval: `Get ${req.requiredApprovals - req.approvals.length} more approval(s) from ${approverNames(req)} via the Approval Inbox.`,
      Approved: "An executor (or the agent, if within AgentCap authority) can execute the payment.",
      ScheduledForExecution: "It is in a veto window — wait for the timer, or an approver can veto.",
      Failed: "Retry execution or escalate from the Exceptions view.",
      Escalated: `Review the exception${req.exception ? ` (${req.exception.code})` : ""} and either fix per the suggested paths, retry, or cancel.`,
      Executed: "Nothing required — optionally close the request or export the audit trail.",
    };
    parts.push(next[req.state] ?? `Request is in state "${req.state}".`);
    grounding.push("state-machine");
    if (req.approvalPaths?.length && (req.state === "Escalated" || req.state === "PendingApproval")) {
      parts.push(`Options: ${req.approvalPaths.map((p) => p.detail).join(" OR ")}`);
      grounding.push("approval-paths");
    }
  } else {
    parts.push(
      `"${req.title}" — $${req.amount} to ${req.vendorName} (${req.category}), requested by ${req.requesterName}, currently ${req.state}. ` +
      `Risk ${req.policyEvaluation?.riskScore ?? "?"} / 100, ${req.approvals.length}/${req.requiredApprovals} approvals.` +
      (req.exception ? ` Exception: ${req.exception.code}.` : "") +
      (req.receipt ? ` Executed — digest ${req.receipt.txDigest.slice(0, 12)}…` : "")
    );
    grounding.push("summary");
  }

  return { answer: parts.join(" "), grounding };
}

/** Optional conversational polish via Claude — grounded answer is the input,
 *  so the model can rephrase but has no new facts to invent. */
export async function askAgent(req: WorkflowRequest, question: string): Promise<AgentAnswer> {
  const grounded = answerQuestion(req, question);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return grounded;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 300,
        system: "Rephrase the provided grounded answer conversationally in 1-3 sentences. Do not add facts, numbers, or names that are not in the grounded answer.",
        messages: [{ role: "user", content: `Question: ${question}\nGrounded answer: ${grounded.answer}` }],
      }),
    });
    if (!res.ok) return grounded;
    const data = (await res.json()) as { content: { text: string }[] };
    return { answer: data.content[0].text, grounding: grounded.grounding };
  } catch {
    return grounded;
  }
}
