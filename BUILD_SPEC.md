# BUILD_SPEC — Handoff document for Claude Code

This repo is a **working application**, not a starting spec. Everything below exists and is verified (76 vitest cases passing, frontend builds clean). Your job is to extend it, not rebuild it.

## What this is

**OpsFlow** — a policy-bound AI operations agent for the Sui Overflow 2026 Agentic Web track. Natural-language procurement/payout requests become stateful Sui workflows with deterministic policy checks, human approvals, autonomous execution under bounded onchain authority, and a verifiable audit trail.

## Architecture invariants — NEVER break these

1. **The LLM proposes; deterministic code disposes.** LLM output (intent parsing, policy compilation, Q&A rephrasing) is always a *proposal*. State transitions, policy evaluation, approvals, and money movement go through deterministic code only (`policyEngine.ts`, `stateMachine.ts`, `store.ts:agentCapAllows`) mirrored by Move `assert!`s.
2. **The state machine is strict.** All transitions go through `setState()` → `assertTransition()`. Never mutate `req.state` directly. The transition table in `stateMachine.ts` mirrors `workflow.move`.
3. **Anomalies only escalate scrutiny, never relax it** (`escalateForAnomalies`).
4. **The agent's autonomy is bounded by AgentCap** (per-request max, daily limit, revocable). Autonomous execution happens only via the AgentCap check in `orchestrator.ts:runPolicyCheck` → `executeInternal(req, "agent")`.
5. **Maker-checker:** the auditor pass (`intelligence.ts:auditorReview`) must agree before a request proceeds; disagreement → `Escalated` with `AUDITOR_DISAGREEMENT`.
6. **Every execution receipt carries `reasoningHash`** (sha256 of intent + fired rules + plan + approvals), computed BEFORE execution so it can travel onchain as `intent_hash`.
7. **The circuit breaker is sacred.** Every exception path must call `reportIncident()` (orchestrator.ts). 3 incidents in 10 min → the agent revokes its own AgentCap (`store.ts:recordIncident`). Re-issuing authority (`POST /api/agent-cap {revoked:false}`) clears the breaker. New failure modes you add MUST report incidents.
8. **Structuring detection** (`intelligence.ts`): clusters of ≥3 same-vendor sub-threshold requests with cumulative > 2× autoApproveMax escalate. Don't weaken thresholds without updating tests.
9. **Veto window** (`orchestrator.ts:executeInternal`): risk ≥ 60 or dual-approval payments wait `vetoConfig.windowMs` (default 45s, env `VETO_WINDOW_MS`) before `finishExecution`; `veto()` cancels the timer and escalates with `VETOED` (+ incident). Retries and autonomous (AgentCap) executions skip the window by design. `cancel()` defuses pending timers.
10. **Audit exports are hash chains** (`intelligence.ts:buildAuditExport/verifyAuditExport`): every timeline event commits to all prior history. New event kinds are fine; never rewrite past timeline entries.
11. **Backtests accompany policy proposals** (`POST /api/policy/propose` includes `backtest`): keep this when changing the authoring flow.
12. **Ask-the-agent answers are grounded** (`askAgent.ts`): built only from recorded decision data; the optional LLM pass may rephrase but never add facts.

## Repo map

