import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createApp,
  type FetchApp,
} from "./index.js";
import { FakeTransport } from "@m365-copilot/core";
import { TurnGate } from "./gate.js";
import { SessionPool, produceCompletion } from "./handler.js";
import { AnthropicMessagesRequest, toOpenAIChatRequest } from "./anthropic.js";
import { CANONICAL_MODELS } from "@m365-copilot/core";

process.env.M365_NO_BACKOFF = "1";
process.env.M365_CONVERSATION_START_GAP_MS = "0";

/**
 * OFFLINE end-to-end suite: drives the full protocol stack (Anthropic Messages
 * translation -> produceCompletion -> fenced tool parsing -> FakeTransport)
 * through the real fetch handler. No auth, no network, no M365 quota.
 * The scripted backend exercises the same wire shapes Claude Code consumes.
 */

function makeApp(opts?: { command?: string }) {
  const transport = new FakeTransport({ command: opts?.command });
  const app = createApp({
    getToken: async () => "fake-token",
    useAgent: false,
    transport,
  });
  return { app, transport };
}

const BASH_TOOL = {
  name: "bash",
  description: "Run a shell command",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function anthropicRequest(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// --- Models + discovery ---

describe("GET /v1/models", () => {
  const { app } = makeApp();

  it("lists every canonical model with capability metadata", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/models"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.data.map((m: any) => m.id);
    for (const canonical of Object.keys(CANONICAL_MODELS)) {
      expect(ids).toContain(canonical);
    }
    for (const model of body.data) {
      expect(model.context_window).toBeGreaterThan(0);
      expect(model.max_output_tokens).toBeGreaterThan(0);
      if (CANONICAL_MODELS[model.id]) {
        expect(model.m365.tone).toBe(CANONICAL_MODELS[model.id].tone);
        expect(typeof model.m365.supportsTools).toBe("boolean");
      }
    }
  });

  it("exposes health with pool + gate stats", async () => {
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.gate.maxConcurrent).toBeGreaterThanOrEqual(1);
    expect(typeof body.conversations).toBe("number");
  });
});

// --- Anthropic Messages: full agentic tool loop (the Claude Code path) ---

describe("/v1/messages agentic tool loop (offline)", () => {
  const { app, transport } = makeApp();

  it("turn 1 returns a tool_use block parsed from the fenced response", async () => {
    const res = await app.fetch(anthropicRequest({
      model: "claude-sonnet",
      max_tokens: 1024,
      tools: [BASH_TOOL],
      messages: [{ role: "user", content: "run a command to inspect the repo" }],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.type).toBe("message");
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content[0].type).toBe("tool_use");
    expect(body.content[0].name).toBe("bash");
    expect(JSON.parse(JSON.stringify(body.content[0].input))).toEqual({
      command: "echo fake-turn-1",
    });
    // Realistic token accounting (Claude Code sizes its context window off this).
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(transport.prompts.length).toBe(1);
    // The fenced shell-routing manifest must have been injected into the prompt.
    expect(transport.prompts[0].text).toContain("```bash");
  });

  it("turn 2 feeds the tool_result back and gets a final text answer", async () => {
    const res = await app.fetch(anthropicRequest({
      model: "claude-sonnet",
      max_tokens: 1024,
      tools: [BASH_TOOL],
      messages: [
        { role: "user", content: "run a command to inspect the repo" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "call_abc", name: "bash", input: { command: "echo hi" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call_abc", content: "total 48\n-rw-r--r-- README.md" },
          ],
        },
      ],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stop_reason).toBe("end_turn");
    expect(body.content[0].type).toBe("text");
    expect(body.content[0].text).toContain("FAKE_FINAL");
    // Delta mode: only the new messages were sent upstream.
    expect(transport.prompts.at(-1)!.text).toContain("<tool_response");
    expect(transport.prompts.at(-1)!.text).not.toContain("inspect the repo");
  });
});

describe("/v1/messages tool schema enforcement (offline)", () => {
  it("never emits a schema-invalid tool_use", async () => {
    const { app } = makeApp({ command: "echo not-the-enum" });
    const res = await app.fetch(anthropicRequest({
      model: "gpt-5.5",
      max_tokens: 256,
      tools: [{
        ...BASH_TOOL,
        input_schema: {
          type: "object",
          properties: { command: { type: "string", enum: ["echo allowed"] } },
          required: ["command"],
          additionalProperties: false,
        },
      }],
      messages: [{ role: "user", content: "run the allowed command" }],
    }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.type).toBe("error");
    expect(body.error.code).toBe("PROXY_TOOL_SCHEMA_ERROR");
  });

  it("rejects an invalid client schema before calling M365", async () => {
    const { app, transport } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "gpt-5.5",
      max_tokens: 256,
      tools: [{ name: "Broken", input_schema: { type: "not-a-real-type" } }],
      messages: [{ role: "user", content: "use the tool" }],
    }));
    expect(res.status).toBe(400);
    expect(transport.prompts).toHaveLength(0);
  });
});

// --- Streaming: genuine incremental SSE in Anthropic wire format ---

describe("/v1/messages streaming (offline)", () => {
  it("emits message_start, incremental text deltas, and a proper stop", async () => {
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "gpt-5.5",
      max_tokens: 256,
      stream: true,
      messages: [{ role: "user", content: "tell me a one-liner" }],
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const raw = await res.text();
    const events = raw.split("\n\n").filter((c) => c.startsWith("event: "));
    const names = events.map((e) => e.split("\n")[0].replace("event: ", ""));

    expect(names[0]).toBe("message_start");
    expect(names.at(-1)).toBe("message_stop");
    expect(names).toContain("message_delta");

    // Genuinely incremental: more than one text_delta, ordered, lossless.
    const deltas: string[] = [];
    let stopReason: string | null = null;
    for (const chunk of raw.split("\n\n")) {
      if (!chunk.startsWith("event: ")) continue;
      const name = chunk.split("\n")[0].replace("event: ", "");
      const data = JSON.parse(chunk.split("\n")[1].slice(6));
      if (name === "content_block_delta" && data.delta.type === "text_delta") deltas.push(data.delta.text);
      if (name === "message_delta") stopReason = data.delta.stop_reason;
    }
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toContain("FAKE_ECHO");
    expect(stopReason).toBe("end_turn");

    // No duplicate prefix: each streamed fragment appears exactly once.
    const joined = deltas.join("");
    expect(joined.indexOf("FAKE_ECHO")).toBe(joined.lastIndexOf("FAKE_ECHO"));
  });

  it("streams tool_use blocks when the scripted backend calls a tool", async () => {
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "claude-opus",
      max_tokens: 256,
      stream: true,
      tools: [BASH_TOOL],
      messages: [{ role: "user", content: "do the thing" }],
    }));
    const raw = await res.text();
    expect(raw).toContain('"type":"tool_use"');
    expect(raw).toContain('"stop_reason":"tool_use"');
    expect(raw).toContain("input_json_delta");
    expect(raw).toContain("echo fake-turn-1");
  });
});

