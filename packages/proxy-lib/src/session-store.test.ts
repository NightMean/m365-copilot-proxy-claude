import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionStore } from "./session-store.js";
import { SessionPool } from "./handler.js";

const tmpDirs: string[] = [];
function tmpFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m365-store-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.M365_SESSION_STORE_PATH;
});

const RECORD = { conversationId: "cid-1234", sentMessageCount: 7, lastUsedAt: Date.now() };

describe("SessionStore (persistent session durability)", () => {
  it("round-trips records through flush + reload with all fields intact", () => {
    const file = tmpFile("sessions.json");
    const a = new SessionStore(file);
    a.set("fp-1", RECORD);
    a.flush();

    const b = new SessionStore(file);
    expect(b.get("fp-1")).toEqual(RECORD);
  });

  it("returns an empty store when the file does not exist", () => {
    const store = new SessionStore(tmpFile("missing.json"));
    expect(store.get("anything")).toBeNull();
    expect(store.size).toBe(0);
  });

  it("survives a corrupt snapshot: starts empty, next flush overwrites it", () => {
    const file = tmpFile("corrupt.json");
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const store = new SessionStore(file);
    expect(store.size).toBe(0);

    store.set("fp-2", RECORD);
    store.flush();
    expect(new SessionStore(file).get("fp-2")).toEqual(RECORD);
  });

  it("flush leaves no .tmp behind and delete removes records", () => {
    const file = tmpFile("atomic.json");
    const store = new SessionStore(file);
    store.set("fp-3", RECORD);
    store.flush();
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(fs.existsSync(file)).toBe(true);

    store.delete("fp-3");
    store.flush();
    expect(new SessionStore(file).get("fp-3")).toBeNull();
  });
});

describe("SessionPool hydration (restart resumes the M365 thread)", () => {
  const SESSION_OPTS = {
    getToken: async () => "fake-token",
    useAgent: false,
    transport: { chat: async () => ({}) as never },
  };

  it("a new pool resumes the persisted conversationId + delta position", () => {
    process.env.M365_SESSION_STORE_PATH = tmpFile("hydrate.json");
    const messages = [{ role: "user" as const, content: "seed message for fingerprint" }];

    // Process A: one conversation makes progress, then "dies".
    const poolA = new SessionPool(SESSION_OPTS);
    const stateA = poolA.resolve(messages, "m365-copilot");
    const cidA = stateA.session.conversationId;
    stateA.sentMessageCount = 4;
    poolA.persistConversation(poolA.fingerprintOf(messages, "m365-copilot"), stateA);

    // Process B (fresh pool, same store file): must RESUME, not start over.
    const poolB = new SessionPool(SESSION_OPTS);
    const stateB = poolB.resolve(messages, "m365-copilot");
    expect(stateB.session.conversationId).toBe(cidA);
    expect(stateB.sentMessageCount).toBe(4);
  });

  it("ignores stale records older than the idle-eviction window", () => {
    const file = tmpFile("stale.json");
    const fresh = new SessionStore(file);
    fresh.set("stale-fp", { conversationId: "old-cid", sentMessageCount: 9, lastUsedAt: Date.now() - 31 * 60 * 1000 });
    fresh.flush();

    process.env.M365_SESSION_STORE_PATH = file;
    const pool = new SessionPool(SESSION_OPTS);
    // Any request fingerprints differently from "stale-fp", so seed via the
    // same key the store holds by writing through the store again post-load:
    const messages = [{ role: "user" as const, content: "stale check" }];
    const fp = pool.fingerprintOf(messages, "m365-copilot");
    fresh.set(fp, { conversationId: "old-cid", sentMessageCount: 9, lastUsedAt: Date.now() - 31 * 60 * 1000 });
    fresh.flush();

    const state = pool.resolve(messages, "m365-copilot");
    expect(state.session.conversationId).not.toBe("old-cid");
    expect(state.sentMessageCount).toBe(0);
  });
});

describe("SessionStore TTL & LRU eviction", () => {
  it("prunes expired sessions past TTL in JSON backend", () => {
    const file = tmpFile("ttl.json");
    const store = new SessionStore({ filePath: file, backend: "json", ttlMs: 1000 });
    store.set("active", { conversationId: "cid-1", sentMessageCount: 1, lastUsedAt: Date.now() });
    store.set("expired", { conversationId: "cid-2", sentMessageCount: 1, lastUsedAt: Date.now() - 2000 });
    store.flush();

    expect(store.get("active")).not.toBeNull();
    expect(store.get("expired")).toBeNull();
  });

  it("evicts oldest sessions when maxSessions capacity is exceeded (LRU) in JSON backend", () => {
    const file = tmpFile("lru.json");
    const store = new SessionStore({ filePath: file, backend: "json", maxSessions: 2 });
    const now = Date.now();
    store.set("oldest", { conversationId: "cid-1", sentMessageCount: 1, lastUsedAt: now - 3000 });
    store.set("middle", { conversationId: "cid-2", sentMessageCount: 1, lastUsedAt: now - 2000 });
    store.set("newest", { conversationId: "cid-3", sentMessageCount: 1, lastUsedAt: now - 1000 });
    store.flush();

    expect(store.get("oldest")).toBeNull();
    expect(store.get("middle")).not.toBeNull();
    expect(store.get("newest")).not.toBeNull();
  });
});

describe("SessionStore SQLite backend", () => {
  it("round-trips records through SQLite database", () => {
    const file = tmpFile("sessions.sqlite");
    const a = new SessionStore({ filePath: file, backend: "sqlite" });
    a.set("sq-1", RECORD);
    a.flush();
    a.close();

    const b = new SessionStore({ filePath: file, backend: "sqlite" });
    expect(b.get("sq-1")).toEqual(RECORD);
    b.close();
  });

  it("prunes expired records and enforces LRU capacity in SQLite", () => {
    const file = tmpFile("lru.sqlite");
    const store = new SessionStore({ filePath: file, backend: "sqlite", ttlMs: 2000, maxSessions: 2 });
    store.set("s-old", { conversationId: "cid-old", sentMessageCount: 1, lastUsedAt: Date.now() - 3000 });
    store.set("s-1", { conversationId: "cid-1", sentMessageCount: 1, lastUsedAt: Date.now() - 500 });
    store.set("s-2", { conversationId: "cid-2", sentMessageCount: 1, lastUsedAt: Date.now() - 200 });

    // s-old is past TTL
    expect(store.get("s-old")).toBeNull();

    // Adding s-3 exceeds maxSessions (2), so oldest active s-1 gets evicted
    store.set("s-3", { conversationId: "cid-3", sentMessageCount: 1, lastUsedAt: Date.now() });
    expect(store.get("s-1")).toBeNull();
    expect(store.get("s-2")).not.toBeNull();
    expect(store.get("s-3")).not.toBeNull();
    store.close();
  });
});
