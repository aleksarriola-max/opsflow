import { useCallback, useEffect, useState } from "react";
import { ConnectModal, useCurrentAccount, useDisconnectWallet } from "@mysten/dapp-kit";
import { api, type Meta, type WorkflowRequest } from "./api";
import { ZK_ENABLED } from "./zk/provider";
import { Dashboard } from "./views/Dashboard";
import { NewRequest } from "./views/NewRequest";
import { RequestDetail } from "./views/RequestDetail";
import { Approvals } from "./views/Approvals";
import { Policies } from "./views/Policies";
import { Exceptions } from "./views/Exceptions";

type View = "dashboard" | "new" | "approvals" | "policies" | "exceptions";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "▦" },
  { id: "new", label: "New Request", icon: "✚" },
  { id: "approvals", label: "Approval Inbox", icon: "✓" },
  { id: "policies", label: "Policy & Budgets", icon: "⚖" },
  { id: "exceptions", label: "Exceptions", icon: "⚠" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [meta, setMeta] = useState<Meta | null>(null);
  const [requests, setRequests] = useState<WorkflowRequest[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [actor, setActor] = useState<string>("0xa11ce");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, rs] = await Promise.all([api.meta(), api.requests()]);
      setMeta(m);
      setRequests(rs);
      setError(null);
    } catch (e) {
      setError(`Backend unreachable: ${(e as Error).message}. Start it with "npm run dev" in backend/.`);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const open = (id: string) => setSelected(id);
  const closeDetail = () => { setSelected(null); refresh(); };

  const pendingApprovals = requests.filter((r) => r.state === "PendingApproval").length;
  const exceptions = requests.filter((r) => r.state === "Failed" || r.state === "Escalated").length;

  return (
    <div className="min-h-screen text-slate-200 flex">
      {/* Sidebar */}
      <aside className="w-60 shrink-0 border-r border-slate-800 p-4 flex flex-col gap-1 sticky top-0 h-screen">
        <div className="mb-5">
          <div className="text-lg font-bold text-white">OpsFlow</div>
          <div className="text-[11px] text-slate-500">Autonomous Procurement & Ops OS</div>
          {meta && (
            <span className="inline-block mt-2 text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
              Sui · {meta.suiMode}
            </span>
          )}
        </div>
        {NAV.map((n) => (
          <button
            key={n.id}
            onClick={() => { setView(n.id); setSelected(null); }}
            className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm text-left transition ${
              view === n.id ? "bg-sky-950 text-sky-200 border border-sky-900" : "hover:bg-slate-800 text-slate-300"
            }`}
          >
            <span>{n.icon}&nbsp;&nbsp;{n.label}</span>
            {n.id === "approvals" && pendingApprovals > 0 && (
              <span className="text-[10px] bg-amber-700 text-white rounded-full px-1.5">{pendingApprovals}</span>
            )}
            {n.id === "exceptions" && exceptions > 0 && (
              <span className="text-[10px] bg-rose-700 text-white rounded-full px-1.5">{exceptions}</span>
            )}
          </button>
        ))}
        <div className="mt-auto">
          <label className="text-[11px] text-slate-500 block mb-1">Acting as (demo persona)</label>
          <select
            value={actor}
            onChange={(e) => setActor(e.target.value)}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm"
          >
            {meta?.members.map((m) => (
              <option key={m.address} value={m.address}>{m.name} · {m.role}</option>
            ))}
          </select>
          <button
            onClick={async () => { await api.seed(); refresh(); }}
            className="w-full mt-2 text-xs text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-lg py-1.5"
          >
            Seed demo data
          </button>
          {ZK_ENABLED && <ZkLoginPanel actor={actor} setActor={setActor} />}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 p-6 max-w-6xl">
        {error && (
          <div className="mb-4 bg-rose-950 border border-rose-800 text-rose-200 text-sm rounded-lg px-4 py-3">{error}</div>
        )}
        {meta?.circuitBreaker.tripped && (
          <div className="mb-4 bg-rose-950 border border-rose-700 rounded-lg px-4 py-3">
            <p className="text-sm font-semibold text-rose-200">⚡ Agent self-suspended (circuit breaker)</p>
            <p className="text-xs text-rose-300 mt-1">{meta.circuitBreaker.reason}</p>
            <p className="text-xs text-slate-400 mt-1">Re-issue the AgentCap in Policy &amp; Budgets to restore autonomous execution.</p>
          </div>
        )}
        {selected ? (
          <RequestDetail id={selected} actor={actor} meta={meta} onBack={closeDetail} onChanged={refresh} />
        ) : view === "dashboard" ? (
          <Dashboard requests={requests} meta={meta} onOpen={open} />
        ) : view === "new" ? (
          <NewRequest actor={actor} meta={meta} onCreated={(id) => { refresh(); setSelected(id); }} />
        ) : view === "approvals" ? (
          <Approvals requests={requests} actor={actor} onOpen={open} onChanged={refresh} />
        ) : view === "policies" ? (
          <Policies meta={meta} actor={actor} onChanged={refresh} />
        ) : (
          <Exceptions requests={requests} actor={actor} onOpen={open} onChanged={refresh} />
        )}
      </main>
    </div>
  );
}

function truncate(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}

/** Walletless sign-in: lets a human approver connect via Google (zkLogin,
 *  through Enoki) instead of holding a Sui keypair. Only rendered when
 *  VITE_ENOKI_API_KEY + VITE_GOOGLE_CLIENT_ID are configured. */
function ZkLoginPanel({ actor, setActor }: { actor: string; setActor: (a: string) => void }) {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();

  if (!account) {
    return (
      <ConnectModal
        trigger={
          <button className="w-full mt-2 text-xs text-cyan-300 hover:text-cyan-200 border border-dashed border-cyan-800 rounded-lg py-1.5">
            Sign in with Google (zkLogin)
          </button>
        }
      />
    );
  }

  return (
    <div className="mt-2 text-xs border border-cyan-900 rounded-lg p-2 bg-cyan-950/30">
      <div className="text-cyan-300">zkLogin: {truncate(account.address)}</div>
      {actor !== account.address && (
        <button
          onClick={() => setActor(account.address)}
          className="w-full mt-1.5 text-cyan-300 hover:text-cyan-200 border border-cyan-800 rounded-lg py-1"
        >
          Act as this address
        </button>
      )}
      <button onClick={() => disconnect()} className="w-full mt-1.5 text-slate-500 hover:text-slate-300 border border-dashed border-slate-700 rounded-lg py-1">
        Disconnect
      </button>
    </div>
  );
}
