# OpsFlow — the first AI agent with self-enforcing safety

**One line:** An AI operations agent that handles procurement and payouts under team-defined policy — and whose authority, restraint, and reasoning are all onchain objects on Sui.

## The problem

Team spending is fragmented across chat, spreadsheets, invoices, and follow-up. Approvals stall, policy lives in someone's head, and nobody can prove *why* a payment happened. Meanwhile, every "AI agent with a wallet" demo terrifies the exact finance people who would buy it.

## The insight

The blocker for agentic finance isn't capability — it's trust. So we built trust as the product:

1. **The LLM proposes; deterministic code disposes.** Intent parsing and policy authoring use AI; every state transition, policy check, and dollar moved goes through deterministic rules mirrored by Move `assert!`s.
2. **The agent's autonomy is an object, not a setting.** `AgentCap` — a revocable Sui object granting the agent ≤$X/request, $Y/day. Same pattern Mastercard Agent Pay and Coinbase Agentic Wallets shipped in 2026, but composed natively with the rest of the workflow graph.
3. **The agent polices itself.** Three incidents in ten minutes and it revokes its *own* AgentCap and waits for a human. An independent auditor agent must agree with every plan before a human is even asked (AI maker-checker).
4. **The chain proves why, not just that.** Every receipt carries a hash of the parsed intent + fired rules + plan + approvals. Every audit trail exports as a hash chain.

## What it does (live demo)

NL request → agent reasoning streams live → policy rules + anomaly checks (vendor trust, amount deviation, duplicate payments, **threshold structuring**) → auto-approve & autonomous execution under AgentCap, or routed to approvers → high-risk payments wait in a **veto window** with a countdown → execution on Sui with reasoning-hash receipt → blocked requests get computed **paths to yes**. Admins write policy in English, preview the deterministic diff, and see it **backtested against history** before signing. Ask the agent "why was this blocked?" and it answers from the audit trail — never from imagination.

The agent's vendor trust isn't binary: a first-time payee carries the most scrutiny, but that risk decays as the agent builds an executed track record with each vendor — after three clean payments the "new vendor" flag disappears entirely. The Policy & Budgets view also renders the org's live Sui object graph — Org → PolicySet → AgentCap → BudgetBuckets — each box a real testnet object with an Explorer link, so judges can click straight through to the chain.

## Why Sui specifically

Workflows are shared objects with strict lifecycle transitions. Policy, budgets, approvals, receipts, and the agent's own authority are composable objects linked into one graph. Execution is one atomic PTB: budget debit + payment + receipt + state change, all-or-nothing. This isn't "blockchain for payments" — Sui's object model *is* the coordination layer.

## Engineering evidence

4 Move modules (Org/roles, PolicySet/BudgetBucket, WorkflowRequest state machine, AgentCap), deployed live on Sui testnet. Node/TS backend: deterministic policy engine, 13-state transition table, anomaly engine, auditor pass, NL policy compiler with backtest. React frontend: 6 screens incl. live reasoning stream, approval inbox, exceptions/recovery, and a Sui object-graph visualization with Explorer links. zkLogin (walletless approvals via Enoki) and USDC payouts (`Coin<T>`-generic `workflow::execute`) are both shipped. **84-check end-to-end suite** covering self-approval blocks, structuring detection, circuit-breaker trips, veto windows, hash-chain tamper detection, and graduated vendor trust. TypeScript-clean on both sides.

## Roadmap

Testnet → mainnet (architecture is wired; chain layer maps 1:1 to Move entry points). Next: recurring workflows, multi-team workspaces. The category: **autonomous operations infrastructure** — the operating layer where AI agents do the work and the chain holds the leash.
