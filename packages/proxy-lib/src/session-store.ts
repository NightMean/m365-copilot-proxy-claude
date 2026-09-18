// Persistent session store — proxy restarts no longer burn fresh M365
// conversation starts (thread-rate throttle, docs/hypotheses.md F13).
//
// The SessionPool fingerprints conversations by first-user-message + model +
// caller key; that fingerprint is stable across restarts (the client resends
// its full history), so it doubles as the on-disk key. On hydration a stored
// ConversationId is seeded into the new ModelSession and sentMessageCount is
// restored so delta prompting continues exactly where the previous process
// left off.
//
// Supports both high-performance SQLite (via built-in node:sqlite) and atomic
// JSON snapshots, with configurable TTL pruning and LRU capacity eviction.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@m365-copilot/core";

const log = createLogger("session-store");

export interface PersistedSession {
  /** Live M365 ConversationId to resume. */
  conversationId: string;
  /** How many request messages the previous process had already sent. */
  sentMessageCount: number;
  lastUsedAt: number;
}

export interface SessionStoreOptions {
  filePath?: string;
  backend?: "auto" | "json" | "sqlite";
  /** Time-to-live in ms for persisted sessions (default: 7 days). */
  ttlMs?: number;
  /** Maximum number of sessions before evicting least-recently-used records (default: 1000). */
  maxSessions?: number;
}

interface StoreFile {
  version: 1;
  sessions: Record<string, PersistedSession>;
}

export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const DEFAULT_MAX_SESSIONS = 1000;

export function defaultSessionStorePath(backend: "json" | "sqlite" = "json"): string {
  const ext = backend === "sqlite" ? "sessions.sqlite" : "sessions.json";
  return join(homedir(), ".config", "opencode-m365", ext);
}

interface InternalStoreBackend {
  get(key: string): PersistedSession | null;
  set(key: string, record: PersistedSession): void;
  delete(key: string): void;
  prune(ttlMs?: number): number;
  flush(): void;
  close(): void;
  readonly size: number;
}

/** JSON snapshot backend with atomic rename-over-write. */
class JsonStoreBackend implements InternalStoreBackend {
  private cache: Map<string, PersistedSession> | null = null;

  constructor(
    readonly filePath: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {}

  private load(): Map<string, PersistedSession> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreFile;
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") {
        const now = Date.now();
        for (const [key, rec] of Object.entries(parsed.sessions)) {
          if (
            rec &&
            typeof rec.conversationId === "string" &&
            Number.isFinite(rec.sentMessageCount) &&
            Number.isFinite(rec.lastUsedAt)
          ) {
            // Apply TTL pruning on load
            if (now - rec.lastUsedAt <= this.ttlMs) {
              this.cache.set(key, rec);
            }
          }
        }
      }
      if (this.cache.size > 0) {
        log.info(`Loaded ${this.cache.size} persisted session(s) from ${this.filePath}`);
      }
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        log.warn(`Session store unreadable (${err?.message ?? err}); starting empty`);
      }
    }
    return this.cache;
  }

  get(key: string): PersistedSession | null {
    const map = this.load();
    const rec = map.get(key);
    if (!rec) return null;
    if (Date.now() - rec.lastUsedAt > this.ttlMs) {
      map.delete(key);
      return null;
    }
    return rec;
  }

  set(key: string, record: PersistedSession): void {
    const map = this.load();
    map.set(key, record);
    // LRU eviction if capacity exceeded
    if (map.size > this.maxSessions) {
      const sorted = Array.from(map.entries()).sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      );
      const excess = map.size - this.maxSessions;
      for (let i = 0; i < excess; i++) {
        map.delete(sorted[i][0]);
      }
    }
  }

  delete(key: string): void {
    this.load().delete(key);
  }

  prune(ttlMs: number = this.ttlMs): number {
    const map = this.load();
    const threshold = Date.now() - ttlMs;
    let pruned = 0;
    for (const [k, v] of map.entries()) {
      if (v.lastUsedAt < threshold) {
        map.delete(k);
        pruned++;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.load().size;
  }

  flush(): void {
    const sessions: Record<string, PersistedSession> = {};
    for (const [key, rec] of this.load()) sessions[key] = rec;
    const payload: StoreFile = { version: 1, sessions };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err: any) {
      log.warn(`Session store flush failed: ${err?.message ?? err}`);
    }
  }

  close(): void {
    this.flush();
  }
}

/** SQLite backend leveraging Node.js DatabaseSync. */
class SqliteStoreBackend implements InternalStoreBackend {
  private db: any = null;

  constructor(
    readonly filePath: string,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly maxSessions: number = DEFAULT_MAX_SESSIONS,
  ) {
    this.init();
  }

