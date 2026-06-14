import { useEffect, useState } from "react";
import type { WorkflowRequest } from "../api";
import { Card } from "../ui";

const ICON: Record<string, { glyph: string; color: string }> = {
  info: { glyph: "→", color: "text-sky-400" },
  pass: { glyph: "✓", color: "text-emerald-400" },
  warn: { glyph: "▲", color: "text-amber-400" },
  block: { glyph: "✕", color: "text-rose-400" },
};

/** Animated agent decision trace: steps appear sequentially, as if the
 *  agent is thinking live. Re-animates once per request id. */
export function ReasoningStream({ req }: { req: WorkflowRequest }) {
  const steps = req.reasoning ?? [];
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    if (steps.length === 0) return;
    let i = 0;
    const t = setInterval(() => {
      i += 1;
      setShown(i);
      if (i >= steps.length) clearInterval(t);
    }, 280);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.id, steps.length]);

  if (steps.length === 0) return null;

  return (
    <Card title="Agent reasoning (live trace)">
      <div className="space-y-2 font-mono text-[13px]">
        {steps.slice(0, shown).map((s, i) => {
          const ic = ICON[s.outcome] ?? ICON.info;
          return (
            <div key={i} className="flex gap-2 items-start" style={{ animation: "fadeIn 0.3s ease" }}>
              <span className={`${ic.color} shrink-0`}>{ic.glyph}</span>
              <div>
                <span className="text-slate-200">{s.step}</span>
                <span className="text-slate-500"> — {s.detail}</span>
              </div>
            </div>
          );
        })}
        {shown < steps.length && <div className="text-slate-600 animate-pulse">▌ thinking…</div>}
      </div>
      <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(3px);} to { opacity: 1; transform: none;} }`}</style>
    </Card>
  );
}
