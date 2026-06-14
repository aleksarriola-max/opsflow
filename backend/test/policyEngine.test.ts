import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "../src/policyEngine.js";
import { canTransition, assertTransition } from "../src/stateMachine.js";
import { heuristicParse } from "../src/intentParser.js";
import type { BudgetBucket, PolicySet } from "../src/types.js";

const policy: PolicySet = {
  autoApproveMax: 250,
  dualApprovalMin: 2000,
  perRequestCap: 10000,
  allowedCategories: ["software", "events"],
  vendorAllowlist: [],
  vendorDenylist: ["0xbad"],
};

const bucket: BudgetBucket = {
  id: "b1", name: "Software", category: "software", limit: 5000, spent: 1000,
};

const base = { category: "software", vendor: "0xok", vendorName: "Figma", urgency: "normal" as const };

describe("policy engine", () => {
  it("auto-approves small requests", () => {
    const r = evaluatePolicy({ ...base, amount: 100 }, policy, bucket);
    expect(r.allowed).toBe(true);
    expect(r.requiredApprovals).toBe(0);
  });

  it("requires one approval above threshold", () => {
    const r = evaluatePolicy({ ...base, amount: 300 }, policy, bucket);
    expect(r.allowed).toBe(true);
    expect(r.requiredApprovals).toBe(1);
  });

  it("requires two approvals at dual threshold", () => {
    const r = evaluatePolicy({ ...base, amount: 2500 }, policy, bucket);
    expect(r.requiredApprovals).toBe(2);
  });

  it("blocks denied vendors", () => {
    const r = evaluatePolicy({ ...base, amount: 100, vendor: "0xbad" }, policy, bucket);
    expect(r.allowed).toBe(false);
    expect(r.firedRules.some((f) => f.rule === "vendor-denylist" && f.outcome === "block")).toBe(true);
  });

  it("blocks over per-request cap", () => {
    const r = evaluatePolicy({ ...base, amount: 99999 }, policy, bucket);
    expect(r.allowed).toBe(false);
  });

  it("blocks when budget headroom is insufficient", () => {
    const r = evaluatePolicy({ ...base, amount: 4500 }, policy, bucket);
    expect(r.allowed).toBe(false);
    expect(r.budgetOk).toBe(false);
  });

  it("blocks disallowed categories", () => {
    const r = evaluatePolicy({ ...base, amount: 100, category: "weapons" }, policy, undefined);
    expect(r.allowed).toBe(false);
  });

  it("enforces allowlist when non-empty", () => {
    const p = { ...policy, vendorAllowlist: ["0xonly"] };
    const r = evaluatePolicy({ ...base, amount: 100 }, p, bucket);
    expect(r.allowed).toBe(false);
  });
});

describe("state machine", () => {
  it("allows the happy path", () => {
    expect(canTransition("Submitted", "PendingPolicyCheck")).toBe(true);
    expect(canTransition("PendingPolicyCheck", "PendingApproval")).toBe(true);
    expect(canTransition("PendingApproval", "Approved")).toBe(true);
    expect(canTransition("Approved", "ScheduledForExecution")).toBe(true);
    expect(canTransition("Executing", "Executed")).toBe(true);
    expect(canTransition("Executed", "Closed")).toBe(true);
  });

  it("supports failure and recovery", () => {
    expect(canTransition("Executing", "Failed")).toBe(true);
    expect(canTransition("Failed", "Escalated")).toBe(true);
    expect(canTransition("Failed", "ScheduledForExecution")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("Submitted", "Executed")).toBe(false);
    expect(canTransition("PendingApproval", "Executing")).toBe(false);
    expect(canTransition("Cancelled", "Submitted")).toBe(false);
    expect(() => assertTransition("Draft", "Executed")).toThrow();
  });
});

describe("heuristic intent parser", () => {
  it("parses the headline demo sentence", () => {
    const p = heuristicParse(
      "Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly."
    );
    expect(p.category).toBe("software");
    expect(p.amount).toBe(300);
    expect(p.vendorName).toBe("Figma");
    expect(p.missingFields).toEqual([]);
  });

  it("flags missing fields instead of guessing", () => {
    const p = heuristicParse("We need to pay someone for that thing");
    expect(p.missingFields).toContain("amount");
    expect(p.missingFields.length).toBeGreaterThan(0);
  });

  it("detects urgency", () => {
    expect(heuristicParse("Urgent: renew Slack $120 today").urgency).toBe("high");
  });
});
