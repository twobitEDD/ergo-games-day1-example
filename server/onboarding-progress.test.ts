import assert from "node:assert/strict";
import test from "node:test";
import { buildProgressiveAccountCapabilities } from "@twobitedd/ergo-account-model";
import { deriveOnboardingProgress } from "../src/onboardingProgress.ts";

const buildCapabilities = (walletBound: boolean) =>
  buildProgressiveAccountCapabilities({
    sessionActive: true,
    walletBound,
    rewardsWalletRequirement: "required",
    wageringWalletRequirement: "required",
  });

test("deriveOnboardingProgress marks persisted session+wallet as completed", () => {
  const model = deriveOnboardingProgress({
    hasDynamicIdentity: true,
    hasBackendSession: true,
    walletLinked: true,
    walletAddress: "9h123abc",
    hasRecoveryMaterial: true,
    passkeySupported: true,
    passkeyConfigured: true,
    hasExampleGame: true,
    capabilities: buildCapabilities(true),
  });

  assert.equal(model.steps[0].status, "complete");
  assert.equal(model.steps[1].status, "complete");
  assert.equal(model.steps[2].status, "complete");
  assert.equal(model.steps[3].status, "complete");
  assert.equal(model.steps[4].status, "complete");
  assert.equal(model.fullyComplete, true);
});

test("deriveOnboardingProgress keeps recovery step in progress without local recovery evidence", () => {
  const model = deriveOnboardingProgress({
    hasDynamicIdentity: true,
    hasBackendSession: true,
    walletLinked: true,
    walletAddress: "9h987xyz",
    hasRecoveryMaterial: false,
    passkeySupported: true,
    passkeyConfigured: false,
    hasExampleGame: false,
    capabilities: buildCapabilities(true),
  });

  assert.equal(model.steps[0].status, "complete");
  assert.equal(model.steps[1].status, "complete");
  assert.equal(model.steps[2].status, "in_progress");
  assert.equal(model.firstActionableIndex, 2);
});

test("deriveOnboardingProgress treats unsupported passkey as optional complete", () => {
  const model = deriveOnboardingProgress({
    hasDynamicIdentity: true,
    hasBackendSession: true,
    walletLinked: true,
    walletAddress: "9hpasskey",
    hasRecoveryMaterial: true,
    passkeySupported: false,
    passkeyConfigured: false,
    hasExampleGame: false,
    capabilities: buildCapabilities(true),
  });

  assert.equal(model.steps[3].status, "complete");
  assert.equal(model.completedCount >= 4, true);
});

test("deriveOnboardingProgress starts at account connection when session missing", () => {
  const model = deriveOnboardingProgress({
    hasDynamicIdentity: false,
    hasBackendSession: false,
    walletLinked: false,
    walletAddress: null,
    hasRecoveryMaterial: false,
    passkeySupported: true,
    passkeyConfigured: false,
    hasExampleGame: false,
    capabilities: buildProgressiveAccountCapabilities({
      sessionActive: false,
      walletBound: false,
      rewardsWalletRequirement: "required",
      wageringWalletRequirement: "required",
    }),
  });

  assert.equal(model.steps[0].status, "pending");
  assert.equal(model.steps[1].status, "pending");
  assert.equal(model.firstActionableIndex, 0);
});