describe("/v1/messages stop sequences (offline)", () => {
  it("truncates non-stream text and reports the matched stop sequence", async () => {
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "gpt-5.5",
      max_tokens: 256,
      stop_sequences: [":"],
      messages: [{ role: "user", content: "hello" }],
    }));
    const body = await res.json();
    expect(body.stop_reason).toBe("stop_sequence");
    expect(body.stop_sequence).toBe(":");
    expect(body.content[0].text).toBe("FAKE_ECHO turn=1");
  });

  it("buffers safely when streaming with stop sequences", async () => {
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "gpt-5.5",
      max_tokens: 256,
      stream: true,
      stop_sequences: [":"],
      messages: [{ role: "user", content: "hello" }],
    }));
    const raw = await res.text();
    const chunks = raw.split("\n\n").filter((chunk) => chunk.startsWith("event: "));
    const deltas = chunks.map((chunk) => JSON.parse(chunk.split("\n")[1].slice(6)));
    const text = deltas.filter((data) => data.delta?.type === "text_delta").map((data) => data.delta.text).join("");
    const final = deltas.find((data) => data.type === "message_delta");
    expect(text).toBe("FAKE_ECHO turn=1");
    expect(final.delta).toEqual({ stop_reason: "stop_sequence", stop_sequence: ":" });
  });
});

// --- System prompt library + injection ---

