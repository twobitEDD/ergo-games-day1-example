import type { ProgressiveAccountCapabilities } from "@twobitedd/ergo-account-model";

export type OnboardingStepStatus = "complete" | "in_progress" | "pending";

export type OnboardingStepAction =
  | "dynamic_sync"
  | "create_wallet"
  | "save_recovery"
  | "setup_passkey"
  | "start_example_game";

export interface OnboardingStep {
  id: "account_connected" | "wallet_linked" | "recovery_saved" | "passkey_setup" | "example_game";
  title: string;
  description: string;
  status: OnboardingStepStatus;
  evidence: string;
  action: OnboardingStepAction;
  actionLabel: string;
  required: boolean;
}

export interface DeriveOnboardingStepsInput {
  hasDynamicIdentity: boolean;
  hasBackendSession: boolean;
  walletLinked: boolean;
  walletAddress: string | null;
  hasRecoveryMaterial: boolean;
  passkeySupported: boolean;
  passkeyConfigured: boolean;
  hasExampleGame: boolean;
  capabilities: ProgressiveAccountCapabilities;
}

export interface OnboardingProgressModel {
  steps: OnboardingStep[];
  completedCount: number;
  totalCount: number;
  firstActionableIndex: number;
  fullyComplete: boolean;
}

const toWalletEvidence = (walletLinked: boolean, walletAddress: string | null) => {
  if (!walletLinked) return "Secure wallet is not linked yet.";
  return `Linked wallet: ${walletAddress ?? "address unavailable"}.`;
};

const toCapabilitiesEvidence = (capabilities: ProgressiveAccountCapabilities) => {
  const rewardsState = capabilities.layers.rewards.eligible ? "ready" : "locked";
  const wageringState = capabilities.layers.wagering.eligible ? "ready" : "locked";
  return `Capabilities check - rewards: ${rewardsState}, wager: ${wageringState}.`;
};

export const deriveOnboardingProgress = (input: DeriveOnboardingStepsInput): OnboardingProgressModel => {
  const capabilityHint = toCapabilitiesEvidence(input.capabilities);

  const step1Status: OnboardingStepStatus = input.hasBackendSession
    ? "complete"
    : input.hasDynamicIdentity
      ? "in_progress"
      : "pending";
  const step2Status: OnboardingStepStatus = !input.hasBackendSession
    ? "pending"
    : input.walletLinked
      ? "complete"
      : "in_progress";
  const step3Status: OnboardingStepStatus = !input.walletLinked
    ? "pending"
    : input.hasRecoveryMaterial
      ? "complete"
      : "in_progress";
  const step4Status: OnboardingStepStatus = !input.walletLinked
    ? "pending"
    : input.passkeyConfigured || !input.passkeySupported
      ? "complete"
      : "in_progress";
  const step5Status: OnboardingStepStatus = !input.hasBackendSession
    ? "pending"
    : input.hasExampleGame
      ? "complete"
      : "in_progress";

  const steps: OnboardingStep[] = [
    {
      id: "account_connected",
      title: "Step 1: Account connected",
      description: "Connect Dynamic to Day1 so your account can be restored on refresh and future visits.",
      status: step1Status,
      evidence: input.hasBackendSession
        ? "Day1 session is active from backend session records."
        : input.hasDynamicIdentity
          ? "Dynamic identity found. Finish Dynamic -> Day1 Session to complete."
          : "No active Dynamic identity or Day1 session detected.",
      action: "dynamic_sync",
      actionLabel: "Complete account connection",
      required: true,
    },
    {
      id: "wallet_linked",
      title: "Step 2: Secure your account",
      description: "Create a secure wallet so your account setup is protected and tied to you.",
      status: step2Status,
      evidence: toWalletEvidence(input.walletLinked, input.walletAddress),
      action: "create_wallet",
      actionLabel: "Create secure wallet",
      required: true,
    },
    {
      id: "recovery_saved",
      title: "Step 3: Save recovery code",
      description: "Save your recovery code in a safe place so you can restore access later.",
      status: step3Status,
      evidence: input.hasRecoveryMaterial
        ? "Recovery code has been generated and saved on this device."
        : input.walletLinked
          ? "Wallet is ready. Save the recovery code before continuing."
          : "Create your secure wallet first to unlock this step.",
      action: "save_recovery",
      actionLabel: "Review and save recovery code",
      required: true,
    },
    {
      id: "passkey_setup",
      title: "Step 4: Add passkey protection",
      description: "Add Touch ID or Face ID for faster sign-in on supported devices.",
      status: step4Status,
      evidence:
        !input.passkeySupported
          ? "Passkeys are not supported on this device, so this step is optional."
          : input.passkeyConfigured
            ? "Passkey protection is enabled on this device."
            : input.walletLinked
              ? "Passkey setup is available now."
              : "Create your secure wallet first to unlock this step.",
      action: "setup_passkey",
      actionLabel: "Set up passkey",
      required: false,
    },
    {
      id: "example_game",
      title: "Step 5: Play an example game",
      description: "Start a quick example Tic-Tac-Toe game to confirm your setup is working end to end.",
      status: step5Status,
      evidence: input.hasExampleGame
        ? `Example game found in your backend lobby history. ${capabilityHint}`
        : `No example game found yet. ${capabilityHint}`,
      action: "start_example_game",
      actionLabel: "Start example game",
      required: true,
    },
  ];

  const completedCount = steps.filter((step) => step.status === "complete").length;
  const firstActionableIndex = steps.findIndex((step) => step.status !== "complete");
  const requiredSteps = steps.filter((step) => step.required);

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    firstActionableIndex: firstActionableIndex === -1 ? steps.length - 1 : firstActionableIndex,
    fullyComplete: requiredSteps.every((step) => step.status === "complete"),
  };
};
