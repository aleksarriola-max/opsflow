# OpsFlow — Autonomous Procurement & Ops OS on Sui

A policy-bound AI operations agent: natural-language requests become stateful Sui workflows with deterministic policy checks, human approvals, onchain execution, and a verifiable audit trail.

**Golden rule:** the LLM proposes; only deterministic code approves state transitions and executes money movement.

## Headline features

- **Circuit breaker — an agent that suspends itself.** If 3 incidents (policy blocks, chain failures, auditor disagreements, rejections) occur within 10 minutes, the agent revokes its *own* AgentCap, records the self-suspension in its reasoning trace, and waits for an admin to re-issue authority. Safety isn't imposed on the agent — the agent enforces it on itself.
- **Structuring detection (anti-smurfing).** Repeated sub-threshold payments to the same vendor are detected as a cluster and escalated — closing the classic exploit against our own auto-approve rule.
- **AgentCap — agent authority as an onchain object.** The AI may autonomously execute requests only within an admin-issued, revocable Sui capability (per-request max + daily limit). Revoke it and autonomy stops instantly.
- **Natural-language policy authoring.** Admins write rules in English; the system compiles a deterministic policy patch, shows a diff preview with plain-language effects, and nothing changes until a finance-admin signs.
- **Live agent reasoning stream.** Every decision renders as an animated step-by-step trace: parse → policy rules → anomaly checks → auditor verdict → routing.
- **Anomaly-based risk escalation.** First-time vendors, amount deviations vs. history, velocity spikes, urgency-pressure patterns — anomalies raise approval tiers, never lower them.
- **AI maker-checker.** An independent auditor pass re-derives every decision; disagreement escalates to humans before anyone is asked to approve.
- **Counterfactual "path to yes."** Blocked or pending requests come with computed alternatives: reduce amount, switch bucket, add approvers, allowlist vendor.
- **Verifiable reasoning receipts.** Each execution receipt anchors a sha256 of intent + fired rules + plan + approvals — the chain proves *why* money moved.
- **Budget burn forecasting.** "At current pace, Software exhausts on Sep 1."
- **Policy backtesting.** Every NL policy change is backtested against your request history before applying: "this would have changed 2 of your last 11 outcomes." Evidence, not vibes.
- **Policy simulator.** Dry-run any hypothetical request against current policy — creates nothing, shows outcome + path to yes.
- **Optimistic execution with veto window.** High-risk approved payments wait in a timed challenge window (countdown in the UI); any approver can veto with one click before funds move.
- **Duplicate-payment detection.** "Figma was already paid $300 on the 4th — this looks like a double payment." Built on per-vendor payment memory (vendor intelligence view).
- **Verifiable audit export.** One-click hash-chained JSON export of any request's full history — tamper with one event and every later hash breaks.
- **Ask the agent.** Natural-language Q&A on any request ("why was this blocked?", "show me the proof") answered deterministically from the recorded rules, anomalies, and receipts — every answer lists what it's grounded in.

## Structure

```
move/       Sui Move package: Org, MemberRole, PolicySet, BudgetBucket,
            WorkflowRequest, ApprovalRecord, ExecutionReceipt (w/ intent hash),
            ExceptionRecord, AgentCap (autonomous authority + epoch limits)
backend/    Node/TS: policy engine, strict state machine, anomaly detection,
            maker-checker auditor, counterfactuals, NL policy compiler,
            LLM intent parser (heuristic fallback), Sui layer (mock or real)
frontend/   React/Vite: dashboard w/ burn forecasts, NL + form intake,
            reasoning stream, approval inbox, NL policy admin + AgentCap
            controls, exceptions & recovery, audit timeline
```

See **BUILD_SPEC.md** for the full handoff document (architecture invariants, repo map, API routes, next work).

## Run the demo

```bash
# Terminal 1
cd backend && npm install && npm run dev     # http://localhost:4000

# Terminal 2
cd frontend && npm install && npm run dev    # http://localhost:5173
```

Open http://localhost:5173, click **Seed demo data** in the sidebar.

- Optional: set `ANTHROPIC_API_KEY` before starting the backend to use Claude for intent parsing. Without it, a deterministic heuristic parser runs — the demo never depends on network.
- `SUI_MODE=mock` (default) simulates chain calls with realistic digests. Tests in `backend/test/`.

## Workflow states

Draft → Submitted → PendingPolicyCheck → (PendingClarification | PendingApproval | Approved | Escalated) → ScheduledForExecution → Executing → (Executed → Closed | Failed → Retry/Escalate). Transitions are enforced by a strict table offchain and `assert!`s onchain.

## Policy model

- ≤ $250: auto-approved. > $250: one approver. ≥ $2,000: two approvers. > $10,000: hard-blocked.
- Vendor denylist/allowlist, category allowlist, budget-bucket headroom — all evaluated deterministically and mirrored in Move (`policy::required_approvals`, `policy::record_spend`).
- No self-approval, no duplicate approvals, role-gated execution — enforced in both layers.

## Deploying the Move package (testnet)

```bash
# Install Sui CLI: https://docs.sui.io/guides/developer/getting-started/sui-install
cd move
sui move build
sui client publish --gas-budget 200000000
```

Windows: see `move/deploy.ps1`. After publishing, run `backend/scripts/setupSui.ts` to create the Org/PolicySet/BudgetBuckets/AgentCap and print the full `.env` block (`SUI_MODE`, `SUI_PACKAGE_ID`, `SUI_SECRET_KEY`, `SUI_APPROVER_SECRET_KEY`, `SUI_ORG_ID`, `SUI_POLICY_ID`, `SUI_AGENT_CAP_ID`, `SUI_BUCKET_<CATEGORY>_ID`). Two wallets are required: `workflow::approve` forbids the requester from approving its own request, so approvals are signed by a second wallet. Every backend chain call maps 1:1 to a Move entry function (see `backend/src/sui.ts`). Drop the printed block into `backend/.env` — `npm run dev`/`start` load it automatically (`tsx --env-file-if-exists=.env`).

### Testing against a local network

No faucet, no waiting: run a local Sui network and point the same `SUI_MODE=testnet` code at it via `SUI_RPC_URL`.

```bash
sui genesis -f --with-faucet --working-dir <dir>
sui start --network.config <dir> --with-faucet   # RPC on :9000, faucet on :9123
cd move && sui client test-publish --gas-budget 200000000 --build-env testnet --json
```

Then set `SUI_SECRET_KEY`/`SUI_APPROVER_SECRET_KEY` to two local wallets' `sui keytool export` keys, `SUI_PACKAGE_ID` to the published package id, add `SUI_RPC_URL=http://127.0.0.1:9000`, and run `setupSui.ts` as above (also with `SUI_RPC_URL` set) to get the rest of the `.env` block.

## Tests

```bash
cd backend && npm install && npm test        # vitest: 69 tests (unit + e2e, SUI_MODE=mock)
```

CI (`.github/workflows/ci.yml`) runs the backend test suite plus `tsc --noEmit` for both
packages and the frontend production build on every push/PR.

`test/e2e.test.ts` covers: thresholds, denylist, caps, state machine legality, parser, full approve→execute loop, self-approval block, autonomous execution under AgentCap, revocation, structuring detection, circuit breaker trips, veto windows (veto, elapse, cancel-defuse), backtesting, duplicate detection, hash-chain tamper detection, and grounded Q&A.
