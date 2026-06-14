import { useEffect, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SuiClientProvider, WalletProvider, createNetworkConfig, useSuiClient } from "@mysten/dapp-kit";
import { registerEnokiWallets, type EnokiNetwork } from "@mysten/enoki";
import { getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

const ENOKI_API_KEY = import.meta.env.VITE_ENOKI_API_KEY as string | undefined;
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

/** Walletless (zkLogin) approvals are only wired up when both Enoki + Google
 *  OAuth env vars are set. Unset (the default) -> this whole module is a
 *  no-op: SuiClientProvider/WalletProvider still mount (cheap context
 *  providers, no UI), but no wallets are registered and `useCurrentAccount()`
 *  stays null everywhere, so the app behaves exactly as before. */
export const ZK_ENABLED = Boolean(ENOKI_API_KEY && GOOGLE_CLIENT_ID);

const NETWORK = (import.meta.env.VITE_SUI_NETWORK as EnokiNetwork | undefined) ?? "testnet";

const { networkConfig } = createNetworkConfig({
  testnet: { url: getJsonRpcFullnodeUrl("testnet"), network: "testnet" },
  mainnet: { url: getJsonRpcFullnodeUrl("mainnet"), network: "mainnet" },
  devnet: { url: getJsonRpcFullnodeUrl("devnet"), network: "devnet" },
});

const queryClient = new QueryClient();

function RegisterEnokiWallets() {
  const client = useSuiClient();
  useEffect(() => {
    if (!ZK_ENABLED) return;
    import("@mysten/dapp-kit/dist/index.css");
    const { unregister } = registerEnokiWallets({
      apiKey: ENOKI_API_KEY!,
      providers: { google: { clientId: GOOGLE_CLIENT_ID! } },
      client,
      network: NETWORK,
    });
    return unregister;
  }, [client]);
  return null;
}

export function ZkProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork={NETWORK}>
        <WalletProvider autoConnect>
          <RegisterEnokiWallets />
          {children}
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
