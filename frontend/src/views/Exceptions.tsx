import { useState } from "react";
import { api, type WorkflowRequest } from "../api";
import { Btn, Card, StateBadge, money } from "../ui";

export function Exceptions({ requests, actor, onOpen, onChanged }: {
  requests: WorkflowRequest[]; actor: string; onOpen: (id: string) => void; onChanged: () => void;
}) {
  const broken = requests.filter((r) => r.state === "Failed" || r.state === "Escalated");
  const [err, setErr] = useState<string | null>(null);

  const act = async (id: string, action: string, body: object = {}) => {
    setErr(null);
    try { await api.action(id, action, body); onChanged(); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-white">Exceptions & Recovery</h1>
      {err && <div className="bg-rose-950 border border-rose-800 text-rose-200 text-sm rounded-lg px-4 py-2">{err}</div>}
      {broken.length === 0 && <p className="text-sm text-slate-500">No exceptions. Everything executed cleanly.</p>}
      {broken.map((r) => (
        <Card key={r.id}>
          <div className="flex items-start justify-between">
            <button onClick={() => onOpen(r.id)} className="text-left">
              <div className="flex items-center gap-2">
                <span className="font-medium text-white">{r.title}</span>
                <StateBadge state={r.state} />
              </div>
              <div className="text-sm text-slate-400 mt-1">{r.requesterName} · {money(r.amount)} → {r.vendorName}</div>
              {r.exception && (
                <p className="text-sm text-rose-300 mt-2">
                  <span className="font-mono text-xs bg-rose-950 px-1.5 py-0.5 rounded mr-1">{r.exception.code}</span>
                  {r.exception.detail}
                </p>
              )}
            </button>
            <div className="flex gap-2 shrink-0">
              {r.state === "Failed" && (
                <>
                  <Btn onClick={() => act(r.id, "retry", { executor: actor })}>Retry</Btn>
                  <Btn kind="warn" onClick={() => act(r.id, "escalate")}>Escalate</Btn>
                </>
              )}
              <Btn kind="ghost" onClick={() => act(r.id, "cancel", { by: actor })}>Cancel</Btn>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}