describe("system prompts (offline)", () => {
  let dir: string;
  const previousEnv = process.env.M365_SYSTEM_PROMPTS_DIR;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "m365-prompts-"));
    fs.mkdirSync(path.join(dir, "claude-code"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "claude-code", "claude-code-4-6.md"),
      "You are Claude Code, Anthropic's official CLI for coding.\nMARKER_INJECTED_PROMPT",
    );
    process.env.M365_SYSTEM_PROMPTS_DIR = dir;
  });
  afterAll(() => {
    if (previousEnv === undefined) delete process.env.M365_SYSTEM_PROMPTS_DIR;
    else process.env.M365_SYSTEM_PROMPTS_DIR = previousEnv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("indexes and serves the corpus over HTTP", async ({}) => {
    const { clearSystemPromptCache } = await import("@m365-copilot/core");
    clearSystemPromptCache();
    const { app } = makeApp();
    const list = await app.fetch(new Request("http://localhost/v1/system-prompts"));
    expect(list.status).toBe(200);
    const listed = await list.json();
    const names = listed.data.map((p: any) => p.name);
    expect(names).toContain("claude-code/claude-code-4-6");

    const one = await app.fetch(new Request(`http://localhost/v1/system-prompts/${encodeURIComponent("claude-code/claude-code-4-6")}`));
    expect(one.status).toBe(200);
    expect((await one.json()).text).toContain("MARKER_INJECTED_PROMPT");

    const missing = await app.fetch(new Request("http://localhost/v1/system-prompts/nope"));
    expect(missing.status).toBe(404);
  });

  it("injects the chosen prompt ahead of the conversation via header", async () => {
    const { clearSystemPromptCache } = await import("@m365-copilot/core");
    clearSystemPromptCache();
    const { app, transport } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "claude-sonnet",
      max_tokens: 64,
      messages: [{ role: "user", content: "hello there" }],
    }, { "x-m365-system-prompt": "name:claude-code/claude-code-4-6" }));
    expect(res.status).toBe(200);
    const prompt = transport.prompts[0].text;
    const markerAt = prompt.indexOf("MARKER_INJECTED_PROMPT");
    const userAt = prompt.indexOf("hello there");
    expect(markerAt).toBeGreaterThanOrEqual(0);
    expect(userAt).toBeGreaterThan(markerAt);
  });

  it("rejects an unknown explicit name: spec with a 400 instead of silent no-op", async () => {
    const { clearSystemPromptCache } = await import("@m365-copilot/core");
    clearSystemPromptCache();
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest({
      model: "claude-sonnet",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }, { "x-m365-system-prompt": "name:does-not-exist" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain("Unknown system prompt name");
  });
});

// --- Token counting + OpenAI surface sanity ---

