import { db } from "./db.js";
import { chain, getEventClient } from "./sui.js";
import type { EventCursor, SuiEvent } from "./sui.js";

/**
 * Onchain event indexer (testnet/mainnet only — no-op in SUI_MODE=mock).
 *
 * Polls `queryEvents` per Move module and appends new events to
 * `chain_events`, tracking a per-(package, module) cursor in
 * `indexer_cursor` so restarts resume rather than re-scan from genesis.
 * Read back via `recentEvents()` / `GET /api/chain-events`.
 */

const MODULES = ["workflow", "agent_cap", "org", "policy"] as const;
const POLL_MS = Number(process.env.INDEXER_POLL_MS ?? 5000);

function loadCursor(packageId: string, module: string): EventCursor | null {
  const row = db
    .prepare("SELECT tx_digest, event_seq FROM indexer_cursor WHERE package_id = ? AND module = ?")
    .get(packageId, module) as { tx_digest: string | null; event_seq: string | null } | undefined;
  if (!row || row.tx_digest === null || row.event_seq === null) return null;
  return { txDigest: row.tx_digest, eventSeq: row.event_seq };
}

function saveCursor(packageId: string, module: string, cursor: EventCursor): void {
  db.prepare(
    `INSERT INTO indexer_cursor (package_id, module, tx_digest, event_seq) VALUES (?, ?, ?, ?)
     ON CONFLICT(package_id, module) DO UPDATE SET tx_digest = excluded.tx_digest, event_seq = excluded.event_seq`,
  ).run(packageId, module, cursor.txDigest, cursor.eventSeq);
}

function storeEvent(packageId: string, module: string, ev: SuiEvent): void {
  db.prepare(
    `INSERT INTO chain_events (package_id, module, event_type, tx_digest, event_seq, data, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(packageId, module, ev.type, ev.id.txDigest, ev.id.eventSeq, JSON.stringify(ev.parsedJson ?? {}), new Date().toISOString());
}

async function pollModule(client: NonNullable<Awaited<ReturnType<typeof getEventClient>>>["client"], packageId: string, module: string): Promise<void> {
  const cursor = loadCursor(packageId, module);
  const page = await client.queryEvents({
    query: { MoveModule: { package: packageId, module } },
    cursor,
    order: "ascending",
    limit: 50,
  });
  for (const ev of page.data) storeEvent(packageId, module, ev);
  const last = page.data[page.data.length - 1];
  if (last) saveCursor(packageId, module, last.id);
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start polling for onchain events. Safe to call in mock mode (no-op). */
export function startIndexer(): void {
  if (chain.mode === "mock" || timer) return;
  const tick = async () => {
    const ec = await getEventClient();
    if (!ec) return;
    for (const module of MODULES) {
      try {
        await pollModule(ec.client, ec.packageId, module);
      } catch (e) {
        console.error(`indexer: ${module} poll failed:`, (e as Error).message);
      }
    }
  };
  timer = setInterval(tick, POLL_MS);
  void tick();
}

export function stopIndexer(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function recentEvents(limit = 100): unknown[] {
  const rows = db
    .prepare("SELECT package_id, module, event_type, tx_digest, event_seq, data, observed_at FROM chain_events ORDER BY id DESC LIMIT ?")
    .all(limit) as { package_id: string; module: string; event_type: string; tx_digest: string; event_seq: string; data: string; observed_at: string }[];
  return rows.map((r) => ({
    packageId: r.package_id,
    module: r.module,
    eventType: r.event_type,
    txDigest: r.tx_digest,
    eventSeq: r.event_seq,
    data: JSON.parse(r.data),
    observedAt: r.observed_at,
  }));
}
