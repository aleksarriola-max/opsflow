import { Transaction } from "@mysten/sui/transactions";
import { useSuiClient, useSignAndExecuteTransaction } from "@mysten/dapp-kit";
import type { Meta } from "../api";

/** Builds + signs `workflow::approve`/`workflow::reject` client-side via the
 *  connected zkLogin (Enoki) wallet, mirroring the `approve`/`reject` cases
 *  of `backend/src/sui.ts`'s `realCall`. Enoki sponsors gas, so the
 *  connected zkLogin address never needs to hold SUI. */
export function useZkApprove(chainConfig: Meta["chainConfig"]) {
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();

  async function run(action: "approve" | "reject", chainObjectId: string, text: string): Promise<string> {
    if (!chainConfig) throw new Error("zkLogin signing requires a non-mock chain config");
    const tx = new Transaction();
    tx.moveCall({
      target: `${chainConfig.packageId}::workflow::${action}`,
      arguments: [tx.object(chainObjectId), tx.object(chainConfig.orgId), tx.pure.string(text)],
    });
    const { digest } = await mutateAsync({ transaction: tx });
    await client.waitForTransaction({ digest });
    return digest;
  }

  return {
    approve: (chainObjectId: string, note: string) => run("approve", chainObjectId, note),
    reject: (chainObjectId: string, reason: string) => run("reject", chainObjectId, reason),
  };
}