describe("count_tokens + chat/completions parity (offline)", () => {
  const { app } = makeApp();

  it("estimates tokens for an Anthropic payload", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet", messages: [{ role: "user", content: "count my tokens please" }] }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.input_tokens).toBeGreaterThan(5);
  });

  it("serves the OpenAI tool-call surface too", async () => {
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.5",
        messages: [{ role: "user", content: "run something" }],
        tools: [{
          type: "function",
          function: {
            name: "bash",
            description: "Run a shell command",
            parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
          },
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });
});

// --- TurnGate: parallel-agent safety semantics ---

describe("TurnGate", () => {
  it("serializes turns beyond maxConcurrent", async () => {
    const gate = new TurnGate({ maxConcurrent: 1, minConversationGapMs: 0 });
    let inflightMax = 0;
    let inflight = 0;
    const turn = () => gate.run("c", async () => {
      inflight += 1;
      inflightMax = Math.max(inflightMax, inflight);
      await new Promise((r) => setTimeout(r, 10));
      inflight -= 1;
    });
    await Promise.all([turn(), turn(), turn()]);
    expect(inflightMax).toBe(1);
  });

  it("staggeres NEW conversation starts by minConversationGapMs but not follow-ups", async () => {
    const gate = new TurnGate({ maxConcurrent: 8, minConversationGapMs: 60 });
    const t0 = Date.now();
    await Promise.all([
      gate.run("a", async () => {}),
      gate.run("b", async () => {}),
      gate.run("c", async () => {}),
    ]);
    const threeNew = Date.now() - t0;
    expect(threeNew).toBeGreaterThanOrEqual(120); // two enforced gaps

    // Follow-ups in the SAME conversations are never gap-delayed...
    const t1 = Date.now();
    await Promise.all([
      gate.run("a", async () => {}),
      gate.run("b", async () => {}),
    ]);
    expect(Date.now() - t1).toBeLessThan(60);

    // ...and stats reflect reality.
    const stats = gate.stats();
    expect(stats.distinctConversations).toBe(3);
    expect(stats.inflight).toBe(0);
  });

  it("keeps a long single-agent loop fast while others queue", async () => {
    const gate = new TurnGate({ maxConcurrent: 1, minConversationGapMs: 50 });
    // Agent A: five rapid follow-up turns.
    const a = (async () => {
      for (let i = 0; i < 5; i++) await gate.run("agent-a", async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
    })();
    // Agent B: one fresh conversation, must wait for A's slots + its own gap.
    const bStart = Date.now();
    const b = gate.run("agent-b", async () => {});
    await a;
    await b;
    // B's total wait is dominated by A's 25ms of work, not 50ms of extra gap:
    // the point is B eventually proceeds and nothing deadlocks.
    expect(Date.now() - bStart).toBeLessThan(2000);
  });
});

// --- Per-request system-prompt spec must reach produceCompletion on BOTH paths ---

describe("/v1/messages x-m365-system-prompt passthrough", () => {
  const SYS = "M365-SYSPROMPT-E2E-CHECK";
  const body = {
    model: "claude-sonnet",
    max_tokens: 100,
    messages: [{ role: "user", content: "ping" }],
  };

  it("non-stream path honors the header", async () => {
    const { app, transport } = makeApp();
    const res = await app.fetch(anthropicRequest(body, { "x-m365-system-prompt": SYS }));
    expect(res.status).toBe(200);
    await res.json();
    expect(transport.prompts[0].text).toContain(SYS);
  });

  it("stream path honors it too (regression: streaming dropped the spec entirely)", async () => {
    const { app, transport } = makeApp();
    const res = await app.fetch(
      anthropicRequest({ ...body, stream: true }, { "x-m365-system-prompt": SYS }),
    );
    expect(res.status).toBe(200);
    await res.text(); // drain the SSE stream
    expect(transport.prompts[0].text).toContain(SYS);
  });
});

// --- Adaptive harness profiles (x-m365-profile) ---

const PROFILE_TOOLS = [
  BASH_TOOL,
  { name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
  { name: "WebFetch", description: "Fetch a URL", input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

describe("x-m365-profile routing (offline)", () => {
  const SYS2 = undefined;
  const body = {
    model: "claude-sonnet",
    max_tokens: 100,
    messages: [{ role: "user", content: "ping" }],
  };

  it("rejects an unknown profile with 400 + supported list on /v1/messages", async () => {
    const { app } = makeApp();
    const res = await app.fetch(anthropicRequest(body, { "x-m365-profile": "claude-yolo" }));
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.message).toContain("claude-safe");
    expect(payload.error.message).toContain("claude-wide");
  });

  it("rejects an unknown profile on the OpenAI route with parity", async () => {
    const { app } = makeApp();
    const res = await app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-m365-profile": "claude-yolo" },
      body: JSON.stringify({ model: "claude-sonnet", messages: [{ role: "user", content: "hi" }] }),
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain("claude-diagnose");
  });

  it("claude-safe defers web tools behind ToolSearch; claude-wide advertises them", async () => {
    const safe = makeApp();
    const safeRes = await safe.app.fetch(
      anthropicRequest({ ...body, tools: PROFILE_TOOLS }, { "x-m365-profile": "claude-safe" }),
    );
    await safeRes.json();
    const safeManifest = safe.transport.prompts[0].text;
    expect(safeManifest).toContain("ENVIRONMENT REALITY"); // identity anchor present
    expect(safeManifest).toContain("Read");           // coding tool advertised
    expect(safeManifest).not.toContain("WebFetch");   // deferred, not advertised
    expect(safeManifest).toContain("ToolSearch");     // discovery meta-tool present

    const wide = makeApp();
    const wideRes = await wide.app.fetch(
      anthropicRequest({ ...body, tools: PROFILE_TOOLS }, { "x-m365-profile": "claude-wide" }),
    );
    await wideRes.json();
    expect(wide.transport.prompts[0].text).toContain("WebFetch");
  });

  it("profiles are part of the conversation identity (no state bleed)", async () => {
    process.env.M365_CONVERSATION_START_GAP_MS = "0"; // fresh conversations must not pay the stampede gap here
    try {
      const { app, transport } = makeApp();
      const mk = (profile?: string) =>
        app.fetch(anthropicRequest(
          { ...body, tools: PROFILE_TOOLS },
          { ...(profile ? { "x-m365-profile": profile } : {}) },
        ));
      await mk("claude-safe");
      await mk("claude-wide"); // same first message + model — profile alone must fork the thread
      await mk();              // default (claude-safe) reuses the FIRST conversation
      expect(transport.prompts.length).toBe(3);
      const [safeCid, wideCid, defaultCid] = transport.prompts.map((p) => p.conversationId);
      expect(safeCid).not.toBe(wideCid);
      expect(defaultCid).toBe(safeCid);
    } finally {
      delete process.env.M365_CONVERSATION_START_GAP_MS;
    }
  }, 20_000);
});

// --- Strict serialization through the full stack (normal turns included) ---

describe("account-wide serial execution (max M365 concurrency == 1)", () => {
  class SerialProbe {
    inflight = 0;
    maxInflight = 0;
    constructor(private inner: FakeTransport) {}
    readonly prompts = [] as Array<{ text: string; conversationId: string }>;
    async chat(args: any) {
      this.inflight += 1;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      try {
        return await this.inner.chat(args);
      } finally {
        this.inflight -= 1;
      }
    }
  }

  it("two concurrent clients never overlap their M365 turns", async () => {
    process.env.M365_CONVERSATION_START_GAP_MS = "0"; // isolate queue behavior from the stampede guard
    const inner = new FakeTransport({});
    const probe = new SerialProbe(inner);
    const app = createApp({
      getToken: async () => "fake-token",
      useAgent: false,
      transport: probe as never,
    });
    const req = (sid: string) =>
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-m365-session-id": sid },
        body: JSON.stringify({
          model: "claude-sonnet",
          max_tokens: 100,
          messages: [{ role: "user", content: `work ${sid}` }],
        }),
      });
    try {
      const [a, b] = await Promise.all([app.fetch(req("s1")), app.fetch(req("s2"))]);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(probe.maxInflight).toBe(1);
    } finally {
      delete process.env.M365_CONVERSATION_START_GAP_MS;
    }
  }, 20_000);
});

// --- Control-tool exemption + request-level single-tool enforcement ---

const EXIT_PLAN_TOOL = {
  name: "ExitPlanMode",
  description: "Exit plan mode",
  input_schema: { type: "object", properties: {} },
};
const TODO_TOOL = {
  name: "TodoWrite",
  description: "Write todos",
  input_schema: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] },
};
const ECHO_TOOL = {
  name: "echo",
  description: "Echo text",
  input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
};

