import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import {
  applyDeterministicTicTacToeMove,
  createTicTacToeState,
  statusOf,
} from "@twobitedd/ergo-games-interface";
import type { GameType, RuntimeGameStatus } from "@twobitedd/ergo-games-interface";

type TicTacToeMoveResult = ReturnType<typeof applyDeterministicTicTacToeMove>;
type TicTacToeState = ReturnType<typeof createTicTacToeState>;
type TicTacToePlayer = "X" | "O";
type RewardTier = "none" | "starter" | "engaged";

const DEFAULT_DB_PATH = resolve(process.cwd(), ".day1-data/day1.sqlite");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30;
const MFA_ENROLLMENT_TTL_MS = 1000 * 60 * 10;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const canonicalizeLoginIdentifier = (value: string) => value.trim().toLowerCase();

export interface SessionRecord {
  sessionId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  deviceId?: string;
  mfaVerifiedAt?: string;
}

export interface ProfileRecord {
  userId: string;
  displayName: string;
  email: string;
  mfaEnabled?: boolean;
  walletAddress?: string;
  walletStatus: "unbound" | "bound_stub";
  gamesPlayed: number;
  wins: number;
}

export interface AccountSecurityStateRecord {
  userId: string;
  wallet: {
    status: "unbound" | "bound_stub";
    address?: string;
    linked: boolean;
    updatedAt?: string;
  };
  identities: Array<{
    provider: string;
    subject: string;
    linked: boolean;
    emailAtLink?: string;
    displayNameAtLink?: string;
    createdAt: string;
    lastSeenAt: string;
  }>;
  lastUpdatedAt: string;
}

export interface GameEventRecord {
  type: "MOVE_APPLIED";
  actorUserId: string;
  cell: number;
  nextTurn?: "X" | "O";
  winner?: "X" | "O";
  drawn?: boolean;
}

export interface GameRecord {
  gameId: string;
  gameType: GameType;
  createdByUserId: string;
  participants: string[];
  playerSeats: {
    X: string;
    O: string | null;
  };
  trustLabel: "NO_WAGER_TRUSTED_SCAFFOLD";
  state: TicTacToeState | { phase: "placeholder"; open: boolean };
  events: GameEventRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface GameListRecord {
  gameId: string;
  gameType: GameType;
  playerSeats: { X: string; O: string | null };
  participants: string[];
  status: RuntimeGameStatus;
  createdAt: string;
  updatedAt: string;
}

export interface RecentPlayerRecord {
  userId: string;
  displayName: string;
  lastActiveAt: string;
  gamesPlayed: number;
  wins: number;
}

export interface LeaderboardRecord {
  rank: number;
  userId: string;
  displayName: string;
  points: number;
  wins: number;
  gamesPlayed: number;
}

export type JoinGameResult =
  | { ok: true; game: GameRecord }
  | { ok: false; reason: "GAME_NOT_FOUND" | "GAME_FULL" };

export type StoreMoveResult =
  | TicTacToeMoveResult
  | {
      ok: false;
      reason: "PLAYER_NOT_IN_GAME" | "NOT_YOUR_TURN" | "WAITING_FOR_OPPONENT" | "UNSUPPORTED_FOR_GAME_TYPE";
      expectedTurn?: TicTacToePlayer;
      actorSymbol?: TicTacToePlayer | null;
    };

export interface OnChainIntentRecord {
  intentId: string;
  gameId: string;
  createdByUserId: string;
  action: "SETTLE_GAME" | "SYNC_RESULT";
  status: "pending_stub" | "confirmed_stub";
  txHash?: string;
  createdAt: string;
}

export type RatificationBatchStatus = "submitting" | "awaiting_signature" | "submitted" | "confirmed" | "failed";
export type RatificationConfirmationStatus = "pending" | "confirmed" | "finalized" | "reorged" | "unknown";

export interface RatificationScheduleRecord {
  intervalMs: number;
  enabled: boolean;
  updatedAt: string;
  source: "env" | "api";
}

export interface RatificationCheckpointRecord {
  lastAnchoredEventId: number;
  lastBatchId?: string;
  lastSuccessfulRatificationAt?: string;
  lastRatifiedBlockHeight?: number;
  updatedAt: string;
}

export interface RatificationBatchRecord {
  batchId: string;
  status: RatificationBatchStatus;
  fromEventId: number;
  toEventId: number;
  recordCount: number;
  recordHash: string;
  merkleRoot: string;
  txId?: string;
  adapterMode: string;
  chainNetwork: "testnet" | "mainnet";
  payloadHash: string;
  confirmationStatus: RatificationConfirmationStatus;
  confirmationDepth: number;
  finalized: boolean;
  reorgDetected: boolean;
  artifactJson: string;
  signerPayloadJson?: string;
  createdAt: string;
  submittedAt?: string;
  confirmedAt?: string;
  finalizedAt?: string;
  lastCheckedAt?: string;
  failedAt?: string;
  failureReason?: string;
  submitError?: string;
}

export interface RatifiableEventRecord {
  eventId: number;
  gameId: string;
  type: string;
  actorUserId: string;
  cell: number;
  nextTurn?: "X" | "O";
  winner?: "X" | "O";
  drawn: boolean;
  createdAt: string;
}

export interface AccountCredentialRecord {
  userId: string;
  email: string;
  displayName: string;
  passwordHash: string;
  passwordSalt: string;
  mfaEnabled: boolean;
  totpSecretCiphertext?: string;
}

export interface ExternalIdentityRecord {
  provider: string;
  subject: string;
  userId: string;
  emailAtLink?: string;
  displayNameAtLink?: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface TrustedDeviceRecord {
  deviceId: string;
  userId: string;
  label?: string;
  createdAt: string;
  lastUsedAt: string;
  revokedAt?: string;
}

export interface SecurityEventRecord {
  eventId: string;
  eventType: string;
  userId?: string;
  sessionId?: string;
  ipAddress?: string;
  userAgent?: string;
  outcome: "SUCCESS" | "FAILURE" | "INFO";
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface EndpointMetricRecord {
  key: string;
  requests: number;
  errors: number;
  avgLatencyMs: number;
  updatedAt: string;
}

export interface RateLimitPolicy {
  windowMs: number;
  maxAttempts: number;
  blockMs: number;
}

export interface IdempotencyReplayRecord {
  statusCode: number;
  body: unknown;
  requestHash: string;
  createdAt: string;
}

export type IdempotencyLookupResult =
  | { state: "miss" }
  | { state: "pending" }
  | { state: "conflict"; requestHash: string }
  | { state: "replay"; replay: IdempotencyReplayRecord };

interface SessionAndProfile {
  session: SessionRecord;
  profile: ProfileRecord;
}

export class Day1Store {
  private readonly db: Database.Database;

  constructor(dbPath = process.env.DAY1_DB_PATH ?? DEFAULT_DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();
  }

  close() {
    this.db.close();
  }

