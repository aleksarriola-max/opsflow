import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * SQLite persistence for the in-memory demo state.
 *
 * - `requests`: one row per WorkflowRequest, JSON-serialized (mirrors the
 *   onchain Move struct shape — see types.ts).
 * - `kv`: small mutable singletons (policy, agentCap, circuitBreaker,
 *   bucket spend, id counter) so a server restart resumes where it left off.
 * - `chain_events` / `indexer_cursor`: raw events fetched by indexer.ts from
 *   the deployed Move package (testnet/localnet only).
 *
 * Tests run with NODE_ENV=test (set by vitest) and get a fresh in-memory
 * database so the demo DB on disk is never touched by the suite.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.OPSFLOW_DB_PATH
  ?? (process.env.NODE_ENV === "test" ? ":memory:" : path.resolve(here, "../data/opsflow.db"));

if (DB_PATH !== ":memory:") fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id TEXT NOT NULL,
    module TEXT NOT NULL,
    event_type TEXT NOT NULL,
    tx_digest TEXT NOT NULL,
    event_seq TEXT NOT NULL,
    data TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS indexer_cursor (
    package_id TEXT NOT NULL,
    module TEXT NOT NULL,
    tx_digest TEXT,
    event_seq TEXT,
    PRIMARY KEY (package_id, module)
  );
`);

export function loadKv<T>(key: string): T | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}

export function saveKv(key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value));
}
