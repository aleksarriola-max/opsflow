import { useState } from "react";
import { api, type Meta } from "../api";
import { Btn, Card } from "../ui";

export function NewRequest({ actor, meta, onCreated }: {
  actor: string; meta: Meta | null; onCreated: (id: string) => void;
}) {
  const [mode, setMode] = useState<"nl" | "form">("nl");
  const [nl, setNl] = useState("Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly.");
  const [form, setForm] = useState({ title: "", category: "software", amount: "", vendorName: "", description: "", urgency: "normal" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const body = mode === "nl"
        ? { requester: actor, naturalLanguage: nl }
        : { requester: actor, structured: { ...form, amount: Number(form.amount) } };
      const r = await api.create(body);
      onCreated(r.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5 max-w-2xl">
      <h1 className="text-xl font-semibold text-white">New Request</h1>

      <div className="flex gap-2">
        <Btn kind={mode === "nl" ? "primary" : "ghost"} onClick={() => setMode("nl")}>Natural language</Btn>
        <Btn kind={mode === "form" ? "primary" : "ghost"} onClick={() => setMode("form")}>Structured form</Btn>
      </div>

      {mode === "nl" ? (
        <Card title="Describe what you need">
          <textarea
            value={nl}
            onChange={(e) => setNl(e.target.value)}
            rows={4}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-3 text-sm"
            placeholder='e.g. "Buy a design tool subscription for the product team, up to $400/month, finance approval required."'
          />
          <p className="text-xs text-slate-500 mt-2">
            The agent extracts category, amount, vendor and urgency, then runs the deterministic policy check.
            If anything is ambiguous it asks for clarification instead of guessing.
          </p>
        </Card>
      ) : (
        <Card title="Request details">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title">
              <input className="inp" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label="Category">
              <select className="inp" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {meta?.policy.allowedCategories.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Amount (USD)">
              <input className="inp" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label="Vendor / payee">
              <select className="inp" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })}>
                <option value="">Select vendor…</option>
                {meta?.vendors.map((v) => <option key={v.address}>{v.name}</option>)}
              </select>
            </Field>
            <Field label="Urgency">
              <select className="inp" value={form.urgency} onChange={(e) => setForm({ ...form, urgency: e.target.value })}>
                <option>low</option><option>normal</option><option>high</option>
              </select>
            </Field>
            <div className="col-span-2">
              <Field label="Description / supporting note">
                <textarea className="inp" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
            </div>
          </div>
          <style>{`.inp{width:100%;background:#0f172a;border:1px solid #334155;border-radius:0.5rem;padding:0.5rem 0.75rem;font-size:0.875rem}`}</style>
        </Card>
      )}

      {err && <div className="text-sm text-rose-400">{err}</div>}
      <Btn onClick={submit} disabled={busy}>{busy ? "Agent processing…" : "Submit request"}</Btn>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-slate-400 block mb-1">{label}</span>
      {children}
    </label>
  );
}
