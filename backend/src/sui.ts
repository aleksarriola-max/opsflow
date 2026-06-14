import { randomBytes } from "node:crypto";
import type { ExecutionReceipt } from "./types.js";

/**
 * Sui execution layer.
 *
 * SUI_MODE=mock (default): simulates execution with realistic digests so the
 *   full product loop works with zero chain dependencies.
 * SUI_MODE=testnet|mainnet: real execution via @mysten/sui against the
 *   deployed ops_agent Move package. Requires:
 *     npm i @mysten/sui
 *     SUI_PACKAGE_ID=0x...                 (from `sui client publish`)
 *     SUI_SECRET_KEY=suiprivkey...          (agent/requester wallet, bech32)
 *     SUI_APPROVER_SECRET_KEY=suiprivkey... (second wallet, used for approve/reject —
 *                                             workflow::approve forbids the requester
 *                                             from approving its own request)
 *     SUI_ORG_ID / SUI_POLICY_ID / SUI_AGENT_CAP_ID / SUI_BUCKET_<CATEGORY>_ID
 *       (shared/owned object IDs, printed by `move/setup.ts`)
 *     SUI_RPC_URL (optional) overrides the fullnode URL — e.g. point
 *       SUI_MODE=testnet at a local `sui start` network for offline testing.
 *     SUI_ADMIN_CAP_ID (optional) — AdminCap object id, owned by the agent
 *       wallet from `create_org`. Only needed for chain.setMemberRole(),
 *       i.e. registering new org members (e.g. zkLogin approvers).
 *     SUI_PAYMENT_COIN_TYPE (optional, default "0x2::sui::SUI") — the
 *       `Coin<T>` type `workflow::execute`/`agent_cap::execute_autonomous`
 *       pay vendors in. For SUI, the payment is split straight from the
 *       gas coin; for any other type, the agent wallet must own coins of
 *       that type (sourced via `getCoins`/`mergeCoins`).
 *     SUI_PAYMENT_COIN_DECIMALS (optional, default 9, matching SUI) —
 *       decimals of SUI_PAYMENT_COIN_TYPE, used to scale demo amounts to
 *       base units (see toBaseUnits below). USDC on Sui has 6 decimals.
 *
 * Every call here maps 1:1 to a Move entry function, so mock -> real is
 * plumbing, not product logic.
 */

const MODE = (process.env.SUI_MODE ?? "mock") as "mock" | "testnet" | "mainnet";

export interface ChainResult {
  digest: string;
  ok: boolean;
  error?: string;
  /** Object ID of the WorkflowRequest shared object created by `submit`. */
  objectId?: string;
}

// ---------- mock implementation ----------

function mockDigest(): string {
  return randomBytes(32).toString("base64url").slice(0, 44);
}

async function mockCall(fn: string, opts?: { failureRate?: number }): Promise<ChainResult> {
  await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
  if (Math.random() < (opts?.failureRate ?? 0)) {
    return { digest: "", ok: false, error: `Simulated chain failure in ${fn} (gas/object contention)` };
  }
  return { digest: mockDigest(), ok: true };
}

// ---------- real implementation (lazy-loaded) ----------

type Signer = { keypair: unknown; address: string };

export type SuiEvent = {
  id: { txDigest: string; eventSeq: string };
  type: string;
  parsedJson?: unknown;
  timestampMs?: string;
};

export type EventCursor = { txDigest: string; eventSeq: string };

type ChainClient = {
  signAndExecuteTransaction(o: object): Promise<{
    digest: string;
    effects?: { status?: { status?: string; error?: string } } | null;
    objectChanges?: { type: string; objectType?: string; objectId?: string }[] | null;
  }>;
  waitForTransaction(o: { digest: string }): Promise<unknown>;
  queryEvents(o: {
    query: unknown;
    cursor?: EventCursor | null;
    order?: "ascending" | "descending";
    limit?: number;
  }): Promise<{ data: SuiEvent[]; hasNextPage: boolean; nextCursor: EventCursor | null }>;
  getCoins(o: { owner: string; coinType?: string }): Promise<{ data: { coinObjectId: string; balance: string }[] }>;
};

