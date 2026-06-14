import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the mock factories below (which vitest hoists above imports)
// can reference them.
const { transactions, signAndExecuteTransaction, getCoins } = vi.hoisted(() => ({
  transactions: [] as FakeTransaction[],
  signAndExecuteTransaction: vi.fn(),
  getCoins: vi.fn(),
}));

class FakeTransaction {
  calls: { target: string; arguments: unknown[]; typeArguments?: string[] }[] = [];
  splits: { from: unknown; amounts: unknown[] }[] = [];
  merges: { destination: unknown; sources: unknown[] }[] = [];
  gas = { __gas: true };
  pure = new Proxy(
    {},
    { get: (_t, prop: string) => (...args: unknown[]) => ({ __pure: prop, args }) },
  ) as unknown as Record<string, (...args: unknown[]) => unknown>;
  constructor() {
    transactions.push(this);
  }
  moveCall(opts: { target: string; arguments: unknown[]; typeArguments?: string[] }) {
    this.calls.push(opts);
  }
  object(id: string) {
    return { __object: id };
  }
  splitCoins(coin: unknown, amounts: unknown[]) {
    this.splits.push({ from: coin, amounts });
    return [{ __split: amounts }];
  }
  mergeCoins(destination: unknown, sources: unknown[]) {
    this.merges.push({ destination, sources });
  }
}

vi.mock("@mysten/sui/transactions", () => ({ Transaction: FakeTransaction }));

vi.mock("@mysten/sui/keypairs/ed25519", () => ({
  Ed25519Keypair: {
    fromSecretKey: (key: string) => ({
      __secretKey: key,
      getPublicKey: () => ({ toSuiAddress: () => `0xADDR_${key}` }),
    }),
  },
}));

vi.mock("@mysten/sui/client", () => ({
  SuiClient: vi.fn().mockImplementation(() => ({ signAndExecuteTransaction, waitForTransaction: vi.fn(), getCoins })),
  getFullnodeUrl: (net: string) => `https://fullnode.${net}.sui.io`,
}));

const ENV: Record<string, string> = {
  SUI_MODE: "testnet",
  SUI_PACKAGE_ID: "0xPKG",
  SUI_SECRET_KEY: "agentkey",
  SUI_APPROVER_SECRET_KEY: "approverkey",
  SUI_ORG_ID: "0xORG",
  SUI_POLICY_ID: "0xPOLICY",
  SUI_AGENT_CAP_ID: "0xAGENTCAP",
  SUI_ADMIN_CAP_ID: "0xADMINCAP",
  SUI_BUCKET_SOFTWARE_ID: "0xBUCKETSW",
};

async function freshChain() {
  vi.resetModules();
  transactions.length = 0;
  signAndExecuteTransaction.mockReset();
  getCoins.mockReset();
  const mod = await import("../src/sui.js");
  return mod.chain;
}

