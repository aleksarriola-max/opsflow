import { useEffect, useState } from "react";
import { api, type BurnForecast, type Meta, type WorkflowRequest } from "../api";
import { Card, RiskBadge, StateBadge, money } from "../ui";

export function Dashboard({ requests, meta, onOpen }: {
  requests: WorkflowRequest[]; meta: Meta | null; onOpen: (id: string) => void;
}) {
  const [forecasts, setForecasts] = useState<BurnForecast[]>([]);
  useEffect(() => {
    api.forecast().then(setForecasts).catch(() => {});
  }, [requests.length]);

  const pending = requests.filter((r) => ["Submitted", "PendingPolicyCheck", "PendingClarification"].includes(r.state));
  const needApproval = requests.filter((r) => r.state === "PendingApproval");
  const executed = requests.filter((r) => r.state === "Executed" || r.state === "Closed");
  const alerts = requests.filter((r) => r.state === "Failed" || r.state === "Escalated");

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold text-white">Operations Dashboard</h1>

      <div className="grid grid-cols-4 gap-4">
        <Stat label="Open requests" value={pending.length + needApproval.length} />
        <Stat label="Awaiting approval" value={needApproval.length} accent="text-amber-400" />
        <Stat label="Executed onchain" value={executed.length} accent="text-emerald-400" />
        <Stat label="Exceptions" value={alerts.length} accent={alerts.length ? "text-rose-400" : undefined} />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Budget status">
          <div className="space-y-3">
            {meta?.buckets.map((b) => {
              const pct = Math.min(100, Math.round((b.spent / b.limit) * 100));
              const f = forecasts.find((x) => x.bucketId === b.id);
              return (
                <div key={b.id}>
                  <div className="flex justify-between text-sm mb-1">
                    <span>{b.name}</span>
                    <span className="text-slate-400">{money(b.spent)} / {money(b.limit)}</span>
                  </div>
                  <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${pct > 90 ? "bg-rose-500" : pct > 70 ? "bg-amber-500" : "bg-emerald-500"}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  {f && f.daysToExhaustion !== null && f.status !== "healthy" && (
                    <p className={`text-xs mt-0.5 ${f.status === "critical" ? "text-rose-400" : "text-amber-400"}`}>
                      ⚡ At current burn (~${f.dailyBurn}/day), exhausts in {f.daysToExhaustion}d ({f.exhaustionDate})
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="Requires your attention">
          {needApproval.length + alerts.length === 0 && <p className="text-sm text-slate-500">Nothing pending. The agent is idle.</p>}
          <div className="space-y-2">
            {[...needApproval, ...alerts].map((r) => (
              <button key={r.id} onClick={() => onOpen(r.id)} className="w-full flex items-center justify-between bg-slate-900 hover:bg-slate-800 rounded-lg px-3 py-2 text-left">
                <div>
                  <div className="text-sm">{r.title}</div>
                  <div className="text-xs text-slate-500">{r.requesterName} · {money(r.amount)}</div>
                </div>
                <div className="flex items-center gap-2">
                  {r.policyEvaluation && <RiskBadge score={r.policyEvaluation.riskScore} />}
                  <StateBadge state={r.state} />
                </div>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card title="All requests">
        {requests.length === 0 && (
          <p className="text-sm text-slate-500">No requests yet. Create one, or click “Seed demo data” in the sidebar.</p>
        )}
        <table className="w-full text-sm">
          <tbody>
            {requests.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r.id)} className="border-t border-slate-800 hover:bg-slate-800/50 cursor-pointer">
                <td className="py-2 pr-3 text-slate-500 text-xs">{r.id}</td>
                <td className="py-2 pr-3">{r.title}</td>
                <td className="py-2 pr-3 text-slate-400">{r.category}</td>
                <td className="py-2 pr-3">{money(r.amount)}</td>
                <td className="py-2 pr-3 text-slate-400">{r.vendorName}</td>
                <td className="py-2 text-right"><StateBadge state={r.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <Card>
      <div className={`text-2xl font-bold ${accent ?? "text-white"}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-1">{label}</div>
    </Card>
  );
}
