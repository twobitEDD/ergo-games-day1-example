import { useEffect, type ReactNode } from "react";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicContextProvider, getAuthToken, useDynamicContext } from "@dynamic-labs/sdk-react-core";

export interface DynamicBridgeSnapshot {
  sdkHasLoaded: boolean;
  user: Record<string, unknown> | null;
  setShowAuthFlow: (visible: boolean) => void;
  handleLogOut: () => Promise<void>;
  getAuthToken: () => string | null;
}

const DynamicBridge = ({
  children,
  onSnapshot,
}: {
  children: ReactNode;
  onSnapshot: (snapshot: DynamicBridgeSnapshot) => void;
}) => {
  const { user, sdkHasLoaded, setShowAuthFlow, handleLogOut } = useDynamicContext();

  useEffect(() => {
    onSnapshot({
      sdkHasLoaded,
      user: (user ?? null) as Record<string, unknown> | null,
      setShowAuthFlow,
      handleLogOut,
      getAuthToken: () => getAuthToken() ?? null,
    });
  }, [handleLogOut, onSnapshot, sdkHasLoaded, setShowAuthFlow, user]);

  return <>{children}</>;
};

export const DynamicRuntimeBridge = ({
  children,
  onSnapshot,
  environmentId,
}: {
  children: ReactNode;
  onSnapshot: (snapshot: DynamicBridgeSnapshot) => void;
  environmentId: string;
}) => (
  <DynamicContextProvider
    settings={{
      environmentId,
      walletConnectors: [EthereumWalletConnectors],
    }}
  >
    <DynamicBridge onSnapshot={onSnapshot}>{children}</DynamicBridge>
  </DynamicContextProvider>
);
