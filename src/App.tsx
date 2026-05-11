import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildExportArtifact,
  buildAccountSession,
  getPortabilityStatus,
  validateExportArtifact,
  type WalletSourceKind,
} from "@twobitedd/ergo-account-model";
import { CELL_EMPTY, CELL_O, CELL_X, statusOf, type Board, type GameType, type GameTypeMetadata } from "@twobitedd/ergo-games-interface";
import {
  apiRegister,
  apiLogin,
  apiGuestLogin,
  apiDynamicLogin,
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
import { waitForAuthTokenWithRetry } from "./dynamicSessionSync";
import "./App.css";

const ENCRYPTED_VAULT_LOCAL_STORAGE_KEY = "ergo-dynamic-vault-v1";
const ENCRYPTED_VAULT_DYNAMIC_METADATA_KEY = "ergoVaultV1";
const LIVE_SYNC_INTERVAL_MS = 4000;
const GAME_TYPES_MAX_RETRIES = 3;
const GAME_TYPES_RETRY_DELAY_MS = 220;
const DYNAMIC_TOKEN_MAX_RETRIES = 4;
const DYNAMIC_TOKEN_RETRY_DELAY_MS = 180;
const SESSION_VERIFY_MAX_RETRIES = 4;
const SESSION_VERIFY_RETRY_DELAY_MS = 220;
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
      <button type="button" disabled={busy || !dynamic.enabled || !dynamic.configured} onClick={dynamic.openAuthFlow}>
        Open Dynamic Auth
      </button>
      {dynamic.availability === "idle" ? (
        <button type="button" disabled={busy || !dynamic.enabled || !dynamic.configured} onClick={dynamic.requestActivation}>
          Enable Dynamic Auth Module
        </button>
      ) : null}
      <button type="button" disabled={busy || !authTokenReady} onClick={handleSync}>
        {syncInProgress ? "Syncing Dynamic -> Day1..." : "Dynamic -> Day1 Session"}
      </button>
      <button type="button" disabled={busy || !sdkReady || !dynamicUser} onClick={() => void dynamic.signOut()}>
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
  const [lastBackupExportAt, setLastBackupExportAt] = useState<string | null>(null);
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
  const exportVaultCandidate = useMemo(() => loadExportVaultCandidate(dynamicUser), [dynamicUser]);
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

  const refreshProfile = async () => {
    const session = await apiGetSession();
    const me = await apiGetProfile();
    setBackendSession(session.session);
    setProfile(me.profile);
    await Promise.all([refreshSecurityPosture(), refreshRatificationState()]);
    setEventLog(`Session verified for ${session.profile.displayName}`);
  };

  const waitForDynamicAuthToken = async () =>
    waitForAuthTokenWithRetry({
      maxRetries: DYNAMIC_TOKEN_MAX_RETRIES,
      retryDelayMs: DYNAMIC_TOKEN_RETRY_DELAY_MS,
      getToken: dynamic.getAuthToken,
      sleep,
      onRetry: (attempt, maxRetries) => {
        setDynamicSyncStatusMessage(`Waiting for Dynamic auth token (${attempt}/${maxRetries})...`);
      },
    });

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

  const refreshLobbyAndDirectory = async (filter: "all" | "open" | "active" | "completed" = lobbyFilter) => {
    await fetchLobbyAndDirectorySnapshot(filter);
  };

  const refreshPostLoginState = async () => {
    const [lobbyResult, securityResult, ratificationResult] = await Promise.allSettled([
      refreshLobbyAndDirectory(),
      refreshSecurityPosture(),
      refreshRatificationState(),
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
    const nonBlockingFailures = [securityResult, ratificationResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    return { partialFailures: nonBlockingFailures.length > 0 };
  };

  const refreshSecurityPosture = async () => {
    const [devicesPayload, sessionsPayload, metricsPayload] = await Promise.all([
      apiListTrustedDevices(),
      apiListSessions(),
      apiGetSecurityMetrics(),
    ]);
    setTrustedDevices(devicesPayload.devices.map((entry) => ({ deviceId: entry.deviceId, label: entry.label })));
    setActiveSessions(sessionsPayload.sessions.map((entry) => ({ sessionId: entry.sessionId, deviceId: entry.deviceId })));
    setSecurityMetrics(metricsPayload.metrics);
  };

  const refreshRatificationState = async () => {
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
      const refreshOutcome = await refreshPostLoginState();
      setDynamicAuthMode(null);
      setEventLog(
        refreshOutcome.partialFailures
          ? `Local login session active for ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
          : `Local login session active for ${verifiedSession.profile.displayName}.`
      );
    });
  };

  const handleDynamicLogin = (payload: { email?: string; displayName?: string }) => {
    if (!dynamic.enabled || !dynamic.configured) {
      setDynamicSyncErrorMessage("Dynamic is not configured. Set Dynamic env vars and enable the module before syncing.");
      setDynamicSyncStatusMessage(null);
      return;
    }
    if (!dynamic.sdkHasLoaded || !dynamic.user) {
      setDynamicSyncErrorMessage("Dynamic user session is not ready. Open Dynamic Auth and complete sign-in first.");
      setDynamicSyncStatusMessage(null);
      return;
    }
    setBusy(true);
    setDynamicSyncInProgress(true);
    setDynamicSyncErrorMessage(null);
    setDynamicSyncStatusMessage("Starting Dynamic -> Day1 session handshake...");
    void (async () => {
      try {
        if (!dynamic.getAuthToken()?.trim()) {
          dynamic.openAuthFlow();
        }
        const authToken = await waitForDynamicAuthToken();
        setDynamicSyncStatusMessage("Submitting Dynamic token to Day1 API...");
        await apiDynamicLogin({ authToken, ...payload });
        setAuthBlockingReason(null);
        setDynamicAuthMode("jwt_verified");
        setEventLog("Dynamic JWT login accepted. Verifying backend session...");
        setDynamicSyncStatusMessage("Verifying Day1 backend session...");
        const verifiedSession = await verifyBackendSessionAfterLogin("Dynamic JWT");
        setBackendSession(verifiedSession.session);
        setProfile(verifiedSession.profile);
        setDynamicSyncStatusMessage("Hydrating lobby and security state...");
        const refreshOutcome = await refreshPostLoginState();
        setDynamicSyncStatusMessage(
          refreshOutcome.partialFailures
            ? `Day1 session active for ${verifiedSession.profile.displayName}; background panels will continue syncing.`
            : `Day1 session active for ${verifiedSession.profile.displayName}.`
        );
        setEventLog(
          refreshOutcome.partialFailures
            ? `Dynamic linked via JWT verified mode for ${verifiedSession.profile.displayName}. Some non-critical panels will refresh on next sync.`
            : `Dynamic linked via JWT verified mode for ${verifiedSession.profile.displayName}.`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected Dynamic login failure.";
        setDynamicSyncErrorMessage(message);
        setDynamicSyncStatusMessage(null);
        setEventLog(`Dynamic -> Day1 session failed: ${message}`);
      } finally {
        setDynamicSyncInProgress(false);
        setBusy(false);
      }
    })();
  };

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
      setAuthBlockingReason(null);
      await refreshLobbyAndDirectory();
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
      setProfile(payload.profile);
      setEventLog(`Wallet bound as scaffold: ${payload.walletBinding.status}`);
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
        channel: "email-service",
        contact: profile?.email ?? null,
        continuityGuaranteed: true,
        notes: [
          "Recovery can continue through Day1 server-owned account registry when Dynamic is unavailable.",
          "Use /api/auth/recovery/request and /api/auth/recovery/reset for service continuity.",
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
    if (!backendSession) return;
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

      <section className="panel">
        <h2>1) Account Access</h2>
        <p className="panelHint">
          Dynamic.xyz is optional authentication. Day1 server registry is the authoritative account identity.
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
        <div className="row">
          <button type="button" disabled={busy || isSignedIn} onClick={handleGuestLogin}>
            Continue as Guest
          </button>
          <small>Guest mode is for local testing only and is not used as Dynamic fallback.</small>
        </div>
        <div className="row">
          <input
            value={localAuthDisplayName}
            onChange={(event) => setLocalAuthDisplayName(event.target.value)}
            placeholder="Display name"
          />
          <input
            value={localAuthEmail}
            onChange={(event) => setLocalAuthEmail(event.target.value)}
            placeholder="Email"
            type="email"
          />
          <input
            value={localAuthPassword}
            onChange={(event) => setLocalAuthPassword(event.target.value)}
            placeholder="Password"
            type="password"
          />
          <button type="button" disabled={busy || isSignedIn} onClick={handleLocalRegister}>
            Register Local Account
          </button>
          <button type="button" disabled={busy || isSignedIn} onClick={handleLocalLogin}>
            Local Login
          </button>
        </div>
        <small>Dynamic unavailable? Use local login/register to keep server identity continuity.</small>
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
        <div className="row">
          <button type="button" disabled={busy} onClick={handleRecoverSession}>
            Recover Session + Lobby
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>2) Email Recovery Path</h2>
        <p className="panelHint">
          Email-based recovery is part of the Day1 continuity path when Dynamic is unavailable.
        </p>
        <details>
          <summary>Open legacy password recovery controls</summary>
          <div className="row">
            <input value={recoveryEmail} onChange={(event) => setRecoveryEmail(event.target.value)} placeholder="Recovery email" />
            <button type="button" disabled={busy} onClick={handleRecoveryRequest}>
              Request Recovery
            </button>
          </div>
          <div className="row">
            <input value={recoveryToken} onChange={(event) => setRecoveryToken(event.target.value)} placeholder="Reset token" />
            <input
              value={recoveryNewPassword}
              onChange={(event) => setRecoveryNewPassword(event.target.value)}
              placeholder="New password"
              type="password"
            />
            <button type="button" disabled={busy || !recoveryToken.trim()} onClick={handleRecoveryReset}>
              Reset Password
            </button>
          </div>
        </details>
      </section>

      <section className="panel">
        <h2>3) MFA + Device Controls</h2>
        <p className="panelHint">TOTP enrollment and trusted-device/session scaffolding for account hardening.</p>
        <div className="row">
          <button type="button" disabled={busy || !backendSession} onClick={handleTotpEnrollStart}>
            Start TOTP Enrollment
          </button>
          <input value={mfaCodeInput} onChange={(event) => setMfaCodeInput(event.target.value)} placeholder="6-digit TOTP" />
          <button type="button" disabled={busy || !backendSession} onClick={handleTotpEnrollVerify}>
            Verify Enrollment
          </button>
          <button type="button" disabled={busy || !backendSession} onClick={handleTotpDisable}>
            Disable TOTP
          </button>
        </div>
        <div className="row">
          <button type="button" disabled={busy || !backendSession} onClick={handleTrustCurrentDevice}>
            Trust This Device
          </button>
          <button type="button" disabled={busy || !backendSession} onClick={() => void withBusy(() => refreshSecurityPosture())}>
            Refresh Security State
          </button>
        </div>
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
        <h2>2) Account Card (Backend State)</h2>
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
              <span>Wallet Linked</span>
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
            <div className="row">
              <button
                type="button"
                disabled={busy || !backendSession}
                onClick={() => void withBusy(() => refreshProfile())}
              >
                Refresh Backend Account
              </button>
              <button type="button" disabled={busy || !backendSession} onClick={handleSignOut}>
                Sign Out (Backend Session)
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  {
                    clearClientAuthBootstrap();
                    resetSessionState("Local session state reset. Sign in again to create a new backend session.");
                  }
                }
              >
                Reset Local Session
              </button>
              <button type="button" disabled={busy || !backendSession} onClick={handleExportWalletBackup}>
                Export Wallet Backup
              </button>
            </div>
            <small className="backupHint">
              Export is client-side only and never posts backup payloads to the Day1 API.{" "}
              {exportVaultCandidate
                ? "Encrypted vault material is available and will be included."
                : "No encrypted vault material detected, so export contains migration/session portability data only."}
            </small>
            <small className="backupHint">
              Last export: {lastBackupExportAt ?? "not exported in this session"}
            </small>
          </>
        )}
      </section>

      <section className="panel">
        <h2>3) Wallet Binding (Optional)</h2>
        <p className="panelHint">
          Identity and wallet remain separate by design for MVP stability.
        </p>
        <div className="row">
          <input
            value={walletAddress}
            onChange={(event) => setWalletAddress(event.target.value)}
            placeholder="Wallet address (stub)"
          />
          <button type="button" disabled={busy || !backendSession} onClick={handleWalletBind}>
            Bind Wallet
          </button>
        </div>
        <small>
          Wallet status: {profile?.walletStatus ?? "unknown"} {profile?.walletAddress ?? ""}
        </small>
      </section>

      <section className="panel">
        <h2>4) Lobby (Create/Join/List)</h2>
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
        <h2>5) Game Board (Server Authoritative)</h2>
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
        <h2>6) Completion + Rewards</h2>
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
        <h2>7) Known Players + Leaderboard</h2>
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
        <h2>8) On-Chain Intent Scaffold</h2>
        <div className="row">
          <button type="button" disabled={busy || !backendSession} onClick={handleRefreshRewards}>
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
      </section>

      <section className="panel">
        <h2>9) Periodic Ratification</h2>
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
        <h2>10) Truth Stack</h2>
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

      <pre className="eventBox">{eventLog}</pre>
    </main>
  );
}

export default App;
