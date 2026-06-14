import type { ParsedIntent } from "./types.js";

/**
 * LLM intent parsing layer.
 * - If ANTHROPIC_API_KEY is set, uses Claude for parsing + explanations.
 * - Otherwise falls back to a deterministic heuristic parser so the demo
 *   never depends on network availability.
 * Golden rule: output here is a *proposal*; the policy engine and state
 * machine decide what actually happens.
 */

const CATEGORY_HINTS: Record<string, string[]> = {
  software: ["software", "subscription", "saas", "license", "seat", "tool", "figma", "notion", "slack", "github"],
  contractor: ["contractor", "freelancer", "consultant", "developer", "designer", "invoice"],
  events: ["event", "conference", "meetup", "sponsorship", "ticket", "booth"],
  reimbursements: ["reimburse", "reimbursement", "expense", "out of pocket", "travel", "flight", "hotel"],
};

export function heuristicParse(text: string): ParsedIntent {
  const lower = text.toLowerCase();

  // amount: $300, 300 usd, 300/month etc. — take the largest figure as total
  const amountMatches = [...lower.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(?:usd|dollars|\$|\/month|\/mo|monthly)?/g)]
    .map((m) => parseFloat(m[1].replace(/,/g, "")))
    .filter((n) => !isNaN(n) && n > 0);
  const amount = amountMatches.length ? Math.max(...amountMatches) : null;

  let category: string | null = null;
  for (const [cat, words] of Object.entries(CATEGORY_HINTS)) {
    if (words.some((w) => lower.includes(w))) { category = cat; break; }
  }

  const vendorMatch = text.match(/(?:from|to|for|via|with|at)\s+([A-Z][A-Za-z0-9.&-]{2,})/);
  const knownVendors = ["figma", "notion", "slack", "github", "vercel", "linear", "adobe", "canva"];
  const knownVendor = knownVendors.find((v) => lower.includes(v));
  const vendorName = knownVendor
    ? knownVendor[0].toUpperCase() + knownVendor.slice(1)
    : vendorMatch?.[1] ?? null;

  const urgency: ParsedIntent["urgency"] = /urgent|asap|immediately|today/.test(lower)
    ? "high"
    : /whenever|no rush|low priority/.test(lower)
      ? "low"
      : "normal";

  const missingFields: string[] = [];
  if (amount === null) missingFields.push("amount");
  if (!category) missingFields.push("category");
  if (!vendorName) missingFields.push("vendor");

  const title = text.length > 60 ? text.slice(0, 57) + "..." : text;

  return {
    title,
    category,
    amount,
    vendorName,
    urgency,
    description: text,
    missingFields,
    confidence: 1 - missingFields.length * 0.25,
  };
}

export async function parseIntent(text: string): Promise<ParsedIntent> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return heuristicParse(text);

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system:
          'Parse a procurement/payout request into JSON: {"title":string,"category":"software"|"contractor"|"events"|"reimbursements"|null,"amount":number|null,"vendorName":string|null,"urgency":"low"|"normal"|"high","missingFields":string[]}. amount is the total in USD. missingFields lists any of amount/category/vendor you could not determine. Respond with JSON only.',
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const data = (await res.json()) as { content: { text: string }[] };
    const parsed = JSON.parse(data.content[0].text.replace(/^```json?\n?|```$/g, ""));
    return {
      title: parsed.title ?? text.slice(0, 60),
      category: parsed.category ?? null,
      amount: parsed.amount ?? null,
      vendorName: parsed.vendorName ?? null,
      urgency: parsed.urgency ?? "normal",
      description: text,
      missingFields: parsed.missingFields ?? [],
      confidence: 0.9,
    };
  } catch {
    return heuristicParse(text); // never let LLM failure break the flow
  }
}

export function explainPlan(req: {
  title: string; amount: number; category: string; vendorName: string;
  requiredApprovals: number; bucketName: string;
}): string {
  const approvalText =
    req.requiredApprovals === 0
      ? "it qualifies for auto-approval under policy"
      : req.requiredApprovals === 1
        ? "policy requires one approver because the amount exceeds the auto-approve threshold"
        : "policy requires two approvers because the amount crosses the dual-approval threshold";
  return `I classified this as a ${req.category} purchase from ${req.vendorName} for $${req.amount}, charged to the "${req.bucketName}" budget. ${approvalText[0].toUpperCase() + approvalText.slice(1)}. Once approved, I will execute payment onchain and attach the receipt.`;
}