```
move/sources/
  org.move        Org (shared), AdminCap, member roles + role checks
  policy.move     PolicySet, BudgetBucket (shared), required_approvals(), record_spend()
  workflow.move   WorkflowRequest state machine, approve/reject/execute (atomic:
                  budget debit + payment + receipt incl. intent_hash), exceptions
  agent_cap.move  AgentCap: the agent's revocable onchain spending authority;
                  execute_autonomous() with per-request + per-epoch caps
  deploy.sh / deploy.ps1   testnet publish scripts (bash / Windows PowerShell)

backend/src/
  types.ts            All shared types
  stateMachine.ts     Strict transition table (single source of truth offchain)
  policyEngine.ts     Deterministic rule evaluation -> PolicyEvaluation
  intelligence.ts     Anomaly detection (incl. structuring + duplicates),
                      escalateForAnomalies, pathToYes (counterfactuals),
                      auditorReview (maker-checker), forecastBurn, backtestPolicy,
                      buildAuditExport/verifyAuditExport, vendorIntel, reasoningHash
  policyAuthoring.ts  NL -> policy patch (LLM w/ heuristic fallback) + diff + apply
  askAgent.ts         Grounded Q&A: answers built only from recorded decision
                      data (rules, anomalies, receipts); optional LLM rephrase
  intentParser.ts     NL -> structured request (LLM w/ heuristic fallback)
  orchestrator.ts     The agent: createRequest -> parse -> policy -> anomalies ->
                      auditor -> route (clarify / approve / autonomous execute);
                      veto windows, circuit-breaker incident reporting
  sui.ts              Chain layer; SUI_MODE=mock|testnet|mainnet; real calls via
                      @mysten/sui dynamic import (install before enabling)
  db.ts               node:sqlite (DatabaseSync) — requests, kv (singletons),
                      chain_events/indexer_cursor tables; :memory: under vitest
  store.ts            State incl. agentCap, circuitBreaker, vetoConfig, backed by
                      db.ts (RequestStore + persistState/loadState)
  indexer.ts          Onchain event indexer (testnet/mainnet only; no-op in mock):
                      polls queryEvents per Move module into chain_events
  index.ts            Express API (see routes below)

frontend/src/  (React + Vite + Tailwind CDN, proxy /api -> :4000)
  views/Dashboard      stats, budget bars + burn forecasts, attention list
  views/NewRequest     NL + structured intake
  views/RequestDetail  actions, reasoning stream, veto countdown, path-to-yes,
                       policy rules + anomalies, maker-checker, receipt
                       (reasoningHash), ask-the-agent, audit export, timeline,
                       zkLogin-signed approve/reject (useZkApprove)
  views/Approvals      inbox with risk scores
  views/Policies       NL policy authoring w/ diff + backtest, simulator,
                       AgentCap + circuit breaker, vendor intelligence,
                       thresholds, buckets, roles, register org member (zkLogin)
  views/Exceptions     failed/escalated + retry/escalate/cancel
  components/ReasoningStream  animated agent trace
  zk/provider.tsx      ZkProvider (dapp-kit + Enoki), ZK_ENABLED gate
  zk/useZkApprove.ts   builds + signs workflow::approve/reject client-side
```

## API routes

`GET /api/meta` (incl. agentCap + circuitBreaker), `GET /api/forecast`, `GET /api/vendors/intel`,
`GET /api/chain-events[?limit=]` (indexed onchain events; empty in mock mode),
`GET /api/requests[/:id]`, `GET /api/requests/:id/audit-export`,
`POST /api/requests` `{requester, naturalLanguage | structured}`,
`POST /api/requests/:id/(clarify|approve|reject|execute|veto|retry|escalate|cancel|close|ask)`,
`POST /api/policy/propose` `{instruction}` (returns diff + backtest), `POST /api/policy/apply` `{patch, by}` (finance-admin only),
`POST /api/policy/dryrun` `{category, amount, vendorName}`,
`POST /api/agent-cap` `{by, maxPerRequest?, dailyLimit?, revoked?}` (finance-admin only; revoked:false clears breaker),
`POST /api/org/members` `{by, address, name, role}` (finance-admin only — registers a member onchain via `org::set_member_role`, e.g. a zkLogin approver address),
`POST /api/seed`, `POST /api/reset` (full demo reset to seed state).

`POST /api/requests/:id/(approve|reject)` accept an optional `txDigest` — if present (the frontend already signed + executed `workflow::approve`/`reject` itself via zkLogin/Enoki), the backend records that digest instead of re-signing onchain. `GET /api/meta` includes `chainConfig: {packageId, orgId} | null` (null in mock mode) so the frontend can build that transaction.

**Production mode:** if `frontend/dist` exists (or `FRONTEND_DIST` is set), the backend serves the SPA from the same process — one URL, one deploy. See Dockerfile + DEPLOYMENT.md.

## Env

