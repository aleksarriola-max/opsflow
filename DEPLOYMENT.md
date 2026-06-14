# Going live — hosted app + real domain

The backend now serves the built frontend from one process, so production is a single service: build frontend → start backend → done. The Dockerfile does both.

## Option A — Render (free tier, ~15 min)

1. Push this repo to GitHub (`git init && git add -A && git commit -m "OpsFlow" && gh repo create ...` or via the website).
2. render.com → New → Web Service → connect the repo.
3. Environment: **Docker** (it auto-detects the Dockerfile). Instance: free.
4. Env vars (optional): `ANTHROPIC_API_KEY` (real LLM parsing), `SUI_MODE`, `VETO_WINDOW_MS=45000`.
5. Deploy. You get `https://opsflow.onrender.com` — open it, hit "Seed demo data".

Note: free tier sleeps after idle; first load takes ~30s. For demo day, either upgrade ($7/mo) or open the site 5 minutes before presenting.

## Option B — Railway (~10 min, ~$5 credit)

railway.app → New Project → Deploy from GitHub repo → it detects the Dockerfile → set env vars → deploy. Faster cold starts than Render free.

## Custom domain (~$10/yr)

Buy a domain (Namecheap/Cloudflare — e.g. `opsflow.app`, `getopsflow.xyz`). In Render/Railway: Settings → Custom Domains → add it → set the CNAME they give you at your registrar. HTTPS is automatic. A real domain in the submission reads "product", not "hackathon project".

## Walletless approvals (zkLogin)

Approvers can sign in with Google instead of holding a Sui wallet, via [Enoki](https://docs.enoki.mystenlabs.com/)
(zkLogin + sponsored gas). This is optional and off by default.

1. Create an Enoki app (mysten Enoki portal) and a Google OAuth client; add the
   frontend's origin as an authorized redirect.
2. Set in the frontend environment: `VITE_ENOKI_API_KEY`, `VITE_GOOGLE_CLIENT_ID`,
   and optionally `VITE_SUI_NETWORK` (default `testnet`) — see `frontend/.env.example`.
3. Deploy to testnet/mainnet (`SUI_MODE=testnet|mainnet`) and run
   `backend/scripts/setupSui.ts`; ensure `SUI_ADMIN_CAP_ID` is included in the
   backend `.env` (needed for registering members).
4. In **Policy & Budgets**, a finance-admin registers the approver's zkLogin
   address (role `approver` or `finance-admin`) via "Register org member".
5. That approver clicks "Sign in with Google (zkLogin)" in the sidebar, then
   "Act as this address" — their Approve/Reject on a request now signs
   `workflow::approve`/`reject` directly from the browser, with Enoki
   sponsoring gas.

Leaving the env vars unset keeps the app exactly as it was: no zkLogin UI, and
approvals continue to be signed server-side by the two configured wallets.

## Paying vendors in USDC instead of SUI

`workflow::execute`/`agent_cap::execute_autonomous` are generic over `Coin<T>`, so
vendor payouts aren't tied to native SUI.

1. Set `SUI_PAYMENT_COIN_TYPE=<package>::usdc::USDC` (the USDC coin type on your
   target network) and `SUI_PAYMENT_COIN_DECIMALS=6` in the backend `.env`.
2. The agent wallet (`SUI_SECRET_KEY`) must own coins of that type — `chain.execute`
   sources the payment from the agent's owned USDC coins (merging multiple coin
   objects if needed) instead of splitting from the gas coin.
3. Demo amounts still map via `toBaseUnits()`; with 6-decimal USDC this is a 1:1
   mapping (1 demo-unit = 1 micro-USDC), matching the existing "keep amounts tiny"
   philosophy used for SUI.

Leaving `SUI_PAYMENT_COIN_TYPE` unset keeps the app exactly as it was: payments split
from the gas coin in SUI, and the receipt shows "SUI" as the currency.

## Demo hygiene

- `POST /api/reset` restores the entire system to seed state (budgets, policy, AgentCap, circuit breaker, zero requests) — re-run the demo as many times as you want: `curl -X POST https://yourdomain/api/reset`
- Set `VETO_WINDOW_MS=20000` for stage demos so the veto countdown fits the pacing.
- State is in-memory: a service restart also resets everything (acceptable for the hackathon; persistence is on the BUILD_SPEC roadmap).

## Checklist to "finished"

- [ ] Move package deployed to testnet (`move/deploy.ps1`), one real tx digest in hand
- [ ] App hosted with a public URL
- [ ] Custom domain mapped
- [ ] Demo rehearsed twice end-to-end (DEMO.md), reset between runs
- [ ] 3-minute backup video recorded (screen capture of the live site)
- [ ] DeepSurge submission filled from PITCH.md, with: live URL, repo link, video link, testnet package ID + explorer link
- [ ] Submitted BEFORE June 20
