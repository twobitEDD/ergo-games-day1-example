import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Day1DynamicContext,
  type Day1DynamicContextValue,
  type DynamicAvailability,
} from "./day1DynamicState";
import type { DynamicBridgeSnapshot } from "./DynamicRuntimeBridge";

const DYNAMIC_INIT_TIMEOUT_MS = 8000;
const DYNAMIC_ENVIRONMENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DynamicRuntimeBridge = lazy(() =>
  import("./DynamicRuntimeBridge").then((module) => ({ default: module.DynamicRuntimeBridge }))
);

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
  getAuthToken: () => null,
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

export const DynamicProvider = ({ children }: { children: ReactNode }) => {
  const dynamicEnabled = parseBoolean(import.meta.env.VITE_DAY1_DYNAMIC_ENABLED, false);
  const dynamicAutoStart = parseBoolean(import.meta.env.VITE_DAY1_DYNAMIC_AUTOSTART, true);
  const environmentIdRaw = String(import.meta.env.VITE_DYNAMIC_ENVIRONMENT_ID ?? "").trim();
  const environmentId = environmentIdRaw || null;
  const environmentIdValid = Boolean(environmentIdRaw) && DYNAMIC_ENVIRONMENT_ID_REGEX.test(environmentIdRaw);
  const configured = dynamicEnabled && environmentIdValid;

  const [activated, setActivated] = useState(dynamicAutoStart);
  const [snapshot, setSnapshot] = useState<DynamicBridgeSnapshot>(DEFAULT_BRIDGE_SNAPSHOT);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const setShowAuthFlowRef = useRef<(visible: boolean) => void>(NOOP_SET_SHOW_AUTH_FLOW);
  const handleLogOutRef = useRef<() => Promise<void>>(NOOP_HANDLE_LOG_OUT);
  const pendingOpenAuthFlowRef = useRef(false);

  useEffect(() => {
    if (!configured || !activated || runtimeError || snapshot.sdkHasLoaded || timedOut) return;
    const timeoutId = window.setTimeout(() => {
      setTimedOut(true);
    }, DYNAMIC_INIT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activated, configured, runtimeError, snapshot.sdkHasLoaded, timedOut]);

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
    if (!activated) {
      return "Dynamic login is available but deferred until you explicitly enable it.";
    }
    if (runtimeError) {
      return `Dynamic runtime error: ${runtimeError}`;
    }
    if (timedOut) {
      return `Dynamic failed to initialize within ${Math.floor(DYNAMIC_INIT_TIMEOUT_MS / 1000)}s (often CORS or dashboard origin mismatch).`;
    }
    return null;
  }, [activated, dynamicEnabled, environmentIdRaw, environmentIdValid, runtimeError, timedOut]);

  const availability: DynamicAvailability = !dynamicEnabled
    ? "disabled"
    : !environmentIdRaw || !environmentIdValid
      ? "misconfigured"
      : !activated
        ? "idle"
      : reason
        ? "degraded"
        : snapshot.sdkHasLoaded
          ? "ready"
          : "initializing";
  const active = configured && activated && availability !== "degraded";

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
      requestActivation: () => {
        if (!configured) return;
        setActivated(true);
      },
      openAuthFlow: () => {
        if (!configured) return;
        if (!activated) {
          setActivated(true);
          pendingOpenAuthFlowRef.current = true;
          return;
        }
        if (!snapshot.sdkHasLoaded) {
          pendingOpenAuthFlowRef.current = true;
          return;
        }
        setShowAuthFlowRef.current(true);
      },
      getAuthToken: () => {
        if (!active) return null;
        return snapshot.getAuthToken();
      },
      signOut: async () => {
        if (!active) return;
        await handleLogOutRef.current();
      },
    }),
    [activated, active, availability, configured, dynamicEnabled, environmentId, reason, snapshot]
  );

  const handleBridgeSnapshot = useCallback((nextSnapshot: DynamicBridgeSnapshot) => {
    setShowAuthFlowRef.current = nextSnapshot.setShowAuthFlow;
    handleLogOutRef.current = nextSnapshot.handleLogOut;

    if (nextSnapshot.sdkHasLoaded) {
      setTimedOut((previous) => (previous ? false : previous));
      setRuntimeError((previous) => (previous ? null : previous));
      if (pendingOpenAuthFlowRef.current) {
        pendingOpenAuthFlowRef.current = false;
        nextSnapshot.setShowAuthFlow(true);
      }
    }

    setSnapshot((previous) => {
      if (
        previous.sdkHasLoaded === nextSnapshot.sdkHasLoaded &&
        previous.user === nextSnapshot.user &&
        previous.getAuthToken === nextSnapshot.getAuthToken
      ) {
        return previous;
      }
      return {
        ...previous,
        sdkHasLoaded: nextSnapshot.sdkHasLoaded,
        user: nextSnapshot.user,
        getAuthToken: nextSnapshot.getAuthToken,
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
        <Suspense fallback={children}>
          <DynamicRuntimeBridge onSnapshot={handleBridgeSnapshot} environmentId={environmentIdRaw}>
            {children}
          </DynamicRuntimeBridge>
        </Suspense>
      </DynamicErrorBoundary>
    </Day1DynamicContext.Provider>
  );
};
