import { createContext, useContext } from "react";

export type DynamicAvailability = "disabled" | "misconfigured" | "initializing" | "ready" | "degraded";

export interface Day1DynamicContextValue {
  enabled: boolean;
  configured: boolean;
  active: boolean;
  availability: DynamicAvailability;
  environmentId: string | null;
  reason: string | null;
  sdkHasLoaded: boolean;
  user: Record<string, unknown> | null;
  openAuthFlow: () => void;
  signOut: () => Promise<void>;
}

export const DEFAULT_DAY1_DYNAMIC_CONTEXT: Day1DynamicContextValue = {
  enabled: false,
  configured: false,
  active: false,
  availability: "disabled",
  environmentId: null,
  reason: "Dynamic login disabled. Set VITE_DAY1_DYNAMIC_ENABLED=true to enable.",
  sdkHasLoaded: false,
  user: null,
  openAuthFlow: () => {
    // no-op fallback when Dynamic is disabled/unavailable
  },
  signOut: async () => {
    // no-op fallback when Dynamic is disabled/unavailable
  },
};

export const Day1DynamicContext = createContext<Day1DynamicContextValue>(DEFAULT_DAY1_DYNAMIC_CONTEXT);

export const useDay1Dynamic = () => useContext(Day1DynamicContext);
