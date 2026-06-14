import type { PolicySet } from "./types.js";
import { vendors } from "./store.js";

/**
 * Natural-language policy authoring.
 * English -> proposed PolicySet changes -> human-readable diff -> admin applies.
 * Same golden rule: the LLM (or heuristic) only *proposes*; the diff is
 * computed deterministically and nothing changes until an admin applies it.
 */

export interface PolicyChange {
  field: string;
  from: string;
  to: string;
  effect: string;
}

export interface PolicyProposal {
  patch: Partial<PolicySet>;
  changes: PolicyChange[];
  warnings: string[];
}

export function heuristicCompile(text: string, current: PolicySet): Partial<PolicySet> {
  const lower = text.toLowerCase();
  const patch: Partial<PolicySet> = {};

  const dollars = (m: RegExpMatchArray | null) =>
    m ? parseFloat(m[1].replace(/,/g, "")) : null;

  // "auto approve up to $X" / "anything under $X auto" / "auto-approval threshold $X"
  const auto = dollars(lower.match(/auto[- ]?approv\w*[^$\d]{0,40}\$?\s?(\d[\d,]*)/))
    ?? dollars(lower.match(/(?:under|below|up to)\s+\$?\s?(\d[\d,]*)[^.]{0,30}auto/));
  if (auto !== null) patch.autoApproveMax = auto;

  // "over/above $X needs/requires (one|an|finance) approval"
  const single = dollars(lower.match(/(?:over|above|more than)\s+\$?\s?(\d[\d,]*)[^.]{0,50}(?:approval|approver|sign[- ]?off)/));
  if (single !== null && auto === null) patch.autoApproveMax = single;

  // "two approvals/approvers (for anything) over $X" or "$X+ needs two"
  const dual = dollars(lower.match(/(?:two|2|dual)\s+approv\w+[^$\d]{0,40}\$?\s?(\d[\d,]*)/))
    ?? dollars(lower.match(/(?:over|above)\s+\$?\s?(\d[\d,]*)[^.]{0,40}(?:two|2|dual)\s+approv/));
  if (dual !== null) patch.dualApprovalMin = dual;

  // "cap/never exceed/maximum per request $X"
  const cap = dollars(lower.match(/(?:cap|maximum|max|never (?:pay|exceed)|hard limit)[^$\d]{0,40}\$?\s?(\d[\d,]*)/));
  if (cap !== null) patch.perRequestCap = cap;

  // "deny/block/never pay <vendor>" / "allow <vendor>"
  for (const v of vendors) {
    const name = v.name.toLowerCase();
    if (lower.includes(name)) {
      if (new RegExp(`(?:deny|block|never pay|ban|blacklist)[^.]{0,40}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower)) {
        patch.vendorDenylist = [...new Set([...(patch.vendorDenylist ?? current.vendorDenylist), v.address])];
      } else if (new RegExp(`(?:allow|whitelist|approve|unblock)[^.]{0,40}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(lower)) {
        patch.vendorDenylist = (patch.vendorDenylist ?? current.vendorDenylist).filter((a) => a !== v.address);
        patch.vendorAllowlist = [...new Set([...(patch.vendorAllowlist ?? current.vendorAllowlist), v.address])];
      }
    }
  }

  return patch;
}

async function llmCompile(text: string, current: PolicySet): Promise<Partial<PolicySet> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: `Current policy: ${JSON.stringify(current)}. Known vendors: ${JSON.stringify(vendors)}. Convert the admin's instruction into a JSON patch of the policy (only changed fields). Fields: autoApproveMax, dualApprovalMin, perRequestCap (numbers, USD); allowedCategories (string[]); vendorAllowlist, vendorDenylist (address[] using known vendor addresses). Respond with JSON only.`,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content: { text: string }[] };
    return JSON.parse(data.content[0].text.replace(/^```json?\n?|```$/g, ""));
  } catch {
    return null;
  }
}

const vendorName = (addr: string) => vendors.find((v) => v.address === addr)?.name ?? addr;

export async function proposePolicy(text: string, current: PolicySet): Promise<PolicyProposal> {
  const patch = (await llmCompile(text, current)) ?? heuristicCompile(text, current);
  const changes: PolicyChange[] = [];
  const warnings: string[] = [];

  const num = (field: "autoApproveMax" | "dualApprovalMin" | "perRequestCap", effect: (v: number) => string) => {
    const v = patch[field];
    if (v !== undefined && v !== current[field]) {
      changes.push({ field, from: `$${current[field]}`, to: `$${v}`, effect: effect(v) });
    }
  };
  num("autoApproveMax", (v) => `Requests up to $${v} will execute with zero human approvals.`);
  num("dualApprovalMin", (v) => `Requests of $${v} or more will require two distinct approvers.`);
  num("perRequestCap", (v) => `Any single request above $${v} will be hard-blocked.`);

  const lists: ("vendorAllowlist" | "vendorDenylist" | "allowedCategories")[] = ["vendorAllowlist", "vendorDenylist", "allowedCategories"];
  for (const field of lists) {
    const v = patch[field];
    if (v && JSON.stringify(v) !== JSON.stringify(current[field])) {
      const fmt = (arr: string[]) =>
        field === "allowedCategories" ? arr.join(", ") || "(none)" : arr.map(vendorName).join(", ") || "(none)";
      changes.push({
        field,
        from: fmt(current[field]),
        to: fmt(v as string[]),
        effect:
          field === "vendorDenylist" ? "Denied vendors are blocked even with approvals."
          : field === "vendorAllowlist" ? "A non-empty allowlist blocks every vendor not on it."
          : "Requests outside allowed categories are blocked.",
      });
    }
  }

  // Sanity warnings
  const next = { ...current, ...patch };
  if (next.autoApproveMax >= next.dualApprovalMin) {
    warnings.push("autoApproveMax ≥ dualApprovalMin — the single-approver band disappears.");
  }
  if (next.autoApproveMax > 1000) {
    warnings.push(`Auto-approving up to $${next.autoApproveMax} without humans is unusually permissive.`);
  }
  if (changes.length === 0) {
    warnings.push("No recognizable policy change found in that instruction. Try e.g. \"auto approve up to $300\" or \"never pay ShadyVendor Inc\".");
  }

  return { patch, changes, warnings };
}

export function applyPolicy(patch: Partial<PolicySet>, current: PolicySet): PolicySet {
  // Deterministic merge — in production this is a Move call updating the
  // PolicySet shared object, signed by an AdminCap holder.
  return Object.assign(current, patch);
}