type ChainTransaction = {
  moveCall(opts: { target: string; arguments: unknown[]; typeArguments?: string[] }): void;
  pure: Record<string, (...args: unknown[]) => unknown>;
  object(id: string): unknown;
  splitCoins(coin: unknown, amounts: unknown[]): unknown[];
  mergeCoins(destination: unknown, sources: unknown[]): void;
  gas: unknown;
};

type SuiRuntime = {
  client: ChainClient;
  agent: Signer;
  approver: Signer;
  Transaction: new () => ChainTransaction;
};

let runtime: SuiRuntime | null = null;

async function loadRuntime(): Promise<SuiRuntime> {
  if (runtime) return runtime;
  const pkg = process.env.SUI_PACKAGE_ID;
  const agentKey = process.env.SUI_SECRET_KEY;
  const approverKey = process.env.SUI_APPROVER_SECRET_KEY;
  if (!pkg || !agentKey || !approverKey) {
    throw new Error(
      "SUI_MODE=" + MODE + " requires SUI_PACKAGE_ID, SUI_SECRET_KEY and SUI_APPROVER_SECRET_KEY env vars — see README 'Deploying the Move package'.",
    );
  }
  try {
    // Dynamic imports so `mock` mode needs no SDK installed.
    // @ts-ignore — resolves once `npm i @mysten/sui` has been run
    const clientMod = await import("@mysten/sui/client");
    // @ts-ignore — resolves once `npm i @mysten/sui` has been run
    const keypairMod = await import("@mysten/sui/keypairs/ed25519");
    // @ts-ignore — resolves once `npm i @mysten/sui` has been run
    const txMod = await import("@mysten/sui/transactions");
    const rpcUrl = process.env.SUI_RPC_URL ?? clientMod.getFullnodeUrl(MODE as "testnet" | "mainnet");
    const client = new clientMod.SuiClient({ url: rpcUrl });
    const agentKeypair = keypairMod.Ed25519Keypair.fromSecretKey(agentKey);
    const approverKeypair = keypairMod.Ed25519Keypair.fromSecretKey(approverKey);
    runtime = {
      client: client as unknown as ChainClient,
      agent: { keypair: agentKeypair, address: agentKeypair.getPublicKey().toSuiAddress() },
      approver: { keypair: approverKeypair, address: approverKeypair.getPublicKey().toSuiAddress() },
      Transaction: txMod.Transaction as unknown as new () => ChainTransaction,
    };
    return runtime;
  } catch (e) {
    throw new Error("Install the SDK first: cd backend && npm i @mysten/sui (" + (e as Error).message + ")");
  }
}

const DEFAULT_PAYMENT_COIN_TYPE = "0x2::sui::SUI";

function paymentCoinType(): string {
  return process.env.SUI_PAYMENT_COIN_TYPE ?? DEFAULT_PAYMENT_COIN_TYPE;
}

function paymentCoinDecimals(): number {
  return Number(process.env.SUI_PAYMENT_COIN_DECIMALS ?? 9);
}

/** Demo amounts are USD-denominated units; for the testnet demo we map
 *  1 unit -> 10^(decimals-6) base units of the payment coin, so budgets
 *  stay affordable. For SUI (9 decimals) that's 0.000001 SUI = 1000 MIST;
 *  for USDC (6 decimals) that's 1:1 with USDC's base unit. Adjust as needed. */
function toBaseUnits(amount: number): bigint {
  const scale = 10 ** Math.max(paymentCoinDecimals() - 6, 0);
  return BigInt(Math.round(amount * scale));
}

