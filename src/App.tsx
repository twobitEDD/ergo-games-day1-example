import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildExportArtifact,
  buildAccountSession,
  buildProgressiveAccountCapabilities,
  getPortabilityStatus,
  validateExportArtifact,
  type AccountTransferIntent,
  type ProgressiveAccountCapabilities,
  type WalletSourceKind,
} from "@twobitedd/ergo-account-model";
import { CELL_EMPTY, CELL_O, CELL_X, statusOf, type Board, type GameType, type GameTypeMetadata } from "@twobitedd/ergo-games-interface";
import {
  apiRegister,
  apiLogin,
  apiGuestLogin,
  apiDynamicLogin,
  apiAuthSync,
  apiBindWallet,
  apiCreateGame,
  apiCreateOnChainIntent,
  apiGetRatificationSchedule,
  apiSetRatificationSchedule,
  apiRunRatification,
  apiListRatificationBatches,
  apiGetTruthStack,
  apiSubmitSignedRatificationBatch,
  apiGetServerWalletStatus,
  apiGetGame,
  apiGetIntentStatus,
  apiJoinGame,
  apiListGames,
  apiListGameTypes,
  apiListRecentPlayers,
  apiGetLeaderboard,
  apiGetProfile,
  apiGetRewards,
  apiGetCapabilities,
  apiGetAccountSecurityState,
  apiSignOut,
  apiGetSession,
  apiMove,
  apiRequestRecovery,
  apiResetRecovery,
  apiStartTotpEnrollment,
  apiVerifyTotpEnrollment,
  apiDisableTotp,
  apiListTrustedDevices,
  apiTrustCurrentDevice,
  apiRevokeDevice,
  apiListSessions,
  apiRevokeSession,
  apiGetSecurityMetrics,
  clearClientAuthBootstrap,
  type ApiGame,
  type ApiSession,
  type ApiProfile,
  type ApiAccountSecurityState,
  type ApiSecurityMetric,
  type ApiGameCompletion,
  type ApiGameStatus,
  type ApiGameListItem,
  type ApiRecentPlayer,
  type ApiLeaderboardEntry,
  type ApiRewardSnapshot,
  type ApiRatificationBatch,
  type ApiRatificationSchedule,
  type ApiRatificationCheckpoint,
  type ApiServerWalletStatus,
  type ApiRatificationAdapterInfo,
  type ApiTruthStack,
  type ApiTruthStackItem,
} from "./api";
import { deriveCompletionFromStatus } from "./game-hydration";
import { useDay1Dynamic } from "./day1DynamicState";
import {
  isDynamicConfigurationError,
  isHardDynamicBridgeError,
  retryWithBoundedBackoff,
  shouldRetryDynamicBridgeError,
  shouldStartAutoBridgeAttempt,
  waitForAuthTokenWithRetry,
} from "./dynamicSessionSync";
import { deriveAccountProgression } from "./accountProgression";
import { deriveOnboardingProgress, type OnboardingStepAction, type OnboardingStepStatus } from "./onboardingProgress";
import { isDuplicatePasskeyCredentialSignal } from "./passkeyRegistration";
import { deriveTransferIntentReadModel } from "./transferIntents";
import "./App.css";

const ENCRYPTED_VAULT_LOCAL_STORAGE_KEY = "ergo-dynamic-vault-v1";
const ENCRYPTED_VAULT_DYNAMIC_METADATA_KEY = "ergoVaultV1";
const RECOVERY_SECRET_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LIVE_SYNC_INTERVAL_MS = 4000;
const GAME_TYPES_MAX_RETRIES = 3;
const GAME_TYPES_RETRY_DELAY_MS = 220;
const DYNAMIC_TOKEN_MAX_RETRIES = 4;
const DYNAMIC_TOKEN_RETRY_DELAY_MS = 180;
const SESSION_VERIFY_MAX_RETRIES = 4;
const SESSION_VERIFY_RETRY_DELAY_MS = 220;
const DYNAMIC_LOGIN_MAX_ATTEMPTS = 3;
const DYNAMIC_LOGIN_RETRY_BASE_DELAY_MS = 250;
const DYNAMIC_LOGIN_RETRY_MAX_DELAY_MS = 1400;
const ACCOUNT_REPAIR_SYNC_INTERVAL_MS = 15000;
// Auto-bridge guardrails: keep retries rare, bounded, and identity-scoped.
const AUTO_BRIDGE_MAX_ATTEMPTS_PER_IDENTITY = 3;
const AUTO_BRIDGE_COOLDOWN_BASE_MS = 4000;
const AUTO_BRIDGE_COOLDOWN_MAX_MS = 30000;
const AUTO_BRIDGE_MIN_ATTEMPT_GAP_MS = 1500;
const AUTO_BRIDGE_SUCCESS_MESSAGE_MS = 1500;
const LazyDynamicWidget = lazy(() =>
  import("./DynamicWidgetSlot").then((module) => ({ default: module.DynamicWidgetSlot }))
);

interface EncryptedVaultRecord {
  v: number;
  ergoAddress: string;
  passkey?: unknown;
  passkeyEncrypted?: { iv?: unknown; ciphertext?: unknown } | null;
  recoveryEncrypted?: { iv?: unknown; ciphertext?: unknown; salt?: unknown } | null;
  createdAt: number;
}

type ExportVaultSource = "local-storage" | "dynamic-metadata";

interface ExportVaultCandidate {
  source: ExportVaultSource;
  record: EncryptedVaultRecord;
}

const isEncryptedVaultRecord = (value: unknown): value is EncryptedVaultRecord => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.v === "number" &&
    typeof candidate.ergoAddress === "string" &&
    typeof candidate.createdAt === "number"
  );
};

const loadExportVaultCandidate = (dynamicUser: Record<string, unknown> | null): ExportVaultCandidate | null => {
  if (typeof window !== "undefined") {
    try {
      const fromLocalStorage = window.localStorage.getItem(ENCRYPTED_VAULT_LOCAL_STORAGE_KEY);
      if (fromLocalStorage) {
        const parsed = JSON.parse(fromLocalStorage);
        if (isEncryptedVaultRecord(parsed)) {
          return { source: "local-storage", record: parsed };
        }
      }
    } catch {
      // Ignore malformed local storage values.
    }
  }

  const metadata = dynamicUser?.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const dynamicVaultCandidate = (metadata as Record<string, unknown>)[ENCRYPTED_VAULT_DYNAMIC_METADATA_KEY];
  if (isEncryptedVaultRecord(dynamicVaultCandidate)) {
    return { source: "dynamic-metadata", record: dynamicVaultCandidate };
  }
  return null;
};

const downloadJsonFile = (fileName: string, payload: unknown): void => {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return window.btoa(binary);
};

const toBase64Url = (bytes: Uint8Array): string =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = window.atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};

const createRecoverySecretCode = (): string => {
  const random = new Uint8Array(20);
  crypto.getRandomValues(random);
  const secret = Array.from(random, (value) => RECOVERY_SECRET_ALPHABET[value % RECOVERY_SECRET_ALPHABET.length]).join("");
  return secret.match(/.{1,4}/g)?.join("-") ?? secret;
};

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const deriveManagedWalletAddress = async (seed: string): Promise<string> => {
  const hash = await sha256Hex(seed);
  return `9h${hash.slice(0, 49)}`;
};

const encryptRecoveryPayload = async (
  recoverySecretCode: string,
  payload: Record<string, unknown>
): Promise<{ iv: string; ciphertext: string; salt: string }> => {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(recoverySecretCode),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 160000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return {
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    salt: toBase64(salt),
  };
};

const decryptRecoveryPayload = async (
  recoverySecretCode: string,
  encryptedPayload: { iv?: unknown; ciphertext?: unknown; salt?: unknown } | null | undefined
): Promise<Record<string, unknown> | null> => {
  if (
    !encryptedPayload ||
    typeof encryptedPayload.iv !== "string" ||
    typeof encryptedPayload.ciphertext !== "string" ||
    typeof encryptedPayload.salt !== "string"
  ) {
    return null;
  }
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(recoverySecretCode),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: Uint8Array.from(window.atob(encryptedPayload.salt), (char) => char.charCodeAt(0)),
      iterations: 160000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(window.atob(encryptedPayload.iv), (char) => char.charCodeAt(0)) },
    key,
    Uint8Array.from(window.atob(encryptedPayload.ciphertext), (char) => char.charCodeAt(0))
  );
  return JSON.parse(new TextDecoder().decode(decrypted)) as Record<string, unknown>;
};

const toSymbol = (cell: Board[number]): "" | "X" | "O" => {
  if (cell === CELL_X) return "X";
  if (cell === CELL_O) return "O";
  return "";
};

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const isTransientSessionHydrationError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("SESSION_NOT_FOUND") ||
    message.includes("MISSING_SESSION") ||
    message.includes("401")
  );
};

const deriveGameTypesFailureMessage = (error: unknown) => {
  if (isTransientSessionHydrationError(error)) {
    return "Game types could not load because the Day1 session is missing or expired. Re-run Dynamic -> Day1 Session and verify deploy cookie/CORS settings.";
  }
  const detail = error instanceof Error ? error.message : String(error ?? "Unknown request failure");
  return `Game types could not load: ${detail}`;
};

const toOnboardingStatusCopy = (status: OnboardingStepStatus) => {
  if (status === "complete") return "Completed";
  if (status === "in_progress") return "In progress";
  return "Not started";
};

const FALLBACK_GAME_TYPES: GameTypeMetadata[] = [
  {
    gameType: "tic_tac_toe",
    displayName: "Tic-Tac-Toe",
    description: "Fallback local mode when game-type registry fetch is unavailable.",
    supportsMoves: true,
    maturity: "ga",
  },
  {
    gameType: "coin_flip_demo",
    displayName: "Coin Flip (Demo Adapter)",
    description: "Fallback preview adapter while recovering game-type registry fetch.",
    supportsMoves: false,
    maturity: "preview",
  },
];

interface DynamicLoginPanelProps {
  busy: boolean;
  isSignedIn: boolean;
  syncInProgress: boolean;
  syncStatusMessage: string | null;
  syncErrorMessage: string | null;
  onSync: (payload: { email?: string; displayName?: string }) => void;
}

interface LocalPasskeyRecord {
  credentialId: string;
  rpId: string;
  createdAt: string;
  transports: string[];
}

type PasskeySetupState =
  | { status: "idle"; message: null }
  | { status: "success" | "already_configured" | "unsupported" | "skipped" | "error"; message: string };

type RecoveryImportState =
  | { status: "idle"; message: null }
  | { status: "success" | "warning" | "error"; message: string };

type DynamicBridgeSource = "manual" | "auto";

const DynamicLoginPanel = ({
  busy,
  isSignedIn,
  syncInProgress,
  syncStatusMessage,
  syncErrorMessage,
  onSync,
}: DynamicLoginPanelProps) => {
  const dynamic = useDay1Dynamic();
  const dynamicUser = dynamic.user;
  const dynamicEmail = typeof dynamicUser?.email === "string" ? dynamicUser.email : undefined;
  const firstName = typeof dynamicUser?.firstName === "string" ? dynamicUser.firstName : "";
  const lastName = typeof dynamicUser?.lastName === "string" ? dynamicUser.lastName : "";
  const dynamicDisplayName = [firstName, lastName].filter(Boolean).join(" ").trim() || dynamicEmail;
  const handleSync = () => {
    onSync({ email: dynamicEmail, displayName: dynamicDisplayName || undefined });
  };
  const sdkReady = dynamic.active && dynamic.sdkHasLoaded;
  const authTokenReady = sdkReady && Boolean(dynamicUser);

  return (
    <div className="row">
      <button
        type="button"
        title="Open Dynamic login/signup so you can connect identity before syncing to Day1."
        disabled={busy || !dynamic.enabled || !dynamic.configured}
        onClick={dynamic.openAuthFlow}
      >
        Open Dynamic Auth
      </button>
      {dynamic.availability === "idle" ? (
        <button
          type="button"
          title="Activate the optional Dynamic auth module when it has not been initialized yet."
          disabled={busy || !dynamic.enabled || !dynamic.configured}
          onClick={dynamic.requestActivation}
        >
          Enable Dynamic Auth Module
        </button>
      ) : null}
      <button
        type="button"
        title="Exchange Dynamic identity for a Day1 backend session used by onboarding and gameplay."
        disabled={busy || !authTokenReady}
        onClick={handleSync}
      >
        {syncInProgress ? "Syncing Dynamic -> Day1..." : "Dynamic -> Day1 Session"}
      </button>
      <button
        type="button"
        title="Sign out from Dynamic in this browser."
        disabled={busy || !sdkReady || !dynamicUser}
        onClick={() => void dynamic.signOut()}
      >
        Dynamic Sign Out
      </button>
      <small>
        Dynamic user: {dynamicEmail ?? "not authenticated"} | Day1 session: {isSignedIn ? "active" : "none"}
      </small>
      {syncStatusMessage ? <small>{syncStatusMessage}</small> : null}
      {syncErrorMessage ? <p className="dynamicStatus dynamicStatus--degraded">{syncErrorMessage}</p> : null}
      {!authTokenReady ? (
        <small>
          Sign into Dynamic first, then retry Day1 session sync. If auth appears stuck, reopen Dynamic auth.
        </small>
      ) : null}
      {dynamic.active ? (
        <Suspense fallback={<small>Loading Dynamic UI...</small>}>
          <LazyDynamicWidget />
        </Suspense>
      ) : null}
    </div>
  );
};

