import type { WorkflowState } from "./types.js";

/** Strict transition table — single source of truth offchain,
 *  mirroring the Move module's onchain assertions. */
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  Draft: ["Submitted", "Cancelled"],
  Submitted: ["PendingPolicyCheck", "Cancelled"],
  PendingPolicyCheck: ["PendingClarification", "PendingApproval", "Approved", "Escalated", "Cancelled"],
  PendingClarification: ["Submitted", "Cancelled"],
  PendingApproval: ["Approved", "Escalated", "Cancelled"],
  Approved: ["ScheduledForExecution", "Cancelled"],
  ScheduledForExecution: ["Executing", "Escalated", "Cancelled"],
  Executing: ["Executed", "Failed"],
  Executed: ["Closed"],
  Failed: ["Escalated", "ScheduledForExecution"],
  Escalated: ["Submitted", "ScheduledForExecution", "Cancelled"],
  Cancelled: [],
  Closed: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal state transition: ${from} -> ${to}`);
  }
}

export const TERMINAL_STATES: WorkflowState[] = ["Cancelled", "Closed"];
