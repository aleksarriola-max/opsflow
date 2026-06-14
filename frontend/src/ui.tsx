import type { ReactNode } from "react";

export const STATE_COLORS: Record<string, string> = {
  Draft: "bg-slate-700 text-slate-200",
  Submitted: "bg-sky-900 text-sky-200",
  PendingPolicyCheck: "bg-indigo-900 text-indigo-200",
  PendingClarification: "bg-amber-900 text-amber-200",
  PendingApproval: "bg-amber-800 text-amber-100",
  Approved: "bg-emerald-900 text-emerald-200",
  ScheduledForExecution: "bg-teal-900 text-teal-200",
  Executing: "bg-teal-800 text-teal-100 animate-pulse",
  Executed: "bg-emerald-700 text-emerald-50",
  Failed: "bg-rose-900 text-rose-200",
  Escalated: "bg-orange-900 text-orange-200",
  Cancelled: "bg-slate-800 text-slate-400",
  Closed: "bg-slate-700 text-slate-300",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATE_COLORS[state] ?? "bg-slate-700 text-slate-200"}`}>
      {state.replace(/([A-Z])/g, " $1").trim()}
    </span>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`bg-[#111827] border border-slate-800 rounded-xl p-4 ${className}`}>
      {title && <h3 className="text-xs uppercase tracking-wider text-slate-400 mb-3">{title}</h3>}
      {children}
    </div>
  );
}

export function Btn({ children, onClick, kind = "primary", disabled = false }: {
  children: ReactNode; onClick?: () => void; kind?: "primary" | "ghost" | "danger" | "warn"; disabled?: boolean;
}) {
  const styles = {
    primary: "bg-sky-600 hover:bg-sky-500 text-white",
    ghost: "bg-slate-800 hover:bg-slate-700 text-slate-200",
    danger: "bg-rose-700 hover:bg-rose-600 text-white",
    warn: "bg-amber-700 hover:bg-amber-600 text-white",
  }[kind];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition disabled:opacity-40 disabled:cursor-not-allowed ${styles}`}
    >
      {children}
    </button>
  );
}

export function RiskBadge({ score }: { score: number }) {
  const color = score >= 60 ? "text-rose-400" : score >= 30 ? "text-amber-400" : "text-emerald-400";
  return <span className={`text-xs font-semibold ${color}`}>risk {score}</span>;
}

export function money(n: number): string {
  return `$${n.toLocaleString()}`;
}
