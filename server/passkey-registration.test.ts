import assert from "node:assert/strict";
import test from "node:test";
import { isDuplicatePasskeyCredentialSignal } from "../src/passkeyRegistration.ts";

test("detects duplicate credential via WebAuthn InvalidStateError", () => {
  const duplicateSignal = isDuplicatePasskeyCredentialSignal({
    error: {
      name: "InvalidStateError",
      message:
        "The user attempted to register an authenticator that contains one of the credentials already registered with the relying party.",
    },
  });

  assert.equal(duplicateSignal, true);
});

test("detects duplicate credential via server duplicate code", () => {
  const duplicateSignal = isDuplicatePasskeyCredentialSignal({
    serverErrorCode: "WEBAUTHN_DUPLICATE_CREDENTIAL",
  });

  assert.equal(duplicateSignal, true);
});

test("does not classify user cancel as duplicate", () => {
  const duplicateSignal = isDuplicatePasskeyCredentialSignal({
    error: {
      name: "NotAllowedError",
      message: "The operation either timed out or was not allowed.",
    },
  });

  assert.equal(duplicateSignal, false);
});
