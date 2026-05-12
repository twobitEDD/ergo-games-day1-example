const DUPLICATE_ERROR_NAMES = new Set(["InvalidStateError", "ConstraintError"]);

const DUPLICATE_MESSAGE_PATTERNS = [
  /already registered/i,
  /already exists/i,
  /already been registered/i,
  /contains one of the credentials already registered/i,
  /credential.+already/i,
  /duplicate.+credential/i,
];

const DUPLICATE_SERVER_CODE_PATTERNS = [
  /^duplicate_credential$/i,
  /^credential_already_exists$/i,
  /^webauthn_duplicate_credential$/i,
  /^passkey_already_configured$/i,
  /^passkey_already_registered$/i,
];

const toNormalizedString = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const extractErrorName = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  if ("name" in error) {
    return toNormalizedString((error as { name?: unknown }).name);
  }
  return null;
};

const extractErrorMessage = (error: unknown): string | null => {
  if (!error || typeof error !== "object") return null;
  if ("message" in error) {
    return toNormalizedString((error as { message?: unknown }).message);
  }
  return null;
};

const matchesAnyPattern = (value: string | null, patterns: RegExp[]) =>
  Boolean(value && patterns.some((pattern) => pattern.test(value)));

const isDuplicateServerCode = (value: string | null) =>
  Boolean(value && DUPLICATE_SERVER_CODE_PATTERNS.some((pattern) => pattern.test(value)));

export interface DuplicateCredentialSignalInput {
  error?: unknown;
  serverErrorCode?: unknown;
  serverMessage?: unknown;
}

export const isDuplicatePasskeyCredentialSignal = (input: DuplicateCredentialSignalInput): boolean => {
  const errorName = extractErrorName(input.error);
  const errorMessage = extractErrorMessage(input.error);
  const serverErrorCode = toNormalizedString(input.serverErrorCode);
  const serverMessage = toNormalizedString(input.serverMessage);

  if (errorName && DUPLICATE_ERROR_NAMES.has(errorName) && matchesAnyPattern(errorMessage, DUPLICATE_MESSAGE_PATTERNS)) {
    return true;
  }

  if (matchesAnyPattern(errorMessage, DUPLICATE_MESSAGE_PATTERNS)) {
    return true;
  }

  if (isDuplicateServerCode(serverErrorCode)) {
    return true;
  }

  if (matchesAnyPattern(serverMessage, DUPLICATE_MESSAGE_PATTERNS)) {
    return true;
  }

  return false;
};