  private init(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      // Dynamically import or require node:sqlite DatabaseSync
      const sqliteModule = (globalThis as any).process?.getBuiltinModule?.("node:sqlite") ??
        require("node:sqlite");
      const { DatabaseSync } = sqliteModule;
      this.db = new DatabaseSync(this.filePath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          key TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          sent_message_count INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_last_used ON sessions (last_used_at);
      `);
      this.prune();
    } catch (err: any) {
      log.warn(`SQLite initialization failed (${err?.message ?? err}); operating in-memory or degraded`);
      throw err;
    }
  }

  get(key: string): PersistedSession | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare(`SELECT conversation_id, sent_message_count, last_used_at FROM sessions WHERE key = ?`);
      const row = stmt.get(key) as any;
      if (!row) return null;
      if (Date.now() - Number(row.last_used_at) > this.ttlMs) {
        this.delete(key);
        return null;
      }
      return {
        conversationId: String(row.conversation_id),
        sentMessageCount: Number(row.sent_message_count),
        lastUsedAt: Number(row.last_used_at),
      };
    } catch (err: any) {
      log.warn(`SQLite get failed: ${err?.message ?? err}`);
      return null;
    }
  }

  set(key: string, record: PersistedSession): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO sessions (key, conversation_id, sent_message_count, last_used_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          sent_message_count = excluded.sent_message_count,
          last_used_at = excluded.last_used_at
      `);
      stmt.run(key, record.conversationId, record.sentMessageCount, record.lastUsedAt);

      // LRU eviction
      const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
      const countRow = countStmt.get() as any;
      const count = Number(countRow?.count ?? 0);
      if (count > this.maxSessions) {
        const excess = count - this.maxSessions;
        const evictStmt = this.db.prepare(`
          DELETE FROM sessions WHERE key IN (
            SELECT key FROM sessions ORDER BY last_used_at ASC LIMIT ?
          )
        `);
        evictStmt.run(excess);
      }
    } catch (err: any) {
      log.warn(`SQLite set failed: ${err?.message ?? err}`);
    }
  }

  delete(key: string): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`DELETE FROM sessions WHERE key = ?`);
      stmt.run(key);
    } catch (err: any) {
      log.warn(`SQLite delete failed: ${err?.message ?? err}`);
    }
  }

  prune(ttlMs: number = this.ttlMs): number {
    if (!this.db) return 0;
    try {
      const threshold = Date.now() - ttlMs;
      const stmt = this.db.prepare(`DELETE FROM sessions WHERE last_used_at < ?`);
      const result = stmt.run(threshold) as any;
      return Number(result?.changes ?? 0);
    } catch {
      return 0;
    }
  }

  get size(): number {
    if (!this.db) return 0;
    try {
      const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM sessions`);
      const row = stmt.get() as any;
      return Number(row?.count ?? 0);
    } catch {
      return 0;
    }
  }

  flush(): void {
    // SQLite commits synchronously per transaction
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
      this.db = null;
    }
  }
}

/**
 * Unified SessionStore supporting both JSON and SQLite persistence
 * with TTL pruning and LRU eviction.
 */
export class SessionStore {
  private backend: InternalStoreBackend;
  readonly filePath: string;

  constructor(optionsOrPath?: string | SessionStoreOptions) {
    const opts: SessionStoreOptions =
      typeof optionsOrPath === "string"
        ? { filePath: optionsOrPath }
        : (optionsOrPath ?? {});

    const envBackend = process.env.M365_SESSION_BACKEND;
    let selectedBackend = opts.backend ?? (envBackend === "sqlite" ? "sqlite" : "auto");

    let resolvedPath = opts.filePath ?? process.env.M365_SESSION_STORE_PATH;
    if (!resolvedPath) {
      const isSqlite = selectedBackend === "sqlite";
      resolvedPath = defaultSessionStorePath(isSqlite ? "sqlite" : "json");
    }
    this.filePath = resolvedPath;

    if (selectedBackend === "auto") {
      if (resolvedPath.endsWith(".db") || resolvedPath.endsWith(".sqlite")) {
        selectedBackend = "sqlite";
      } else {
        selectedBackend = "json";
      }
    }

    const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    const maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;

    if (selectedBackend === "sqlite") {
      try {
        this.backend = new SqliteStoreBackend(resolvedPath, ttlMs, maxSessions);
        log.info(`Initialized SQLite session store at ${resolvedPath}`);
      } catch (err: any) {
        log.warn(`Failed to initialize SQLite backend, falling back to JSON: ${err?.message ?? err}`);
        this.backend = new JsonStoreBackend(resolvedPath, ttlMs, maxSessions);
      }
    } else {
      this.backend = new JsonStoreBackend(resolvedPath, ttlMs, maxSessions);
    }
  }

  get(key: string): PersistedSession | null {
    return this.backend.get(key);
  }

  set(key: string, record: PersistedSession): void {
    this.backend.set(key, record);
  }

  delete(key: string): void {
    this.backend.delete(key);
  }

  prune(ttlMs?: number): number {
    return this.backend.prune(ttlMs);
  }

  flush(): void {
    this.backend.flush();
  }

  close(): void {
    this.backend.close();
  }

  get size(): number {
    return this.backend.size;
  }
}
