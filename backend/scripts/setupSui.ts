/**
 * One-time testnet bootstrap for OpsFlow's Move package.
 *
 * Creates the shared Org, PolicySet, 4 BudgetBuckets and an AgentCap
 * (issued to the agent wallet), and grants the second wallet the
 * approver role (workflow::approve forbids the requester from
 * approving its own request, so a second signer is required).
 *
 * Usage (from backend/):
 *   SUI_MODE=testnet \
 *   SUI_PACKAGE_ID=0x... \
 *   SUI_SECRET_KEY=suiprivkey...      (agent / admin wallet) \
 *   SUI_APPROVER_SECRET_KEY=suiprivkey... (second wallet) \
 *   npx tsx scripts/setupSui.ts
 *
 * Prints a .env block with every object ID the backend needs.
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

const NETWORK = (process.env.SUI_MODE ?? "testnet") as "testnet" | "mainnet";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} env var`);
  return v;
}

const PKG = need("SUI_PACKAGE_ID");
const agentKey = need("SUI_SECRET_KEY");
const approverKey = need("SUI_APPROVER_SECRET_KEY");

const client = new SuiClient({ url: process.env.SUI_RPC_URL ?? getFullnodeUrl(NETWORK) });
const agent = Ed25519Keypair.fromSecretKey(agentKey);
const approver = Ed25519Keypair.fromSecretKey(approverKey);
const agentAddr = agent.getPublicKey().toSuiAddress();
const approverAddr = approver.getPublicKey().toSuiAddress();

type TxResult = {
  digest: string;
  effects?: { status?: { status?: string; error?: string } } | null;
  objectChanges?: { type: string; objectType?: string; objectId?: string }[] | null;
};

async function run(tx: Transaction, signer: Ed25519Keypair, label: string): Promise<TxResult> {
  const result = (await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  })) as TxResult;
  if (result.effects?.status?.status === "failure") {
    throw new Error(`${label} failed: ${result.effects.status.error}`);
  }
  // Local/testnet fullnodes can lag behind execution by a checkpoint or two;
  // wait so the next tx's object resolution sees what we just created.
  await client.waitForTransaction({ digest: result.digest });
  console.log(`${label}: ${result.digest}`);
  return result;
}

function created(result: TxResult, typeSuffix: string): string {
  const change = (result.objectChanges ?? []).find((c) => c.type === "created" && c.objectType?.endsWith(typeSuffix));
  if (!change?.objectId) throw new Error(`No created object ending with ${typeSuffix} found in ${JSON.stringify(result.objectChanges)}`);
  return change.objectId;
}

async function main() {
  console.log(`Agent wallet:    ${agentAddr}`);
  console.log(`Approver wallet: ${approverAddr}`);
  console.log(`Package:         ${PKG}\n`);

  // 1. Org (shared) + AdminCap (owned by agent wallet, which acts as admin)
  let tx = new Transaction();
  tx.moveCall({ target: `${PKG}::org::create_org_entry`, arguments: [tx.pure.string("OpsFlow Demo Org")] });
  let res = await run(tx, agent, "create_org");
  const orgId = created(res, "::org::Org");
  const adminCapId = created(res, "::org::AdminCap");

  // 2. PolicySet (amounts scaled the same way as backend's toMist(): x1000)
  tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::policy::create_policy_set`,
    arguments: [tx.object(orgId), tx.object(adminCapId), tx.pure.u64(250_000n), tx.pure.u64(2_000_000n), tx.pure.u64(10_000_000n)],
  });
  res = await run(tx, agent, "create_policy_set");
  const policyId = created(res, "::policy::PolicySet");

  // 3. Budget buckets — one tx each so each created object is unambiguous.
  const bucketSpecs = [
    { envKey: "SOFTWARE", name: "Software & SaaS", limit: 5_000_000n },
    { envKey: "CONTRACTOR", name: "Contractors", limit: 20_000_000n },
    { envKey: "EVENTS", name: "Events", limit: 3_000_000n },
    { envKey: "REIMBURSEMENTS", name: "Reimbursements", limit: 4_000_000n },
  ];
  const bucketIds: Record<string, string> = {};
  for (const b of bucketSpecs) {
    tx = new Transaction();
    tx.moveCall({
      target: `${PKG}::policy::create_budget_bucket`,
      arguments: [tx.object(orgId), tx.object(adminCapId), tx.pure.string(b.name), tx.pure.u64(b.limit)],
    });
    res = await run(tx, agent, `create_budget_bucket(${b.envKey})`);
    bucketIds[b.envKey] = created(res, "::policy::BudgetBucket");
  }

  // 4. AgentCap — issued to the agent wallet (same wallet signs execute_autonomous)
  tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::agent_cap::issue`,
    arguments: [
      tx.object(orgId),
      tx.object(adminCapId),
      tx.pure.address(agentAddr),
      tx.pure.string("opsflow-agent-v1"),
      tx.pure.u64(250_000n),
      tx.pure.u64(1_000_000n),
    ],
  });
  res = await run(tx, agent, "agent_cap::issue");
  const agentCapId = created(res, "::agent_cap::AgentCap");

  // 5. Second wallet becomes the approver (agent wallet is finance-admin by
  //    default from create_org, but workflow::approve forbids self-approval).
  tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::org::set_member_role`,
    arguments: [tx.object(orgId), tx.object(adminCapId), tx.pure.address(approverAddr), tx.pure.u8(1)],
  });
  await run(tx, agent, "set_member_role(approver)");

  console.log("\n--- Append to backend/.env ---");
  console.log(`SUI_MODE=testnet`);
  console.log(`SUI_PACKAGE_ID=${PKG}`);
  console.log(`SUI_SECRET_KEY=${agentKey}`);
  console.log(`SUI_APPROVER_SECRET_KEY=${approverKey}`);
  console.log(`SUI_ORG_ID=${orgId}`);
  console.log(`SUI_ADMIN_CAP_ID=${adminCapId}`);
  console.log(`SUI_POLICY_ID=${policyId}`);
  console.log(`SUI_AGENT_CAP_ID=${agentCapId}`);
  for (const b of bucketSpecs) console.log(`SUI_BUCKET_${b.envKey}_ID=${bucketIds[b.envKey]}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