function staticStream(text: string): never {
  const stream = {
    fullText: text,
    hasContent: true,
    throttle: null,
    contentOrigin: null,
    messageType: null,
    messageId: null,
    scores: null,
    turnCount: null,
    turnState: null,
    thinkingText: null,
    hasThinking: false,
    images: [],
    sawAction: false,
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
  return stream as never;
}

class ScriptedTransport {
  calls = 0;
  constructor(private readonly script: string) {}
  reset(): void {}
  async chat(args: { token: string; text: string }): Promise<never> {
    this.calls += 1;
    this.lastPrompt = args.text;
    return staticStream(this.script);
  }
  lastPrompt = "";
}

describe("control tools are exempt from profile filtering and caps", () => {
  it("advertises ExitPlanMode/TodoWrite even when the allow-list and cap would drop them", async () => {
    // claude-safe allow-list covers Bash+Read but NOT ExitPlanMode; the 7-tool
    // catalog exceeds maxVisibleTools=7 once WebFetch defers — controls must
    // still be visible.
    const transport = new ScriptedTransport("```bash\nls\n```");
    const pool = new SessionPool({
      getToken: async () => "fake-token",
      useAgent: false,
      transport: transport as never,
    });
    const anthropicBody = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "plan then do" }],
      tools: [
        BASH_TOOL,
        PROFILE_TOOLS[1], // Read
        { name: "Write", description: "w", input_schema: { type: "object", properties: {} } },
        { name: "Edit", description: "e", input_schema: { type: "object", properties: {} } },
        { name: "WebFetch", description: "wf", input_schema: { type: "object", properties: {} } },
        EXIT_PLAN_TOOL,
        TODO_TOOL,
      ],
    });
    const { produced } = await produceCompletion(toOpenAIChatRequest(anthropicBody), pool, { profile: "claude-safe" });
    expect(produced.kind).toBe("tools");
    const manifest = transport.lastPrompt;
    expect(manifest).toContain("ExitPlanMode"); // control exemption beats allow-list
    expect(manifest).toContain("TodoWrite");
    expect(manifest).not.toContain("WebFetch");
    expect(manifest).toContain("ToolSearch");   // WebFetch deferred & discoverable
  });
});

