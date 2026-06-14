import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit";
import { api, type Meta, type WorkflowRequest } from "../api";
import { ReasoningStream } from "../components/ReasoningStream";
import { useZkApprove } from "../zk/useZkApprove";
import { Btn, Card, RiskBadge, StateBadge, money } from "../ui";

export function RequestDetail({ id, actor, meta, onBack, onChanged }: {
  id: string; actor: string; meta: Meta | null; onBack: () => void; onChanged: () => void;
}) {
  const [req, setReq] = useState<WorkflowRequest | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clarify, setClarify] = useState({ category: "", amount: "", vendorName: "" });

  const load = useCallback(() => { api.request(id).then(setReq).catch((e) => setErr(e.message)); }, [id]);
  useEffect(() => { load(); }, [load]);
  // Poll while in a veto window or executing so the page advances on its own.
  useEffect(() => {
    if (!req) return;
    if (req.state === "ScheduledForExecution" || req.state === "Executing") {
      const t = setInterval(load, 1500);
      return () => clearInterval(t);
    }
  }, [req?.state, load, req]);

  const act = async (action: string, body: object = {}) => {
    setBusy(true); setErr(null);
    try {
      const r = await api.action(id, action, body);
      setReq(r);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // zkLogin path: if the connected wallet IS the acting persona and there's a
  // real onchain object to sign against, the frontend builds + signs the
  // approve/reject transaction itself (Enoki-sponsored), then hands the
  // resulting digest to the backend instead of letting it sign server-side.
  const zkAccount = useCurrentAccount();
  const zk = useZkApprove(meta?.chainConfig ?? null);
  const useZkSigning = !!zkAccount && zkAccount.address === actor && meta?.suiMode !== "mock" && !!meta?.chainConfig && !!req?.chainObjectId;

  const approveOrReject = async (action: "approve" | "reject", text: string) => {
    const field = action === "approve" ? "note" : "reason";
    if (!useZkSigning) return act(action, { approver: actor, [field]: text });
    setBusy(true); setErr(null);
    try {
      const txDigest = action === "approve" ? await zk.approve(req!.chainObjectId!, text) : await zk.reject(req!.chainObjectId!, text);
      await act(action, { approver: actor, [field]: text, txDigest });
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (!req) return <div className="text-slate-500">Loading…</div>;

  const me = meta?.members.find((m) => m.address === actor);
  const canApprove = me && (me.role === "approver" || me.role === "finance-admin") && actor !== req.requester;
  const canExecute = me && (me.role === "executor" || me.role === "finance-admin");
  const canVeto = me && (me.role === "approver" || me.role === "finance-admin");
  const inVetoWindow = req.state === "ScheduledForExecution" && !!req.vetoDeadline && new Date(req.vetoDeadline).getTime() > Date.now();

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-sm text-slate-400 hover:text-white">← Back</button>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-white">{req.title}</h1>
          <p className="text-sm text-slate-500 mt-1">
            {req.id} · {req.requesterName} · {req.category} · {money(req.amount)} → {req.vendorName || "?"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {req.policyEvaluation && <RiskBadge score={req.policyEvaluation.riskScore} />}
          <StateBadge state={req.state} />
        </div>
      </div>

      {err && <div className="bg-rose-950 border border-rose-800 text-rose-200 text-sm rounded-lg px-4 py-2">{err}</div>}

      {/* Action bar — role-gated, mirrors onchain permissions */}
      <div className="flex gap-2 flex-wrap">
        {req.state === "PendingApproval" && canApprove && (
          <>
            <Btn onClick={() => approveOrReject("approve", "Approved via inbox")} disabled={busy}>
              Approve ({req.approvals.length}/{req.requiredApprovals})
            </Btn>
            <Btn kind="danger" onClick={() => approveOrReject("reject", "Rejected by approver")} disabled={busy}>Reject</Btn>
            {useZkSigning && <span className="text-xs text-cyan-400 self-center">zkLogin: signs onchain, gas-sponsored</span>}
          </>
        )}
        {req.state === "PendingApproval" && !canApprove && (
          <span className="text-xs text-slate-500 self-center">Waiting for an approver. ({me?.name} cannot approve{actor === req.requester ? " — self-approval blocked" : ""})</span>
        )}
        {req.state === "Approved" && canExecute && (
          <>
            <Btn onClick={() => act("execute", { executor: actor })} disabled={busy}>{busy ? "Executing…" : "Execute payment on Sui"}</Btn>
            <Btn kind="warn" onClick={() => act("execute", { executor: actor, simulateFailure: true })} disabled={busy}>Execute (simulate failure)</Btn>
          </>
        )}
        {req.state === "Failed" && canExecute && (
          <>
            <Btn onClick={() => act("retry", { executor: actor })} disabled={busy}>Retry execution</Btn>
            <Btn kind="warn" onClick={() => act("escalate")} disabled={busy}>Escalate to admin</Btn>
          </>
        )}
        {req.state === "Executed" && <Btn kind="ghost" onClick={() => act("close")} disabled={busy}>Close request</Btn>}
        {req.state === "Executed" && (
          <a href={api.auditExportUrl(req.id)} download className="px-3 py-1.5 rounded-lg text-sm font-medium bg-slate-800 hover:bg-slate-700 text-slate-200">
            Export verifiable audit (JSON)
          </a>
        )}
        {!["Executed", "Closed", "Cancelled"].includes(req.state) && (
          <Btn kind="ghost" onClick={() => act("cancel", { by: actor })} disabled={busy}>Cancel</Btn>
        )}
      </div>

      {/* Clarification loop */}
      {req.state === "PendingClarification" && (
        <Card title="Agent needs clarification">
          <p className="text-sm text-amber-300 mb-3">Missing: {req.missingFields?.join(", ")}</p>
          <div className="grid grid-cols-3 gap-3">
            <select className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm" value={clarify.category} onChange={(e) => setClarify({ ...clarify, category: e.target.value })}>
              <option value="">category…</option>
              {meta?.policy.allowedCategories.map((c) => <option key={c}>{c}</option>)}
            </select>
            <input className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm" placeholder="amount" type="number" value={clarify.amount} onChange={(e) => setClarify({ ...clarify, amount: e.target.value })} />
            <select className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm" value={clarify.vendorName} onChange={(e) => setClarify({ ...clarify, vendorName: e.target.value })}>
              <option value="">vendor…</option>
              {meta?.vendors.map((v) => <option key={v.address}>{v.name}</option>)}
            </select>
          </div>
          <div className="mt-3">
            <Btn
              onClick={() => act("clarify", {
                ...(clarify.category && { category: clarify.category }),
                ...(clarify.amount && { amount: Number(clarify.amount) }),
                ...(clarify.vendorName && { vendorName: clarify.vendorName }),
              })}
              disabled={busy}
            >
              Submit clarification
            </Btn>
          </div>
        </Card>
      )}

      {inVetoWindow && (
        <Card title="⏳ Veto window — optimistic execution" className="border-amber-700">
          <VetoCountdown deadline={req.vetoDeadline!} onElapsed={load} />
          <p className="text-sm text-slate-300 mt-1">
            This payment is high-risk, so execution is delayed. Funds have not moved. Any approver can challenge it before the timer ends.
          </p>
          {canVeto && (
            <div className="mt-3">
              <Btn kind="danger" onClick={() => act("veto", { by: actor, reason: "Challenged by approver" })} disabled={busy}>
                Veto this payment
              </Btn>
            </div>
          )}
        </Card>
      )}

      <ReasoningStream req={req} />

      {/* Path to yes: the agent negotiates instead of just refusing */}
      {req.approvalPaths && req.approvalPaths.length > 0 && !["Executed", "Closed", "Cancelled"].includes(req.state) && (
        <Card title="Path to approval (agent-computed counterfactuals)">
          <div className="space-y-2">
            {req.approvalPaths.map((p, i) => (
              <div key={i} className="flex gap-2 text-sm">
                <span className="text-sky-400 shrink-0">◇</span>
                <p className="text-slate-300"><span className="text-slate-500 text-xs font-mono mr-1">{p.option}</span>{p.detail}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4">
        {/* Policy evaluation */}
        <Card title="Policy evaluation">
          {!req.policyEvaluation && <p className="text-sm text-slate-500">Not evaluated yet.</p>}
          {req.policyEvaluation && (
            <div className="space-y-2">
              {req.policyEvaluation.firedRules.map((r, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <span className={
                    r.outcome === "pass" ? "text-emerald-400" : r.outcome === "warn" ? "text-amber-400" : "text-rose-400"
                  }>
                    {r.outcome === "pass" ? "✓" : r.outcome === "warn" ? "▲" : "✕"}
                  </span>
                  <div>
                    <span className="text-slate-400 text-xs">{r.rule}</span>
                    <p className="text-slate-300">{r.detail}</p>
                  </div>
                </div>
              ))}
              {req.anomalies && req.anomalies.length > 0 && (
                <div className="pt-2 border-t border-slate-800">
                  <div className="text-xs text-slate-500 mb-1">Anomaly factors (escalate scrutiny, never relax it)</div>
                  {req.anomalies.map((a, i) => (
                    <div key={i} className="flex gap-2 text-sm">
                      <span className="text-amber-400">▲</span>
                      <p className="text-slate-300"><span className="text-slate-500 text-xs font-mono">{a.factor} +{a.weight}</span> {a.detail}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>

        {/* Plan + approvals + receipt */}
        <div className="space-y-4">
          {req.agentExplanation && (
            <Card title="Agent explanation">
              <p className="text-sm text-slate-300 leading-relaxed">{req.agentExplanation}</p>
            </Card>
          )}
          <Card title={`Approvals (${req.approvals.length}/${req.requiredApprovals})`}>
            {req.approvals.length === 0 && <p className="text-sm text-slate-500">{req.requiredApprovals === 0 ? "Auto-approved under policy." : "None yet."}</p>}
            {req.approvals.map((a, i) => (
              <div key={i} className="text-sm flex justify-between border-t border-slate-800 py-1.5 first:border-0">
                <span>{a.approverName}</span>
                <span className="text-slate-500 text-xs">{new Date(a.at).toLocaleTimeString()}</span>
              </div>
            ))}
          </Card>
          {req.auditorVerdict && (
            <Card title="Maker-checker (auditor agent)">
              <p className={`text-sm mb-2 ${req.auditorVerdict.agree ? "text-emerald-300" : "text-rose-300"}`}>
                {req.auditorVerdict.agree
                  ? "✓ Independent auditor re-derived the decision and agrees."
                  : "✕ Auditor disagrees — escalated before any human was asked."}
              </p>
              {req.auditorVerdict.checks.map((c, i) => (
                <div key={i} className="flex gap-2 text-xs text-slate-400 py-0.5">
                  <span className={c.ok ? "text-emerald-500" : "text-rose-500"}>{c.ok ? "✓" : "✕"}</span>
                  <span><span className="font-mono">{c.check}</span> — {c.detail}</span>
                </div>
              ))}
            </Card>
          )}
          {req.receipt && (
            <Card title="Execution receipt">
              <div className="text-sm space-y-1">
                <div className="flex justify-between"><span className="text-slate-400">Network</span><span>Sui {req.receipt.network}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Amount</span><span>{money(req.receipt.amount)} {req.receipt.currency}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Executor</span><span className="font-mono text-xs">{req.receipt.executor === "agent" ? "🤖 autonomous (AgentCap)" : req.receipt.executor}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Digest</span>
                  <a href={req.explorerUrl ?? "#"} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline font-mono text-xs">
                    {req.receipt.txDigest.slice(0, 20)}…
                  </a>
                </div>
                {req.receipt.reasoningHash && (
                  <div className="flex justify-between" title="sha256 of parsed intent + fired rules + plan + approvals — proves WHY the money moved">
                    <span className="text-slate-400">Reasoning hash</span>
                    <span className="font-mono text-xs text-cyan-300">{req.receipt.reasoningHash.slice(0, 20)}…</span>
                  </div>
                )}
              </div>
            </Card>
          )}
          {req.exception && (
            <Card title="Exception">
              <p className="text-sm text-rose-300"><span className="font-mono text-xs bg-rose-950 px-1.5 py-0.5 rounded">{req.exception.code}</span> {req.exception.detail}</p>
            </Card>
          )}
        </div>
      </div>

      <AskAgent id={req.id} />

      {/* Audit timeline */}
      <Card title="Audit timeline">
        <ol className="relative border-l border-slate-800 ml-2 space-y-3">
          {req.timeline.map((t, i) => (
            <li key={i} className="ml-4">
              <span className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${
                t.kind === "exception" || t.kind === "rejection" ? "bg-rose-500"
                : t.kind === "approval" ? "bg-emerald-500"
                : t.kind === "receipt" ? "bg-cyan-400"
                : t.kind === "policy" ? "bg-indigo-400"
                : "bg-slate-600"}`} />
              <div className="text-xs text-slate-500">
                {new Date(t.at).toLocaleTimeString()} · {t.actor}{t.rule ? ` · ${t.rule}` : ""}
              </div>
              <p className="text-sm text-slate-300">{t.message}</p>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

const SUGGESTED_QUESTIONS = [
  "Why does this need approval?",
  "Why was this blocked?",
  "What's the risk here?",
  "What should I do next?",
  "Show me the proof it executed",
];

function AskAgent({ id }: { id: string }) {
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<{ q: string; a: string; grounding: string[] }[]>([]);
  const [busy, setBusy] = useState(false);

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await api.ask(id, q);
      setThread((t) => [...t, { q, a: r.answer, grounding: r.grounding }]);
      setQuestion("");
    } catch {
      /* surfaced via empty response */
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Ask the agent — answers grounded in the audit trail">
      <div className="flex flex-wrap gap-2 mb-3">
        {SUGGESTED_QUESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => ask(s)}
            disabled={busy}
            className="text-xs px-2.5 py-1 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>
      {thread.map((t, i) => (
        <div key={i} className="mb-3">
          <p className="text-sm text-sky-300">You: {t.q}</p>
          <p className="text-sm text-slate-300 mt-1">{t.a}</p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">grounded in: {t.grounding.join(", ")}</p>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask(question)}
          placeholder="Ask anything about this request…"
          className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm"
        />
        <Btn onClick={() => ask(question)} disabled={busy}>{busy ? "…" : "Ask"}</Btn>
      </div>
    </Card>
  );
}

function VetoCountdown({ deadline, onElapsed }: { deadline: string; onElapsed: () => void }) {
  const [left, setLeft] = useState(Math.max(0, new Date(deadline).getTime() - Date.now()));
  // Denominator = window length observed at mount, so the bar is correct
  // for any VETO_WINDOW_MS setting.
  const [total] = useState(Math.max(1, new Date(deadline).getTime() - Date.now()));
  useEffect(() => {
    const t = setInterval(() => {
      const ms = Math.max(0, new Date(deadline).getTime() - Date.now());
      setLeft(ms);
      if (ms === 0) { clearInterval(t); onElapsed(); }
    }, 250);
    return () => clearInterval(t);
  }, [deadline, onElapsed]);
  const secs = Math.ceil(left / 1000);
  return (
    <div className="flex items-center gap-3">
      <span className={`text-3xl font-bold font-mono ${secs <= 10 ? "text-rose-400" : "text-amber-300"}`}>{secs}s</span>
      <div className="flex-1 h-2 bg-slate-800 rounded-full overflow-hidden">
        <div className="h-full bg-amber-500 transition-all" style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
    </div>
  );
}