- `ANTHROPIC_API_KEY` (optional): Claude for intent parsing, policy compilation, Q&A polish; heuristics otherwise.
- `SUI_MODE=mock|testnet|mainnet` (default mock). Real modes need `npm i @mysten/sui`, `SUI_PACKAGE_ID`, `SUI_SECRET_KEY` (agent wallet), `SUI_APPROVER_SECRET_KEY` (second wallet — `workflow::approve` forbids self-approval), `SUI_ORG_ID`, `SUI_POLICY_ID`, `SUI_AGENT_CAP_ID`, `SUI_BUCKET_<CATEGORY>_ID`. Run `backend/scripts/setupSui.ts` after publish to create these objects and print the block.
- `VETO_WINDOW_MS` (default 45000).
- `OPSFLOW_DB_PATH` (default `backend/data/opsflow.db`; `:memory:` automatically under vitest). `INDEXER_POLL_MS` (default 5000) — onchain event indexer poll interval (testnet/mainnet only).
- `SUI_ADMIN_CAP_ID` (optional, real modes only): AdminCap object id from `create_org`, owned by the agent wallet. Required for `chain.setMemberRole()` / `POST /api/org/members`. Printed by `backend/scripts/setupSui.ts` alongside the other object IDs.
- `SUI_PAYMENT_COIN_TYPE` (optional, default `0x2::sui::SUI`) and `SUI_PAYMENT_COIN_DECIMALS` (optional, default `9`): the `Coin<T>` vendors are paid in via `workflow::execute`/`agent_cap::execute_autonomous`. SUI payments split from the gas coin as before; any other type is sourced from coins of that type owned by the agent wallet (`getCoins`/`mergeCoins`). For USDC (6 decimals), set both — e.g. `SUI_PAYMENT_COIN_TYPE=0x...::usdc::USDC SUI_PAYMENT_COIN_DECIMALS=6`.
- Frontend `VITE_ENOKI_API_KEY` + `VITE_GOOGLE_CLIENT_ID` (optional, see `frontend/.env.example`): enable walletless zkLogin approvals via Enoki. Unset (default) -> identical behavior to before, no zkLogin UI. `VITE_SUI_NETWORK` (default `testnet`).

## Verification

- `backend/test/e2e.test.ts` — 53 vitest cases covering the full product loop (SUI_MODE=mock, no chain dependency), alongside `policyEngine.test.ts` (14) and `sui.test.ts` (17) — 84 total. Run: `cd backend && npm test`.
- Frontend: `npx tsc --noEmit && npm run build`. Backend also type-checks clean: `npx tsc --noEmit` (pin `@types/express@4`). Frontend type-checks and builds clean both with and without `VITE_ENOKI_API_KEY`/`VITE_GOOGLE_CLIENT_ID` set.
- `.github/workflows/ci.yml` runs both on every push/PR (backend tsc+test, frontend tsc+build).
- Keep this suite green after every change. Extend it for new features.

## Known gaps / next work (priority order)