describe("tool_choice.disable_parallel_tool_use forces one call per turn", () => {
  const TWO_FENCES = "```bash\nls\n```\n```echo\nhello\n```";
  const mkBody = (parallelDisabled?: boolean) =>
    toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "run both" }],
      tools: [
        { name: "bash", description: "Run shell", input_schema: { type: "object", properties: {} } },
        { name: "echo", description: "Echo text", input_schema: { type: "object", properties: {} } },
      ],
      ...(parallelDisabled
        ? { tool_choice: { type: "auto", disable_parallel_tool_use: true } }
        : {}),
    }));

  it("default profile batching forwards both calls", async () => {
    const transport = new ScriptedTransport(TWO_FENCES);
    const pool = new SessionPool({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const { produced } = await produceCompletion(mkBody(false), pool, {});
    if (produced.kind !== "tools") throw new Error(`expected tools, got ${produced.kind}`);
    expect(produced.toolCalls.length).toBe(2);
  });

  it("disable_parallel_tool_use trims to the first call", async () => {
    const transport = new ScriptedTransport(TWO_FENCES);
    const pool = new SessionPool({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const { produced } = await produceCompletion(mkBody(true), pool, { forceSingleToolUse: true });
    if (produced.kind !== "tools") throw new Error(`expected tools, got ${produced.kind}`);
    expect(produced.toolCalls.length).toBe(1);
    expect(produced.toolCalls[0].function.name).toBe("bash");
  });
});

describe("direct produceCompletion callers get strict profile validation too", () => {
  it("invalid profile -> 400 invalid_request_error, no crash", async () => {
    const transport = new ScriptedTransport("ok");
    const pool = new SessionPool({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const { produced } = await produceCompletion(
      { model: "claude-sonnet", messages: [{ role: "user" as const, content: "hi" }] } as never,
      pool,
      { profile: "nope" },
    );
    expect(produced.kind).toBe("error");
    if (produced.kind === "error") expect(produced.resp.status).toBe(400);
    expect(transport.calls).toBe(0); // rejected before any upstream work
  });
});

// --- Phase 1: arbitrary/namespaced tools, correlation, tokenizer scale ---

import { parseFencedToolCalls } from "@m365-copilot/core";
import { searchDeferredCatalog } from "./handler.js";

// Hermeticity: several fixtures intentionally produce empty/aborted turns, which
// would latch the shared account-degradation backoff and stall every later test
// in this file. Disable that policy here; it has its own dedicated suite.
process.env.M365_NO_BACKOFF = "1";

const MCP_TOOL = {
  name: "mcp__github__create_pull_request",
  description: "Create a pull request",
  input_schema: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title"],
  },
};

describe("arbitrary + namespaced tool transport", () => {
  it("fenced parser accepts namespaced MCP tool names verbatim", () => {
    // FencedToolSpec mirrors what deriveFencedSpec(buildSpecMap(...)) produces
    // for this schema: scalar `title` as a header line, `body` as fence body.
    const specs = new Map([
      ["mcp__github__create_pull_request", {
        name: "mcp__github__create_pull_request",
        description: "Create a PR",
        headerParams: ["title"],
        bodyParam: "body",
      }],
    ]);
    const { calls } = parseFencedToolCalls(
      "```mcp__github__create_pull_request\ntitle: demo\nbody: hello world\n```",
      specs as never,
    );
    expect(calls.length).toBe(1);
    expect(calls[0].function.name).toBe("mcp__github__create_pull_request");
    const args = JSON.parse(calls[0].function.arguments);
    expect(args.title).toBe("demo");
  });

  it("preserves tool_use.id, arguments and is_error state through conversion", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      max_tokens: 100,
      messages: [
        { role: "user", content: "open a pr" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_mcp_01", name: MCP_TOOL.name, input: { title: "demo", body: "text" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_mcp_01", is_error: true, content: "403 forbidden" }] },
      ],
      tools: [MCP_TOOL],
    });
    const msgs = toOpenAIChatRequest(body).messages;
    const assistant = msgs.find((m) => m.role === "assistant" && m.tool_calls?.length)!;
    expect(assistant.tool_calls[0].id).toBe("toolu_mcp_01");
    expect(assistant.tool_calls[0].function.name).toBe("mcp__github__create_pull_request");
    expect(JSON.parse(assistant.tool_calls[0].function.arguments)).toEqual({ title: "demo", body: "text" });
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("toolu_mcp_01");
    expect(String(toolMsg.content)).toContain("[tool error]");
    expect(String(toolMsg.content)).toContain("403 forbidden");
  });

  it("orphan tool_result gets a synthesized stub pair (documented recovery)", () => {
    const body = AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      max_tokens: 100,
      messages: [
        { role: "user", content: "history was trimmed above" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "orphan_42", content: "stale output" }] },
      ],
    });
    const msgs = toOpenAIChatRequest(body).messages;
    const stub = msgs.find((m) => m.role === "assistant" && m.tool_calls?.length);
    expect(stub).toBeTruthy();
    const toolMsg = msgs.find((m) => m.role === "tool")!;
    expect(toolMsg.tool_call_id).toBe("orphan_42");
    expect(toolMsg.content).toContain("stale output");
  });
});

describe("searchDeferredCatalog tokenizer + scale", () => {
  const mkCatalog = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      function: {
        name: `mcp__srv${i % 9}__utility_${i}`,
        description: `utility number ${i} does things`,
      },
    }));

  it("tokenizes __ . / - separated names: 'pull request' finds create_pull_request", () => {
    const catalog = [
      { function: { name: "mcp__github__list_issues", description: "list issues" } },
      { function: { name: "mcp__github__create_pull_request", description: "create a PR" } },
      { function: { name: "filesystem.read_file", description: "read" } },
      { function: { name: "some/tool-name", description: "misc" } },
    ];
    const hits = searchDeferredCatalog(catalog, "create pull request", 3);
    expect(hits[0]?.function?.name).toBe("mcp__github__create_pull_request");
  });

  it.each([50, 200, 1000])("handles a %i-tool deferred catalog deterministically", (n) => {
    const catalog = mkCatalog(n);
    const target = catalog[n - 1];
    const hits = searchDeferredCatalog(catalog, `utility_${n - 1}`, 6);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.function?.name === target.function?.name)).toBe(true);
  });
});

// --- Graceful Disengage + queued-Task cancellation ---

class DisengageTransport {
  calls = 0;
  reset(): void {}
  async chat(): Promise<never> {
    this.calls += 1;
    return {
      fullText: "",
      hasContent: false,
      throttle: null,
      contentOrigin: null,
      messageType: "Disengaged",
      messageId: null,
      scores: null,
      turnCount: null,
      turnState: null,
      thinkingText: null,
      hasThinking: false,
      images: [],
      sawAction: false,
      async *[Symbol.asyncIterator]() {},
    } as never;
  }
}

