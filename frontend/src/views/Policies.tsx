import { useEffect, useState } from "react";
import { api, type DryRunResult, type Meta, type PolicyProposal, type VendorIntel } from "../api";
import { Btn, Card, money } from "../ui";

export function Policies({ meta, actor, onChanged }: { meta: Meta | null; actor: string; onChanged: () => void }) {
  const [instruction, setInstruction] = useState("Auto approve anything up to $300, and never pay ShadyVendor Inc");
  const [proposal, setProposal] = useState<PolicyProposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [editingCap, setEditingCap] = useState(false);
  const [capForm, setCapForm] = useState({ maxPerRequest: "", dailyLimit: "" });

  if (!meta) return null;
  const p = meta.policy;
  const cap = meta.agentCap;
  const isAdmin = meta.members.find((m) => m.address === actor)?.role === "finance-admin";

  const propose = async () => {
    setBusy(true); setMsg(null);
    try { setProposal(await api.proposePolicy(instruction)); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!proposal) return;
    setBusy(true); setMsg(null);
    try {
      await api.applyPolicy(proposal.patch, actor);
      setProposal(null);
      setMsg("Policy updated. Onchain this is a PolicySet mutation signed by the AdminCap holder.");
      onChanged();
    } catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const setCap = async (body: object) => {
    setBusy(true); setMsg(null);
    try { await api.setAgentCap({ ...body, by: actor }); onChanged(); }
    catch (e) { setMsg((e as Error).message); }
    finally { setBusy(false); }
  };

  const startEditCap = () => {
    setCapForm({ maxPerRequest: String(cap.maxPerRequest), dailyLimit: String(cap.dailyLimit) });
    setEditingCap(true);
  };

  const saveCap = async () => {
    const maxPerRequest = Number(capForm.maxPerRequest);
    const dailyLimit = Number(capForm.dailyLimit);
    if (!Number.isFinite(maxPerRequest) || maxPerRequest <= 0 || !Number.isFinite(dailyLimit) || dailyLimit <= 0) {
      setMsg("Enter positive numbers for both limits.");
      return;
    }
    await setCap({ maxPerRequest, dailyLimit });
    setEditingCap(false);
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <h1 className="text-xl font-semibold text-white">Policy & Budget Administration</h1>
      {msg && <div className="bg-sky-950 border border-sky-800 text-sky-200 text-sm rounded-lg px-4 py-2">{msg}</div>}

      {/* NL policy authoring */}
      <Card title="Write policy in plain English">
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={2}
          className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm"
          placeholder='e.g. "Anything over $500 needs approval, two approvers from $1500, block EvilCorp"'
        />
        <div className="flex gap-2 mt-2">
          <Btn onClick={propose} disabled={busy}>Preview changes</Btn>
          {proposal && proposal.changes.length > 0 && (
            <Btn kind="warn" onClick={apply} disabled={busy || !isAdmin}>
              {isAdmin ? "Apply (sign as AdminCap holder)" : "Only finance-admin can apply"}
            </Btn>
          )}
        </div>
        {proposal && (
          <div className="mt-3 space-y-2">
            {proposal.changes.map((c, i) => (
              <div key={i} className="text-sm bg-slate-900 rounded-lg px-3 py-2">
                <span className="font-mono text-xs text-slate-400">{c.field}</span>{" "}
                <span className="text-rose-300 line-through">{c.from}</span>{" "}
                <span className="text-slate-500">→</span>{" "}
                <span className="text-emerald-300">{c.to}</span>
                <p className="text-xs text-slate-500 mt-0.5">{c.effect}</p>
              </div>
            ))}
            {proposal.warnings.map((w, i) => (
              <p key={i} className="text-xs text-amber-400">▲ {w}</p>
            ))}
            {proposal.backtest && proposal.changes.length > 0 && (
              <div className="bg-slate-900 rounded-lg px-3 py-2">
                <p className="text-xs text-slate-400 mb-1">
                  Backtest against your {proposal.backtest.total} historical requests:{" "}
                  {proposal.backtest.changed.length === 0
                    ? "no outcomes would have changed."
                    : `${proposal.backtest.changed.length} outcome(s) would have changed.`}
                </p>
                {proposal.backtest.changed.map((c, i) => (
                  <p key={i} className="text-xs text-slate-300">
                    <span className="font-mono text-slate-500">{c.id}</span> "{c.title.slice(0, 40)}" ({money(c.amount)}):{" "}
                    <span className="text-rose-300">{c.before}</span> → <span className="text-emerald-300">{c.after}</span>
                  </p>
                ))}
              </div>
            )}
            <p className="text-[11px] text-slate-600">
              The language model only proposed this patch — the diff and backtest were computed deterministically, and nothing changes until an admin signs.
            </p>
          </div>
        )}
      </Card>

      <Simulator meta={meta} />

      {/* AgentCap */}
      <Card title="Agent authority (AgentCap onchain object)">
        <div className="flex items-center justify-between">
          <div className="text-sm flex-1">
            {!editingCap ? (
              <p className="text-slate-300">
                <span className="font-mono text-xs text-cyan-300">{cap.agentId}</span>{" "}
                may autonomously execute requests ≤ <b>{money(cap.maxPerRequest)}</b>, up to <b>{money(cap.dailyLimit)}</b>/day
                ({money(cap.spentToday)} used today).
              </p>
            ) : (
              <div className="flex items-end gap-3 flex-wrap">
                <span className="font-mono text-xs text-cyan-300 self-center">{cap.agentId}</span>
                <label className="text-xs text-slate-400">Per-request max
                  <input
                    type="number" min="0" step="1"
                    className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
                    value={capForm.maxPerRequest}
                    onChange={(e) => setCapForm({ ...capForm, maxPerRequest: e.target.value })}
                  />
                </label>
                <label className="text-xs text-slate-400">Daily limit
                  <input
                    type="number" min="0" step="1"
                    className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
                    value={capForm.dailyLimit}
                    onChange={(e) => setCapForm({ ...capForm, dailyLimit: e.target.value })}
                  />
                </label>
                <span className="text-xs text-slate-500 self-center">({money(cap.spentToday)} used today)</span>
              </div>
            )}
            <p className="text-xs text-slate-500 mt-1">
              The agent's autonomy is a revocable Sui object — not a config flag. Outside these bounds, humans are always in the loop.
            </p>
          </div>
          <div className="flex gap-2 shrink-0 ml-4">
            {editingCap ? (
              <>
                <Btn onClick={saveCap} disabled={busy}>Save</Btn>
                <Btn kind="ghost" onClick={() => setEditingCap(false)} disabled={busy}>Cancel</Btn>
              </>
            ) : (
              <Btn kind="ghost" onClick={startEditCap} disabled={busy || !isAdmin}>Edit limits</Btn>
            )}
            {cap.revoked ? (
              <Btn onClick={() => setCap({ revoked: false })} disabled={busy || !isAdmin}>Re-issue</Btn>
            ) : (
              <Btn kind="danger" onClick={() => setCap({ revoked: true })} disabled={busy || !isAdmin}>Revoke</Btn>
            )}
          </div>
        </div>
        {cap.revoked && <p className="text-sm text-rose-300 mt-2">⛔ Authority revoked — the agent cannot execute anything autonomously.</p>}
        <div className="mt-3 pt-3 border-t border-slate-800">
          <div className="flex justify-between text-xs text-slate-500">
            <span>
              Circuit breaker: {meta.circuitBreaker.tripped
                ? <span className="text-rose-400 font-semibold">TRIPPED — agent revoked its own authority</span>
                : <span className="text-emerald-400">armed</span>}
            </span>
            <span>{meta.circuitBreaker.incidents.length}/{meta.circuitBreaker.maxIncidents} incidents in window</span>
          </div>
          {meta.circuitBreaker.reason && <p className="text-xs text-rose-300 mt-1">{meta.circuitBreaker.reason}</p>}
          <p className="text-[11px] text-slate-600 mt-1">
            If {meta.circuitBreaker.maxIncidents} incidents (policy blocks, failures, auditor disagreements) occur within {meta.circuitBreaker.windowMs / 60000} minutes, the agent suspends itself. Re-issuing clears the breaker.
          </p>
        </div>
      </Card>

      <Card title="Approval thresholds (enforced onchain in PolicySet)">
        <div className="grid grid-cols-3 gap-4 text-sm">
          <Threshold label="Auto-approve up to" value={money(p.autoApproveMax)} hint="0 approvers" color="text-emerald-400" />
          <Threshold label="Dual approval from" value={money(p.dualApprovalMin)} hint="2 approvers" color="text-amber-400" />
          <Threshold label="Per-request hard cap" value={money(p.perRequestCap)} hint="always blocked above" color="text-rose-400" />
        </div>
      </Card>

      <Card title="Budget buckets (BudgetBucket shared objects)">
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 text-left">
            <tr><th className="pb-2">Bucket</th><th>Category</th><th>Limit</th><th>Spent</th><th>Remaining</th></tr>
          </thead>
          <tbody>
            {meta.buckets.map((b) => (
              <tr key={b.id} className="border-t border-slate-800">
                <td className="py-2">{b.name}</td>
                <td className="text-slate-400">{b.category}</td>
                <td>{money(b.limit)}</td>
                <td>{money(b.spent)}</td>
                <td className={b.limit - b.spent < 500 ? "text-rose-400" : "text-emerald-400"}>{money(b.limit - b.spent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        <Card title="Allowed categories">
          <div className="flex flex-wrap gap-2">
            {p.allowedCategories.map((c) => (
              <span key={c} className="px-2 py-1 rounded-lg bg-slate-800 text-sm">{c}</span>
            ))}
          </div>
        </Card>
        <Card title="Role assignments (MemberRole objects)">
          {meta.members.map((m) => (
            <div key={m.address} className="flex justify-between text-sm border-t border-slate-800 py-1.5 first:border-0">
              <span>{m.name}</span>
              <span className="text-slate-400 font-mono text-xs">{m.role}</span>
            </div>
          ))}
        </Card>
      </div>

      {isAdmin && <RegisterMember meta={meta} actor={actor} onChanged={onChanged} />}

      <VendorIntelCard />

      <Card title="Vendor rules">
        <p className="text-sm text-slate-400">
          Denylist: {meta.vendors.filter((v) => p.vendorDenylist.includes(v.address)).map((v) => v.name).join(", ") || "none"}.
          Allowlist empty — any vendor not denied is permitted.
        </p>
      </Card>
    </div>
  );
}

const ROLES = ["requester", "approver", "finance-admin", "executor"];

function RegisterMember({ meta, actor, onChanged }: { meta: Meta; actor: string; onChanged: () => void }) {
  const [form, setForm] = useState({ address: "", name: "", role: "approver" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    if (!form.address || !form.name) { setMsg("Address and name are required."); return; }
    setBusy(true); setMsg(null);
    try {
      await api.org.addMember({ by: actor, address: form.address, name: form.name, role: form.role });
      setForm({ address: "", name: "", role: "approver" });
      setMsg(`Registered ${form.name} as ${form.role} (signed onchain via org::set_member_role).`);
      onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Register org member (e.g. a zkLogin approver address)">
      {meta.suiMode === "mock" && (
        <p className="text-xs text-slate-500 mb-2">Mock mode: this records the member locally without an onchain transaction.</p>
      )}
      <div className="flex gap-2 items-end flex-wrap">
        <label className="text-xs text-slate-400 flex-1 min-w-[16rem]">Sui address
          <input
            className="block mt-1 w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200 font-mono"
            placeholder="0x..."
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </label>
        <label className="text-xs text-slate-400">Name
          <input
            className="block mt-1 w-40 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="text-xs text-slate-400">Role
          <select
            className="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <Btn onClick={submit} disabled={busy}>Register</Btn>
      </div>
      {msg && <p className="text-xs text-sky-300 mt-2">{msg}</p>}
    </Card>
  );
}

function Simulator({ meta }: { meta: Meta }) {
  const [form, setForm] = useState({ category: "software", amount: "500", vendorName: "Figma" });
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try { setResult(await api.dryrun({ category: form.category, amount: Number(form.amount), vendorName: form.vendorName })); }
    catch { setResult(null); }
    finally { setBusy(false); }
  };

  return (
    <Card title="Policy simulator — test a hypothetical request (creates nothing)">
      <div className="flex gap-2 items-end flex-wrap">
        <label className="text-xs text-slate-400">Category
          <select className="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {meta.policy.allowedCategories.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">Amount
          <input type="number" className="block mt-1 w-28 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </label>
        <label className="text-xs text-slate-400">Vendor
          <select className="block mt-1 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm text-slate-200" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })}>
            {meta.vendors.map((v) => <option key={v.address}>{v.name}</option>)}
          </select>
        </label>
        <Btn onClick={run} disabled={busy}>Simulate</Btn>
      </div>
      {result && (
        <div className="mt-3 text-sm space-y-1">
          <p className={result.evaluation.allowed ? "text-emerald-300" : "text-rose-300"}>
            {result.evaluation.allowed
              ? `✓ Would be allowed — ${result.evaluation.requiredApprovals === 0 ? "auto-approved" : `${result.evaluation.requiredApprovals} approval(s) required`} (risk ${result.evaluation.riskScore})`
              : "✕ Would be blocked by policy"}
          </p>
          {result.evaluation.firedRules.filter((r) => r.outcome !== "pass").map((r, i) => (
            <p key={i} className="text-xs text-slate-400">{r.outcome === "block" ? "✕" : "▲"} {r.detail}</p>
          ))}
          {result.paths.map((p, i) => (
            <p key={i} className="text-xs text-sky-300">◇ {p.detail}</p>
          ))}
        </div>
      )}
    </Card>
  );
}

function VendorIntelCard() {
  const [intel, setIntel] = useState<VendorIntel[]>([]);
  useEffect(() => { api.vendorIntel().then(setIntel).catch(() => {}); }, []);
  const paid = intel.filter((v) => v.executedCount > 0);
  return (
    <Card title="Vendor intelligence (org payment memory)">
      {paid.length === 0 && <p className="text-sm text-slate-500">No executed payments yet.</p>}
      {paid.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-slate-500 text-left">
            <tr><th className="pb-2">Vendor</th><th>Payments</th><th>Total</th><th>Avg</th><th>Categories</th></tr>
          </thead>
          <tbody>
            {paid.map((v) => (
              <tr key={v.address} className="border-t border-slate-800">
                <td className="py-2">{v.name}</td>
                <td>{v.executedCount}</td>
                <td>{money(v.totalSpend)}</td>
                <td>{money(v.avgAmount)}</td>
                <td className="text-slate-400">{v.categories.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-[11px] text-slate-600 mt-2">
        The agent uses this memory for duplicate-payment warnings and amount-deviation checks.
      </p>
    </Card>
  );
}

function Threshold({ label, value, hint, color }: { label: string; value: string; hint: string; color: string }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-bold ${color}`}>{value}</div>
      <div className="text-xs text-slate-500">{hint}</div>
    </div>
  );
}
