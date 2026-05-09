import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { EthereumWalletConnectors } from "@dynamic-labs/ethereum";
import { DynamicContextProvider, useDynamicContext } from "@dynamic-labs/sdk-react-core";
import {
  Day1DynamicContext,
  type Day1DynamicContextValue,
  type DynamicAvailability,
} from "./day1DynamicState";

interface DynamicBridgeSnapshot {
  sdkHasLoaded: boolean;
  user: Record<string, unknown> | null;
  setShowAuthFlow: (visible: boolean) => void;
  handleLogOut: () => Promise<void>;
}

const DYNAMIC_INIT_TIMEOUT_MS = 8000;
const DYNAMIC_ENVIRONMENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const parseBoolean = (value: unknown, fallback = false) => {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const toErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
};

const DEFAULT_BRIDGE_SNAPSHOT: DynamicBridgeSnapshot = {
  sdkHasLoaded: false,
  user: null,
  setShowAuthFlow: () => {
    // no-op fallback when Dynamic is disabled/unavailable
  },
  handleLogOut: async () => {
    // no-op fallback when Dynamic is disabled/unavailable
  },
};

const NOOP_SET_SHOW_AUTH_FLOW = (visible: boolean) => {
  void visible;
  // no-op fallback when Dynamic is disabled/unavailable
};

const NOOP_HANDLE_LOG_OUT = async () => {
  // no-op fallback when Dynamic is disabled/unavailable
};

interface DynamicErrorBoundaryProps {
  children: ReactNode;
  onRuntimeError: (error: Error) => void;
}

interface DynamicErrorBoundaryState {
  hasError: boolean;
}

class DynamicErrorBoundary extends Component<DynamicErrorBoundaryProps, DynamicErrorBoundaryState> {
  state: DynamicErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): DynamicErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    this.props.onRuntimeError(error);
  }

  override render() {
    if (this.state.hasError) {
      return null;
    }
    return this.props.children;
  }
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
    });
  }, [handleLogOut, onSnapshot, sdkHasLoaded, setShowAuthFlow, user]);

  return <>{children}</>;
};

export const DynamicProvider = ({ children }: { children: ReactNode }) => {
  const dynamicEnabled = parseBoolean(import.meta.env.VITE_DAY1_DYNAMIC_ENABLED, false);
  const environmentIdRaw = String(import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? "").trim();
  const environmentId = environmentIdRaw || null;
  const environmentIdValid = Boolean(environmentIdRaw) && DYNAMIC_ENVIRONMENT_ID_REGEX.test(environmentIdRaw);
  const configured = dynamicEnabled && environmentIdValid;

  const [snapshot, setSnapshot] = useState<DynamicBridgeSnapshot>(DEFAULT_BRIDGE_SNAPSHOT);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const setShowAuthFlowRef = useRef<(visible: boolean) => void>(NOOP_SET_SHOW_AUTH_FLOW);
  const handleLogOutRef = useRef<() => Promise<void>>(NOOP_HANDLE_LOG_OUT);

  useEffect(() => {
    if (!configured || runtimeError || snapshot.sdkHasLoaded || timedOut) return;
    const timeoutId = window.setTimeout(() => {
      setTimedOut(true);
    }, DYNAMIC_INIT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [configured, runtimeError, snapshot.sdkHasLoaded, timedOut]);

  const reason = useMemo(() => {
    if (!dynamicEnabled) {
      return "Dynamic login disabled. Set VITE_DAY1_DYNAMIC_ENABLED=true to enable.";
    }
    if (!environmentIdRaw) {
      return "Dynamic is enabled but VITE_DYNAMIC_ENVIRONMENT_ID is missing.";
    }
    if (!environmentIdValid) {
      return "Dynamic is enabled but VITE_DYNAMIC_ENVIRONMENT_ID is not a valid UUID.";
    }
    if (runtimeError) {
      return `Dynamic runtime error: ${runtimeError}`;
    }
    if (timedOut) {
      return `Dynamic failed to initialize within ${Math.floor(DYNAMIC_INIT_TIMEOUT_MS / 1000)}s (often CORS or dashboard origin mismatch).`;
    }
    return null;
  }, [dynamicEnabled, environmentIdRaw, environmentIdValid, runtimeError, timedOut]);

  const availability: DynamicAvailability = !dynamicEnabled
    ? "disabled"
    : !environmentIdRaw || !environmentIdValid
      ? "misconfigured"
      : reason
        ? "degraded"
        : snapshot.sdkHasLoaded
          ? "ready"
          : "initializing";
  const active = configured && availability !== "degraded";

  const contextValue = useMemo<Day1DynamicContextValue>(
    () => ({
      enabled: dynamicEnabled,
      configured,
      active,
      availability,
      environmentId,
      reason,
      sdkHasLoaded: active ? snapshot.sdkHasLoaded : false,
      user: active ? snapshot.user : null,
      openAuthFlow: () => {
        if (!active) return;
        setShowAuthFlowRef.current(true);
      },
      signOut: async () => {
        if (!active) return;
        await handleLogOutRef.current();
      },
    }),
    [active, availability, configured, dynamicEnabled, environmentId, reason, snapshot]
  );

  const handleBridgeSnapshot = useCallback((nextSnapshot: DynamicBridgeSnapshot) => {
    setShowAuthFlowRef.current = nextSnapshot.setShowAuthFlow;
    handleLogOutRef.current = nextSnapshot.handleLogOut;

    if (nextSnapshot.sdkHasLoaded) {
      setTimedOut((previous) => (previous ? false : previous));
      setRuntimeError((previous) => (previous ? null : previous));
    }

    setSnapshot((previous) => {
      if (previous.sdkHasLoaded === nextSnapshot.sdkHasLoaded && previous.user === nextSnapshot.user) {
        return previous;
      }
      return {
        ...previous,
        sdkHasLoaded: nextSnapshot.sdkHasLoaded,
        user: nextSnapshot.user,
      };
    });
  }, []);

  if (!active) {
    return <Day1DynamicContext.Provider value={contextValue}>{children}</Day1DynamicContext.Provider>;
  }

  return (
    <Day1DynamicContext.Provider value={contextValue}>
      <DynamicErrorBoundary
        onRuntimeError={(error) => {
          const message = toErrorMessage(error, "Unknown Dynamic SDK runtime error.");
          setRuntimeError((previous) => (previous === message ? previous : message));
        }}
      >
        <DynamicContextProvider
          settings={{
            environmentId: environmentIdRaw,
            walletConnectors: [EthereumWalletConnectors],
          }}
        >
          <DynamicBridge
            onSnapshot={handleBridgeSnapshot}
          >
            {children}
          </DynamicBridge>
        </DynamicContextProvider>
      </DynamicErrorBoundary>
    </Day1DynamicContext.Provider>
  );
};