1. **Testnet deployment**: run `move/deploy.ps1` (Windows) or `deploy.sh`, then `backend/scripts/setupSui.ts` to create Org/PolicySet/BudgetBuckets/AgentCap and print the `.env` block. All chain calls (submit/evaluate_policy/approve/reject/execute/execute_autonomous/cancel) are wired in `sui.ts` with a 2-wallet signer model and verified against a mocked SDK (`backend/test/sui.test.ts`). Demo amounts map to the payment coin's base units via `toBaseUnits()` (default 1 unit = 0.000001 SUI = 1000 MIST; see `SUI_PAYMENT_COIN_TYPE`/`SUI_PAYMENT_COIN_DECIMALS` in Env) — adjust before real money. **Verified end-to-end against a local `sui start --with-faucet` network** (set `SUI_RPC_URL=http://127.0.0.1:9000` alongside `SUI_MODE=testnet` to point the same code at localnet): full demo seed submits + evaluates policy onchain, a human approval signs with the second wallet, and `workflow::execute` moves real MIST to the vendor address — all confirmed via `sui client tx-block`. Remaining: fund both wallets on public testnet (faucet was rate-limited at the time) and re-run the same flow with `SUI_RPC_URL` unset.
2. ~~zkLogin + sponsored transactions for walletless approvers (`@mysten/enoki`).~~ — done. Enoki is registered as Wallet-Standard wallets via `@mysten/dapp-kit`'s `registerEnokiWallets()` in `frontend/src/zk/provider.tsx`, gated behind `ZK_ENABLED` (both `VITE_ENOKI_API_KEY` and `VITE_GOOGLE_CLIENT_ID` set). When connected as the acting persona on a non-mock chain, `RequestDetail` uses `useZkApprove` (`frontend/src/zk/useZkApprove.ts`) to build + sign `workflow::approve`/`reject` client-side (Enoki sponsors gas — the zkLogin address never needs SUI), then posts the resulting `txDigest` to `POST /api/requests/:id/(approve|reject)`, which records it on the `ApprovalRecord` instead of re-signing onchain (`orchestrator.ts`). A finance-admin registers a zkLogin address as an org member (role + `can_approve`) via the new "Register org member" form in `Policies.tsx` → `POST /api/org/members` → `chain.setMemberRole` (`org::set_member_role`, signed by the agent wallet holding the `AdminCap`; requires `SUI_ADMIN_CAP_ID`). Unset env vars -> fully inert: `SuiClientProvider`/`WalletProvider` still mount (so dapp-kit hooks never throw) but no wallets are registered, `useCurrentAccount()` is always null, and the app behaves exactly as before. **Not verifiable end-to-end here** — no real Enoki/Google OAuth credentials in this environment; verification covers `tsc`/`vitest`/`vite build` (both with and without the env vars) plus a no-op dev-server smoke test.
3. ~~Persist state (SQLite) + onchain event indexer replacing the in-memory `requests` Map (keep object shapes — they mirror Move structs).~~ — done. `db.ts` (`node:sqlite`/`DatabaseSync`, `:memory:` under vitest) backs `store.ts`: `RequestStore` persists each `WorkflowRequest` (`requests` table) and `persistState()`/`loadState()` round-trip policy/agentCap/circuitBreaker/bucket-spend/id-counter via a `kv` table, called from `index.ts`'s `wrap` middleware so every mutating route persists and a restart resumes exactly where it left off. `indexer.ts` polls `queryEvents` per Move module (workflow/agent_cap/org/policy) into `chain_events` with a per-module cursor in `indexer_cursor` — no-op in `SUI_MODE=mock`, exposed via `GET /api/chain-events`. Requires Node ≥22.5 for `node:sqlite` (CI bumped to Node 24).
4. ~~`vitest` port of e2e.verify.mjs; CI.~~ — done. `backend/test/e2e.test.ts` (45 cases, SUI_MODE=mock) replaces the old standalone script; `.github/workflows/ci.yml` runs backend tsc+test and frontend tsc+build on push/PR.
5. ~~USDC payouts (swap `Coin<SUI>` for a stablecoin type param in Move).~~ — done. `workflow::execute<T>` and `agent_cap::execute_autonomous<T>` are now generic over `Coin<T>` (no more hardcoded `Coin<SUI>`/`use sui::sui::SUI`); the caller picks `T` via the transaction's type arguments. `sui.ts`'s `realCall("execute", ...)` passes `typeArguments: [SUI_PAYMENT_COIN_TYPE]` (default `0x2::sui::SUI`, unchanged behavior — splits from `tx.gas`); any other coin type is sourced via `getCoins`/`mergeCoins`/`splitCoins` against the agent wallet's owned coins of that type. `toMist()` was generalized to `toBaseUnits()`, scaling by `SUI_PAYMENT_COIN_DECIMALS` (default 9, identical to the old 1-unit=0.000001-SUI mapping; USDC's 6 decimals give a 1:1 mapping). `ExecutionReceipt` gained a `currency` field (e.g. "SUI"/"USDC") shown next to the amount in the receipt card. **Not exercised end-to-end here** — no testnet USDC available in any wallet in this environment; verification covers `tsc`/`vitest` (incl. mocked `getCoins`/`mergeCoins` coverage in `sui.test.ts`) and `vite build`.
6. ~~AgentCap UI: editable per-request/daily limits~~ — done. `Policies.tsx`'s "Agent authority" card has an "Edit limits" button (finance-admin only) that swaps the summary for per-request-max/daily-limit inputs and calls `POST /api/agent-cap`; Revoke/Re-issue sit alongside it.

## Demo

See DEMO.md and PITCH.md. The seed (`POST /api/seed`) creates the four demo scenarios: autonomous execution, threshold approval, vendor denylist block, budget exhaustion block.