async function waitFor(fn: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("explicit Disengaged becomes a graceful assistant turn", () => {
  const BODY = { model: "claude-sonnet", max_tokens: 100, messages: [{ role: "user", content: "do a thing" }] };

  it("non-stream returns 200 + explanation text + end_turn", async () => {
    const transport = new DisengageTransport();
    const app = createApp({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const res = await app.fetch(anthropicRequest(BODY));
    expect(res.status).toBe(200);
    const message = await res.json();
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content[0].text).toContain("safety filter engaged");
    expect(transport.calls).toBe(1); // fail-fast, no retry storm
  });

  it("stream emits explanation deltas and NEVER an error event", async () => {
    const transport = new DisengageTransport();
    const app = createApp({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const res = await app.fetch(anthropicRequest({ ...BODY, stream: true }));
    const raw = await res.text();
    expect(raw).toContain('"text_delta"');
    expect(raw).toContain("safety filter engaged");
    expect(raw).not.toContain('"type":"error"');
    const lastEvent = raw.trim().split("\n\n").pop() ?? "";
    expect(lastEvent).toContain('"type":"message_stop"');
  });
});

describe("queued Task jobs abandon on cancellation", () => {
  it("second Task job never starts once the caller aborts after the first", async () => {
    process.env.M365_CONVERSATION_START_GAP_MS = "0"; // sub-agent conversations must not pay the stampede gap
    class TaskFlowTransport {
      seen: string[] = [];
      mainTurns = 0;
      /** Test holds alpha's turn open so the abort lands BETWEEN the two jobs deterministically. */
      alphaGate: Promise<void>;
      private releaseAlpha!: () => void;
      reset(): void {}
      constructor() {
        this.alphaGate = new Promise<void>((r) => { this.releaseAlpha = r; });
      }
      async chat(args: { text: string }): Promise<never> {
        const t = String(args.text);
        if (t.includes("HARNESS REALITY")) {
          this.seen.push(t); // record FIRST so the test can observe while alpha is held open
          if (t.includes("alpha research")) await this.alphaGate;
          return staticStream("report: findings attached");
        }
        this.mainTurns += 1;
        if (this.mainTurns === 1) {
          return staticStream("```Task\nprompt: alpha research\n```\n```Task\nprompt: beta research\n```");
        }
        return staticStream("FINAL ANSWER");
      }
    }

    const transport = new TaskFlowTransport();
    const pool = new SessionPool({ getToken: async () => "t", useAgent: false, transport: transport as never });
    const controller = new AbortController();
    const chatBody = toOpenAIChatRequest(AnthropicMessagesRequest.parse({
      model: "claude-sonnet",
      messages: [{ role: "user", content: "delegate two jobs" }],
      tools: [PROFILE_TOOLS[1]], // Read — enough to enter tool mode
    }));
    const done = produceCompletion(chatBody, pool, { signal: controller.signal, profile: "claude-wide" });

    await waitFor(() => transport.seen.length >= 1); // alpha in flight, held open by its gate
    controller.abort();
    (transport as unknown as { releaseAlpha: () => void }).releaseAlpha();

    const { produced } = await done;
    delete process.env.M365_CONVERSATION_START_GAP_MS;
    expect(produced.kind).toBe("text");
    if (produced.kind === "text") expect(produced.text).toContain("FINAL ANSWER");
    expect(transport.seen.length).toBeGreaterThanOrEqual(1);
    expect(transport.seen.some((t) => t.includes("beta research"))).toBe(false);
  }, 20_000);
});

// --- Cancellation timing: client disconnects must fail fast, never retry-storm ---

describe("cancellation propagation (abort before start + mid-turn)", () => {
  /**
   * Scripted transport whose turns hang until the caller's signal fires —
   * mirroring how a real M365 WebSocket dies on the Stop frame. ModelSession
   * is allowed exactly ONE reconnect retry per turn, so a fully-cancelled turn
   * deterministically costs 2 transport attempts; anything more (the historical
   * empty-retry amplification) is a regression.
   */
  class AbortAwareTransport {
    calls = 0;
    async chat(args: { signal?: AbortSignal }): Promise<never> {
      this.calls += 1;
      return new Promise<never>((_resolve, reject) => {
        if (args.signal?.aborted) {
          reject(new Error("aborted before start"));
          return;
        }
        const timer = setTimeout(() => reject(new Error("turn outlived its abort")), 5_000);
        args.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted mid-turn"));
          },
          { once: true },
        );
      });
    }
  }

  const BODY = { model: "claude-sonnet", messages: [{ role: "user" as const, content: "hi" }] };

  it("a pre-aborted signal fails fast with no retry storm", async () => {
    const transport = new AbortAwareTransport();
    const pool = new SessionPool({
      getToken: async () => "fake-token",
      useAgent: false,
      transport: transport as never,
    });
    const controller = new AbortController();
    controller.abort();

    const { produced } = await produceCompletion(BODY as never, pool, { signal: controller.signal });
    expect(produced.kind).toBe("error");
    if (produced.kind === "error") expect(produced.resp.status).toBe(502);
    // initial attempt + ModelSession's single reconnect — NOT MAX_RETRIES more
    expect(transport.calls).toBe(2);
  });

  it("an abort mid-turn cancels the hung stream and does not re-attempt beyond the reconnect", async () => {
    const transport = new AbortAwareTransport();
    const pool = new SessionPool({
      getToken: async () => "fake-token",
      useAgent: false,
      transport: transport as never,
    });
    const controller = new AbortController();
    const done = produceCompletion(BODY as never, pool, { signal: controller.signal });

    // Wait until the turn is genuinely in flight, then simulate the client
    // disconnecting mid-stream.
    while (transport.calls === 0) await new Promise((r) => setTimeout(r, 1));
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();

    const { produced } = await done;
    expect(produced.kind).toBe("error");
    if (produced.kind === "error") expect(produced.resp.status).toBe(502);
    expect(transport.calls).toBe(2);
  });
});

describe("12 Protocol Test Fixtures Suite (/v1/messages)", () => {
  beforeAll(() => {
    process.env.M365_CONVERSATION_START_GAP_MS = "0";
    process.env.M365_NO_BACKOFF = "1";
  });

  function makeFixtureApp(fixture: any, opts?: any) {
    const transport = new FakeTransport({ fixture, ...opts });
    const app = createApp({
      getToken: async () => "fake-token",
      useAgent: false,
      transport,
    });
    return { app, transport };
  }

  it("fixture 1: normal-text generates complete assistant message", async () => {
    const { app } = makeFixtureApp("normal-text");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hello" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
    expect(body.stop_reason).toBe("end_turn");
  });

  it("fixture 2: streamed-text streams chunks over SSE", async () => {
    const { app } = makeFixtureApp("streamed-text");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        stream: true,
        messages: [{ role: "user", content: "hello stream" }],
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("content_block_delta");
    expect(text).toContain("event: message_stop");
  });

  it("fixture 3: tool-call produces valid Anthropic tool_use block", async () => {
    const { app } = makeFixtureApp("tool-call");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        tools: [BASH_TOOL],
        messages: [{ role: "user", content: "run command" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stop_reason).toBe("tool_use");
    expect(body.content.some((c: any) => c.type === "tool_use")).toBe(true);
  });

  it("fixture 4: multi-tool produces multiple tool_use blocks in one turn", async () => {
    const { app } = makeFixtureApp("multi-tool");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        tools: [BASH_TOOL],
        messages: [{ role: "user", content: "run steps" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stop_reason).toBe("tool_use");
    const toolUses = body.content.filter((c: any) => c.type === "tool_use");
    expect(toolUses.length).toBeGreaterThanOrEqual(2);
  });

  it("fixture 5: malformed-tool handles syntax errors safely", async () => {
    const { app } = makeFixtureApp("malformed-tool");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        tools: [{ name: "read_file", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
        messages: [{ role: "user", content: "read file" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("assistant");
  });

  it("fixture 6: confabulated-prose triggers retry or surfaces prose fallback", async () => {
    const { app } = makeFixtureApp("confabulated-prose");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        tools: [BASH_TOOL],
        messages: [{ role: "user", content: "please edit this file" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("assistant");
    expect(body.content[0].type).toBe("text");
  });

  it("fixture 7: disengaged returns graceful assistant turn", async () => {
    const { app } = makeFixtureApp("disengaged");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "trigger disengage" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("assistant");
    expect(body.content[0].text).toMatch(/safety filter|content filter|declined this request/);
  });

  it("fixture 8: throttle-429 surfaces rate limit error", async () => {
    const { app } = makeFixtureApp("throttle-429");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "trigger throttle" }],
      }),
    );
    expect(res.status).toBe(429);
  });

  it("fixture 9: expired-auth surfaces authentication error", async () => {
    const { app } = makeFixtureApp("expired-auth");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hello auth" }],
      }),
    );
    expect(res.status).toBe(401);
  });

  it("fixture 10: conversation-expired returns error", async () => {
    const { app } = makeFixtureApp("conversation-expired");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "hello expired" }],
      }),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("fixture 11: image-response delivers generated image markdown", async () => {
    const { app } = makeFixtureApp("image-response");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "draw me a sunset" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content[0].text).toContain("![generated image]");
  });

  it("fixture 12: unknown-frame safely processes unknown frame type without crashing", async () => {
    const { app } = makeFixtureApp("unknown-frame");
    const res = await app.fetch(
      anthropicRequest({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "future frame test" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe("assistant");
  });
});