describe("sui chain mappings (testnet)", () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(ENV)) original[k] = process.env[k];
    Object.assign(process.env, ENV);
  });

  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("submit builds workflow::submit and returns the created object id", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({
      digest: "digest-submit",
      effects: { status: { status: "success" } },
      objectChanges: [
        { type: "created", objectType: "0xPKG::workflow::WorkflowRequest", objectId: "0xREQ1" },
      ],
    });

    const result = await chain.submitRequest({
      title: "Buy laptop", category: "software", amount: 500, vendor: "0xVENDOR", description: "for the new hire",
    });

    expect(result.ok).toBe(true);
    expect(result.objectId).toBe("0xREQ1");

    const tx = transactions.at(-1)!;
    expect(tx.calls).toHaveLength(1);
    expect(tx.calls[0].target).toBe("0xPKG::workflow::submit");
    expect(tx.calls[0].arguments[0]).toEqual({ __object: "0xORG" });
    expect(tx.calls[0].arguments[1]).toEqual({ __pure: "string", args: ["Buy laptop"] });
    expect(tx.calls[0].arguments[2]).toEqual({ __pure: "string", args: ["software"] });
    expect(tx.calls[0].arguments[3]).toEqual({ __pure: "u64", args: [500_000n] }); // toMist(500)
    expect(tx.calls[0].arguments[4]).toEqual({ __pure: "address", args: ["0xVENDOR"] });
    expect(tx.calls[0].arguments[5]).toEqual({ __pure: "string", args: ["for the new hire"] });

    expect(signAndExecuteTransaction).toHaveBeenCalledTimes(1);
    expect((signAndExecuteTransaction.mock.calls[0][0] as { signer: { __secretKey: string } }).signer.__secretKey).toBe("agentkey");
  });

  it("evaluate_policy references the request, policy set and category bucket", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-eval", effects: { status: { status: "success" } } });

    const result = await chain.evaluatePolicy({ chainObjectId: "0xREQ1", category: "software" });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::workflow::evaluate_policy");
    expect(tx.calls[0].arguments).toEqual([
      { __object: "0xREQ1" },
      { __object: "0xPOLICY" },
      { __object: "0xBUCKETSW" },
    ]);
  });

  it("approve is signed by the approver wallet, not the agent wallet", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-approve", effects: { status: { status: "success" } } });

    const result = await chain.approve({ chainObjectId: "0xREQ1", note: "looks good" });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::workflow::approve");
    expect(tx.calls[0].arguments).toEqual([
      { __object: "0xREQ1" },
      { __object: "0xORG" },
      { __pure: "string", args: ["looks good"] },
    ]);
    expect((signAndExecuteTransaction.mock.calls[0][0] as { signer: { __secretKey: string } }).signer.__secretKey).toBe("approverkey");
  });

  it("reject is signed by the approver wallet", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-reject", effects: { status: { status: "success" } } });

    const result = await chain.reject({ chainObjectId: "0xREQ1", reason: "missing receipt" });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::workflow::reject");
    expect(tx.calls[0].arguments).toEqual([
      { __object: "0xREQ1" },
      { __object: "0xORG" },
      { __pure: "string", args: ["missing receipt"] },
    ]);
    expect((signAndExecuteTransaction.mock.calls[0][0] as { signer: { __secretKey: string } }).signer.__secretKey).toBe("approverkey");
  });

  it("cancel references the request and org", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-cancel", effects: { status: { status: "success" } } });

    const result = await chain.cancel({ chainObjectId: "0xREQ1" });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::workflow::cancel");
    expect(tx.calls[0].arguments).toEqual([{ __object: "0xREQ1" }, { __object: "0xORG" }]);
  });

  it("execute by a human executor calls workflow::execute with a split payment and intent hash", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-exec", effects: { status: { status: "success" } } });

    const result = await chain.execute({
      chainObjectId: "0xREQ1", category: "software", amount: 200, vendor: "0xVENDOR", intentHash: "deadbeef", executorAddr: "0xd3f0",
    });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::workflow::execute");
    expect(tx.calls[0].arguments[0]).toEqual({ __object: "0xREQ1" });
    expect(tx.calls[0].arguments[1]).toEqual({ __object: "0xORG" });
    expect(tx.calls[0].arguments[2]).toEqual({ __object: "0xBUCKETSW" });
    expect(tx.calls[0].arguments[3]).toEqual({ __split: [{ __pure: "u64", args: [200_000n] }] }); // toBaseUnits(200)
    expect(tx.calls[0].arguments[4]).toEqual({ __pure: "vector", args: ["u8", [0xde, 0xad, 0xbe, 0xef]] });
    expect(tx.calls[0].typeArguments).toEqual(["0x2::sui::SUI"]);
    expect(tx.splits[0].from).toBe(tx.gas);
  });

  it("execute by the agent calls agent_cap::execute_autonomous with the AgentCap", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-auto", effects: { status: { status: "success" } } });

    const result = await chain.execute({
      chainObjectId: "0xREQ1", category: "software", amount: 100, vendor: "0xVENDOR", intentHash: "ab", executorAddr: "agent",
    });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::agent_cap::execute_autonomous");
    expect(tx.calls[0].arguments[0]).toEqual({ __object: "0xAGENTCAP" });
    expect(tx.calls[0].arguments[1]).toEqual({ __object: "0xREQ1" });
    expect(tx.calls[0].arguments[2]).toEqual({ __object: "0xORG" });
    expect(tx.calls[0].arguments[3]).toEqual({ __object: "0xBUCKETSW" });
    expect(tx.calls[0].typeArguments).toEqual(["0x2::sui::SUI"]);
  });

  it("execute with a non-SUI payment coin sources payment from the agent's owned coins, not gas", async () => {
    process.env.SUI_PAYMENT_COIN_TYPE = "0xUSDC::usdc::USDC";
    process.env.SUI_PAYMENT_COIN_DECIMALS = "6";
    try {
      const chain = await freshChain();
      getCoins.mockResolvedValueOnce({ data: [{ coinObjectId: "0xCOIN1", balance: "1000" }, { coinObjectId: "0xCOIN2", balance: "500" }] });
      signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-usdc", effects: { status: { status: "success" } } });

      const result = await chain.execute({
        chainObjectId: "0xREQ1", category: "software", amount: 200, vendor: "0xVENDOR", intentHash: "ab", executorAddr: "0xd3f0",
      });

      expect(result.ok).toBe(true);
      expect(getCoins).toHaveBeenCalledWith({ owner: "0xADDR_agentkey", coinType: "0xUSDC::usdc::USDC" });
      const tx = transactions.at(-1)!;
      expect(tx.calls[0].target).toBe("0xPKG::workflow::execute");
      expect(tx.calls[0].typeArguments).toEqual(["0xUSDC::usdc::USDC"]);
      // merges the second coin into the first, then splits the payment off the merged coin
      expect(tx.merges).toEqual([{ destination: { __object: "0xCOIN1" }, sources: [{ __object: "0xCOIN2" }] }]);
      expect(tx.splits[0].from).toEqual({ __object: "0xCOIN1" });
      expect(tx.splits[0].amounts).toEqual([{ __pure: "u64", args: [200n] }]); // toBaseUnits(200) at 6 decimals = 1:1
    } finally {
      delete process.env.SUI_PAYMENT_COIN_TYPE;
      delete process.env.SUI_PAYMENT_COIN_DECIMALS;
    }
  });

  it("execute with a non-SUI payment coin fails fast (no signing) if the agent owns none of that coin", async () => {
    process.env.SUI_PAYMENT_COIN_TYPE = "0xUSDC::usdc::USDC";
    try {
      const chain = await freshChain();
      getCoins.mockResolvedValueOnce({ data: [] });

      const result = await chain.execute({
        chainObjectId: "0xREQ1", category: "software", amount: 200, vendor: "0xVENDOR", intentHash: "ab", executorAddr: "0xd3f0",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/0xUSDC::usdc::USDC/);
      expect(signAndExecuteTransaction).not.toHaveBeenCalled();
    } finally {
      delete process.env.SUI_PAYMENT_COIN_TYPE;
    }
  });

  it("returns ok:false with the chain error on transaction failure", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({
      digest: "digest-fail", effects: { status: { status: "failure", error: "InsufficientGas" } },
    });

    const result = await chain.cancel({ chainObjectId: "0xREQ1" });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("InsufficientGas");
  });

  it("returns ok:false without touching the network when a bucket env var is missing", async () => {
    const chain = await freshChain();

    const result = await chain.evaluatePolicy({ chainObjectId: "0xREQ1", category: "unknown-category" });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/SUI_BUCKET_UNKNOWN-CATEGORY_ID/);
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();
  });

  it("setMemberRole calls org::set_member_role with the AdminCap, signed by the agent wallet", async () => {
    const chain = await freshChain();
    signAndExecuteTransaction.mockResolvedValueOnce({ digest: "digest-member", effects: { status: { status: "success" } } });

    const result = await chain.setMemberRole({ address: "0xZK", role: 1 });

    expect(result.ok).toBe(true);
    const tx = transactions.at(-1)!;
    expect(tx.calls[0].target).toBe("0xPKG::org::set_member_role");
    expect(tx.calls[0].arguments).toEqual([
      { __object: "0xORG" },
      { __object: "0xADMINCAP" },
      { __pure: "address", args: ["0xZK"] },
      { __pure: "u8", args: [1] },
    ]);
    expect((signAndExecuteTransaction.mock.calls[0][0] as { signer: { __secretKey: string } }).signer.__secretKey).toBe("agentkey");
  });

  it("chainConfig returns the package and org ids", async () => {
    vi.resetModules();
    const mod = await import("../src/sui.js");
    expect(mod.chainConfig()).toEqual({ packageId: "0xPKG", orgId: "0xORG" });
  });
});

describe("sui chain mappings (mock mode)", () => {
  it("never touches the SDK and returns a digest", async () => {
    const original = process.env.SUI_MODE;
    delete process.env.SUI_MODE;
    const chain = await freshChain();
    process.env.SUI_MODE = original;

    expect(chain.mode).toBe("mock");
    const result = await chain.submitRequest({ title: "t", category: "software", amount: 10, vendor: "0xV", description: "d" });
    expect(result.ok).toBe(true);
    expect(result.digest).toBeTruthy();
    expect(signAndExecuteTransaction).not.toHaveBeenCalled();

    const setMemberResult = await chain.setMemberRole({ address: "0xZK", role: 1 });
    expect(setMemberResult.ok).toBe(true);
    expect(setMemberResult.digest).toBeTruthy();
  });

  it("chainConfig returns null", async () => {
    const original = process.env.SUI_MODE;
    delete process.env.SUI_MODE;
    vi.resetModules();
    const mod = await import("../src/sui.js");
    process.env.SUI_MODE = original;

    expect(mod.chainConfig()).toBeNull();
  });
});