  private initializeSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        email_canonical TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        totp_secret_ciphertext TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS account_identities (
        provider TEXT NOT NULL,
        provider_subject TEXT NOT NULL,
        user_id TEXT NOT NULL,
        email_at_link TEXT,
        display_name_at_link TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (provider, provider_subject),
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        device_id TEXT,
        mfa_verified_at TEXT,
        ip_address TEXT,
        user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS wallet_bindings (
        user_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        wallet_status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS games (
        game_id TEXT PRIMARY KEY,
        game_type TEXT NOT NULL DEFAULT 'tic_tac_toe',
        created_by_user_id TEXT NOT NULL,
        player_x_user_id TEXT NOT NULL,
        player_o_user_id TEXT,
        trust_label TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (created_by_user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS game_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        cell INTEGER NOT NULL,
        next_turn TEXT,
        winner TEXT,
        drawn INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS leaderboard_stats (
        user_id TEXT PRIMARY KEY,
        games_played INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        last_game_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS reward_snapshots (
        user_id TEXT PRIMARY KEY,
        tier TEXT NOT NULL,
        points INTEGER NOT NULL,
        note TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS onchain_intents (
        intent_id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL,
        created_by_user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        tx_hash TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (created_by_user_id) REFERENCES accounts(user_id) ON DELETE CASCADE,
        FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        rate_key TEXT PRIMARY KEY,
        attempts INTEGER NOT NULL,
        window_start_ms INTEGER NOT NULL,
        blocked_until_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        requested_ip TEXT,
        requested_user_agent TEXT,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS mfa_totp_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        secret_ciphertext TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS trusted_devices (
        device_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        label TEXT,
        fingerprint_hash TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (device_id, user_id),
        FOREIGN KEY (user_id) REFERENCES accounts(user_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS security_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        user_id TEXT,
        session_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        outcome TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS security_metrics (
        metric_key TEXT PRIMARY KEY,
        total_count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS endpoint_metrics (
        endpoint_key TEXT PRIMARY KEY,
        request_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        total_latency_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS idempotency_keys (
        principal_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        response_status INTEGER,
        response_body_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (principal_key, scope, idempotency_key)
      );

      CREATE TABLE IF NOT EXISTS ratification_schedule (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        interval_ms INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ratification_checkpoint (
        singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
        last_anchored_event_id INTEGER NOT NULL DEFAULT 0,
        last_batch_id TEXT,
        last_successful_ratification_at TEXT,
        last_ratified_block_height INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ratification_batches (
        batch_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        from_event_id INTEGER NOT NULL,
        to_event_id INTEGER NOT NULL,
        record_count INTEGER NOT NULL,
        record_hash TEXT NOT NULL,
        merkle_root TEXT NOT NULL,
        tx_id TEXT,
        adapter_mode TEXT NOT NULL,
        chain_network TEXT NOT NULL DEFAULT 'testnet',
        payload_hash TEXT NOT NULL DEFAULT '',
        confirmation_status TEXT NOT NULL DEFAULT 'pending',
        confirmation_depth INTEGER NOT NULL DEFAULT 0,
        finalized INTEGER NOT NULL DEFAULT 0,
        finalized_at TEXT,
        reorg_detected INTEGER NOT NULL DEFAULT 0,
        last_checked_at TEXT,
        signer_payload_json TEXT,
        submit_error TEXT,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        submitted_at TEXT,
        confirmed_at TEXT,
        failed_at TEXT,
        failure_reason TEXT
      );
    `);
    this.ensureColumn("accounts", "email_canonical", "TEXT");
    this.db.exec(
      `UPDATE accounts
       SET email = LOWER(TRIM(email))
       WHERE user_id IN (
         SELECT candidate.user_id
         FROM accounts AS candidate
         WHERE candidate.email <> LOWER(TRIM(candidate.email))
           AND NOT EXISTS (
             SELECT 1
             FROM accounts AS other
             WHERE other.user_id <> candidate.user_id
               AND LOWER(TRIM(other.email)) = LOWER(TRIM(candidate.email))
           )
       );`
    );
    this.db.exec(
      `UPDATE accounts
       SET email_canonical = LOWER(TRIM(email))
       WHERE user_id IN (
         SELECT candidate.user_id
         FROM accounts AS candidate
         WHERE (candidate.email_canonical IS NULL OR candidate.email_canonical <> LOWER(TRIM(candidate.email)))
           AND NOT EXISTS (
             SELECT 1
             FROM accounts AS other
             WHERE other.user_id <> candidate.user_id
               AND LOWER(TRIM(other.email)) = LOWER(TRIM(candidate.email))
           )
       );`
    );
    this.db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email_canonical_unique
       ON accounts(email_canonical)
       WHERE email_canonical IS NOT NULL;`
    );
    this.ensureColumn("accounts", "mfa_enabled", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("accounts", "totp_secret_ciphertext", "TEXT");
    this.ensureColumn("sessions", "csrf_token_hash", "TEXT");
    this.ensureColumn("sessions", "device_id", "TEXT");
    this.ensureColumn("sessions", "mfa_verified_at", "TEXT");
    this.ensureColumn("games", "game_type", "TEXT NOT NULL DEFAULT 'tic_tac_toe'");
    this.ensureColumn("ratification_batches", "chain_network", "TEXT NOT NULL DEFAULT 'testnet'");
    this.ensureColumn("ratification_batches", "payload_hash", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("ratification_batches", "confirmation_status", "TEXT NOT NULL DEFAULT 'pending'");
    this.ensureColumn("ratification_batches", "confirmation_depth", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("ratification_batches", "finalized", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("ratification_batches", "finalized_at", "TEXT");
    this.ensureColumn("ratification_batches", "reorg_detected", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("ratification_batches", "last_checked_at", "TEXT");
    this.ensureColumn("ratification_batches", "signer_payload_json", "TEXT");
    this.ensureColumn("ratification_batches", "submit_error", "TEXT");
    this.ensureColumn("ratification_checkpoint", "last_successful_ratification_at", "TEXT");
    this.ensureColumn("ratification_checkpoint", "last_ratified_block_height", "INTEGER");
  }

  private ensureColumn(tableName: string, columnName: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === columnName)) return;
    this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  private createInitialState(gameType: GameType) {
    if (gameType === "tic_tac_toe") return createTicTacToeState(false);
    return { phase: "placeholder" as const, open: true };
  }

  private deriveGameStatus(gameType: GameType, state: GameRecord["state"]): RuntimeGameStatus {
    if (gameType === "tic_tac_toe") {
      const typedState = state as TicTacToeState;
      return statusOf(typedState.board, typedState.open);
    }
    const open = "open" in state ? Boolean(state.open) : true;
    return open ? { kind: "open" } : { kind: "ongoing", turn: "X" };
  }

  private parseGame(row: {
    game_id: string;
    game_type: string;
    created_by_user_id: string;
    player_x_user_id: string;
    player_o_user_id: string | null;
    trust_label: "NO_WAGER_TRUSTED_SCAFFOLD";
    state_json: string;
    created_at: string;
    updated_at: string;
  }): GameRecord {
    const events = this.db
      .prepare(
        `SELECT actor_user_id, cell, next_turn, winner, drawn
         FROM game_events WHERE game_id = ? ORDER BY id ASC`
      )
      .all(row.game_id) as Array<{
      actor_user_id: string;
      cell: number;
      next_turn: "X" | "O" | null;
      winner: "X" | "O" | null;
      drawn: number;
    }>;

    return {
      gameId: row.game_id,
      gameType: row.game_type === "coin_flip_demo" ? "coin_flip_demo" : "tic_tac_toe",
      createdByUserId: row.created_by_user_id,
      participants: row.player_o_user_id
        ? [row.player_x_user_id, row.player_o_user_id]
        : [row.player_x_user_id],
      playerSeats: {
        X: row.player_x_user_id,
        O: row.player_o_user_id,
      },
      trustLabel: row.trust_label,
      state: JSON.parse(row.state_json) as TicTacToeState | { phase: "placeholder"; open: boolean },
      events: events.map((entry) => ({
        type: "MOVE_APPLIED",
        actorUserId: entry.actor_user_id,
        cell: entry.cell,
        nextTurn: entry.next_turn ?? undefined,
        winner: entry.winner ?? undefined,
        drawn: Boolean(entry.drawn),
      })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private ensureLeaderboardSeed(userId: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO leaderboard_stats (user_id, games_played, wins, points, updated_at)
         VALUES (?, 0, 0, 0, ?)`
      )
      .run(userId, now);
  }

  private upsertRewardSnapshot(userId: string) {
    const stats = this.db
      .prepare("SELECT games_played, wins FROM leaderboard_stats WHERE user_id = ?")
      .get(userId) as { games_played: number; wins: number } | undefined;
    if (!stats) return null;

    let tier: RewardTier = "none";
    if (stats.games_played >= 1) tier = "starter";
    if (stats.wins >= 2) tier = "engaged";
    const points = stats.wins * 100 + stats.games_played * 20;
    const updatedAt = new Date().toISOString();
    const note = "Reward values are Day1 scaffolds for UX and API integration.";

    this.db
      .prepare(
        `INSERT INTO reward_snapshots (user_id, tier, points, note, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
          tier = excluded.tier,
          points = excluded.points,
          note = excluded.note,
          updated_at = excluded.updated_at`
      )
      .run(userId, tier, points, note, updatedAt);

    return { userId, tier, points, note, updatedAt };
  }

  createAccount(input: {
    email: string;
    displayName: string;
    passwordHash: string;
    passwordSalt: string;
  }) {
    const canonicalEmail = canonicalizeLoginIdentifier(input.email);
    if (!canonicalEmail || !canonicalEmail.includes("@")) return null;
    const existing = this.getAccountCredentialByEmail(canonicalEmail);
    if (existing) return null;
    const userId = `user_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO accounts
           (user_id, email, email_canonical, display_name, password_hash, password_salt, mfa_enabled, totp_secret_ciphertext, created_at, last_active_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`
        )
        .run(
          userId,
          canonicalEmail,
          canonicalEmail,
          input.displayName,
          input.passwordHash,
          input.passwordSalt,
          now,
          now
        );
      this.ensureLeaderboardSeed(userId);
      this.upsertRewardSnapshot(userId);
    } catch {
      return null;
    }

    return this.getProfile(userId);
  }

  getAccountCredentialByEmail(email: string): AccountCredentialRecord | null {
    const canonicalEmail = canonicalizeLoginIdentifier(email);
    if (!canonicalEmail) return null;
    const row = this.db
      .prepare(
        `SELECT user_id, email, display_name, password_hash, password_salt, mfa_enabled, totp_secret_ciphertext
         FROM accounts
         WHERE email_canonical = ? OR LOWER(TRIM(email)) = ?
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .get(canonicalEmail, canonicalEmail) as
      | {
          user_id: string;
          email: string;
          display_name: string;
          password_hash: string;
          password_salt: string;
          mfa_enabled: number;
          totp_secret_ciphertext: string | null;
        }
      | undefined;

    if (!row) return null;
    return {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      passwordHash: row.password_hash,
      passwordSalt: row.password_salt,
      mfaEnabled: Boolean(row.mfa_enabled),
      totpSecretCiphertext: row.totp_secret_ciphertext ?? undefined,
    };
  }

  getExternalIdentity(provider: string, subject: string): ExternalIdentityRecord | null {
    const row = this.db
      .prepare(
        `SELECT provider, provider_subject, user_id, email_at_link, display_name_at_link, created_at, last_seen_at
         FROM account_identities
         WHERE provider = ? AND provider_subject = ?`
      )
      .get(provider.trim(), subject.trim()) as
      | {
          provider: string;
          provider_subject: string;
          user_id: string;
          email_at_link: string | null;
          display_name_at_link: string | null;
          created_at: string;
          last_seen_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      provider: row.provider,
      subject: row.provider_subject,
      userId: row.user_id,
      emailAtLink: row.email_at_link ?? undefined,
      displayNameAtLink: row.display_name_at_link ?? undefined,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    };
  }

  upsertExternalIdentity(input: {
    provider: string;
    subject: string;
    userId: string;
    emailAtLink?: string;
    displayNameAtLink?: string;
  }) {
    const provider = input.provider.trim();
    const subject = input.subject.trim();
    if (!provider || !subject) return;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO account_identities
         (provider, provider_subject, user_id, email_at_link, display_name_at_link, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, provider_subject) DO UPDATE SET
          user_id = excluded.user_id,
          email_at_link = COALESCE(excluded.email_at_link, account_identities.email_at_link),
          display_name_at_link = COALESCE(excluded.display_name_at_link, account_identities.display_name_at_link),
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        provider,
        subject,
        input.userId,
        input.emailAtLink ?? null,
        input.displayNameAtLink ?? null,
        now,
        now
      );
  }

  createSessionForUser(
    userId: string,
    metadata: { ipAddress?: string; userAgent?: string; deviceId?: string; mfaVerifiedAt?: string }
  ) {
    const sessionId = `sess_${randomUUID().slice(0, 16)}`;
    const token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const csrfToken = randomBytes(24).toString("hex");
    const csrfTokenHash = hashToken(csrfToken);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const mfaVerifiedAt = metadata.mfaVerifiedAt ?? null;

    this.db
      .prepare(
        `INSERT INTO sessions
         (session_id, user_id, token_hash, csrf_token_hash, created_at, expires_at, last_seen_at, device_id, mfa_verified_at, ip_address, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sessionId,
        userId,
        tokenHash,
        csrfTokenHash,
        createdAt,
        expiresAt,
        createdAt,
        metadata.deviceId ?? null,
        mfaVerifiedAt,
        metadata.ipAddress ?? null,
        metadata.userAgent ?? null
      );

    this.db
      .prepare("UPDATE accounts SET last_active_at = ? WHERE user_id = ?")
      .run(createdAt, userId);

    return {
      session: { sessionId, userId, createdAt, expiresAt, deviceId: metadata.deviceId, mfaVerifiedAt: metadata.mfaVerifiedAt },
      sessionToken: token,
      csrfToken,
    };
  }

  getSessionAndProfileByToken(token: string): SessionAndProfile | null {
    const tokenHash = hashToken(token);

    const row = this.db
      .prepare(
        `SELECT s.session_id, s.user_id, s.created_at, s.expires_at, s.device_id, s.mfa_verified_at,
                a.display_name, a.email, a.mfa_enabled,
                a.last_active_at, lb.games_played, lb.wins, wb.wallet_address, wb.wallet_status
         FROM sessions s
         JOIN accounts a ON a.user_id = s.user_id
         LEFT JOIN leaderboard_stats lb ON lb.user_id = a.user_id
         LEFT JOIN wallet_bindings wb ON wb.user_id = a.user_id
         WHERE s.token_hash = ?`
      )
      .get(tokenHash) as
      | {
          session_id: string;
          user_id: string;
          created_at: string;
          expires_at: string;
          device_id: string | null;
          mfa_verified_at: string | null;
          display_name: string;
          email: string;
          mfa_enabled: number;
          games_played: number | null;
          wins: number | null;
          wallet_address: string | null;
          wallet_status: "unbound" | "bound_stub" | null;
        }
      | undefined;

    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
      return null;
    }

    const now = new Date().toISOString();
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(now, tokenHash);
    this.db.prepare("UPDATE accounts SET last_active_at = ? WHERE user_id = ?").run(now, row.user_id);

    return {
      session: {
        sessionId: row.session_id,
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        deviceId: row.device_id ?? undefined,
        mfaVerifiedAt: row.mfa_verified_at ?? undefined,
      },
      profile: {
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        walletAddress: row.wallet_address ?? undefined,
        walletStatus: row.wallet_status ?? "unbound",
        gamesPlayed: row.games_played ?? 0,
        wins: row.wins ?? 0,
        mfaEnabled: Boolean(row.mfa_enabled),
      },
    };
  }

  removeSessionByToken(token: string) {
    const tokenHash = hashToken(token);
    const result = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return result.changes > 0;
  }

  purgeExpiredSessions(referenceTimeMs = Date.now()) {
    const cutoffIso = new Date(referenceTimeMs).toISOString();
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(cutoffIso);
  }

  getProfile(userId: string) {
    const row = this.db
      .prepare(
        `SELECT a.user_id, a.display_name, a.email, a.mfa_enabled,
                lb.games_played, lb.wins, wb.wallet_address, wb.wallet_status
         FROM accounts a
         LEFT JOIN leaderboard_stats lb ON lb.user_id = a.user_id
         LEFT JOIN wallet_bindings wb ON wb.user_id = a.user_id
         WHERE a.user_id = ?`
      )
      .get(userId) as
      | {
          user_id: string;
          display_name: string;
          email: string;
          mfa_enabled: number;
          games_played: number | null;
          wins: number | null;
          wallet_address: string | null;
          wallet_status: "unbound" | "bound_stub" | null;
        }
      | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      mfaEnabled: Boolean(row.mfa_enabled),
      walletAddress: row.wallet_address ?? undefined,
      walletStatus: row.wallet_status ?? "unbound",
      gamesPlayed: row.games_played ?? 0,
      wins: row.wins ?? 0,
    } satisfies ProfileRecord;
  }

  getAccountSecurityState(userId: string): AccountSecurityStateRecord | null {
    const profile = this.getProfile(userId);
    if (!profile) return null;
    const accountRow = this.db
      .prepare("SELECT last_active_at FROM accounts WHERE user_id = ?")
      .get(userId) as { last_active_at: string } | undefined;
    const walletRow = this.db
      .prepare(
        `SELECT wallet_address, wallet_status, updated_at
         FROM wallet_bindings
         WHERE user_id = ?`
      )
      .get(userId) as
      | {
          wallet_address: string;
          wallet_status: "unbound" | "bound_stub";
          updated_at: string;
        }
      | undefined;
    const identityRows = this.db
      .prepare(
        `SELECT provider, provider_subject, email_at_link, display_name_at_link, created_at, last_seen_at
         FROM account_identities
         WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .all(userId) as Array<{
      provider: string;
      provider_subject: string;
      email_at_link: string | null;
      display_name_at_link: string | null;
      created_at: string;
      last_seen_at: string;
    }>;

    const walletUpdatedAt = walletRow?.updated_at;
    const latestIdentityUpdatedAt = identityRows[0]?.last_seen_at;
    const updatedCandidates = [accountRow?.last_active_at, walletUpdatedAt, latestIdentityUpdatedAt]
      .filter((value): value is string => typeof value === "string")
      .sort((a, b) => Date.parse(b) - Date.parse(a));

    return {
      userId,
      wallet: {
        status: profile.walletStatus,
        address: profile.walletAddress,
        linked: profile.walletStatus === "bound_stub" && Boolean(profile.walletAddress?.trim()),
        updatedAt: walletUpdatedAt,
      },
      identities: identityRows.map((entry) => ({
        provider: entry.provider,
        subject: entry.provider_subject,
        linked: true,
        emailAtLink: entry.email_at_link ?? undefined,
        displayNameAtLink: entry.display_name_at_link ?? undefined,
        createdAt: entry.created_at,
        lastSeenAt: entry.last_seen_at,
      })),
      lastUpdatedAt: updatedCandidates[0] ?? new Date().toISOString(),
    };
  }

  bindWallet(userId: string, walletAddress: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO wallet_bindings (user_id, wallet_address, wallet_status, updated_at)
         VALUES (?, ?, 'bound_stub', ?)
         ON CONFLICT(user_id) DO UPDATE SET
          wallet_address = excluded.wallet_address,
          wallet_status = excluded.wallet_status,
          updated_at = excluded.updated_at`
      )
      .run(userId, walletAddress, now);
    return this.getProfile(userId);
  }

  createGame(createdByUserId: string, gameType: GameType = "tic_tac_toe") {
    const now = new Date().toISOString();
    const gameId = `game_${randomUUID().slice(0, 10)}`;
    const state = this.createInitialState(gameType);
    this.db
      .prepare(
        `INSERT INTO games
         (game_id, game_type, created_by_user_id, player_x_user_id, player_o_user_id, trust_label, state_json, created_at, updated_at, completed)
         VALUES (?, ?, ?, ?, NULL, 'NO_WAGER_TRUSTED_SCAFFOLD', ?, ?, ?, 0)`
      )
      .run(gameId, gameType, createdByUserId, createdByUserId, JSON.stringify(state), now, now);
    return this.getGame(gameId)!;
  }

  joinGame(gameId: string, userId: string): JoinGameResult {
    const row = this.db
      .prepare("SELECT player_x_user_id, player_o_user_id FROM games WHERE game_id = ?")
      .get(gameId) as
      | {
          player_x_user_id: string;
          player_o_user_id: string | null;
        }
      | undefined;
    if (!row) return { ok: false, reason: "GAME_NOT_FOUND" };
    if (row.player_x_user_id === userId || row.player_o_user_id === userId) {
      return { ok: true, game: this.getGame(gameId)! };
    }
    if (row.player_o_user_id !== null) return { ok: false, reason: "GAME_FULL" };

    this.db
      .prepare("UPDATE games SET player_o_user_id = ?, updated_at = ? WHERE game_id = ?")
      .run(userId, new Date().toISOString(), gameId);
    return { ok: true, game: this.getGame(gameId)! };
  }

  listGames() {
    const rows = this.db
      .prepare(
        `SELECT game_id, game_type, player_x_user_id, player_o_user_id, state_json, created_at, updated_at
         FROM games ORDER BY updated_at DESC LIMIT 100`
      )
      .all() as Array<{
      game_id: string;
      game_type: string;
      player_x_user_id: string;
      player_o_user_id: string | null;
      state_json: string;
      created_at: string;
      updated_at: string;
    }>;

    return rows.map((row) => {
      const gameType = row.game_type === "coin_flip_demo" ? "coin_flip_demo" : "tic_tac_toe";
      const state = JSON.parse(row.state_json) as GameRecord["state"];
      return {
        gameId: row.game_id,
        gameType,
        playerSeats: {
          X: row.player_x_user_id,
          O: row.player_o_user_id,
        },
        participants: row.player_o_user_id
          ? [row.player_x_user_id, row.player_o_user_id]
          : [row.player_x_user_id],
        status: this.deriveGameStatus(gameType, state),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies GameListRecord;
    });
  }

  getGame(gameId: string) {
    const row = this.db
      .prepare(
        `SELECT game_id, game_type, created_by_user_id, player_x_user_id, player_o_user_id, trust_label, state_json, created_at, updated_at
         FROM games WHERE game_id = ?`
      )
      .get(gameId) as
      | {
          game_id: string;
          game_type: string;
          created_by_user_id: string;
          player_x_user_id: string;
          player_o_user_id: string | null;
          trust_label: "NO_WAGER_TRUSTED_SCAFFOLD";
          state_json: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return this.parseGame(row);
  }

  private symbolForUser(game: GameRecord, userId: string): TicTacToePlayer | null {
    if (game.playerSeats.X === userId) return "X";
    if (game.playerSeats.O === userId) return "O";
    return null;
  }

  private finalizeGameStats(game: GameRecord, winner: "X" | "O" | null) {
    const gameRow = this.db
      .prepare("SELECT completed FROM games WHERE game_id = ?")
      .get(game.gameId) as { completed: number } | undefined;
    if (!gameRow || gameRow.completed === 1) return;

    const now = new Date().toISOString();
    for (const participant of game.participants) {
      this.ensureLeaderboardSeed(participant);
      const won = winner !== null && this.symbolForUser(game, participant) === winner;
      this.db
        .prepare(
          `UPDATE leaderboard_stats
           SET games_played = games_played + 1,
               wins = wins + ?,
               points = points + ?,
               last_game_at = ?,
               updated_at = ?
           WHERE user_id = ?`
        )
        .run(won ? 1 : 0, won ? 120 : 20, now, now, participant);
      this.upsertRewardSnapshot(participant);
    }

    this.db.prepare("UPDATE games SET completed = 1, updated_at = ? WHERE game_id = ?").run(now, game.gameId);
  }

  applyMove(gameId: string, userId: string, cell: number): StoreMoveResult | null {
    const game = this.getGame(gameId);
    if (!game) return null;
    if (game.gameType !== "tic_tac_toe") {
      return { ok: false, reason: "UNSUPPORTED_FOR_GAME_TYPE" };
    }
    const actorSymbol = this.symbolForUser(game, userId);
    if (!actorSymbol) return { ok: false, reason: "PLAYER_NOT_IN_GAME", actorSymbol: null };

    const typedState = game.state as TicTacToeState;
    const beforeStatus = statusOf(typedState.board, typedState.open);
    if (beforeStatus.kind === "ongoing") {
      if (beforeStatus.turn === "O" && game.playerSeats.O === null) {
        return { ok: false, reason: "WAITING_FOR_OPPONENT", expectedTurn: beforeStatus.turn, actorSymbol };
      }
      if (beforeStatus.turn !== actorSymbol) {
        return { ok: false, reason: "NOT_YOUR_TURN", expectedTurn: beforeStatus.turn, actorSymbol };
      }
    }

    const result = applyDeterministicTicTacToeMove(typedState, { actorUserId: userId, cell });
    if (!result.ok) return result;

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE games SET state_json = ?, updated_at = ? WHERE game_id = ?")
      .run(JSON.stringify(result.state), now, gameId);
    this.db
      .prepare(
        `INSERT INTO game_events
         (game_id, type, actor_user_id, cell, next_turn, winner, drawn, created_at)
         VALUES (?, 'MOVE_APPLIED', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        gameId,
        result.event.actorUserId,
        result.event.cell,
        result.event.nextTurn ?? null,
        result.event.winner ?? null,
        result.event.drawn ? 1 : 0,
        now
      );

    const refreshed = this.getGame(gameId);
    if (!refreshed) return result;
    const afterStatus = statusOf(refreshed.state.board, refreshed.state.open);
    if (afterStatus.kind === "won") this.finalizeGameStats(refreshed, afterStatus.winner);
    if (afterStatus.kind === "drawn") this.finalizeGameStats(refreshed, null);
    return result;
  }

  getRewards(userId: string) {
    const snapshot = this.upsertRewardSnapshot(userId);
    if (!snapshot) return null;
    return {
      userId: snapshot.userId,
      tier: snapshot.tier,
      points: snapshot.points,
      note: snapshot.note,
    };
  }

  listRecentPlayers(limit = 20): RecentPlayerRecord[] {
    const rows = this.db
      .prepare(
        `SELECT a.user_id, a.display_name, a.last_active_at, lb.games_played, lb.wins
         FROM accounts a
         LEFT JOIN leaderboard_stats lb ON lb.user_id = a.user_id
         ORDER BY a.last_active_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
      user_id: string;
      display_name: string;
      last_active_at: string;
      games_played: number | null;
      wins: number | null;
    }>;

    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      lastActiveAt: row.last_active_at,
      gamesPlayed: row.games_played ?? 0,
      wins: row.wins ?? 0,
    }));
  }

  getLeaderboard(limit = 25): LeaderboardRecord[] {
    const rows = this.db
      .prepare(
        `SELECT lb.user_id, a.display_name, lb.points, lb.wins, lb.games_played
         FROM leaderboard_stats lb
         JOIN accounts a ON a.user_id = lb.user_id
         ORDER BY lb.points DESC, lb.wins DESC, lb.games_played DESC, a.display_name ASC
         LIMIT ?`
      )
      .all(limit) as Array<{
      user_id: string;
      display_name: string;
      points: number;
      wins: number;
      games_played: number;
    }>;

    return rows.map((row, index) => ({
      rank: index + 1,
      userId: row.user_id,
      displayName: row.display_name,
      points: row.points,
      wins: row.wins,
      gamesPlayed: row.games_played,
    }));
  }

  createOnChainIntent(gameId: string, userId: string, action: "SETTLE_GAME" | "SYNC_RESULT") {
    const intentId = `intent_${randomUUID().slice(0, 10)}`;
    const intent: OnChainIntentRecord = {
      intentId,
      gameId,
      createdByUserId: userId,
      action,
      status: "pending_stub",
      createdAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `INSERT INTO onchain_intents
         (intent_id, game_id, created_by_user_id, action, status, tx_hash, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`
      )
      .run(intent.intentId, intent.gameId, intent.createdByUserId, intent.action, intent.status, intent.createdAt);
    return intent;
  }

  getOnChainIntent(intentId: string) {
    const row = this.db
      .prepare(
        `SELECT intent_id, game_id, created_by_user_id, action, status, tx_hash, created_at
         FROM onchain_intents WHERE intent_id = ?`
      )
      .get(intentId) as
      | {
          intent_id: string;
          game_id: string;
          created_by_user_id: string;
          action: "SETTLE_GAME" | "SYNC_RESULT";
          status: "pending_stub" | "confirmed_stub";
          tx_hash: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;

    if (row.status === "pending_stub") {
      const txHash = `0xstub${row.intent_id.slice(-8)}`;
      this.db
        .prepare("UPDATE onchain_intents SET status = 'confirmed_stub', tx_hash = ? WHERE intent_id = ?")
        .run(txHash, row.intent_id);
      return {
        intentId: row.intent_id,
        gameId: row.game_id,
        createdByUserId: row.created_by_user_id,
        action: row.action,
        status: "confirmed_stub" as const,
        txHash,
        createdAt: row.created_at,
      };
    }

    return {
      intentId: row.intent_id,
      gameId: row.game_id,
      createdByUserId: row.created_by_user_id,
      action: row.action,
      status: row.status,
      txHash: row.tx_hash ?? undefined,
      createdAt: row.created_at,
    };
  }

  listOnChainIntents(limit = 50): OnChainIntentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT intent_id, game_id, created_by_user_id, action, status, tx_hash, created_at
         FROM onchain_intents
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      intent_id: string;
      game_id: string;
      created_by_user_id: string;
      action: "SETTLE_GAME" | "SYNC_RESULT";
      status: "pending_stub" | "confirmed_stub";
      tx_hash: string | null;
      created_at: string;
    }>;

    return rows.map((row) => ({
      intentId: row.intent_id,
      gameId: row.game_id,
      createdByUserId: row.created_by_user_id,
      action: row.action,
      status: row.status,
      txHash: row.tx_hash ?? undefined,
      createdAt: row.created_at,
    }));
  }

  rotateCsrfToken(sessionId: string) {
    const csrfToken = randomBytes(24).toString("hex");
    const updatedAt = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE sessions SET csrf_token_hash = ?, last_seen_at = ? WHERE session_id = ?")
      .run(hashToken(csrfToken), updatedAt, sessionId);
    if (result.changes === 0) return null;
    return csrfToken;
  }

  isCsrfTokenValid(sessionId: string, csrfToken: string) {
    const row = this.db
      .prepare("SELECT csrf_token_hash FROM sessions WHERE session_id = ?")
      .get(sessionId) as { csrf_token_hash: string | null } | undefined;
    if (!row?.csrf_token_hash) return false;
    const candidate = Buffer.from(hashToken(csrfToken));
    const expected = Buffer.from(row.csrf_token_hash);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  createPasswordResetToken(email: string, metadata: { ipAddress?: string; userAgent?: string }) {
    const account = this.getAccountCredentialByEmail(email);
    if (!account) return null;
    this.db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? OR expires_at <= ?").run(
      account.userId,
      new Date().toISOString()
    );
    const token = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString();
    const tokenId = `prt_${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        `INSERT INTO password_reset_tokens
         (token_id, user_id, token_hash, created_at, expires_at, used_at, requested_ip, requested_user_agent)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
      )
      .run(tokenId, account.userId, hashToken(token), now, expiresAt, metadata.ipAddress ?? null, metadata.userAgent ?? null);
    return { token, tokenId, expiresAt, userId: account.userId };
  }

  consumePasswordResetToken(token: string, passwordHash: string, passwordSalt: string) {
    const tokenHash = hashToken(token);
    const row = this.db
      .prepare(
        `SELECT token_id, user_id, expires_at, used_at
         FROM password_reset_tokens
         WHERE token_hash = ?`
      )
      .get(tokenHash) as
      | {
          token_id: string;
          user_id: string;
          expires_at: string;
          used_at: string | null;
        }
      | undefined;
    if (!row) return { ok: false as const, reason: "TOKEN_NOT_FOUND" as const };
    if (row.used_at) return { ok: false as const, reason: "TOKEN_ALREADY_USED" as const };
    if (Date.parse(row.expires_at) <= Date.now()) return { ok: false as const, reason: "TOKEN_EXPIRED" as const };

    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE accounts SET password_hash = ?, password_salt = ?, last_active_at = ? WHERE user_id = ?")
        .run(passwordHash, passwordSalt, now, row.user_id);
      this.db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token_id = ?").run(now, row.token_id);
      this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.user_id);
    });
    tx();
    return { ok: true as const, userId: row.user_id };
  }

  createTotpEnrollment(userId: string, secretCiphertext: string) {
    this.db.prepare("DELETE FROM mfa_totp_enrollments WHERE user_id = ?").run(userId);
    const enrollmentId = `mfae_${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + MFA_ENROLLMENT_TTL_MS).toISOString();
    this.db
      .prepare(
        `INSERT INTO mfa_totp_enrollments (enrollment_id, user_id, secret_ciphertext, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(enrollmentId, userId, secretCiphertext, now, expiresAt);
    return { enrollmentId, expiresAt };
  }

  getPendingTotpEnrollment(userId: string) {
    const row = this.db
      .prepare(
        `SELECT enrollment_id, secret_ciphertext, expires_at
         FROM mfa_totp_enrollments WHERE user_id = ?`
      )
      .get(userId) as
      | {
          enrollment_id: string;
          secret_ciphertext: string;
          expires_at: string;
        }
      | undefined;
    if (!row) return null;
    if (Date.parse(row.expires_at) <= Date.now()) {
      this.db.prepare("DELETE FROM mfa_totp_enrollments WHERE enrollment_id = ?").run(row.enrollment_id);
      return null;
    }
    return { enrollmentId: row.enrollment_id, secretCiphertext: row.secret_ciphertext, expiresAt: row.expires_at };
  }

  confirmTotpEnrollment(userId: string, secretCiphertext: string) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db
        .prepare("UPDATE accounts SET mfa_enabled = 1, totp_secret_ciphertext = ?, last_active_at = ? WHERE user_id = ?")
        .run(secretCiphertext, now, userId);
      this.db.prepare("DELETE FROM mfa_totp_enrollments WHERE user_id = ?").run(userId);
    });
    tx();
  }

  disableTotpForUser(userId: string) {
    this.db
      .prepare("UPDATE accounts SET mfa_enabled = 0, totp_secret_ciphertext = NULL, last_active_at = ? WHERE user_id = ?")
      .run(new Date().toISOString(), userId);
  }

  upsertTrustedDevice(userId: string, deviceId: string, label?: string, fingerprint?: string) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO trusted_devices
         (device_id, user_id, label, fingerprint_hash, created_at, last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(device_id, user_id) DO UPDATE SET
          label = COALESCE(excluded.label, trusted_devices.label),
          fingerprint_hash = COALESCE(excluded.fingerprint_hash, trusted_devices.fingerprint_hash),
          last_used_at = excluded.last_used_at,
          revoked_at = NULL`
      )
      .run(deviceId, userId, label ?? null, fingerprint ? hashToken(fingerprint) : null, now, now);
  }

  isTrustedDevice(userId: string, deviceId: string) {
    const row = this.db
      .prepare(
        `SELECT device_id
         FROM trusted_devices
         WHERE user_id = ? AND device_id = ? AND revoked_at IS NULL`
      )
      .get(userId, deviceId) as { device_id: string } | undefined;
    return Boolean(row);
  }

  listTrustedDevices(userId: string): TrustedDeviceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT device_id, user_id, label, created_at, last_used_at, revoked_at
         FROM trusted_devices
         WHERE user_id = ?
         ORDER BY last_used_at DESC`
      )
      .all(userId) as Array<{
      device_id: string;
      user_id: string;
      label: string | null;
      created_at: string;
      last_used_at: string;
      revoked_at: string | null;
    }>;
    return rows.map((row) => ({
      deviceId: row.device_id,
      userId: row.user_id,
      label: row.label ?? undefined,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      revokedAt: row.revoked_at ?? undefined,
    }));
  }

  revokeTrustedDevice(userId: string, deviceId: string) {
    const result = this.db
      .prepare("UPDATE trusted_devices SET revoked_at = ? WHERE user_id = ? AND device_id = ?")
      .run(new Date().toISOString(), userId, deviceId);
    return result.changes > 0;
  }

  listSessionsForUser(userId: string): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT session_id, user_id, created_at, expires_at, device_id, mfa_verified_at
         FROM sessions
         WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .all(userId) as Array<{
      session_id: string;
      user_id: string;
      created_at: string;
      expires_at: string;
      device_id: string | null;
      mfa_verified_at: string | null;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deviceId: row.device_id ?? undefined,
      mfaVerifiedAt: row.mfa_verified_at ?? undefined,
    }));
  }

  revokeSessionById(userId: string, sessionId: string) {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND session_id = ?")
      .run(userId, sessionId);
    return result.changes > 0;
  }

  logSecurityEvent(event: Omit<SecurityEventRecord, "eventId" | "createdAt">) {
    const eventId = `se_${randomUUID().slice(0, 16)}`;
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO security_events
         (event_id, event_type, user_id, session_id, ip_address, user_agent, outcome, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        eventId,
        event.eventType,
        event.userId ?? null,
        event.sessionId ?? null,
        event.ipAddress ?? null,
        event.userAgent ?? null,
        event.outcome,
        JSON.stringify(event.metadata),
        createdAt
      );
    const metricKey = `${event.eventType}:${event.outcome}`;
    this.db
      .prepare(
        `INSERT INTO security_metrics (metric_key, total_count, updated_at)
         VALUES (?, 1, ?)
         ON CONFLICT(metric_key) DO UPDATE SET
          total_count = security_metrics.total_count + 1,
          updated_at = excluded.updated_at`
      )
      .run(metricKey, createdAt);
  }

  listSecurityEventsForUser(userId: string, limit = 50): SecurityEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, event_type, user_id, session_id, ip_address, user_agent, outcome, metadata_json, created_at
         FROM security_events
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(userId, limit) as Array<{
      event_id: string;
      event_type: string;
      user_id: string | null;
      session_id: string | null;
      ip_address: string | null;
      user_agent: string | null;
      outcome: "SUCCESS" | "FAILURE" | "INFO";
      metadata_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.event_id,
      eventType: row.event_type,
      userId: row.user_id ?? undefined,
      sessionId: row.session_id ?? undefined,
      ipAddress: row.ip_address ?? undefined,
      userAgent: row.user_agent ?? undefined,
      outcome: row.outcome,
      createdAt: row.created_at,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    }));
  }

  getSecurityMetricSnapshot() {
    const rows = this.db
      .prepare("SELECT metric_key, total_count FROM security_metrics ORDER BY metric_key ASC")
      .all() as Array<{ metric_key: string; total_count: number }>;
    return rows.map((row) => ({ key: row.metric_key, count: row.total_count }));
  }

  recordEndpointMetric(input: { endpointKey: string; latencyMs: number; isError: boolean }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO endpoint_metrics (endpoint_key, request_count, error_count, total_latency_ms, updated_at)
         VALUES (?, 1, ?, ?, ?)
         ON CONFLICT(endpoint_key) DO UPDATE SET
          request_count = endpoint_metrics.request_count + 1,
          error_count = endpoint_metrics.error_count + excluded.error_count,
          total_latency_ms = endpoint_metrics.total_latency_ms + excluded.total_latency_ms,
          updated_at = excluded.updated_at`
      )
      .run(
        input.endpointKey,
        input.isError ? 1 : 0,
        Math.max(0, Math.floor(input.latencyMs)),
        now
      );
  }

  getEndpointMetricSnapshot(limit = 100): EndpointMetricRecord[] {
    const rows = this.db
      .prepare(
        `SELECT endpoint_key, request_count, error_count, total_latency_ms, updated_at
         FROM endpoint_metrics
         ORDER BY endpoint_key ASC
         LIMIT ?`
      )
      .all(limit) as Array<{
      endpoint_key: string;
      request_count: number;
      error_count: number;
      total_latency_ms: number;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      key: row.endpoint_key,
      requests: row.request_count,
      errors: row.error_count,
      avgLatencyMs: row.request_count > 0 ? Number((row.total_latency_ms / row.request_count).toFixed(2)) : 0,
      updatedAt: row.updated_at,
    }));
  }

  checkDatabaseReadiness() {
    try {
      const row = this.db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      return { ready: Boolean(row?.ok), detail: "sqlite:query-ok" };
    } catch (error) {
      return {
        ready: false,
        detail: error instanceof Error ? error.message : "sqlite:unknown-error",
      };
    }
  }

  lookupIdempotency(principalKey: string, scope: string, idempotencyKey: string, requestHash: string): IdempotencyLookupResult {
    const now = new Date().toISOString();
    this.db.prepare("DELETE FROM idempotency_keys WHERE expires_at <= ?").run(now);
    const row = this.db
      .prepare(
        `SELECT request_hash, state, response_status, response_body_json, created_at
         FROM idempotency_keys
         WHERE principal_key = ? AND scope = ? AND idempotency_key = ?`
      )
      .get(principalKey, scope, idempotencyKey) as
      | {
          request_hash: string;
          state: string;
          response_status: number | null;
          response_body_json: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return { state: "miss" };
    if (row.request_hash !== requestHash) return { state: "conflict", requestHash: row.request_hash };
    if (row.state !== "completed" || row.response_status === null || !row.response_body_json) return { state: "pending" };
    return {
      state: "replay",
      replay: {
        statusCode: row.response_status,
        body: JSON.parse(row.response_body_json),
        requestHash: row.request_hash,
        createdAt: row.created_at,
      },
    };
  }

  reserveIdempotencyKey(input: {
    principalKey: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    ttlMs: number;
  }) {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + input.ttlMs).toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO idempotency_keys
         (principal_key, scope, idempotency_key, request_hash, state, response_status, response_body_json, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
         ON CONFLICT(principal_key, scope, idempotency_key) DO NOTHING`
      )
      .run(
        input.principalKey,
        input.scope,
        input.idempotencyKey,
        input.requestHash,
        now,
        now,
        expiresAt
      );
    return result.changes > 0;
  }

  completeIdempotencyKey(input: {
    principalKey: string;
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    statusCode: number;
    body: unknown;
  }) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE idempotency_keys
         SET state = 'completed',
             response_status = ?,
             response_body_json = ?,
             updated_at = ?
         WHERE principal_key = ?
           AND scope = ?
           AND idempotency_key = ?
           AND request_hash = ?`
      )
      .run(
        input.statusCode,
        JSON.stringify(input.body),
        now,
        input.principalKey,
        input.scope,
        input.idempotencyKey,
        input.requestHash
      );
  }

  getRateLimitStatus(rateKey: string, policy: RateLimitPolicy) {
    const now = Date.now();
    const row = this.db
      .prepare(
        `SELECT attempts, window_start_ms, blocked_until_ms
         FROM auth_rate_limits WHERE rate_key = ?`
      )
      .get(rateKey) as
      | {
          attempts: number;
          window_start_ms: number;
          blocked_until_ms: number;
        }
      | undefined;
    if (!row) return { blocked: false, attempts: 0, retryAfterMs: 0 };
    if (row.blocked_until_ms > now) {
      return { blocked: true, attempts: row.attempts, retryAfterMs: row.blocked_until_ms - now };
    }
    if (now - row.window_start_ms > policy.windowMs) {
      this.db.prepare("DELETE FROM auth_rate_limits WHERE rate_key = ?").run(rateKey);
      return { blocked: false, attempts: 0, retryAfterMs: 0 };
    }
    return { blocked: false, attempts: row.attempts, retryAfterMs: 0 };
  }

  registerRateLimitFailure(rateKey: string, policy: RateLimitPolicy) {
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT attempts, window_start_ms
         FROM auth_rate_limits WHERE rate_key = ?`
      )
      .get(rateKey) as { attempts: number; window_start_ms: number } | undefined;

    const withinWindow = existing && now - existing.window_start_ms <= policy.windowMs;
    const attempts = withinWindow ? existing.attempts + 1 : 1;
    const windowStart = withinWindow ? existing.window_start_ms : now;
    const blockedUntil = attempts >= policy.maxAttempts ? now + policy.blockMs : 0;

    this.db
      .prepare(
        `INSERT INTO auth_rate_limits (rate_key, attempts, window_start_ms, blocked_until_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(rate_key) DO UPDATE SET
           attempts = excluded.attempts,
           window_start_ms = excluded.window_start_ms,
           blocked_until_ms = excluded.blocked_until_ms,
           updated_at_ms = excluded.updated_at_ms`
      )
      .run(rateKey, attempts, windowStart, blockedUntil, now);
  }

  clearRateLimit(rateKey: string) {
    this.db.prepare("DELETE FROM auth_rate_limits WHERE rate_key = ?").run(rateKey);
  }

  seedRatificationSchedule(defaultIntervalMs: number) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ratification_schedule (singleton_id, interval_ms, enabled, source, updated_at)
         VALUES (1, ?, 1, 'env', ?)`
      )
      .run(defaultIntervalMs, now);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ratification_checkpoint (
           singleton_id,
           last_anchored_event_id,
           last_batch_id,
           last_successful_ratification_at,
           last_ratified_block_height,
           updated_at
         )
         VALUES (1, 0, NULL, NULL, NULL, ?)`
      )
      .run(now);
  }

  getRatificationSchedule(): RatificationScheduleRecord {
    const row = this.db
      .prepare(
        `SELECT interval_ms, enabled, source, updated_at
         FROM ratification_schedule WHERE singleton_id = 1`
      )
      .get() as
      | {
          interval_ms: number;
          enabled: number;
          source: "env" | "api";
          updated_at: string;
        }
      | undefined;
    if (!row) {
      const now = new Date().toISOString();
      return { intervalMs: 20_000, enabled: true, source: "env", updatedAt: now };
    }
    return {
      intervalMs: row.interval_ms,
      enabled: Boolean(row.enabled),
      source: row.source,
      updatedAt: row.updated_at,
    };
  }

  updateRatificationSchedule(input: { intervalMs: number; enabled: boolean; source: "env" | "api" }) {
    const updatedAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ratification_schedule (singleton_id, interval_ms, enabled, source, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(singleton_id) DO UPDATE SET
          interval_ms = excluded.interval_ms,
          enabled = excluded.enabled,
          source = excluded.source,
          updated_at = excluded.updated_at`
      )
      .run(input.intervalMs, input.enabled ? 1 : 0, input.source, updatedAt);
    return this.getRatificationSchedule();
  }

  getRatificationCheckpoint(): RatificationCheckpointRecord {
    const row = this.db
      .prepare(
        `SELECT last_anchored_event_id, last_batch_id, last_successful_ratification_at, last_ratified_block_height, updated_at
         FROM ratification_checkpoint WHERE singleton_id = 1`
      )
      .get() as
      | {
          last_anchored_event_id: number;
          last_batch_id: string | null;
          last_successful_ratification_at: string | null;
          last_ratified_block_height: number | null;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      const now = new Date().toISOString();
      return { lastAnchoredEventId: 0, updatedAt: now };
    }
    return {
      lastAnchoredEventId: row.last_anchored_event_id,
      lastBatchId: row.last_batch_id ?? undefined,
      lastSuccessfulRatificationAt: row.last_successful_ratification_at ?? undefined,
      lastRatifiedBlockHeight:
        row.last_ratified_block_height === null ? undefined : row.last_ratified_block_height,
      updatedAt: row.updated_at,
    };
  }

  recordRatificationSuccess(input: { batchId: string; blockHeight?: number; successfulAt?: string }) {
    const successfulAt = input.successfulAt ?? new Date().toISOString();
    const normalizedBlockHeight =
      input.blockHeight === undefined || !Number.isFinite(input.blockHeight)
        ? null
        : Math.max(0, Math.floor(input.blockHeight));
    this.db
      .prepare(
        `INSERT INTO ratification_checkpoint (
           singleton_id,
           last_anchored_event_id,
           last_batch_id,
           last_successful_ratification_at,
           last_ratified_block_height,
           updated_at
         )
         VALUES (
           1,
           COALESCE((SELECT last_anchored_event_id FROM ratification_checkpoint WHERE singleton_id = 1), 0),
           ?,
           ?,
           ?,
           ?
         )
         ON CONFLICT(singleton_id) DO UPDATE SET
           last_batch_id = excluded.last_batch_id,
           last_successful_ratification_at = excluded.last_successful_ratification_at,
           last_ratified_block_height = COALESCE(excluded.last_ratified_block_height, ratification_checkpoint.last_ratified_block_height),
           updated_at = excluded.updated_at`
      )
      .run(input.batchId, successfulAt, normalizedBlockHeight, successfulAt);
  }

  listRatifiableEventsSince(eventIdExclusive: number, limit: number): RatifiableEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, game_id, type, actor_user_id, cell, next_turn, winner, drawn, created_at
         FROM game_events
         WHERE id > ?
         ORDER BY id ASC
         LIMIT ?`
      )
      .all(eventIdExclusive, limit) as Array<{
      id: number;
      game_id: string;
      type: string;
      actor_user_id: string;
      cell: number;
      next_turn: "X" | "O" | null;
      winner: "X" | "O" | null;
      drawn: number;
      created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: row.id,
      gameId: row.game_id,
      type: row.type,
      actorUserId: row.actor_user_id,
      cell: row.cell,
      nextTurn: row.next_turn ?? undefined,
      winner: row.winner ?? undefined,
      drawn: Boolean(row.drawn),
      createdAt: row.created_at,
    }));
  }

  createRatificationBatch(input: {
    batchId: string;
    status: RatificationBatchStatus;
    fromEventId: number;
    toEventId: number;
    recordCount: number;
    recordHash: string;
    merkleRoot: string;
    artifactJson: string;
    adapterMode: string;
    chainNetwork: "testnet" | "mainnet";
    payloadHash: string;
    signerPayloadJson?: string;
  }) {
    const createdAt = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO ratification_batches
         (batch_id, status, from_event_id, to_event_id, record_count, record_hash, merkle_root, tx_id, adapter_mode, chain_network, payload_hash, confirmation_status, confirmation_depth, finalized, finalized_at, reorg_detected, last_checked_at, signer_payload_json, submit_error, artifact_json, created_at, submitted_at, confirmed_at, failed_at, failure_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'pending', 0, 0, NULL, 0, NULL, ?, NULL, ?, ?, NULL, NULL, NULL, NULL)`
      )
      .run(
        input.batchId,
        input.status,
        input.fromEventId,
        input.toEventId,
        input.recordCount,
        input.recordHash,
        input.merkleRoot,
        input.adapterMode,
        input.chainNetwork,
        input.payloadHash,
        input.signerPayloadJson ?? null,
        input.artifactJson,
        createdAt
      );
  }

  markRatificationBatchSubmitted(batchId: string, txId: string) {
    this.db
      .prepare(
        `UPDATE ratification_batches
         SET status = 'submitted',
             tx_id = ?,
             submitted_at = ?,
             confirmation_status = 'pending',
             confirmation_depth = 0,
             reorg_detected = 0,
             failed_at = NULL,
             failure_reason = NULL,
             submit_error = NULL
         WHERE batch_id = ?`
      )
      .run(txId, new Date().toISOString(), batchId);
  }

  markRatificationBatchAwaitingSignature(batchId: string, reason: string, signerPayloadJson?: string) {
    this.db
      .prepare(
        `UPDATE ratification_batches
         SET status = 'awaiting_signature',
             submit_error = ?,
             signer_payload_json = COALESCE(?, signer_payload_json)
         WHERE batch_id = ?`
      )
      .run(reason.slice(0, 512), signerPayloadJson ?? null, batchId);
  }

  markRatificationBatchConfirmed(batchId: string) {
    const now = new Date().toISOString();
    const row = this.db
      .prepare("SELECT to_event_id FROM ratification_batches WHERE batch_id = ?")
      .get(batchId) as { to_event_id: number } | undefined;
    if (!row) return;

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE ratification_batches
           SET status = 'confirmed',
               confirmed_at = ?,
              confirmation_status = CASE
                WHEN confirmation_status = 'finalized' THEN 'finalized'
                ELSE 'confirmed'
              END,
               failed_at = NULL,
               failure_reason = NULL
           WHERE batch_id = ?`
        )
        .run(now, batchId);
      this.db
        .prepare(
          `INSERT INTO ratification_checkpoint (singleton_id, last_anchored_event_id, last_batch_id, updated_at)
           VALUES (1, ?, ?, ?)
           ON CONFLICT(singleton_id) DO UPDATE SET
            last_anchored_event_id = excluded.last_anchored_event_id,
            last_batch_id = excluded.last_batch_id,
            updated_at = excluded.updated_at`
        )
        .run(row.to_event_id, batchId, now);
    });
    tx();
  }

  markRatificationBatchFailed(batchId: string, reason: string) {
    this.db
      .prepare(
        `UPDATE ratification_batches
         SET status = 'failed',
             failed_at = ?,
             failure_reason = ?,
             submit_error = ?
         WHERE batch_id = ?`
      )
      .run(new Date().toISOString(), reason.slice(0, 512), reason.slice(0, 512), batchId);
  }

  updateRatificationConfirmation(
    batchId: string,
    input: {
      status: RatificationConfirmationStatus;
      depth: number;
      reorgDetected?: boolean;
      checkedAt?: string;
    }
  ) {
    const checkedAt = input.checkedAt ?? new Date().toISOString();
    this.db
      .prepare(
        `UPDATE ratification_batches
         SET confirmation_status = ?,
             confirmation_depth = ?,
             reorg_detected = CASE WHEN ? THEN 1 ELSE reorg_detected END,
             finalized = CASE WHEN ? THEN 1 ELSE finalized END,
             finalized_at = CASE WHEN ? THEN COALESCE(finalized_at, ?) ELSE finalized_at END,
             last_checked_at = ?
         WHERE batch_id = ?`
      )
      .run(
        input.status,
        Math.max(0, Math.floor(input.depth)),
        input.reorgDetected ? 1 : 0,
        input.status === "finalized" ? 1 : 0,
        input.status === "finalized" ? 1 : 0,
        checkedAt,
        checkedAt,
        batchId
      );
  }

  listPendingRatificationSubmissions(limit = 20): Array<{ batchId: string; txId: string }> {
    const rows = this.db
      .prepare(
        `SELECT batch_id, tx_id
         FROM ratification_batches
         WHERE status IN ('submitted', 'confirmed') AND tx_id IS NOT NULL
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(limit) as Array<{ batch_id: string; tx_id: string | null }>;
    return rows
      .filter((row) => row.tx_id)
      .map((row) => ({ batchId: row.batch_id, txId: row.tx_id as string }));
  }

  getRatificationBatch(batchId: string): RatificationBatchRecord | null {
    const row = this.db
      .prepare(
        `SELECT batch_id, status, from_event_id, to_event_id, record_count, record_hash, merkle_root, tx_id, adapter_mode, chain_network, payload_hash, confirmation_status, confirmation_depth, finalized, finalized_at, reorg_detected, last_checked_at, signer_payload_json, submit_error, artifact_json, created_at, submitted_at, confirmed_at, failed_at, failure_reason
         FROM ratification_batches
         WHERE batch_id = ?`
      )
      .get(batchId) as
      | {
          batch_id: string;
          status: RatificationBatchStatus;
          from_event_id: number;
          to_event_id: number;
          record_count: number;
          record_hash: string;
          merkle_root: string;
          tx_id: string | null;
          adapter_mode: string;
          chain_network: "testnet" | "mainnet";
          payload_hash: string;
          confirmation_status: RatificationConfirmationStatus;
          confirmation_depth: number;
          finalized: number;
          finalized_at: string | null;
          reorg_detected: number;
          last_checked_at: string | null;
          signer_payload_json: string | null;
          submit_error: string | null;
          artifact_json: string;
          created_at: string;
          submitted_at: string | null;
          confirmed_at: string | null;
          failed_at: string | null;
          failure_reason: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      batchId: row.batch_id,
      status: row.status,
      fromEventId: row.from_event_id,
      toEventId: row.to_event_id,
      recordCount: row.record_count,
      recordHash: row.record_hash,
      merkleRoot: row.merkle_root,
      txId: row.tx_id ?? undefined,
      adapterMode: row.adapter_mode,
      chainNetwork: row.chain_network,
      payloadHash: row.payload_hash,
      confirmationStatus: row.confirmation_status,
      confirmationDepth: row.confirmation_depth,
      finalized: Boolean(row.finalized),
      finalizedAt: row.finalized_at ?? undefined,
      reorgDetected: Boolean(row.reorg_detected),
      lastCheckedAt: row.last_checked_at ?? undefined,
      signerPayloadJson: row.signer_payload_json ?? undefined,
      submitError: row.submit_error ?? undefined,
      artifactJson: row.artifact_json,
      createdAt: row.created_at,
      submittedAt: row.submitted_at ?? undefined,
      confirmedAt: row.confirmed_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      failureReason: row.failure_reason ?? undefined,
    };
  }

  listRatificationBatches(limit = 20): RatificationBatchRecord[] {
    const rows = this.db
      .prepare(
        `SELECT batch_id, status, from_event_id, to_event_id, record_count, record_hash, merkle_root, tx_id, adapter_mode, chain_network, payload_hash, confirmation_status, confirmation_depth, finalized, finalized_at, reorg_detected, last_checked_at, signer_payload_json, submit_error, artifact_json, created_at, submitted_at, confirmed_at, failed_at, failure_reason
         FROM ratification_batches
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      batch_id: string;
      status: RatificationBatchStatus;
      from_event_id: number;
      to_event_id: number;
      record_count: number;
      record_hash: string;
      merkle_root: string;
      tx_id: string | null;
      adapter_mode: string;
      chain_network: "testnet" | "mainnet";
      payload_hash: string;
      confirmation_status: RatificationConfirmationStatus;
      confirmation_depth: number;
      finalized: number;
      finalized_at: string | null;
      reorg_detected: number;
      last_checked_at: string | null;
      signer_payload_json: string | null;
      submit_error: string | null;
      artifact_json: string;
      created_at: string;
      submitted_at: string | null;
      confirmed_at: string | null;
      failed_at: string | null;
      failure_reason: string | null;
    }>;
    return rows.map((row) => ({
      batchId: row.batch_id,
      status: row.status,
      fromEventId: row.from_event_id,
      toEventId: row.to_event_id,
      recordCount: row.record_count,
      recordHash: row.record_hash,
      merkleRoot: row.merkle_root,
      txId: row.tx_id ?? undefined,
      adapterMode: row.adapter_mode,
      chainNetwork: row.chain_network,
      payloadHash: row.payload_hash,
      confirmationStatus: row.confirmation_status,
      confirmationDepth: row.confirmation_depth,
      finalized: Boolean(row.finalized),
      finalizedAt: row.finalized_at ?? undefined,
      reorgDetected: Boolean(row.reorg_detected),
      lastCheckedAt: row.last_checked_at ?? undefined,
      signerPayloadJson: row.signer_payload_json ?? undefined,
      submitError: row.submit_error ?? undefined,
      artifactJson: row.artifact_json,
      createdAt: row.created_at,
      submittedAt: row.submitted_at ?? undefined,
      confirmedAt: row.confirmed_at ?? undefined,
      failedAt: row.failed_at ?? undefined,
      failureReason: row.failure_reason ?? undefined,
    }));
  }
}