function App() {
  const dynamic = useDay1Dynamic();
  const dynamicUser = dynamic.user;
  const [walletAddress, setWalletAddress] = useState("");
  const [backendSession, setBackendSession] = useState<ApiSession | null>(null);
  const [profile, setProfile] = useState<ApiProfile | null>(null);
  const [accountSecurityState, setAccountSecurityState] = useState<ApiAccountSecurityState | null>(null);
  const [sessionCapabilities, setSessionCapabilities] = useState<ProgressiveAccountCapabilities | null>(null);
  const [games, setGames] = useState<ApiGameListItem[]>([]);
  const [gameTypes, setGameTypes] = useState<GameTypeMetadata[]>([]);
  const [selectedGameType, setSelectedGameType] = useState<GameType>("tic_tac_toe");
  const [knownPlayers, setKnownPlayers] = useState<ApiRecentPlayer[]>([]);
  const [leaderboard, setLeaderboard] = useState<ApiLeaderboardEntry[]>([]);
  const [game, setGame] = useState<ApiGame | null>(null);
  const [playerSymbol, setPlayerSymbol] = useState<"X" | "O" | null>(null);
  const [gameStatusFromServer, setGameStatusFromServer] = useState<ApiGameStatus | null>(null);
  const [completion, setCompletion] = useState<ApiGameCompletion | null>(null);
  const [joinGameId, setJoinGameId] = useState("");
  const [rewards, setRewards] = useState<ApiRewardSnapshot | null>(null);
  const [intentId, setIntentId] = useState("");
  const [transferIntents] = useState<AccountTransferIntent[]>([]);
  const [recoveryEmail, setRecoveryEmail] = useState("player@example.local");
  const [localAuthDisplayName, setLocalAuthDisplayName] = useState("Local Player");
  const [localAuthEmail, setLocalAuthEmail] = useState("player@example.local");
  const [localAuthPassword, setLocalAuthPassword] = useState("localpass1234");
  const [recoveryToken, setRecoveryToken] = useState("");
  const [recoveryNewPassword, setRecoveryNewPassword] = useState("localpass1234");
  const [mfaCodeInput, setMfaCodeInput] = useState("");
  const [mfaSecretPreview, setMfaSecretPreview] = useState("");
  const [trustedDevices, setTrustedDevices] = useState<Array<{ deviceId: string; label?: string }>>([]);
  const [activeSessions, setActiveSessions] = useState<Array<{ sessionId: string; deviceId?: string }>>([]);
  const [securityMetrics, setSecurityMetrics] = useState<ApiSecurityMetric[]>([]);
  const [walletStatus, setWalletStatus] = useState<ApiServerWalletStatus | null>(null);
  const [ratificationSchedule, setRatificationSchedule] = useState<ApiRatificationSchedule | null>(null);
  const [ratificationCheckpoint, setRatificationCheckpoint] = useState<ApiRatificationCheckpoint | null>(null);
  const [ratificationBatches, setRatificationBatches] = useState<ApiRatificationBatch[]>([]);
  const [ratificationAdapter, setRatificationAdapter] = useState<ApiRatificationAdapterInfo | null>(null);
  const [truthStack, setTruthStack] = useState<ApiTruthStack | null>(null);
  const [ratificationIntervalMs, setRatificationIntervalMs] = useState("20000");
  const [signedBatchId, setSignedBatchId] = useState("");
  const [signedTxHex, setSignedTxHex] = useState("");
  const [eventLog, setEventLog] = useState("Ready. Sign in with Dynamic or start as guest.");
  const [latestRecoverySecret, setLatestRecoverySecret] = useState<string | null>(null);
  const [latestRecoveryIssuedAt, setLatestRecoveryIssuedAt] = useState<string | null>(null);
  const [recoverySecretInput, setRecoverySecretInput] = useState("");
  const [recoveryImportState, setRecoveryImportState] = useState<RecoveryImportState>({ status: "idle", message: null });
  const [lastBackupExportAt, setLastBackupExportAt] = useState<string | null>(null);
  const [isSecureWalletModalOpen, setIsSecureWalletModalOpen] = useState(false);
  const [secureWalletConfirmationChecked, setSecureWalletConfirmationChecked] = useState(false);
  const [passkeySetupState, setPasskeySetupState] = useState<PasskeySetupState>({ status: "idle", message: null });
  const [busy, setBusy] = useState(false);
  const [lobbyFilter, setLobbyFilter] = useState<"all" | "open" | "active" | "completed">("all");
  const [gameTypesLoadState, setGameTypesLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [gameTypesLoadError, setGameTypesLoadError] = useState<string | null>(null);
  const [authBlockingReason, setAuthBlockingReason] = useState<string | null>(null);
  const [dynamicSyncStatusMessage, setDynamicSyncStatusMessage] = useState<string | null>(null);
  const [dynamicSyncErrorMessage, setDynamicSyncErrorMessage] = useState<string | null>(null);
  const [dynamicSyncInProgress, setDynamicSyncInProgress] = useState(false);
  const [dynamicAuthMode, setDynamicAuthMode] = useState<"jwt_verified" | null>(null);
  const lobbyRequestRef = useRef(0);
  const walletBindingSectionRef = useRef<HTMLElement | null>(null);
  const walletRecoverySectionRef = useRef<HTMLElement | null>(null);
  const lobbySectionRef = useRef<HTMLElement | null>(null);
  const walletAddressInputRef = useRef<HTMLInputElement | null>(null);
  const dynamicSyncInFlightRef = useRef<Promise<boolean> | null>(null);
  const autoBridgeAttemptsRef = useRef(0);
  const autoBridgeCooldownUntilRef = useRef(0);
  const autoBridgeIdentityRef = useRef<string | null>(null);
  const autoBridgeReadyRef = useRef(false);
  const autoBridgeHardBlockedIdentityRef = useRef<string | null>(null);
  const autoBridgeLastAttemptAtRef = useRef(0);
  const autoBridgeStatusTimerRef = useRef<number | null>(null);

  const gameStatus = useMemo(() => {
    if (gameStatusFromServer) return gameStatusFromServer;
    if (!game || game.gameType !== "tic_tac_toe") return null;
    const typedState = game.state as { board: Board; open: boolean };
    return statusOf(typedState.board, typedState.open);
  }, [game, gameStatusFromServer]);
  const isTicTacToeGame = game?.gameType === "tic_tac_toe";

  const canPlayCurrentTurn =
    gameStatus?.kind === "ongoing" && playerSymbol !== null && gameStatus.turn === playerSymbol;
  const canJoinLobbyEntry = (entry: ApiGameListItem) => {
    const me = backendSession?.userId;
    if (!me) return false;
    if (entry.playerSeats.X === me || entry.playerSeats.O === me) return true;
    return entry.playerSeats.O === null && entry.status.kind !== "won" && entry.status.kind !== "drawn";
  };

  const statusMessage =
    !gameStatus
      ? "No active game"
      : gameStatus.kind === "ongoing"
      ? `Turn: ${gameStatus.turn}`
      : gameStatus.kind === "won"
        ? `Winner: ${gameStatus.winner}`
        : gameStatus.kind === "drawn"
          ? "Draw"
          : "Game is open";
  const isSignedIn = Boolean(backendSession);
  const hasExampleGame = useMemo(() => {
    const userId = backendSession?.userId;
    if (!userId) return false;
    if (
      game?.gameType === "tic_tac_toe" &&
      (game.playerSeats.X === userId || game.playerSeats.O === userId || game.participants.includes(userId))
    ) {
      return true;
    }
    return games.some(
      (entry) => entry.gameType === "tic_tac_toe" && (entry.playerSeats.X === userId || entry.playerSeats.O === userId)
    );
  }, [backendSession?.userId, game, games]);
  const dynamicStatusMessage = useMemo(() => {
    if (dynamic.availability === "ready") return null;
    if (dynamic.availability === "initializing") {
      return "Dynamic is initializing. If it remains unavailable, verify dashboard origins include http://localhost:5173 and reload.";
    }
    if (dynamic.availability === "idle") {
      return "Dynamic login is available but deferred. Enable the Dynamic module to activate wallet/auth SDKs.";
    }
    if (dynamic.availability === "disabled") {
      return "Dynamic login is disabled. Set VITE_DAY1_DYNAMIC_ENABLED=true and VITE_DYNAMIC_ENVIRONMENT_ID=<your-env-id> to turn it on.";
    }
    if (dynamic.availability === "misconfigured") {
      return "Dynamic is misconfigured. Set VITE_DYNAMIC_ENVIRONMENT_ID to your Dynamic environment UUID and enable VITE_DAY1_DYNAMIC_ENABLED=true.";
    }
    return `${dynamic.reason ?? "Dynamic is unavailable."} Fix Dynamic dashboard origins/domains and verify env values before retrying.`;
  }, [dynamic.availability, dynamic.reason]);
  const dynamicEmail = typeof dynamicUser?.email === "string" ? dynamicUser.email : undefined;
  const dynamicDisplayName =
    [typeof dynamicUser?.firstName === "string" ? dynamicUser.firstName : "", typeof dynamicUser?.lastName === "string" ? dynamicUser.lastName : ""]
      .filter(Boolean)
      .join(" ")
      .trim() || dynamicEmail;
  const dynamicIdentityKey =
    (typeof dynamicUser?.userId === "string" && dynamicUser.userId.trim()
      ? `user:${dynamicUser.userId.trim()}`
      : typeof dynamicUser?.email === "string" && dynamicUser.email.trim()
        ? `email:${dynamicUser.email.trim().toLowerCase()}`
        : null);
  const exportVaultCandidate = loadExportVaultCandidate(dynamicUser);
  const localPasskeyRecord =
    exportVaultCandidate?.record.passkey &&
    typeof exportVaultCandidate.record.passkey === "object"
      ? (exportVaultCandidate.record.passkey as LocalPasskeyRecord)
      : null;
  const hasLocalPasskey = Boolean(localPasskeyRecord?.credentialId);
  const passkeyFeatureSupported =
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    "PublicKeyCredential" in window &&
    Boolean(navigator.credentials?.create);
  const externalAuthRef =
    (typeof dynamicUser?.userId === "string" && dynamicUser.userId.trim()
      ? dynamicUser.userId
      : typeof dynamicUser?.email === "string" && dynamicUser.email.trim()
        ? dynamicUser.email
        : profile?.userId
          ? `day1:${profile.userId}`
          : null);
  const providerLinks = useMemo(
    () =>
      externalAuthRef
        ? [
            {
              providerId: "dynamic" as const,
              subjectRef: externalAuthRef,
              status: "linked" as const,
              emailAtLink: profile?.email ?? null,
            },
          ]
        : [],
    [externalAuthRef, profile?.email]
  );
  const accountModelSession = useMemo(() => {
    const walletSource: WalletSourceKind = profile?.walletStatus === "bound_stub" ? "nautilus-direct" : null;
    return buildAccountSession({
      walletConnected: profile?.walletStatus === "bound_stub",
      walletSource,
      ergoAddress: profile?.walletAddress ?? null,
      accountId: profile?.userId ?? null,
      externalAuthRef,
      providerLinks,
      recoveryEmail: profile?.email ?? null,
      serverRegistry: profile?.userId
        ? {
            authority: "server-registry",
            registryId: "day1-registry",
            userId: profile.userId,
            continuityKey: profile.userId,
            recoveryEmail: profile.email,
          }
        : undefined,
      dynamicUser: profile
        ? {
            id: profile.userId,
            email: profile.email,
            externalAuthRef: externalAuthRef ?? undefined,
          }
        : null,
      vault: exportVaultCandidate
        ? {
            ergoAddress: exportVaultCandidate.record.ergoAddress,
            hasPasskeyWrap: Boolean(
              exportVaultCandidate.record.passkey &&
                exportVaultCandidate.record.passkeyEncrypted?.ciphertext
            ),
            hasRecoveryWrap: Boolean(exportVaultCandidate.record.recoveryEncrypted?.ciphertext),
            createdAt: exportVaultCandidate.record.createdAt,
          }
        : null,
      nautilusApiAvailable: typeof window !== "undefined" && Boolean((window as { ergo?: unknown }).ergo),
    });
  }, [profile, exportVaultCandidate, externalAuthRef, providerLinks]);
  const accountStateSnapshot = useMemo(
    () => ({
      accountType: accountModelSession.identity.ergoAddress ? "wallet-linked" : "identity-only",
      accountId: profile?.userId ?? null,
      externalAuthRef,
    }),
    [accountModelSession.identity.ergoAddress, externalAuthRef, profile?.userId]
  );
  const accountConversionSnapshot = useMemo(
    () => ({
      targetType: accountStateSnapshot.accountType === "wallet-linked" ? "wallet-linked" : "identity-only",
    }),
    [accountStateSnapshot.accountType]
  );
  const portabilityStatus = useMemo(
    () => getPortabilityStatus({ session: accountModelSession }),
    [accountModelSession]
  );
  const progressiveCapabilities = useMemo(
    () =>
      sessionCapabilities ??
      buildProgressiveAccountCapabilities({
        sessionActive: Boolean(backendSession),
        walletBound: profile?.walletStatus === "bound_stub" && Boolean(profile?.walletAddress?.trim()),
        rewardsWalletRequirement: "required",
        wageringWalletRequirement: "required",
      }),
    [sessionCapabilities, backendSession, profile?.walletStatus, profile?.walletAddress]
  );
  const onboardingProgress = deriveOnboardingProgress({
    hasDynamicIdentity: Boolean(dynamicIdentityKey),
    hasBackendSession: Boolean(backendSession),
    walletLinked: Boolean(accountSecurityState?.wallet.linked && accountSecurityState.wallet.address?.trim()),
    walletAddress: accountSecurityState?.wallet.address?.trim() ?? profile?.walletAddress?.trim() ?? null,
    hasRecoveryMaterial: Boolean(latestRecoverySecret?.trim() || exportVaultCandidate?.record.recoveryEncrypted?.ciphertext),
    passkeySupported: passkeyFeatureSupported,
    passkeyConfigured: hasLocalPasskey,
    hasExampleGame,
    capabilities: progressiveCapabilities,
  });
  const accountProgression = useMemo(
    () =>
      deriveAccountProgression({
        hasBackendSession: Boolean(backendSession),
        securityState: accountSecurityState,
      }),
    [backendSession, accountSecurityState]
  );
  const easyModeStatus = onboardingProgress.fullyComplete ? "Ready" : "Needs one action";
  const easyModePrimaryStep = onboardingProgress.steps[onboardingProgress.firstActionableIndex] ?? onboardingProgress.steps[0];
  const transferIntentReadModel = useMemo(
    () => deriveTransferIntentReadModel(transferIntents),
    [transferIntents]
  );
  const onboardingCompletionPercent = Math.round(
    (onboardingProgress.completedCount / Math.max(1, onboardingProgress.totalCount)) * 100
  );
  const mnemonicCryptoPathImplemented = false;
  const mnemonicExportEnabled =
    mnemonicCryptoPathImplemented && portabilityStatus.mnemonicExport.state === "supported";
  const portabilitySummary = useMemo(
    () => [
      `Authority=${portabilityStatus.authority}`,
      `RunWithoutDynamic=${portabilityStatus.canRunWithoutDynamic ? "yes" : "no"}`,
      `EncryptedExport=${portabilityStatus.encryptedExport.state}`,
      `MnemonicExport=${portabilityStatus.mnemonicExport.state}`,
      `Nautilus=${portabilityStatus.nautilusLinkage?.status ?? "unlinked"}`,
      `Recovery=${portabilityStatus.recoveryExportHandoff.recoveryChannel}`,
    ],
    [portabilityStatus]
  );

  const withBusy = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected request error";
      setEventLog(`Request failed: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    return () => {
      if (autoBridgeStatusTimerRef.current !== null) {
        window.clearTimeout(autoBridgeStatusTimerRef.current);
      }
    };
  }, []);

  const refreshAccountSecurityState = useCallback(async () => {
    const payload = await apiGetAccountSecurityState();
    setAccountSecurityState(payload.securityState);
    const persistedWalletAddress = payload.securityState.wallet.address?.trim();
    if (payload.securityState.wallet.linked && persistedWalletAddress) {
      setWalletAddress(persistedWalletAddress);
      setProfile((previous) =>
        previous
          ? {
              ...previous,
              walletStatus: "bound_stub",
              walletAddress: persistedWalletAddress,
            }
          : previous
      );
    }
    return payload.securityState;
  }, []);

  const refreshProfile = async () => {
    const session = await apiGetSession();
    const me = await apiGetProfile();
    setBackendSession(session.session);
    setProfile(me.profile);
    setSessionCapabilities(session.capabilities);
    await Promise.all([refreshSecurityPosture(), refreshRatificationState(), refreshAccountSecurityState()]);
    setEventLog(`Session verified for ${session.profile.displayName}`);
  };

  const clearAutoSyncStatusSoon = useCallback(() => {
    if (autoBridgeStatusTimerRef.current !== null) {
      window.clearTimeout(autoBridgeStatusTimerRef.current);
    }
    autoBridgeStatusTimerRef.current = window.setTimeout(() => {
      setDynamicSyncStatusMessage((previous) =>
        previous === "Restoring Day1 session..." || previous?.startsWith("Day1 session active for ") ? null : previous
      );
      autoBridgeStatusTimerRef.current = null;
    }, AUTO_BRIDGE_SUCCESS_MESSAGE_MS);
  }, []);

  const waitForDynamicAuthToken = useCallback(
    async (source: DynamicBridgeSource) =>
      waitForAuthTokenWithRetry({
        maxRetries: DYNAMIC_TOKEN_MAX_RETRIES,
        retryDelayMs: DYNAMIC_TOKEN_RETRY_DELAY_MS,
        getToken: dynamic.getAuthToken,
        sleep,
        onRetry: (attempt, maxRetries) => {
          setDynamicSyncStatusMessage(
            source === "auto"
              ? "Restoring Day1 session..."
              : `Waiting for Dynamic auth token (${attempt}/${maxRetries})...`
          );
        },
      }),
    [dynamic.getAuthToken]
  );

  const verifyBackendSessionAfterLogin = async (authModeLabel: string) => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < SESSION_VERIFY_MAX_RETRIES; attempt += 1) {
      try {
        return await apiGetSession();
      } catch (error) {
        lastError = error;
        const shouldRetry =
          isTransientSessionHydrationError(error) && attempt < SESSION_VERIFY_MAX_RETRIES - 1;
        if (!shouldRetry) break;
        await sleep(SESSION_VERIFY_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    const guidance =
      `${authModeLabel} login reached Day1 API, but session hydration was not confirmed. ` +
      "Verify API origin/CORS and browser cookie policy, then retry.";
    if (lastError instanceof Error) {
      throw new Error(`${guidance} (${lastError.message})`);
    }
    throw new Error(guidance);
  };

  const resetSessionState = useCallback((reason: string) => {
    setBackendSession(null);
    setProfile(null);
    setAccountSecurityState(null);
    setSessionCapabilities(null);
    setGames([]);
    setGameTypes([]);
    setSelectedGameType("tic_tac_toe");
    setKnownPlayers([]);
    setLeaderboard([]);
    setGameTypesLoadState("idle");
    setGameTypesLoadError(null);
    setGame(null);
    setPlayerSymbol(null);
    setGameStatusFromServer(null);
    setCompletion(null);
    setJoinGameId("");
    setRewards(null);
    setIntentId("");
    setTrustedDevices([]);
    setActiveSessions([]);
    setSecurityMetrics([]);
    setWalletStatus(null);
    setRatificationSchedule(null);
    setRatificationCheckpoint(null);
    setRatificationBatches([]);
    setRatificationAdapter(null);
    setTruthStack(null);
    setRatificationIntervalMs("20000");
    setSignedBatchId("");
    setSignedTxHex("");
    setDynamicAuthMode(null);
    setAuthBlockingReason(null);
    setRecoveryImportState({ status: "idle", message: null });
    setEventLog(reason);
  }, []);

  const applyAuthBlockedState = useCallback((reason: string) => {
    resetSessionState(reason);
    setAuthBlockingReason(reason);
    setGameTypes(FALLBACK_GAME_TYPES);
    setSelectedGameType(FALLBACK_GAME_TYPES[0].gameType);
    setGameTypesLoadState("error");
    setGameTypesLoadError(
      `${reason} Use "Dynamic -> Day1 Session" to re-bootstrap auth, then click "Recover Session + Lobby".`
    );
  }, [resetSessionState]);

  const hydrateGameState = async (
    gameId: string,
    eventMessage?: string
  ) => {
    const payload = await apiGetGame(gameId);
    setGame(payload.game);
    setGameStatusFromServer(payload.status);
    setPlayerSymbol(payload.playerSymbol);
    setCompletion(payload.completion);
    if (payload.rewardSnapshot) {
      setRewards(payload.rewardSnapshot);
    }
    if (eventMessage) {
      setEventLog(eventMessage);
    }
  };

  const fetchGameTypesWithRetry = useCallback(async () => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < GAME_TYPES_MAX_RETRIES; attempt += 1) {
      try {
        return await apiListGameTypes();
      } catch (error) {
        lastError = error;
        const shouldRetry = isTransientSessionHydrationError(error) && attempt < GAME_TYPES_MAX_RETRIES - 1;
        if (!shouldRetry) {
          throw error;
        }
        await sleep(GAME_TYPES_RETRY_DELAY_MS * (attempt + 1));
      }
    }
    throw lastError ?? new Error("Failed to load game types.");
  }, []);

  const fetchLobbyAndDirectorySnapshot = useCallback(async (filter: "all" | "open" | "active" | "completed") => {
    const requestId = ++lobbyRequestRef.current;
    setGameTypesLoadState((previous) => (previous === "ready" ? previous : "loading"));
    setGameTypesLoadError(null);
    try {
      const gameTypesPayload = await fetchGameTypesWithRetry();
      const [gamesPayload, playersPayload, leaderboardPayload] = await Promise.allSettled([
        apiListGames(filter),
        apiListRecentPlayers(20),
        apiGetLeaderboard(20),
      ]);
      if (requestId !== lobbyRequestRef.current) return;
      setGameTypes(gameTypesPayload.gameTypes);
      setSelectedGameType((previous) => {
        if (gameTypesPayload.gameTypes.some((entry) => entry.gameType === previous)) return previous;
        return gameTypesPayload.gameTypes[0]?.gameType ?? "tic_tac_toe";
      });
      setGameTypesLoadState("ready");
      if (gamesPayload.status === "fulfilled") {
        setGames(gamesPayload.value.games);
      }
      if (playersPayload.status === "fulfilled") {
        setKnownPlayers(playersPayload.value.players);
      }
      if (leaderboardPayload.status === "fulfilled") {
        setLeaderboard(leaderboardPayload.value.leaderboard);
      }
    } catch (error) {
      if (requestId !== lobbyRequestRef.current) return;
      setGameTypes(FALLBACK_GAME_TYPES);
      setSelectedGameType((previous) => {
        if (FALLBACK_GAME_TYPES.some((entry) => entry.gameType === previous)) return previous;
        return FALLBACK_GAME_TYPES[0].gameType;
      });
      setGameTypesLoadState("error");
      setGameTypesLoadError(
        `${deriveGameTypesFailureMessage(error)} Fallback game-type options are loaded so you can retry session recovery without a dead end.`
      );
      throw error;
    }
  }, [fetchGameTypesWithRetry]);

  const refreshLobbyAndDirectory = useCallback(
    async (filter: "all" | "open" | "active" | "completed" = lobbyFilter) => {
      await fetchLobbyAndDirectorySnapshot(filter);
    },
    [fetchLobbyAndDirectorySnapshot, lobbyFilter]
  );

  const refreshSecurityPosture = useCallback(async () => {
    const [devicesPayload, sessionsPayload, metricsPayload] = await Promise.all([
      apiListTrustedDevices(),
      apiListSessions(),
      apiGetSecurityMetrics(),
    ]);
    setTrustedDevices(devicesPayload.devices.map((entry) => ({ deviceId: entry.deviceId, label: entry.label })));
    setActiveSessions(sessionsPayload.sessions.map((entry) => ({ sessionId: entry.sessionId, deviceId: entry.deviceId })));
    setSecurityMetrics(metricsPayload.metrics);
  }, []);

  const refreshRatificationState = useCallback(async () => {
    const [walletPayload, schedulePayload, batchesPayload, truthPayload] = await Promise.all([
      apiGetServerWalletStatus(),
      apiGetRatificationSchedule(),
      apiListRatificationBatches(20),
      apiGetTruthStack(60, 8),
    ]);
    setWalletStatus(walletPayload.wallet);
    setRatificationSchedule(schedulePayload.schedule);
    setRatificationCheckpoint(schedulePayload.checkpoint);
    setRatificationAdapter(schedulePayload.adapter);
    setRatificationIntervalMs(String(schedulePayload.schedule.intervalMs));
    setRatificationBatches(batchesPayload.batches);
    setTruthStack(truthPayload.truth);
  }, []);

  const refreshPostLoginState = async () => {
    const [lobbyResult, securityResult, ratificationResult, accountSecurityResult] = await Promise.allSettled([
      refreshLobbyAndDirectory(),
      refreshSecurityPosture(),
      refreshRatificationState(),
      refreshAccountSecurityState(),
    ]);
    if (lobbyResult.status === "rejected") {
      if (isTransientSessionHydrationError(lobbyResult.reason)) {
        applyAuthBlockedState(
          "Day1 session was not retained after login. Re-run Dynamic -> Day1 Session and verify production cookie/CORS configuration."
        );
        return { partialFailures: true };
      }
      throw lobbyResult.reason;
    }
    const nonBlockingFailures = [securityResult, ratificationResult, accountSecurityResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    return { partialFailures: nonBlockingFailures.length > 0 };
  };

  useEffect(() => {
    if (!backendSession) return;
    let disposed = false;
    const filter = lobbyFilter;

    const syncLobby = async () => {
      try {
        await fetchLobbyAndDirectorySnapshot(filter);
        if (disposed) return;
      } catch (error) {
        if (disposed) return;
        if (isTransientSessionHydrationError(error)) {
          applyAuthBlockedState(
            "Day1 session expired while loading game types. Re-authenticate and verify deploy cookie/CORS settings."
          );
          return;
        }
        setGameTypesLoadState("error");
        setGameTypesLoadError(deriveGameTypesFailureMessage(error));
      }
    };

    void syncLobby();
    const interval = window.setInterval(() => {
      void syncLobby();
    }, LIVE_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [backendSession, lobbyFilter, fetchLobbyAndDirectorySnapshot, applyAuthBlockedState]);

  useEffect(() => {
    if (!backendSession) return;
    let disposed = false;

    const runBackgroundRepairs = async () => {
      try {
        const sessionPayload = await apiGetSession();
        if (disposed) return;
        setBackendSession(sessionPayload.session);
        setSessionCapabilities(sessionPayload.capabilities);
        await refreshAccountSecurityState();
        if (disposed) return;
        if (passkeyFeatureSupported && !hasLocalPasskey && passkeySetupState.status === "idle") {
          setPasskeySetupState({
            status: "warning",
            message: "Passkey is available on this device. Add it when you are ready for faster sign-in.",
          });
        }
      } catch {
        // Keep this idempotent and non-blocking for active play.
      }
    };

    void runBackgroundRepairs();
    const interval = window.setInterval(() => {
      void runBackgroundRepairs();
    }, ACCOUNT_REPAIR_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [
    backendSession,
    refreshAccountSecurityState,
    passkeyFeatureSupported,
    hasLocalPasskey,
    passkeySetupState.status,
  ]);

  useEffect(() => {
    if (!backendSession || !game?.gameId) return;
    let disposed = false;

    const syncGameState = async () => {
      try {
        const payload = await apiGetGame(game.gameId);
        if (disposed) return;
        setGame(payload.game);
        setGameStatusFromServer(payload.status);
        setPlayerSymbol(payload.playerSymbol);
        setCompletion(payload.completion);
        if (payload.rewardSnapshot) {
          setRewards(payload.rewardSnapshot);
        }
      } catch {
        // Polling failures are ignored; manual actions still show explicit errors.
      }
    };

    void syncGameState();
    const interval = window.setInterval(() => {
      void syncGameState();
    }, LIVE_SYNC_INTERVAL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [backendSession, game?.gameId]);

  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;

    const syncScrollVisual = () => {
      frame = 0;
      const maxScroll = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const scrollY = Math.max(0, window.scrollY);
      const progress = Math.min(1, scrollY / maxScroll);
      root.style.setProperty("--scroll-y", `${scrollY.toFixed(2)}px`);
      root.style.setProperty("--scroll-progress", progress.toFixed(4));
    };

    const queueSync = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(syncScrollVisual);
    };

    syncScrollVisual();
    window.addEventListener("scroll", queueSync, { passive: true });
    window.addEventListener("resize", queueSync);

    return () => {
      window.removeEventListener("scroll", queueSync);
      window.removeEventListener("resize", queueSync);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
      }
      root.style.removeProperty("--scroll-y");
      root.style.removeProperty("--scroll-progress");
    };
  }, []);

  const handleGuestLogin = () => {
    void withBusy(async () => {
      await apiGuestLogin("Guest Player");
      setEventLog("Guest login accepted. Verifying backend session...");
      const verifiedSession = await verifyBackendSessionAfterLogin("Guest");
      setBackendSession(verifiedSession.session);
      setProfile(verifiedSession.profile);
      setSessionCapabilities(verifiedSession.capabilities);
      const refreshOutcome = await refreshPostLoginState();
      setEventLog(
        refreshOutcome.partialFailures
          ? `Guest session active as ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
          : `Guest session active as ${verifiedSession.profile.displayName}.`
      );
    });
  };

  const handleLocalRegister = () => {
    void withBusy(async () => {
      await apiRegister({
        displayName: localAuthDisplayName.trim() || "Local Player",
        email: localAuthEmail.trim(),
        password: localAuthPassword,
      });
      setEventLog("Local registry account created. Verifying backend session...");
      const verifiedSession = await verifyBackendSessionAfterLogin("Local register");
      setBackendSession(verifiedSession.session);
      setProfile(verifiedSession.profile);
      setSessionCapabilities(verifiedSession.capabilities);
      const refreshOutcome = await refreshPostLoginState();
      setDynamicAuthMode(null);
      setEventLog(
        refreshOutcome.partialFailures
          ? `Local account session active for ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
          : `Local account session active for ${verifiedSession.profile.displayName}.`
      );
    });
  };

  const handleLocalLogin = () => {
    void withBusy(async () => {
      await apiLogin({
        email: localAuthEmail.trim(),
        password: localAuthPassword,
      });
      setEventLog("Local registry login accepted. Verifying backend session...");
      const verifiedSession = await verifyBackendSessionAfterLogin("Local login");
      setBackendSession(verifiedSession.session);
      setProfile(verifiedSession.profile);
      setSessionCapabilities(verifiedSession.capabilities);
      const refreshOutcome = await refreshPostLoginState();
      setDynamicAuthMode(null);
      setEventLog(
        refreshOutcome.partialFailures
          ? `Local login session active for ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
          : `Local login session active for ${verifiedSession.profile.displayName}.`
      );
    });
  };

  const performDynamicSessionSync = useCallback(
    ({ payload, source }: { payload: { email?: string; displayName?: string }; source: DynamicBridgeSource }) => {
      if (dynamicSyncInFlightRef.current) {
        return dynamicSyncInFlightRef.current;
      }
      if (!dynamic.enabled || !dynamic.configured) {
        setDynamicSyncErrorMessage("Dynamic is not configured. Set Dynamic env vars and enable the module before syncing.");
        setDynamicSyncStatusMessage(null);
        return Promise.resolve(false);
      }
      if (!dynamic.sdkHasLoaded || !dynamic.user) {
        setDynamicSyncErrorMessage("Dynamic user session is not ready. Open Dynamic Auth and complete sign-in first.");
        setDynamicSyncStatusMessage(null);
        return Promise.resolve(false);
      }
      if (source === "manual") {
        setBusy(true);
      }
      setDynamicSyncInProgress(true);
      setDynamicSyncErrorMessage(null);
      setDynamicSyncStatusMessage(
        source === "auto" ? "Restoring Day1 session..." : "Starting Dynamic -> Day1 session handshake..."
      );
      const inFlight = (async () => {
        try {
          if (source === "manual" && !dynamic.getAuthToken()?.trim()) {
            dynamic.openAuthFlow();
          }
          const authToken = await waitForDynamicAuthToken(source);
          let linkedMode: "jwt_verified" | "dynamic_compatibility" = "jwt_verified";
          await retryWithBoundedBackoff({
            maxAttempts: DYNAMIC_LOGIN_MAX_ATTEMPTS,
            baseDelayMs: DYNAMIC_LOGIN_RETRY_BASE_DELAY_MS,
            maxDelayMs: DYNAMIC_LOGIN_RETRY_MAX_DELAY_MS,
            sleep,
            shouldRetry: shouldRetryDynamicBridgeError,
            onRetry: () => {
              setDynamicSyncStatusMessage(
                source === "auto"
                  ? "Restoring Day1 session..."
                  : "Retrying Dynamic session bridge..."
              );
            },
            run: async () => {
              setDynamicSyncStatusMessage(
                source === "auto"
                  ? "Restoring Day1 session..."
                  : "Submitting Dynamic token to Day1 API..."
              );
              try {
                await apiDynamicLogin({ authToken, ...payload });
                linkedMode = "jwt_verified";
              } catch (dynamicLoginError) {
                if (!isDynamicConfigurationError(dynamicLoginError)) {
                  throw dynamicLoginError;
                }
                setDynamicSyncStatusMessage(
                  source === "auto"
                    ? "Restoring Day1 session..."
                    : "Dynamic JWT mode unavailable. Falling back to compatibility bootstrap..."
                );
                await apiAuthSync({
                  displayName: payload.displayName,
                  email: payload.email,
                  externalAuthRef:
                    (typeof dynamic.user?.userId === "string" && dynamic.user.userId.trim()) ||
                    (typeof dynamic.user?.email === "string" && dynamic.user.email.trim()) ||
                    payload.email,
                });
                linkedMode = "dynamic_compatibility";
              }
            },
          });
          setAuthBlockingReason(null);
          setDynamicAuthMode(linkedMode);
          setEventLog(
            linkedMode === "jwt_verified"
              ? "Dynamic JWT login accepted. Verifying backend session..."
              : "Dynamic compatibility login accepted. Verifying backend session..."
          );
          setDynamicSyncStatusMessage(
            source === "auto" ? "Restoring Day1 session..." : "Verifying Day1 backend session..."
          );
          const verifiedSession = await verifyBackendSessionAfterLogin(
            linkedMode === "jwt_verified" ? "Dynamic JWT" : "Dynamic compatibility"
          );
          setBackendSession(verifiedSession.session);
          setProfile(verifiedSession.profile);
          setSessionCapabilities(verifiedSession.capabilities);
          setDynamicSyncStatusMessage(
            source === "auto" ? "Restoring Day1 session..." : "Hydrating lobby and security state..."
          );
          const refreshOutcome = await refreshPostLoginState();
          setDynamicSyncStatusMessage(
            refreshOutcome.partialFailures
              ? `Day1 session active for ${verifiedSession.profile.displayName}; background panels will continue syncing.`
              : `Day1 session active for ${verifiedSession.profile.displayName}.`
          );
          setEventLog(
            refreshOutcome.partialFailures
              ? `Dynamic linked via ${linkedMode === "jwt_verified" ? "JWT verified mode" : "compatibility mode"} for ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
              : `Dynamic linked via ${linkedMode === "jwt_verified" ? "JWT verified mode" : "compatibility mode"} for ${verifiedSession.profile.displayName}.`
          );
          if (source === "auto") {
            autoBridgeHardBlockedIdentityRef.current = null;
            clearAutoSyncStatusSoon();
          }
          return true;
        } catch (error) {
          const detail = error instanceof Error ? error.message : "Unexpected Dynamic login failure.";
          const message =
            source === "auto"
              ? `Automatic Day1 session restore did not complete (${detail}). Use "Dynamic -> Day1 Session" to retry.`
              : detail;
          setDynamicSyncErrorMessage(message);
          setDynamicSyncStatusMessage(null);
          setEventLog(`Dynamic -> Day1 session failed: ${message}`);
          if (source === "auto" && dynamicIdentityKey && isHardDynamicBridgeError(error)) {
            autoBridgeHardBlockedIdentityRef.current = dynamicIdentityKey;
          }
          return false;
        } finally {
          setDynamicSyncInProgress(false);
          if (source === "manual") {
            setBusy(false);
          }
          dynamicSyncInFlightRef.current = null;
        }
      })();
      dynamicSyncInFlightRef.current = inFlight;
      return inFlight;
    },
    [clearAutoSyncStatusSoon, dynamic, dynamicIdentityKey, refreshPostLoginState, waitForDynamicAuthToken]
  );

  const handleDynamicLogin = (payload: { email?: string; displayName?: string }) => {
    void performDynamicSessionSync({ payload, source: "manual" });
  };

  useEffect(() => {
    const dynamicReady = dynamic.active && dynamic.sdkHasLoaded && Boolean(dynamicIdentityKey);
    const identityChanged = autoBridgeIdentityRef.current !== dynamicIdentityKey;
    const becameReady = dynamicReady && !autoBridgeReadyRef.current;
    autoBridgeReadyRef.current = dynamicReady;
    if (identityChanged) {
      autoBridgeIdentityRef.current = dynamicIdentityKey;
      autoBridgeAttemptsRef.current = 0;
      autoBridgeCooldownUntilRef.current = 0;
      autoBridgeHardBlockedIdentityRef.current = null;
      autoBridgeLastAttemptAtRef.current = 0;
    }
    const now = Date.now();
    if (
      !shouldStartAutoBridgeAttempt({
        dynamicReady,
        identityKey: dynamicIdentityKey,
        identityChanged,
        becameReady,
        hasBackendSession: Boolean(backendSession),
        hasAuthBlockingReason: Boolean(authBlockingReason),
        authMode: dynamicAuthMode,
        syncInFlight: Boolean(dynamicSyncInFlightRef.current),
        syncInProgress: dynamicSyncInProgress,
        nowMs: now,
        cooldownUntilMs: autoBridgeCooldownUntilRef.current,
        attemptsForIdentity: autoBridgeAttemptsRef.current,
        maxAttemptsPerIdentity: AUTO_BRIDGE_MAX_ATTEMPTS_PER_IDENTITY,
        lastAttemptAtMs: autoBridgeLastAttemptAtRef.current,
        minAttemptGapMs: AUTO_BRIDGE_MIN_ATTEMPT_GAP_MS,
        hardBlockedIdentityKey: autoBridgeHardBlockedIdentityRef.current,
      })
    ) {
      return;
    }
    autoBridgeLastAttemptAtRef.current = now;
    void (async () => {
      const success = await performDynamicSessionSync({
        source: "auto",
        payload: { email: dynamicEmail, displayName: dynamicDisplayName || undefined },
      });
      if (success) {
        autoBridgeAttemptsRef.current = 0;
        autoBridgeCooldownUntilRef.current = 0;
        return;
      }
      autoBridgeAttemptsRef.current += 1;
      const cooldownMs = Math.min(
        AUTO_BRIDGE_COOLDOWN_MAX_MS,
        AUTO_BRIDGE_COOLDOWN_BASE_MS * 2 ** (autoBridgeAttemptsRef.current - 1)
      );
      autoBridgeCooldownUntilRef.current = Date.now() + cooldownMs;
    })();
  }, [
    authBlockingReason,
    backendSession,
    dynamic.active,
    dynamic.sdkHasLoaded,
    dynamicAuthMode,
    dynamicDisplayName,
    dynamicEmail,
    dynamicIdentityKey,
    dynamicSyncInProgress,
    performDynamicSessionSync,
  ]);

  const handleRecoveryRequest = () => {
    void withBusy(async () => {
      const payload = await apiRequestRecovery(recoveryEmail);
      if (payload.resetTokenPreview) {
        setRecoveryToken(payload.resetTokenPreview);
      }
      setEventLog("Recovery request accepted. Use preview token in local dev only.");
    });
  };

  const handleRecoveryReset = () => {
    void withBusy(async () => {
      await apiResetRecovery(recoveryToken, recoveryNewPassword);
      setEventLog("Password reset complete. Sign in with your new password.");
    });
  };

  const handleTotpEnrollStart = () => {
    if (!backendSession) return;
    void withBusy(async () => {
      const payload = await apiStartTotpEnrollment();
      setMfaSecretPreview(payload.secret);
      setEventLog("TOTP enrollment started. Add secret to your authenticator and verify code.");
    });
  };

  const handleTotpEnrollVerify = () => {
    if (!backendSession) return;
    void withBusy(async () => {
      await apiVerifyTotpEnrollment(mfaCodeInput);
      const profilePayload = await apiGetProfile();
      setProfile(profilePayload.profile);
      await refreshSecurityPosture();
      setEventLog("TOTP enrollment verified and enabled.");
    });
  };

  const handleTotpDisable = () => {
    if (!backendSession) return;
    void withBusy(async () => {
      await apiDisableTotp(mfaCodeInput);
      const profilePayload = await apiGetProfile();
      setProfile(profilePayload.profile);
      await refreshSecurityPosture();
      setEventLog("TOTP MFA disabled for this account.");
    });
  };

  const handleTrustCurrentDevice = () => {
    if (!backendSession) return;
    void withBusy(async () => {
      await apiTrustCurrentDevice("UI trusted device");
      await refreshSecurityPosture();
      setEventLog("Current device marked as trusted.");
    });
  };

  const handleSignOut = () => {
    if (!backendSession) {
      setEventLog("No active session to sign out.");
      return;
    }
    void withBusy(async () => {
      await apiSignOut();
      resetSessionState("Signed out from backend session.");
    });
  };

  const handleRecoverSession = () => {
    void withBusy(async () => {
      setEventLog("Attempting Day1 session recovery and lobby bootstrap...");
      const session = await apiGetSession();
      setBackendSession(session.session);
      setProfile(session.profile);
      setSessionCapabilities(session.capabilities);
      setAuthBlockingReason(null);
      await Promise.all([refreshLobbyAndDirectory(), refreshAccountSecurityState()]);
      setEventLog(`Recovered Day1 session for ${session.profile.displayName}.`);
    });
  };

  const handleWalletBind = () => {
    if (!backendSession) {
      setEventLog("Create session first.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiBindWallet(walletAddress);
      const capabilityEnvelope = await apiGetCapabilities();
      setProfile(payload.profile);
      setSessionCapabilities(capabilityEnvelope.capabilities);
      await refreshAccountSecurityState();
      setEventLog("Layer 2 unlocked: ownership setup linked for rewards.");
    });
  };

  const registerLocalPasskey = async (
    accountUserId: string,
    accountEmail?: string
  ): Promise<{
    status: "success" | "already_configured" | "unsupported" | "skipped" | "error";
    message: string;
    passkeyRecord?: LocalPasskeyRecord;
  }> => {
    if (typeof window === "undefined" || typeof navigator === "undefined") {
      return {
        status: "unsupported",
        message: "Passkey setup is only available in a browser. Wallet setup completed without passkey.",
      };
    }
    if (!window.isSecureContext) {
      return {
        status: "unsupported",
        message: "Passkeys require HTTPS or localhost. Wallet is ready; set up a passkey later in a secure context.",
      };
    }
    if (!("PublicKeyCredential" in window) || !navigator.credentials?.create) {
      return {
        status: "unsupported",
        message: "This browser does not support passkeys. Wallet is ready; add a passkey later on a supported device.",
      };
    }

    const hasPlatformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().catch(
      () => null
    );
    if (hasPlatformAuthenticator === false) {
      return {
        status: "unsupported",
        message: "No compatible device authenticator was detected. Wallet is ready; add a passkey later.",
      };
    }

    const existingCredentialId =
      exportVaultCandidate?.record.passkey &&
      typeof exportVaultCandidate.record.passkey === "object" &&
      typeof (exportVaultCandidate.record.passkey as { credentialId?: unknown }).credentialId === "string"
        ? (exportVaultCandidate.record.passkey as { credentialId: string }).credentialId
        : null;
    const excludeCredentials = existingCredentialId
      ? [
          {
            id: fromBase64Url(existingCredentialId),
            type: "public-key" as const,
          },
        ]
      : undefined;
    const toPasskeyRecord = (credentialId: string, transports: string[]): LocalPasskeyRecord => ({
      credentialId,
      rpId: window.location.hostname,
      createdAt: new Date().toISOString(),
      transports,
    });
    const verifyExistingPasskey = async (): Promise<LocalPasskeyRecord | undefined> => {
      if (!navigator.credentials?.get) {
        if (!existingCredentialId) return undefined;
        return toPasskeyRecord(existingCredentialId, []);
      }
      try {
        const credential = (await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: window.location.hostname,
            timeout: 60000,
            userVerification: "preferred",
            allowCredentials: excludeCredentials,
          },
        })) as PublicKeyCredential | null;
        if (!credential) {
          if (!existingCredentialId) return undefined;
          return toPasskeyRecord(existingCredentialId, []);
        }
        const attachment = typeof credential.authenticatorAttachment === "string" ? credential.authenticatorAttachment : null;
        const transports = attachment ? [attachment] : [];
        return toPasskeyRecord(toBase64Url(new Uint8Array(credential.rawId)), transports);
      } catch {
        if (!existingCredentialId) return undefined;
        return toPasskeyRecord(existingCredentialId, []);
      }
    };

    if (existingCredentialId) {
      const verifiedRecord = await verifyExistingPasskey();
      return {
        status: "already_configured",
        message: "Passkey protection is already configured on this device.",
        passkeyRecord: verifiedRecord,
      };
    }

    try {
      const createdCredential = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: {
            id: window.location.hostname,
            name: "Ergo Games Day1",
          },
          user: {
            id: crypto.getRandomValues(new Uint8Array(32)),
            name: accountEmail ?? `day1-${accountUserId}`,
            displayName: profile?.displayName ?? "Day1 Player",
          },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          timeout: 60000,
          attestation: "none",
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "preferred",
            residentKey: "preferred",
          },
          excludeCredentials,
        },
      })) as PublicKeyCredential | null;

      if (!createdCredential) {
        return {
          status: "error",
          message: "Passkey registration did not complete. Wallet is still ready.",
        };
      }

      const response = createdCredential.response as AuthenticatorAttestationResponse;
      const transports =
        typeof response.getTransports === "function"
          ? response.getTransports().filter((entry): entry is string => typeof entry === "string")
          : [];

      return {
        status: "success",
        message: "Secure wallet created and local passkey registered on this device.",
        passkeyRecord: toPasskeyRecord(toBase64Url(new Uint8Array(createdCredential.rawId)), transports),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        return {
          status: "skipped",
          message:
            "Wallet created. Passkey setup was skipped or canceled; you can add one later from a passkey-capable device.",
        };
      }
      if (isDuplicatePasskeyCredentialSignal({ error })) {
        const verifiedRecord = await verifyExistingPasskey();
        return {
          status: "already_configured",
          message: "Passkey already exists for this account on this device. Protection is already active.",
          passkeyRecord: verifiedRecord,
        };
      }
      const detail = error instanceof Error ? error.message : "Unknown passkey setup error";
      return {
        status: "error",
        message: `Wallet created, but passkey setup failed (${detail}). You can retry later.`,
      };
    }
  };

  const handleCreateSecureWallet = () => {
    if (!backendSession) {
      setEventLog("Sign in first to complete account security setup.");
      return;
    }
    if (!dynamic.user && dynamicAuthMode !== "jwt_verified") {
      setEventLog("Complete Dynamic sign-in first, then create your secure wallet.");
      return;
    }
    if (!secureWalletConfirmationChecked) {
      setEventLog("Confirm the secure wallet warning before continuing.");
      return;
    }
    setIsSecureWalletModalOpen(false);
    void withBusy(async () => {
      const now = Date.now();
      const latestSecurityState = await refreshAccountSecurityState();
      const persistedWalletAddress = latestSecurityState.wallet.address?.trim();
      const hasPersistedLinkedWallet = Boolean(latestSecurityState.wallet.linked && persistedWalletAddress);
      const walletAddressToLink =
        hasPersistedLinkedWallet && persistedWalletAddress
          ? persistedWalletAddress
          : profile?.walletStatus === "bound_stub" && profile.walletAddress?.trim()
            ? profile.walletAddress.trim()
          : await deriveManagedWalletAddress(
              `${externalAuthRef ?? backendSession.userId}:${now}:${crypto.randomUUID()}`
            );
      const recoverySecretCode = createRecoverySecretCode();
      const recoveryEncrypted = await encryptRecoveryPayload(recoverySecretCode, {
        type: "day1-wallet-recovery-v1",
        accountId: backendSession.userId,
        externalAuthRef: externalAuthRef ?? null,
        ergoAddress: walletAddressToLink,
        issuedAt: new Date(now).toISOString(),
      });
      const vaultRecord: EncryptedVaultRecord = {
        v: 1,
        ergoAddress: walletAddressToLink,
        recoveryEncrypted,
        createdAt: now,
      };
      window.localStorage.setItem(ENCRYPTED_VAULT_LOCAL_STORAGE_KEY, JSON.stringify(vaultRecord));
      if (!hasPersistedLinkedWallet) {
        await apiBindWallet(walletAddressToLink);
      }
      const refreshedProfilePayload = await apiGetProfile();
      const capabilityEnvelope = await apiGetCapabilities();
      const passkeyResult = await registerLocalPasskey(backendSession.userId, profile?.email);
      if ((passkeyResult.status === "success" || passkeyResult.status === "already_configured") && passkeyResult.passkeyRecord) {
        const recordToPersist: EncryptedVaultRecord = {
          ...vaultRecord,
          passkey: passkeyResult.passkeyRecord,
        };
        window.localStorage.setItem(ENCRYPTED_VAULT_LOCAL_STORAGE_KEY, JSON.stringify(recordToPersist));
      }
      setProfile(refreshedProfilePayload.profile);
      setWalletAddress(walletAddressToLink);
      setSessionCapabilities(capabilityEnvelope.capabilities);
      await refreshAccountSecurityState();
      setLatestRecoverySecret(recoverySecretCode);
      setLatestRecoveryIssuedAt(new Date(now).toLocaleString());
      setPasskeySetupState({ status: passkeyResult.status, message: passkeyResult.message });
      setEventLog("Layer 2 unlocked: secure wallet created and linked.");
    });
  };

  const handleLayer2WalletSetup = () => {
    if (!backendSession) {
      setEventLog("Layer 2 requires Layer 1 login. Sign in first, then create your secure wallet.");
      return;
    }
    if (!dynamic.user && dynamicAuthMode !== "jwt_verified") {
      setEventLog("Complete Dynamic sign-in first, then create your secure wallet.");
      return;
    }
    if (!walletAddress.trim() && profile?.walletAddress) {
      setWalletAddress(profile.walletAddress);
    }
    walletBindingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setSecureWalletConfirmationChecked(false);
    setIsSecureWalletModalOpen(true);
    setEventLog("Layer 2 security setup ready: confirm secure wallet creation to unlock rewards.");
  };

  const handleOpenRecoverWallet = () => {
    if (!backendSession) {
      setEventLog("Sign in first to use wallet recovery tools.");
      return;
    }
    walletRecoverySectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setEventLog("Wallet recovery tools opened. Provide your recovery secret to validate/import.");
  };

  const handleSetupPasskey = () => {
    if (!backendSession) {
      setEventLog("Sign in first to set up a passkey.");
      return;
    }
    if (!profile?.walletAddress?.trim()) {
      setEventLog("Create or link a secure wallet first, then add a passkey.");
      return;
    }
    void withBusy(async () => {
      const passkeyResult = await registerLocalPasskey(backendSession.userId, profile?.email);
      if ((passkeyResult.status === "success" || passkeyResult.status === "already_configured") && passkeyResult.passkeyRecord) {
        const existingRecord = exportVaultCandidate?.record;
        const updatedRecord: EncryptedVaultRecord = {
          v: existingRecord?.v ?? 1,
          ergoAddress: existingRecord?.ergoAddress ?? profile.walletAddress ?? "",
          recoveryEncrypted: existingRecord?.recoveryEncrypted ?? null,
          createdAt: existingRecord?.createdAt ?? Date.now(),
          passkey: passkeyResult.passkeyRecord,
        };
        window.localStorage.setItem(ENCRYPTED_VAULT_LOCAL_STORAGE_KEY, JSON.stringify(updatedRecord));
      }
      setPasskeySetupState({ status: passkeyResult.status, message: passkeyResult.message });
      setEventLog(passkeyResult.message);
    });
  };

  const handleEasyModeContinue = () => {
    if (!onboardingProgress.fullyComplete && easyModePrimaryStep) {
      handleOnboardingStepAction(easyModePrimaryStep.action);
      return;
    }
    if (!backendSession) {
      setEventLog("Connect your Day1 session first, then continue playing.");
      return;
    }
    const currentUserId = backendSession.userId;
    const currentGameIsMine =
      game &&
      (game.playerSeats.X === currentUserId ||
        game.playerSeats.O === currentUserId ||
        game.participants.includes(currentUserId))
        ? game.gameId
        : null;
    const resumableGame = currentGameIsMine ?? games.find((entry) => canJoinLobbyEntry(entry))?.gameId;
    if (resumableGame) {
      handleJoinGame(resumableGame);
      return;
    }
    handleCreateGame();
  };

  const handleOnboardingStepAction = (action: OnboardingStepAction) => {
    if (action === "dynamic_sync") {
      handleDynamicLogin({ email: dynamicEmail, displayName: dynamicDisplayName || undefined });
      return;
    }
    if (action === "create_wallet") {
      handleLayer2WalletSetup();
      return;
    }
    if (action === "save_recovery") {
      if (!latestRecoverySecret?.trim()) {
        handleLayer2WalletSetup();
        return;
      }
      walletBindingSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setEventLog("Save your recovery secret offline now, then continue to passkey setup.");
      return;
    }
    if (action === "setup_passkey") {
      handleSetupPasskey();
      return;
    }
    if (action === "start_example_game") {
      if (!backendSession) {
        setEventLog("Sign in first so we can start an example game.");
        return;
      }
      void withBusy(async () => {
        setSelectedGameType("tic_tac_toe");
        const payload = await apiCreateGame("tic_tac_toe");
        setJoinGameId(payload.game.gameId);
        await hydrateGameState(payload.game.gameId, `Example game ready: ${payload.game.gameId}. Make your first move.`);
        await refreshLobbyAndDirectory();
      });
      return;
    }
    void withBusy(async () => {
      await refreshProfile();
    });
  };

  const handleRecoverWalletFromSecret = () => {
    if (!backendSession) {
      setEventLog("Sign in first to recover wallet linkage.");
      return;
    }
    void withBusy(async () => {
      const normalized = recoverySecretInput.trim().toUpperCase();
      if (!normalized) {
        setRecoveryImportState({ status: "error", message: "Enter your recovery secret code first." });
        return;
      }
      const encryptedRecoveryPayload = exportVaultCandidate?.record.recoveryEncrypted;
      if (!encryptedRecoveryPayload?.ciphertext) {
        setRecoveryImportState({
          status: "warning",
          message:
            "This browser has no encrypted recovery payload to decrypt. Current support can validate/import from local backup material only; cross-device deterministic restore requires backend recovery artifact support.",
        });
        return;
      }

      const candidates = [normalized, normalized.replaceAll("-", "")];
      let recoveredPayload: Record<string, unknown> | null = null;
      for (const candidate of candidates) {
        const grouped = candidate.includes("-") ? candidate : candidate.match(/.{1,4}/g)?.join("-") ?? candidate;
        try {
          recoveredPayload = await decryptRecoveryPayload(grouped, encryptedRecoveryPayload);
          if (recoveredPayload) break;
        } catch {
          recoveredPayload = null;
        }
      }
      if (!recoveredPayload) {
        setRecoveryImportState({
          status: "error",
          message: "Recovery secret could not decrypt local payload. Verify the code and try again.",
        });
        return;
      }

      const recoveredAddress =
        typeof recoveredPayload.ergoAddress === "string" ? recoveredPayload.ergoAddress.trim() : "";
      if (!recoveredAddress) {
        setRecoveryImportState({
          status: "error",
          message: "Recovery payload decrypted but no wallet address was present.",
        });
        return;
      }

      const backendAddress = accountSecurityState?.wallet.address?.trim();
      const alreadyLinked =
        accountSecurityState?.wallet.linked && backendAddress && backendAddress === recoveredAddress;
      if (alreadyLinked) {
        setRecoveryImportState({
          status: "success",
          message: `Recovery secret validated. Backend already links wallet ${recoveredAddress}.`,
        });
        setEventLog("Recovery secret validated against persisted backend linkage.");
        return;
      }

      const bindPayload = await apiBindWallet(recoveredAddress);
      const capabilityEnvelope = await apiGetCapabilities();
      setProfile(bindPayload.profile);
      setWalletAddress(recoveredAddress);
      setSessionCapabilities(capabilityEnvelope.capabilities);
      await refreshAccountSecurityState();
      setRecoveryImportState({
        status: "success",
        message: `Recovery secret validated and backend wallet linkage restored to ${recoveredAddress}.`,
      });
      setEventLog("Wallet linkage restored from recovery secret payload.");
    });
  };

  const handleExportWalletBackup = () => {
    if (!backendSession) {
      setEventLog("Create session first.");
      return;
    }
    const now = new Date();
    const safeTimestamp = now.toISOString().replaceAll(":", "-");
    const fileName = `day1-wallet-backup-${safeTimestamp}.json`;
    const notes = [
      "Backup generated entirely in browser memory and downloaded locally.",
      "Server APIs are not used for backup export.",
      `Account state snapshot: type=${accountStateSnapshot.accountType}, target=${accountConversionSnapshot.targetType}.`,
      exportVaultCandidate
        ? "Encrypted vault payload was included for future non-Dynamic recovery."
        : "No encrypted vault payload detected in this browser or Dynamic metadata.",
    ];

    const artifact = buildExportArtifact({
      session: accountModelSession,
      portabilityStatus,
      appId: "ergo-games-day1",
      appVersion: "day1-export-v2",
      authProviders: providerLinks.map((entry) => ({
        providerId: entry.providerId,
        subjectRef: entry.subjectRef,
        metadata: {
          status: entry.status,
          email: profile?.email ?? null,
        },
      })),
      recovery: {
        channel: portabilityStatus.recoveryExportHandoff.recoveryChannel,
        contact: portabilityStatus.recoveryExportHandoff.recoveryContact ?? profile?.email ?? null,
        continuityGuaranteed: portabilityStatus.recoveryExportHandoff.continuityGuaranteed,
        notes: [
          "Recovery can continue through Day1 server-owned account registry when Dynamic is unavailable.",
          "Use /api/auth/recovery/request and /api/auth/recovery/reset for service continuity.",
          ...portabilityStatus.recoveryExportHandoff.notes,
        ],
      },
      encryptedWallet: exportVaultCandidate
        ? {
            format: `ergo-dynamic-vault-v${exportVaultCandidate.record.v}`,
            source: exportVaultCandidate.source,
            encrypted: true,
            payload: exportVaultCandidate.record as Record<string, unknown>,
            metadata: {
              ergoAddress: exportVaultCandidate.record.ergoAddress,
              walletStatus: profile?.walletStatus ?? null,
            },
          }
        : undefined,
      notes,
      exportedAt: now,
    });
    const validation = validateExportArtifact(artifact);
    if (!validation.ok) {
      setEventLog(`Wallet backup validation failed: ${validation.errors.join(" ")}`);
      return;
    }

    downloadJsonFile(fileName, artifact);
    setLastBackupExportAt(now.toLocaleString());
    setEventLog(
      exportVaultCandidate
        ? `Wallet backup exported (${fileName}). Includes encrypted vault package.`
        : `Wallet backup exported (${fileName}). Includes migration metadata only.`
    );
  };

  const handleCreateGame = () => {
    if (!backendSession) {
      setEventLog("Create session first.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiCreateGame(selectedGameType);
      setJoinGameId(payload.game.gameId);
      await hydrateGameState(payload.game.gameId, `Game created: ${payload.game.gameId} (${payload.game.gameType}).`);
      await refreshLobbyAndDirectory();
    });
  };

  const handleJoinGame = (gameIdRaw?: string) => {
    const gameId = gameIdRaw ?? joinGameId;
    if (!backendSession || !gameId.trim()) {
      setEventLog("Need session + game id to join.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiJoinGame(gameId.trim());
      setGame(payload.game);
      setGameStatusFromServer(payload.status);
      setPlayerSymbol(payload.playerSymbol);
      setCompletion(deriveCompletionFromStatus(payload.game, payload.status));
      setJoinGameId(payload.game.gameId);
      setEventLog(`Joined game ${payload.game.gameId}.`);
      await refreshLobbyAndDirectory(lobbyFilter);
      void hydrateGameState(payload.game.gameId);
    });
  };

  const handleCellClick = (cell: number) => {
    if (!backendSession || !game) return;
    if (gameStatus?.kind !== "ongoing") return;
    void withBusy(async () => {
      const payload = await apiMove(game.gameId, cell);
      setGame(payload.game);
      setGameStatusFromServer(payload.status);
      setPlayerSymbol(payload.playerSymbol);
      setCompletion(payload.completion);
      if (payload.rewardSnapshot) {
        setRewards(payload.rewardSnapshot);
      }
      setEventLog(
        payload.result.ok
          ? `MOVE_APPLIED cell=${payload.result.event.cell} nextTurn=${payload.result.event.nextTurn ?? "none"} winner=${payload.result.event.winner ?? "none"}`
          : `Move rejected: ${payload.result.reason}${payload.result.expectedTurn ? ` expectedTurn=${payload.result.expectedTurn}` : ""}`
      );
      await refreshLobbyAndDirectory();
    });
  };

  const handleRefreshRewards = () => {
    if (!backendSession) {
      setEventLog("Start a Day1 session first, then open rewards.");
      return;
    }
    const rewardsLayer = progressiveCapabilities.layers.rewards;
    if (!rewardsLayer.eligible) {
      setEventLog(
        `${rewardsLayer.message}${rewardsLayer.actionLabel ? ` Action: ${rewardsLayer.actionLabel}.` : ""}`
      );
      return;
    }
    void withBusy(async () => {
      const payload = await apiGetRewards();
      setRewards(payload.rewardSnapshot);
      setEventLog(`Rewards refreshed: tier=${payload.rewardSnapshot.tier}`);
    });
  };

  const handleCreateIntent = () => {
    if (!backendSession || !game) {
      setEventLog("Need session + game before creating intent.");
      return;
    }
    const wageringLayer = progressiveCapabilities.layers.wagering;
    if (!wageringLayer.eligible) {
      setEventLog(
        `${wageringLayer.message}${wageringLayer.actionLabel ? ` Action: ${wageringLayer.actionLabel}.` : ""}`
      );
      return;
    }
    void withBusy(async () => {
      const payload = await apiCreateOnChainIntent(game.gameId);
      setIntentId(payload.intent.intentId);
      setEventLog("On-chain intent scaffold created (not connected to live chain).");
    });
  };

  const handleIntentStatus = () => {
    if (!intentId) {
      setEventLog("Create an intent first.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiGetIntentStatus(intentId);
      setEventLog(`Intent status: ${payload.intent.status} tx=${payload.intent.txHash ?? "n/a"}`);
    });
  };

  const handleRatificationRun = () => {
    if (!backendSession) {
      setEventLog("Create session first.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiRunRatification();
      await refreshRatificationState();
      setEventLog(
        `Ratification outcome=${payload.run.outcome} reason=${payload.run.skipReason ?? payload.run.reason ?? "n/a"} message=${payload.run.reasonMessage ?? "n/a"} batch=${payload.run.batchId ?? "n/a"} tx=${payload.run.txId ?? "n/a"} payload=${payload.run.payloadHash ?? "n/a"}`
      );
    });
  };

  const handleSubmitSignedBatch = () => {
    if (ratificationAdapter?.signerMode === "direct") {
      setEventLog("Signer mode is direct. Manual signed submission is not required.");
      return;
    }
    if (!backendSession || !signedBatchId.trim() || !signedTxHex.trim()) {
      setEventLog("Provide batch id + signed tx hex first.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiSubmitSignedRatificationBatch(signedBatchId.trim(), signedTxHex.trim());
      await refreshRatificationState();
      setEventLog(
        `Signed submit outcome=${payload.run.outcome} batch=${payload.run.batchId ?? "n/a"} tx=${payload.run.txId ?? "n/a"}`
      );
    });
  };

  const handleSaveRatificationInterval = () => {
    if (!backendSession) {
      setEventLog("Create session first.");
      return;
    }
    const parsed = Number(ratificationIntervalMs);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setEventLog("Ratification interval must be a positive number.");
      return;
    }
    void withBusy(async () => {
      const payload = await apiSetRatificationSchedule({ intervalMs: Math.floor(parsed) });
      setRatificationSchedule(payload.schedule);
      setRatificationCheckpoint(payload.checkpoint);
      await refreshRatificationState();
      setEventLog(`Ratification interval updated to ${payload.schedule.intervalMs} ms.`);
    });
  };

  const postGameSummary = useMemo(() => {
    if (!completion?.finished || !gameStatus) return null;
    if (gameStatus.kind === "drawn") {
      return "Game complete: draw. Rewards were updated from backend progression data.";
    }
    if (gameStatus.kind === "won") {
      const isWinner = playerSymbol !== null && playerSymbol === gameStatus.winner;
      return isWinner
        ? `Game complete: you won as ${gameStatus.winner}. Rewards were updated from backend progression data.`
        : `Game complete: ${gameStatus.winner} won. Rewards were updated from backend progression data.`;
    }
    return null;
  }, [completion, gameStatus, playerSymbol]);

  const renderedSecurityMetrics = Array.isArray(securityMetrics) ? securityMetrics : [];
  const ratificationSignerMode = ratificationAdapter?.signerMode ?? null;
  const ratificationModeHint =
    ratificationSignerMode === "direct"
      ? "Server signs/submits directly; manual signed batch submission is disabled."
      : ratificationSignerMode === "public-sponsor"
        ? "Public sponsor mode uses external signing handoff; batches may await sponsor-provided signatures."
        : ratificationSignerMode === "external"
          ? "External signer mode requires signed tx submission for awaiting_signature batches."
          : "Signer mode metadata will appear after ratification adapter loads.";
  const truthColumns: Array<{
    key: "off_chain_pending" | "ratified" | "on_chain_source";
    label: string;
    subtitle: string;
    className: string;
    items: ApiTruthStackItem[];
    count: number;
  }> = [
    {
      key: "off_chain_pending",
      label: "Off-chain Pending",
      subtitle: "Not ratified yet",
      className: "truthPending",
      items: truthStack?.layers.off_chain_pending.recent ?? [],
      count: truthStack?.layers.off_chain_pending.count ?? 0,
    },
    {
      key: "ratified",
      label: "Ratified",
      subtitle: "Anchored truth",
      className: "truthRatified",
      items: truthStack?.layers.ratified.recent ?? [],
      count: truthStack?.layers.ratified.count ?? 0,
    },
    {
      key: "on_chain_source",
      label: "On-chain Source",
      subtitle: "Initiated from gate",
      className: "truthOnChain",
      items: truthStack?.layers.on_chain_source.recent ?? [],
      count: truthStack?.layers.on_chain_source.count ?? 0,
    },
  ];

  return (
    <main className="container">
      <h1>EGI Day 1 Full-Stack Tic-Tac-Toe</h1>
      <p className="subtitle">
        Local-first no-wager MVP: persistent accounts/sessions/lobby/leaderboard with deterministic
        server-authoritative gameplay rules.
      </p>
      <p className="trustLabel">No-wager trusted demo flow</p>

      <section className="panel toolboxPanel">
        <h2>1) Day 1 Onboarding</h2>
        <p className="panelHint">
          Easy mode keeps one primary action visible while background checks keep session, wallet link, and passkey hints up to date.
        </p>
        {(dynamic.enabled || dynamic.active || dynamic.availability === "initializing") ? (
          <DynamicLoginPanel
            busy={busy}
            isSignedIn={isSignedIn}
            syncInProgress={dynamicSyncInProgress}
            syncStatusMessage={dynamicSyncStatusMessage}
            syncErrorMessage={dynamicSyncErrorMessage}
            onSync={handleDynamicLogin}
          />
        ) : null}
        <div className="onboardingWizard">
          <div className="onboardingWizardTop">
            <h3>Day 1 easy mode</h3>
            <small>{easyModeStatus}</small>
          </div>
          <div className="onboardingProgressBar" aria-hidden="true">
            <span style={{ width: `${onboardingCompletionPercent}%` }} />
          </div>
          <p className={`dynamicStatus ${onboardingProgress.fullyComplete ? "dynamicStatus--ready" : "dynamicStatus--initializing"}`}>
            {onboardingProgress.fullyComplete
              ? "Ready. Continue playing now."
              : `Needs one action: ${easyModePrimaryStep?.title ?? "Complete setup"}.`}
          </p>
          <div className="row onboardingActionRow">
            <button type="button" disabled={busy} onClick={handleEasyModeContinue}>
              Continue Playing
            </button>
          </div>
          <small>
            {onboardingProgress.completedCount}/{onboardingProgress.totalCount} setup checks complete ({onboardingCompletionPercent}
            %)
          </small>
          {passkeySetupState.status === "warning" && passkeySetupState.message ? (
            <small>{passkeySetupState.message}</small>
          ) : null}
          <div className="row">
            <small>Identity: {accountProgression.identityReadiness === "ready" ? "Ready" : "Needs action"}</small>
            <small>Custody: {accountProgression.custodyReadiness === "ready" ? "Ready" : "Needs action"}</small>
            <small>Payout: {accountProgression.payoutReadiness === "ready" ? "Ready" : "Optional setup"}</small>
          </div>
          {accountProgression.nextActionHint ? <small>{accountProgression.nextActionHint}</small> : null}
          <details>
            <summary>Show setup details</summary>
            {onboardingProgress.steps.map((step) => (
              <article key={step.id} className="onboardingSlideCard">
                <div className="onboardingSlideHeader">
                  <strong>{step.title}</strong>
                  <small className={`onboardingStateBadge onboardingStateBadge--${step.status}`}>
                    {toOnboardingStatusCopy(step.status)}
                  </small>
                </div>
                <p>{step.description}</p>
                <small>{step.evidence}</small>
                <div className="row onboardingActionRow">
                  <button type="button" disabled={busy} onClick={() => handleOnboardingStepAction(step.action)}>
                    {step.actionLabel}
                  </button>
                </div>
              </article>
            ))}
            <small>This view derives from backend session/security truth with local passkey/recovery hints.</small>
          </details>
          <details>
            <summary>Show payout and transfer foundations</summary>
            <small>
              Ergo rail: {accountProgression.payoutRails.find((rail) => rail.rail === "ergo")?.state ?? "not_connected"} | PayPal
              rail: {accountProgression.payoutRails.find((rail) => rail.rail === "paypal")?.state ?? "coming_soon"}
            </small>
            <small>
              Transfer intents scaffold: {transferIntentReadModel.activeCount} active, {transferIntentReadModel.completedCount}{" "}
              completed, {transferIntentReadModel.failedCount} failed.
            </small>
          </details>
          <small>
            This easy mode derives readiness from backend truth and keeps optional rails non-blocking.
          </small>
        </div>
        <details className="toolboxAdvanced">
          <summary>Advanced Tools</summary>
          <div className="toolboxGrid">
            <div className="toolboxGroup">
              <h3>Session + Account Tools</h3>
              <div className="row">
                <button
                  type="button"
                  title="Start a temporary local guest session for quick testing."
                  disabled={busy || isSignedIn}
                  onClick={handleGuestLogin}
                >
                  Continue as Guest
                </button>
                <button
                  type="button"
                  title="Rehydrate active session context and lobby data from the backend."
                  disabled={busy}
                  onClick={handleRecoverSession}
                >
                  Recover Session + Lobby
                </button>
                <button
                  type="button"
                  title="Reload backend profile/account state and capability snapshots."
                  disabled={busy || !backendSession}
                  onClick={() => void withBusy(() => refreshProfile())}
                >
                  Refresh Backend Account
                </button>
                <button
                  type="button"
                  title="Refresh account security posture, trusted devices, and security metrics."
                  disabled={busy || !backendSession}
                  onClick={() => void withBusy(() => refreshSecurityPosture())}
                >
                  Refresh Security State
                </button>
              </div>
              <div className="row">
                <input
                  title="Display name used for local account registration."
                  value={localAuthDisplayName}
                  onChange={(event) => setLocalAuthDisplayName(event.target.value)}
                  placeholder="Display name"
                />
                <input
                  title="Email for local Day1 account login/recovery."
                  value={localAuthEmail}
                  onChange={(event) => setLocalAuthEmail(event.target.value)}
                  placeholder="Email"
                  type="email"
                />
                <input
                  title="Password for local Day1 account registration/login."
                  value={localAuthPassword}
                  onChange={(event) => setLocalAuthPassword(event.target.value)}
                  placeholder="Password"
                  type="password"
                />
                <button
                  type="button"
                  title="Create a local Day1 account when Dynamic is unavailable."
                  disabled={busy || isSignedIn}
                  onClick={handleLocalRegister}
                >
                  Register Local Account
                </button>
                <button
                  type="button"
                  title="Sign in with an existing local Day1 email/password account."
                  disabled={busy || isSignedIn}
                  onClick={handleLocalLogin}
                >
                  Local Login
                </button>
              </div>
              <small>These tools are optional fallbacks when the guided onboarding is not enough.</small>
            </div>
            <div className="toolboxGroup">
              <h3>Wallet + Recovery Tools</h3>
              <div className="row">
                <button
                  type="button"
                  title="Create a managed wallet and recovery secret to unlock Layer 2 rewards."
                  disabled={busy}
                  onClick={handleLayer2WalletSetup}
                >
                  Create Secure Wallet
                </button>
                <button
                  type="button"
                  title="Open wallet recovery tools to validate or restore wallet linkage from a recovery secret."
                  disabled={busy}
                  onClick={handleOpenRecoverWallet}
                >
                  Recover Wallet
                </button>
                <button
                  type="button"
                  title="Register a local device passkey (Touch ID/Face ID) after wallet setup."
                  disabled={busy || !backendSession || !profile?.walletAddress?.trim()}
                  onClick={handleSetupPasskey}
                >
                  Set Up Passkey
                </button>
                <button
                  type="button"
                  title="Download a local wallet portability backup JSON artifact."
                  disabled={busy || !backendSession}
                  onClick={handleExportWalletBackup}
                >
                  Export Wallet Backup
                </button>
              </div>
            </div>
            <div className="toolboxGroup">
              <h3>Legacy Email Recovery</h3>
              <div className="row">
                <input
                  title="Email address for requesting a password recovery reset token."
                  value={recoveryEmail}
                  onChange={(event) => setRecoveryEmail(event.target.value)}
                  placeholder="Recovery email"
                />
                <button
                  type="button"
                  title="Request a recovery email token for local account password reset."
                  disabled={busy}
                  onClick={handleRecoveryRequest}
                >
                  Request Recovery
                </button>
              </div>
              <div className="row">
                <input
                  title="Password reset token received from the recovery path."
                  value={recoveryToken}
                  onChange={(event) => setRecoveryToken(event.target.value)}
                  placeholder="Reset token"
                />
                <input
                  title="New password to set with the reset token."
                  value={recoveryNewPassword}
                  onChange={(event) => setRecoveryNewPassword(event.target.value)}
                  placeholder="New password"
                  type="password"
                />
                <button
                  type="button"
                  title="Complete local password reset using the recovery token."
                  disabled={busy || !recoveryToken.trim()}
                  onClick={handleRecoveryReset}
                >
                  Reset Password
                </button>
              </div>
            </div>
            <div className="toolboxGroup">
              <h3>MFA + Device Diagnostics</h3>
              <div className="row">
                <button
                  type="button"
                  title="Start time-based one-time password enrollment for this account."
                  disabled={busy || !backendSession}
                  onClick={handleTotpEnrollStart}
                >
                  Start TOTP Enrollment
                </button>
                <input
                  title="6-digit authenticator code used to verify TOTP enrollment."
                  value={mfaCodeInput}
                  onChange={(event) => setMfaCodeInput(event.target.value)}
                  placeholder="6-digit TOTP"
                />
                <button
                  type="button"
                  title="Verify TOTP enrollment with the current authenticator code."
                  disabled={busy || !backendSession}
                  onClick={handleTotpEnrollVerify}
                >
                  Verify Enrollment
                </button>
                <button
                  type="button"
                  title="Disable account TOTP if you need to reset MFA state."
                  disabled={busy || !backendSession}
                  onClick={handleTotpDisable}
                >
                  Disable TOTP
                </button>
                <button
                  type="button"
                  title="Mark this browser/device as trusted."
                  disabled={busy || !backendSession}
                  onClick={handleTrustCurrentDevice}
                >
                  Trust This Device
                </button>
              </div>
              <div className="row">
                <input
                  ref={walletAddressInputRef}
                  title="Existing wallet address to attach instead of creating a managed wallet."
                  value={walletAddress}
                  onChange={(event) => setWalletAddress(event.target.value)}
                  placeholder="Existing wallet address"
                />
                <button
                  type="button"
                  title="Link an externally-managed wallet address to the current Day1 account."
                  disabled={busy || !backendSession}
                  onClick={handleWalletBind}
                >
                  Link Existing Wallet
                </button>
                <button
                  type="button"
                  title="Sign out from the active backend Day1 session."
                  disabled={busy || !backendSession}
                  onClick={handleSignOut}
                >
                  Sign Out (Backend Session)
                </button>
                <button
                  type="button"
                  title="Clear local cached auth bootstrap/session state in this browser."
                  disabled={busy}
                  onClick={() => {
                    clearClientAuthBootstrap();
                    resetSessionState("Local session state reset. Sign in again to create a new backend session.");
                  }}
                >
                  Reset Local Session
                </button>
              </div>
            </div>
          </div>
        </details>
        {dynamicStatusMessage ? (
          <p className={`dynamicStatus dynamicStatus--${dynamic.availability}`}>
            {dynamicStatusMessage}
          </p>
        ) : null}
        <small>
          Auth state: {isSignedIn ? "signed in" : "not signed in"} | Session ID:{" "}
          {backendSession?.sessionId ?? "none"}
        </small>
        {dynamicAuthMode ? (
          <small>
            Dynamic link mode: JWT verified mode
          </small>
        ) : null}
        {authBlockingReason ? (
          <p className="dynamicStatus dynamicStatus--degraded">
            {authBlockingReason} Action: click Dynamic -&gt; Day1 Session, then Recover Session + Lobby.
          </p>
        ) : null}
      </section>

      <section className="panel">
        <h2>2) Security Telemetry</h2>
        <p className="panelHint">Live security posture, trusted-device/session inventory, and current counters.</p>
        <small>MFA enabled: {profile?.mfaEnabled ? "yes" : "no"} | Pending secret: {mfaSecretPreview || "none"}</small>
        <div className="securityList">
          <strong>Trusted devices</strong>
          {trustedDevices.length === 0 ? (
            <small>No trusted devices.</small>
          ) : (
            trustedDevices.map((device) => (
              <div key={device.deviceId} className="statRow">
                <span>{device.label ?? device.deviceId}</span>
                <button
                  type="button"
                  disabled={busy || !backendSession}
                  onClick={() =>
                    void withBusy(async () => {
                      await apiRevokeDevice(device.deviceId);
                      await refreshSecurityPosture();
                    })
                  }
                >
                  Revoke
                </button>
              </div>
            ))
          )}
        </div>
        <div className="securityList">
          <strong>Sessions</strong>
          {activeSessions.map((sessionEntry) => (
            <div key={sessionEntry.sessionId} className="statRow">
              <span>{sessionEntry.sessionId}</span>
              <button
                type="button"
                disabled={busy || !backendSession}
                onClick={() =>
                  void withBusy(async () => {
                    await apiRevokeSession(sessionEntry.sessionId);
                    await refreshSecurityPosture();
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
        <div className="securityList">
          <strong>Security metrics snapshot</strong>
          {renderedSecurityMetrics.length === 0 ? (
            <small>No security counters yet.</small>
          ) : (
            renderedSecurityMetrics.map((metric) => (
              <div key={metric.key} className="statRow">
                <span>{metric.key}</span>
                <small>{metric.count}</small>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel">
        <h2>3) Account Card (Backend State)</h2>
        {!isSignedIn ? (
          <p className="accountEmpty">Sign in above to load backend session and account details.</p>
        ) : (
          <>
            <div className="accountGrid">
              <span>Session ID</span>
              <code>{backendSession?.sessionId ?? "n/a"}</code>
              <span>User ID</span>
              <code>{backendSession?.userId ?? profile?.userId ?? "n/a"}</code>
              <span>Display Name</span>
              <strong>{profile?.displayName ?? "n/a"}</strong>
              <span>Email</span>
              <strong>{profile?.email ?? "n/a"}</strong>
              <span>Ownership Setup</span>
              <strong>{profile?.walletStatus === "bound_stub" ? "yes" : "no"}</strong>
              <span>Account Type</span>
              <strong>{accountStateSnapshot.accountType}</strong>
              <span>Canonical Account ID</span>
              <code>{accountStateSnapshot.accountId ?? "n/a"}</code>
              <span>External Auth Ref</span>
              <code>{accountStateSnapshot.externalAuthRef ?? "none"}</code>
              <span>Account Model Status</span>
              <strong>{accountModelSession.status}</strong>
              <span>Account Authority</span>
              <strong>{accountModelSession.identity.authority}</strong>
              <span>Conversion Target</span>
              <strong>{accountConversionSnapshot.targetType}</strong>
            </div>
            <small className="backupHint">
              Session and account fallback actions are available under Advanced Tools in the onboarding panel.
            </small>
            <small className="backupHint">
              Export is client-side only and never posts backup payloads to the Day1 API.{" "}
              {exportVaultCandidate
                ? "Encrypted vault material is available and will be included."
                : "No encrypted vault material detected, so export contains migration/session portability data only."}
            </small>
            <small className="backupHint">
              Last export: {lastBackupExportAt ?? "not exported in this session"}
            </small>
            <div className="securityList">
              <strong>Portability + Recovery Capabilities</strong>
              <small>Identity ref: {portabilityStatus.identityRef}</small>
              <small>
                Server authority:{" "}
                {portabilityStatus.serverAuthorityRef
                  ? `${portabilityStatus.serverAuthorityRef.registryId}/${portabilityStatus.serverAuthorityRef.userId ?? "n/a"}`
                  : "none"}
              </small>
              <small>
                Provider links:{" "}
                {portabilityStatus.providerLinks?.length
                  ? portabilityStatus.providerLinks
                      .map((link) => `${link.providerId}:${link.status}`)
                      .join(", ")
                  : "none"}
              </small>
              <small>Summary: {portabilitySummary.join(" | ")}</small>
              <small>
                Recovery continuity:{" "}
                {portabilityStatus.recoveryExportHandoff.continuityGuaranteed ? "guaranteed" : "not guaranteed"}
              </small>
              <small>
                Mnemonic/seed export:{" "}
                {portabilityStatus.mnemonicExport.state === "supported"
                  ? "supported by capability"
                  : `blocked (${portabilityStatus.mnemonicExport.reason ?? "migration required"})`}
              </small>
              <button
                type="button"
                disabled={!mnemonicExportEnabled}
                onClick={() =>
                  setEventLog(
                    "Mnemonic export will be enabled when cryptography path implementation is complete."
                  )
                }
              >
                Export Mnemonic (Capability-Gated)
              </button>
              {!mnemonicExportEnabled ? (
                <small>
                  Mnemonic flow remains disabled because cryptography/export implementation is pending completion.
                </small>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Account Security Linkage (Backend)</h2>
        {!isSignedIn ? (
          <p className="accountEmpty">Sign in to inspect persisted wallet/account linkage state.</p>
        ) : (
          <>
            <div className="accountGrid">
              <span>Wallet Address</span>
              <code>{accountSecurityState?.wallet.address ?? "not linked"}</code>
              <span>Wallet Linked</span>
              <strong>{accountSecurityState?.wallet.linked ? "yes" : "no"}</strong>
              <span>Dynamic Identity Linked</span>
              <strong>{accountSecurityState?.identities.some((entry) => entry.provider === "dynamic") ? "yes" : "no"}</strong>
              <span>Primary Dynamic Subject</span>
              <code>
                {accountSecurityState?.identities.find((entry) => entry.provider === "dynamic")?.subject ?? "none"}
              </code>
              <span>Wallet Link Updated</span>
              <strong>
                {accountSecurityState?.wallet.updatedAt
                  ? new Date(accountSecurityState.wallet.updatedAt).toLocaleString()
                  : "not linked"}
              </strong>
              <span>Security State Updated</span>
              <strong>
                {accountSecurityState?.lastUpdatedAt
                  ? new Date(accountSecurityState.lastUpdatedAt).toLocaleString()
                  : "n/a"}
              </strong>
            </div>
            <small className="backupHint">
              Values above come from persisted backend records (`wallet_bindings` + `account_identities`), not client-only state.
            </small>
          </>
        )}
      </section>

      <section className="panel" ref={walletBindingSectionRef}>
        <h2>4) Secure Wallet Setup</h2>
        <p className="panelHint">
          Wallet setup actions are in the Toolbox. This panel shows secure-wallet status and recovery material.
        </p>
        <small className="backupHint">
          Uses Dynamic-backed identity plus Day1 account linkage for ownership continuity.
        </small>
        <small className="backupHint">
          Passkey support:{" "}
          {hasLocalPasskey
            ? "supported + enrolled (local device record)"
            : passkeyFeatureSupported
              ? "supported but not enrolled yet"
              : "unsupported on this browser/platform context"}
          . Passkey enrollment is local-only today; backend authoritative passkey persistence is pending.
        </small>
        {passkeySetupState.status !== "idle" ? (
          <p
            className={`dynamicStatus ${
              passkeySetupState.status === "success" || passkeySetupState.status === "already_configured"
                ? "dynamicStatus--ready"
                : "dynamicStatus--initializing"
            }`}
          >
            {passkeySetupState.message}
          </p>
        ) : null}
        <small className="backupHint">
          Status mapping: success=enrolled, already_configured=enrolled already, skipped=user canceled/closed prompt,
          unsupported=platform/browser limitation.
        </small>
        {latestRecoverySecret ? (
          <div className="securityList">
            <strong>Recovery secret code (save offline now)</strong>
            <code>{latestRecoverySecret}</code>
            <small>
              Issued: {latestRecoveryIssuedAt ?? "just now"} | This code unlocks future export/recovery workflows.
            </small>
          </div>
        ) : null}
        <div className="securityList" ref={walletRecoverySectionRef}>
          <strong>Recover wallet linkage from secret</strong>
          <small>
            This validates your recovery secret against encrypted payload available in this browser/device backup and can
            restore backend wallet linkage when data is present.
          </small>
          <div className="row">
            <input
              title="Recovery secret used to validate/import wallet linkage from encrypted backup material."
              value={recoverySecretInput}
              onChange={(event) => setRecoverySecretInput(event.target.value)}
              placeholder="Recovery secret code"
            />
            <button
              type="button"
              title="Validate recovery secret and restore backend wallet linkage when recovery payload is present."
              disabled={busy || !backendSession || !recoverySecretInput.trim()}
              onClick={handleRecoverWalletFromSecret}
            >
              Validate / Import Recovery
            </button>
          </div>
          {recoveryImportState.status !== "idle" ? (
            <p
              className={`dynamicStatus ${
                recoveryImportState.status === "success"
                  ? "dynamicStatus--ready"
                  : recoveryImportState.status === "warning"
                    ? "dynamicStatus--initializing"
                    : "dynamicStatus--degraded"
              }`}
            >
              {recoveryImportState.message}
            </p>
          ) : null}
        </div>
        <small>
          Secure wallet status: {profile?.walletStatus ?? "unknown"} {profile?.walletAddress ?? ""}
        </small>
      </section>

      <section className="panel" ref={lobbySectionRef}>
        <h2>5) Lobby (Create/Join/List)</h2>
        <div className="row">
          <select
            value={selectedGameType}
            onChange={(event) => setSelectedGameType(event.target.value as GameType)}
            disabled={busy || !backendSession}
          >
            {gameTypes.length === 0 ? (
              <option value={selectedGameType}>
                {gameTypesLoadState === "loading"
                  ? "Loading game types..."
                  : gameTypesLoadState === "error"
                    ? "Game types unavailable"
                    : "No game types available"}
              </option>
            ) : (
              gameTypes.map((entry) => (
                <option key={entry.gameType} value={entry.gameType}>
                  {entry.displayName}
                </option>
              ))
            )}
          </select>
          <button type="button" disabled={busy || !backendSession} onClick={handleCreateGame}>
            Create Game
          </button>
          <select
            value={lobbyFilter}
            onChange={(event) => setLobbyFilter(event.target.value as typeof lobbyFilter)}
            disabled={busy || !backendSession}
          >
            <option value="all">All Games</option>
            <option value="open">Open Seats</option>
            <option value="active">Active Games</option>
            <option value="completed">Completed</option>
          </select>
          <button
            type="button"
            disabled={busy || !backendSession}
            onClick={() => void withBusy(() => refreshLobbyAndDirectory())}
          >
            Refresh Lobby
          </button>
        </div>
        {gameTypesLoadError ? <p className="dynamicStatus dynamicStatus--degraded">{gameTypesLoadError}</p> : null}
        <div className="gameList">
          {games.length === 0 ? (
            <small>No games found for current filter.</small>
          ) : (
            games.map((entry) => (
              <div className="gameListRow" key={entry.gameId}>
                <code>{entry.gameId}</code>
                <span>{entry.gameType}</span>
                <span>{entry.status.kind === "ongoing" ? `Turn ${entry.status.turn}` : entry.status.kind}</span>
                <span>Seats: X={entry.playerSeats.X} O={entry.playerSeats.O ?? "open"}</span>
                <button
                  type="button"
                  disabled={busy || !canJoinLobbyEntry(entry)}
                  onClick={() => handleJoinGame(entry.gameId)}
                >
                  {entry.playerSeats.O === null ? "Join" : "View"}
                </button>
              </div>
            ))
          )}
        </div>
        <div className="row">
          <input
            value={joinGameId}
            onChange={(event) => setJoinGameId(event.target.value)}
            placeholder="Join game id"
          />
          <button
            type="button"
            disabled={busy || !backendSession || !joinGameId.trim()}
            onClick={handleJoinGame}
          >
            Join
          </button>
          <button
            type="button"
            disabled={busy || !backendSession || !game?.gameId}
            onClick={() => {
              if (!game?.gameId) return;
              void withBusy(async () => {
                await hydrateGameState(game.gameId, "Game state refreshed from backend.");
              });
            }}
          >
            Refresh Game
          </button>
        </div>
        <small>
          Active game: {game?.gameId ?? "none"} | Assigned side: {playerSymbol ?? "spectator"} | Seats X/
          O: {game?.playerSeats.X ?? "n/a"} / {game?.playerSeats.O ?? "waiting"}
        </small>
      </section>

      <div className="statusRow">
        <span>{statusMessage}</span>
        <span>
          Player: {profile?.displayName ?? "anonymous"} {playerSymbol ? `(${playerSymbol})` : "(observer)"}
        </span>
      </div>

      <section className="panel">
        <h2>6) Game Board (Server Authoritative)</h2>
        <p className="panelHint">
          Server enforces seat ownership, turn order, completion state, and reward confirmations.
        </p>
      </section>

      <section className="board" aria-label="Tic-Tac-Toe board">
        {((game && isTicTacToeGame ? (game.state as { board: Board }).board : Array(9).fill(CELL_EMPTY)) as Board).map((cell, index) => (
          <button
            type="button"
            key={index}
            className="cell"
            disabled={
              busy ||
              !game ||
              !isTicTacToeGame ||
              cell !== CELL_EMPTY ||
              gameStatus?.kind !== "ongoing" ||
              !canPlayCurrentTurn
            }
            onClick={() => handleCellClick(index)}
          >
            {toSymbol(cell)}
          </button>
        ))}
      </section>
      {!isTicTacToeGame && game ? (
        <section className="panel">
          <p className="panelHint">
            {game.gameType} is registered through the shared runtime as a preview adapter and does not expose move actions yet.
          </p>
        </section>
      ) : null}

      <section className="panel">
        <h2>7) Completion + Rewards</h2>
        {postGameSummary ? (
          <div className="completionCard">
            <p>{postGameSummary}</p>
            <p>
              Reward confirmation:{" "}
              {rewards ? `${rewards.tier} tier, ${rewards.points} points` : "waiting for backend reward snapshot"}
            </p>
          </div>
        ) : (
          <p className="panelHint">
            Completion view will appear once the game reaches win/draw state and backend confirms updated rewards.
          </p>
        )}
      </section>

      <section className="panel">
        <h2>8) Known Players + Leaderboard</h2>
        <div className="directoryGrid">
          <div>
            <h3>Recently Active Players</h3>
            {knownPlayers.length === 0 ? (
              <small>No recent players yet.</small>
            ) : (
              knownPlayers.map((player) => (
                <div className="statRow" key={player.userId}>
                  <span>{player.displayName}</span>
                  <small>
                    games {player.gamesPlayed} / wins {player.wins}
                  </small>
                </div>
              ))
            )}
          </div>
          <div>
            <h3>Leaderboard</h3>
            {leaderboard.length === 0 ? (
              <small>No leaderboard entries yet.</small>
            ) : (
              leaderboard.map((entry) => (
                <div className="statRow" key={entry.userId}>
                  <span>
                    #{entry.rank} {entry.displayName}
                  </span>
                  <small>
                    {entry.points} pts | {entry.wins}W / {entry.gamesPlayed}G
                  </small>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>9) On-Chain Intent Scaffold</h2>
        <div className="row">
          <button type="button" disabled={busy} onClick={handleRefreshRewards}>
            Get Rewards
          </button>
          <button type="button" disabled={busy || !game} onClick={handleCreateIntent}>
            Create Intent
          </button>
          <button type="button" disabled={busy || !intentId} onClick={handleIntentStatus}>
            Intent Status
          </button>
        </div>
        <small>
          Rewards: {rewards ? `${rewards.tier} (${rewards.points} pts)` : "not loaded"} | Intent:{" "}
          {intentId || "not created"}
        </small>
        {!progressiveCapabilities.layers.rewards.eligible ? (
          <small>
            {progressiveCapabilities.layers.rewards.message}
            {progressiveCapabilities.layers.rewards.actionLabel
              ? ` Action: ${progressiveCapabilities.layers.rewards.actionLabel}.`
              : ""}
          </small>
        ) : null}
        {!progressiveCapabilities.layers.wagering.eligible ? (
          <small>
            {progressiveCapabilities.layers.wagering.message}
            {progressiveCapabilities.layers.wagering.actionLabel
              ? ` Action: ${progressiveCapabilities.layers.wagering.actionLabel}.`
              : ""}
          </small>
        ) : null}
      </section>

      <section className="panel">
        <h2>10) Periodic Ratification</h2>
        <p className="panelHint">
          Off-chain events are bundled in deterministic batches and anchored by the server on a cadence.
        </p>
        <div className="row">
          <button type="button" disabled={busy || !backendSession} onClick={handleRatificationRun}>
            Run Ratification Now
          </button>
          <button
            type="button"
            disabled={busy || !backendSession}
            onClick={() => void withBusy(() => refreshRatificationState())}
          >
            Refresh Ratification
          </button>
        </div>
        <div className="row">
          <input
            value={ratificationIntervalMs}
            onChange={(event) => setRatificationIntervalMs(event.target.value)}
            placeholder="Interval ms"
          />
          <button type="button" disabled={busy || !backendSession} onClick={handleSaveRatificationInterval}>
            Save Interval
          </button>
        </div>
        <small>
          Wallet ready: {walletStatus?.ready ? "yes" : "no"} | Wallet mode: {walletStatus?.mode ?? "n/a"} | Chain adapter:{" "}
          {ratificationAdapter ? `${ratificationAdapter.mode}/${ratificationAdapter.network}` : "n/a"} | Signer mode:{" "}
          {ratificationAdapter?.signerMode ?? "n/a"} | Finality depth: {ratificationAdapter?.finalityDepth ?? "n/a"} | Schedule:{" "}
          {ratificationSchedule ? `${ratificationSchedule.intervalMs}ms (${ratificationSchedule.source})` : "n/a"} | Last anchored checkpoint:{" "}
          {ratificationCheckpoint?.lastAnchoredEventId ?? 0} | Last successful ratification:{" "}
          {ratificationCheckpoint?.lastSuccessfulRatificationAt ?? "n/a"} | Last ratified block:{" "}
          {ratificationCheckpoint?.lastRatifiedBlockHeight ?? "n/a"}
        </small>
        <small>{ratificationModeHint}</small>
        {ratificationSignerMode !== "direct" && (
          <div className="row">
            <input
              value={signedBatchId}
              onChange={(event) => setSignedBatchId(event.target.value)}
              placeholder="Batch id for signed submit"
            />
            <input
              value={signedTxHex}
              onChange={(event) => setSignedTxHex(event.target.value)}
              placeholder="Signed tx hex"
            />
            <button type="button" disabled={busy || !backendSession} onClick={handleSubmitSignedBatch}>
              Submit Signed Tx
            </button>
          </div>
        )}
        <div className="gameList">
          {ratificationBatches.length === 0 ? (
            <small>No ratification batches yet.</small>
          ) : (
            ratificationBatches.map((batch) => (
              <div className="gameListRow" key={batch.batchId}>
                <code>{batch.batchId}</code>
                <span>
                  {batch.status} | confirmations={batch.confirmationDepth} | finality={batch.confirmationStatus}
                </span>
                <span>
                  {batch.fromEventId}-{batch.toEventId} tx={batch.txId ?? "n/a"} payload={batch.payloadHash.slice(0, 10)}
                </span>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="panel truthPanel">
        <h2>11) Truth Stack</h2>
        <p className="panelHint">
          Stack view of no-wager records: pending off-chain work, ratified anchors, and on-chain gate sources.
        </p>
        <div className="row">
          <button
            type="button"
            disabled={busy || !backendSession}
            onClick={() => void withBusy(() => refreshRatificationState())}
          >
            Refresh Truth Stack
          </button>
          <small>
            Authoritative layers:{" "}
            {truthStack ? truthStack.authoritativeStates.join(" + ").replaceAll("_", " ") : "ratified + on chain source"}
          </small>
        </div>
        <div className="truthColumns">
          {truthColumns.map((column) => (
            <article key={column.key} className={`truthColumn ${column.className}`}>
              <header className="truthColumnHeader">
                <h3>{column.label}</h3>
                <strong>{column.count}</strong>
              </header>
              <small>{column.subtitle}</small>
              <div className="truthCards">
                {column.items.length === 0 ? (
                  <small className="truthEmpty">No recent records.</small>
                ) : (
                  column.items.map((item) => (
                    <div key={item.id} className="truthCard">
                      <div className="truthCardTop">
                        <code>{item.kind === "game_event" ? `event#${item.eventId ?? "?"}` : item.id}</code>
                        <span>{item.action}</span>
                      </div>
                      <small>
                        game={item.gameId} ({item.gameType})
                      </small>
                      <small>users={item.userIds.join(", ")}</small>
                      <small>
                        refs: batch={item.batchId ?? "n/a"} tx={item.txRef ?? "n/a"}
                      </small>
                      <small>{new Date(item.occurredAt).toLocaleString()}</small>
                    </div>
                  ))
                )}
              </div>
            </article>
          ))}
        </div>
      </section>

      {isSecureWalletModalOpen ? (
        <div
          className="secureWalletModalBackdrop"
          role="presentation"
          onClick={() => {
            setIsSecureWalletModalOpen(false);
            setSecureWalletConfirmationChecked(false);
          }}
        >
          <div
            className="secureWalletModal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="secure-wallet-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="secure-wallet-modal-title">Confirm secure wallet creation</h3>
            <p>
              This creates a secure wallet tied to your account security and ownership. It is a serious action that enables
              Layer 2 rewards access.
            </p>
            <ul>
              <li>You will receive a recovery secret code that you must store safely.</li>
              <li>Future access/recovery/export uses your account session plus that recovery code.</li>
              <li>Anyone with your recovery code may be able to recover/export wallet data.</li>
            </ul>
            <p>Store the recovery code offline (for example in a password manager or paper backup).</p>
            <label className="secureWalletConfirmLabel">
              <input
                type="checkbox"
                checked={secureWalletConfirmationChecked}
                onChange={(event) => setSecureWalletConfirmationChecked(event.target.checked)}
              />
              I understand this action and will store my recovery code safely offline.
            </label>
            <div className="row secureWalletModalActions">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setIsSecureWalletModalOpen(false);
                  setSecureWalletConfirmationChecked(false);
                }}
              >
                Not now
              </button>
              <button type="button" disabled={busy || !secureWalletConfirmationChecked} onClick={handleCreateSecureWallet}>
                Continue and Create Wallet
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <pre className="eventBox">{eventLog}</pre>
    </main>
  );
}

export default App;
