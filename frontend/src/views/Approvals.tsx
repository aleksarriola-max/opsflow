import { useState } from "react";
import { api, type WorkflowRequest } from "../api";
import { Btn, Card, RiskBadge, money } from "../ui";

export function Approvals({ requests, actor, onOpen, onChanged }: {
  requests: WorkflowRequest[]; actor: string; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const pending = requests.filter((r) => r.state === "PendingApproval");
  const [err, setErr] = useState<string | null>(null);

  const act = async (id: string, action: "approve" | "reject") => {
    setErr(null);
    try {
      await api.action(id, action, action === "approve"
        ? { approver: actor, note: "Approved from inbox" }
        : { approver: actor, reason: "Rejected from inbox" });
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-white">Approval Inbox</h1>
      {err && <div className="bg-rose-950 border border-rose-800 text-rose-200 text-sm rounded-lg px-4 py-2">{err}</div>}
      {pending.length === 0 && <p className="text-sm text-slate-500">No pending approvals.</p>}
      {pending.map((r) => (
        <Card key={r.id}>
          <div className="flex items-start justify-between">
            <button onClick={() => onOpen(r.id)} className="text-left">
              <div className="font-medium text-white">{r.title}</div>
              <div className="text-sm text-slate-400 mt-1">
                {r.requesterName} requests {money(r.amount)} → {r.vendorName} ({r.category})
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Needs {r.requiredApprovals} approval{r.requiredApprovals > 1 ? "s" : ""} · has {r.approvals.length} ·{" "}
                {r.policyEvaluation?.firedRules.find((f) => f.rule.startsWith("approval-threshold"))?.detail}
              </div>
            </button>
            <div className="flex items-center gap-3 shrink-0">
              {r.policyEvaluation && <RiskBadge score={r.policyEvaluation.riskScore} />}
              <Btn onClick={() => act(r.id, "approve")}>Approve</Btn>
              <Btn kind="danger" onClick={() => act(r.id, "reject")}>Reject</Btn>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
