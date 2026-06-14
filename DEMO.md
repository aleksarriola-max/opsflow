# Demo script (~5 minutes)

**Before every run:** `curl -X POST <url>/api/reset` then click "Seed demo data" — the whole system returns to a pristine state (budgets, policy, AgentCap, circuit breaker). Rehearse as many times as you want.


**Ask-the-agent moment (use during any pause):** on a blocked or pending request, click a suggested question like "Why was this blocked?" — the agent answers from the audit trail and shows exactly which recorded facts it used. Line: *"It can't hallucinate an excuse — every answer cites the rules that fired."*

Persona switcher is in the sidebar — it simulates different wallets/roles.

**The closer — agent self-suspension (do this last, it's the mic drop):**
Trigger three bad requests in a row (the two seeded blocked ones count if recent; otherwise submit ShadyVendor payments). On the third incident, a red banner appears everywhere: *"⚡ Agent self-suspended (circuit breaker)"* — the agent has revoked its own AgentCap and explains why in its reasoning trace. Submit a tiny $40 request: it auto-approves but *waits for a human*. Then re-issue authority in Policy & Budgets. Line for the judges: *"We didn't just put guardrails around the AI — we built an AI that pulls its own emergency brake."*

**Structuring detection (during step 5):** submit three $200 Figma requests back-to-back. The first gets through; the second is flagged as a possible duplicate; a third gets flagged `threshold-structuring` and the cluster escalates to human approval. *"We red-teamed our own auto-approve rule — splitting payments to dodge thresholds doesn't work here."*

**Veto window (after the approval step):** approve a $2,500 dual-approval contractor invoice, hit Execute — instead of paying, a countdown appears: *"high-risk payment, 45s challenge window, funds have not moved."* Veto it as Carol at the 10-second mark. *"Even after two humans said yes, the system still gives them a last chance to say no."*

**Policy backtesting (during the NL policy moment):** when you preview "auto approve up to $300", the diff now includes a backtest: *"2 of your 11 historical requests would have changed outcome."* You're not editing rules blind — every change comes with evidence.

**Duplicate catch (anywhere):** submit the same Figma payment twice. The second is flagged "possible-duplicate" from vendor payment memory and held for approval. Every ops person in the room has been burned by this exact mistake.

**Audit export (closing beat):** on an executed request, click "Export verifiable audit (JSON)" — a hash-chained file where each event commits to all prior history. *"Hand your auditor a proof, not a screenshot."*

**New killer moments to include:**

- **Autonomous execution (after step 1):** open seeded req-0001 (Notion $96). It was approved AND executed by the agent itself — receipt shows "🤖 autonomous (AgentCap)". Then go to Policy & Budgets → **Revoke** the AgentCap → create another small request → it now waits for a human. Say: *"The agent's autonomy is a revocable onchain object, not a config flag."*
- **Reasoning stream (during step 2):** the request detail page plays the agent's decision trace live — parse, each policy rule, anomaly checks, auditor verdict, routing decision.
- **NL policy authoring (before step 5):** in Policy & Budgets, type *"Auto approve anything up to $300"* → diff preview shows $250→$300 with plain-language consequences → apply as Bob (finance-admin). Resubmit the $300 Figma request — it now auto-approves. *"We changed the rules in English; the diff was deterministic; an admin signed."*
- **Path to yes (during step 5):** the blocked ShadyVendor request shows agent-computed counterfactuals — the agent negotiates instead of refusing.
- **Reasoning hash (step 4):** point at the receipt's reasoning hash. *"The chain doesn't just prove the money moved — it proves why."*
- **Vendor trust builds over time (anywhere):** submit a request to a vendor with no payment history — anomalies show `first-time-vendor` at full weight. Execute it, then submit a second request to the same vendor — the flag downgrades to `limited-vendor-history` at half weight. After three clean executions, the flag disappears entirely. *"The agent isn't permanently paranoid — it earns trust in a vendor the same way a new hire earns autonomy, and every step of that is visible in the anomaly trace."*
- **Onchain object graph (during step 6 / close):** in Policy & Budgets, point at the **Onchain object graph** card at the top — Org, PolicySet, AgentCap, and every BudgetBucket are real objects on Sui testnet, each linking out to Sui Explorer. *"This isn't a database with a blockchain bolted on for the demo — click any box and you're looking at the actual onchain object."*
- **Dashboard at a glance (opening):** before clicking anything, the dashboard's budget-allocation donut and request-pipeline bar chart give judges an instant read on system state — spend by category, and how many requests are pending/executed/exception right now.

## Core walkthrough

1. **Problem (20s).** "Team ops are fragmented across chat, spreadsheets, and treasury tools. OpsFlow is an AI agent that runs procurement under policy, with approvals and execution on Sui."
2. **NL intake (40s).** As *Alice (PM)*, New Request → natural language: *"Purchase three monthly software seats from Figma for our design team. Total budget is $300 monthly."* Submit. Show the parsed fields, the reasoning stream, and the policy evaluation: $300 > $250 auto-approve threshold → **PendingApproval**, one approver required.
3. **Approval (30s).** Switch to *Carol (Approver)* → Approval Inbox → Approve. Note: Alice cannot self-approve, Dave (executor) can't approve — role checks mirror the onchain `MemberRole` assertions.
4. **Onchain execution (40s).** Switch to *Dave (Executor)* → request detail → **Execute payment on Sui**. Show the receipt with tx digest + reasoning hash, the budget debit on the dashboard, and the audit timeline.
5. **Graceful failure (60s).** Blocked vendor, budget exhaustion, simulated chain failure → Failed → Retry → Executed. Nothing is ever silently lost.
6. **Close (20s).** Policy & Budgets: thresholds, buckets, roles, AgentCap, circuit breaker — all Sui objects. "The LLM proposes; deterministic code and Move contracts decide. That's what makes an agent safe enough to hold a treasury."

Sui-native claims to say out loud: shared-object workflow state, strict lifecycle transitions enforced with `assert!`, composable objects linking policy → budget → approval → receipt → agent authority, and atomic execution (budget debit + payment + receipt in one transaction).