function envObj(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var — run move/setup.ts and copy its .env block.`);
  return v;
}

function bucketEnvId(category: string): string {
  return envObj(`SUI_BUCKET_${category.toUpperCase()}_ID`);
}

interface RealCallArgs {
  chainObjectId?: string;
  title?: string;
  category?: string;
  amount?: number;
  vendor?: string;
  description?: string;
  note?: string;
  reason?: string;
  intentHash?: string;
  executorAddr?: string;
  address?: string;
  role?: number;
}

async function realCall(fn: string, args: RealCallArgs): Promise<ChainResult> {
  try {
    const rt = await loadRuntime();
    const pkg = process.env.SUI_PACKAGE_ID!;
    const org = envObj("SUI_ORG_ID");
    const tx = new rt.Transaction();
    let signer = rt.agent;
    let wantsObjectId = false;

    switch (fn) {
      case "submit": {
        tx.moveCall({
          target: `${pkg}::workflow::submit`,
          arguments: [
            tx.object(org),
            tx.pure.string(args.title ?? ""),
            tx.pure.string(args.category ?? ""),
            tx.pure.u64(toBaseUnits(args.amount ?? 0)),
            tx.pure.address(args.vendor ?? "0x0"),
            tx.pure.string(args.description ?? ""),
          ],
        });
        wantsObjectId = true;
        break;
      }
      case "evaluate_policy": {
        tx.moveCall({
          target: `${pkg}::workflow::evaluate_policy`,
          arguments: [tx.object(args.chainObjectId!), tx.object(envObj("SUI_POLICY_ID")), tx.object(bucketEnvId(args.category ?? ""))],
        });
        break;
      }
      case "approve": {
        signer = rt.approver;
        tx.moveCall({
          target: `${pkg}::workflow::approve`,
          arguments: [tx.object(args.chainObjectId!), tx.object(org), tx.pure.string(args.note ?? "")],
        });
        break;
      }
      case "reject": {
        signer = rt.approver;
        tx.moveCall({
          target: `${pkg}::workflow::reject`,
          arguments: [tx.object(args.chainObjectId!), tx.object(org), tx.pure.string(args.reason ?? "")],
        });
        break;
      }
      case "cancel": {
        tx.moveCall({
          target: `${pkg}::workflow::cancel`,
          arguments: [tx.object(args.chainObjectId!), tx.object(org)],
        });
        break;
      }
      case "set_member_role": {
        tx.moveCall({
          target: `${pkg}::org::set_member_role`,
          arguments: [tx.object(org), tx.object(envObj("SUI_ADMIN_CAP_ID")), tx.pure.address(args.address ?? "0x0"), tx.pure.u8(args.role ?? 0)],
        });
        break;
      }
      case "execute": {
        const bucket = bucketEnvId(args.category ?? "");
        const coinType = paymentCoinType();
        const amountUnits = toBaseUnits(args.amount ?? 0);
        let payment: unknown;
        if (coinType === DEFAULT_PAYMENT_COIN_TYPE) {
          [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(amountUnits)]);
        } else {
          // Non-SUI payments can't be split from the gas coin — source them
          // from coins of `coinType` owned by the signing (agent) wallet.
          const coins = await rt.client.getCoins({ owner: rt.agent.address, coinType });
          if (coins.data.length === 0) {
            return { digest: "", ok: false, error: `No ${coinType} coins owned by ${rt.agent.address}` };
          }
          const primary = tx.object(coins.data[0].coinObjectId);
          if (coins.data.length > 1) {
            tx.mergeCoins(primary, coins.data.slice(1).map((c) => tx.object(c.coinObjectId)));
          }
          [payment] = tx.splitCoins(primary, [tx.pure.u64(amountUnits)]);
        }
        const intentBytes = Array.from(Buffer.from(args.intentHash ?? "", "hex"));
        if (args.executorAddr === "agent") {
          tx.moveCall({
            target: `${pkg}::agent_cap::execute_autonomous`,
            typeArguments: [coinType],
            arguments: [
              tx.object(envObj("SUI_AGENT_CAP_ID")),
              tx.object(args.chainObjectId!),
              tx.object(org),
              tx.object(bucket),
              payment,
              tx.pure.vector("u8", intentBytes),
            ],
          });
        } else {
          tx.moveCall({
            target: `${pkg}::workflow::execute`,
            typeArguments: [coinType],
            arguments: [tx.object(args.chainObjectId!), tx.object(org), tx.object(bucket), payment, tx.pure.vector("u8", intentBytes)],
          });
        }
        break;
      }
      default:
        return { digest: "", ok: false, error: `Unknown chain fn: ${fn}` };
    }

    const result = await rt.client.signAndExecuteTransaction({
      signer: signer.keypair,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });
    // Local/testnet fullnodes can lag behind execution by a checkpoint or
    // two; wait so the next call's object resolution sees this tx's effects.
    await rt.client.waitForTransaction({ digest: result.digest });
    const status = result.effects?.status;
    if (status?.status === "failure") return { digest: result.digest, ok: false, error: status.error };

    let objectId: string | undefined;
    if (wantsObjectId) {
      const created = (result.objectChanges ?? []).find(
        (c) => c.type === "created" && c.objectType?.endsWith("::workflow::WorkflowRequest"),
      );
      objectId = created?.objectId;
    }
    return { digest: result.digest, ok: true, objectId };
  } catch (e) {
    return { digest: "", ok: false, error: (e as Error).message };
  }
}

// ---------- public interface ----------

async function call(fn: string, args: RealCallArgs, opts?: { failureRate?: number }): Promise<ChainResult> {
  if (MODE === "mock") return mockCall(fn, opts);
  return realCall(fn, args);
}

export const chain = {
  mode: MODE,
  submitRequest: (args: { title: string; category: string; amount: number; vendor: string; description: string }) =>
    call("submit", args),
  evaluatePolicy: (args: { chainObjectId?: string; category: string }) => call("evaluate_policy", args),
  approve: (args: { chainObjectId?: string; note: string }) => call("approve", args),
  reject: (args: { chainObjectId?: string; reason: string }) => call("reject", args),
  execute: (args: {
    chainObjectId?: string;
    category: string;
    amount: number;
    vendor: string;
    intentHash: string;
    executorAddr: string;
    simulateFailure?: boolean;
  }) => call("execute", args, { failureRate: args.simulateFailure ? 1 : 0 }),
  cancel: (args: { chainObjectId?: string }) => call("cancel", args),
  setMemberRole: (args: { address: string; role: number }) => call("set_member_role", args),
};

/** Package + Org object IDs the frontend needs to build its own
 *  workflow::approve/reject transactions (zkLogin/Enoki path). `null` in
 *  mock mode, where there's nothing onchain to reference. */
export function chainConfig(): { packageId: string; orgId: string } | null {
  if (MODE === "mock") return null;
  return { packageId: envObj("SUI_PACKAGE_ID"), orgId: envObj("SUI_ORG_ID") };
}

/** Short ticker for the configured payment coin, e.g. "SUI" or "USDC",
 *  derived from the last segment of SUI_PAYMENT_COIN_TYPE. */
function currencySymbol(): string {
  const type = paymentCoinType();
  const parts = type.split("::");
  return parts[parts.length - 1] ?? type;
}

export function buildReceipt(digest: string, executor: string, amount: number, vendor: string): ExecutionReceipt {
  return {
    txDigest: digest,
    executor,
    amount,
    vendor,
    at: new Date().toISOString(),
    network: MODE,
    currency: currencySymbol(),
  };
}

export function explorerUrl(digest: string): string {
  if (MODE === "mock") return `https://suiscan.xyz/testnet/tx/${digest}`;
  return `https://suiscan.xyz/${MODE}/tx/${digest}`;
}

/** Chain client + package id for the event indexer (indexer.ts). `null` in
 *  mock mode, where there's no chain to index. */
export async function getEventClient(): Promise<{ client: ChainClient; packageId: string } | null> {
  if (MODE === "mock") return null;
  const rt = await loadRuntime();
  return { client: rt.client, packageId: envObj("SUI_PACKAGE_ID") };
}
