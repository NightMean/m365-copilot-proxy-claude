import {
  ModelSession,
  type ModelSessionOptions,
  createLogger,
  trunc,
  getToneForModel,
  resolveModel,
  UnsupportedModelError,
  formatMessages,
  formatFencedToolDefinitions,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  isProseDocument,
  getMessageContent,
  noteRequestOutcome,
  awaitDegradationBackoff,
  getImageArtifactToken,
  fetchImageBytes,
  resolveSystemPromptSpec,
  type CapturedImage,
  type UploadedImageAnnotation,
  M365ProxyError,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { TurnGate } from "./gate.js";
import {
  classifyFailure,
  toneHealth,
  nextHealthyFallback,
  fallbackChain,
  failoverEnabled,
  type FailureClass,
} from "./health.js";
import { upstreamEnabled, handleUpstreamChat } from "./upstream.js";
import { enqueueTurn } from "./turn-queue.js";
import { SessionStore } from "./session-store.js";
import { resolveProfile, toolAllowedByProfile } from "./profiles.js";
import { resolveModelSystemPrompt } from "./model-prompts.js";
import {
  subAgentsEnabled,
  makeTaskToolDef,
  runSubAgent,
  extractSubAgentJob,
  SUBAGENT_TOOL_NAME,
} from "./subagent.js";
import type { z } from "zod/v4";
import { createHash } from "node:crypto";
import { ToolSchemaRegistry } from "./tool-registry.js";

const log = createLogger("handler");

// --- Ops stats ring (dashboard + /internal/stats) ---

export interface TurnStat {
  at: number;
  model: string;
  totalMs: number;
  ttftMs: number | null;
  chars: number;
  outcome: "ok" | "empty" | "disengaged" | "rate_limited";
  /** Harness profile active for the turn (telemetry only). */
  profile?: string;
  /** Tool-surface telemetry: advertised vs deferred sizes at turn time. */
  visibleTools?: number;
  deferredTools?: number;
  promotedTools?: number;
  /** ToolSearch discovery rounds consumed by the request so far. */
  toolSearchRounds?: number;
  /** Synthetic Task sub-agent jobs launched by the request so far. */
  taskJobs?: number;
  /** Inline tone-failover reroute happened (depth > 0). */
  failoverUsed?: boolean;
  /** Caller aborted this turn. */
  cancelled?: boolean;
}

const TURN_STATS_CAP = 80;
const turnStats: TurnStat[] = [];

function recordTurnStat(s: TurnStat): void {
  turnStats.push(s);
  if (turnStats.length > TURN_STATS_CAP) turnStats.shift();
}

/** Recent upstream turns, oldest first (for the status dashboard). */
export function getTurnStats(): TurnStat[] {
  return [...turnStats];
}

// Render generated images (§14) as markdown so any OpenAI-compatible client shows
// them inline. The artifact URL 401s without the designerappservice token, so we
// fetch the bytes ourselves and embed a self-contained data URI — a bare URL would
// be useless to the client. On fetch failure we fall back to the raw URL so the
// response is never silently empty.
async function renderImagesMarkdown(images: CapturedImage[]): Promise<string> {
  if (images.length === 0) return "";
  let artifactToken: string | null = null;
  try { artifactToken = await getImageArtifactToken(); } catch (e: any) { log.info(`image token failed: ${e.message}`); }
  const parts: string[] = [];
  for (const img of images) {
    const url = img.referenceUrls[0];
    if (!url) continue;
    if (artifactToken) {
      try {
        const { data, contentType } = await fetchImageBytes(url, artifactToken);
        parts.push(`![generated image](data:${contentType};base64,${data.toString("base64")})`);
        continue;
      } catch (e: any) { log.info(`image fetch failed: ${e.message}`); }
    }
    parts.push(`![generated image](${url})`);
  }
  return parts.join("\n\n");
}

// Forcing follow-up sent (in the same conversation) when M365 confabulates an
// inability to act instead of calling a tool. See the confab-retry loop below.
const CONFAB_FORCE_PROMPT =
  "PROOF OF ACCESS: the pwd/ls output you just received in <tool_response> is REAL output from YOUR OWN tool call, executed on a live filesystem this exact moment. The files listed exist and your tool works. Any sentence claiming you lack filesystem or machine access, that tools are unavailable, or asking the user to paste files is FALSE and will be treated as a malfunction. " +
  "Continue the ORIGINAL task now. Emit ONE ```bash block this turn (inspect the named files/config with ls/cat) and nothing else.";

// Forcing follow-up when the model CLAIMS it did a file change but ran no tool.
const HALLUCINATION_FORCE_PROMPT =
  "You have NOT actually done that — no tool ran this turn, so nothing changed on disk. Do not claim a file was created, replaced, or updated until a <tool_response> confirms it. Emit ONE ```bash block now that performs the change for real (write the file with a `cat > path <<'EOF' … EOF` heredoc), and nothing else.";

// M365 soft-caps output around ~3k tokens (~12k chars) and — critically —
// CONCLUDES EARLY rather than truncating mid-stream, so a too-long answer comes
// back clean-looking but incomplete with no error to detect (docs/hypotheses.md
// F9). We can't see token counts, so we heuristically flag responses at/over the
// observed ceiling with finish_reason:"length" — the standard signal a harness
// uses to ask for a continuation. Tune/disable via env (0 disables).
const OUTPUT_CHAR_CEILING = process.env.M365_OUTPUT_CHAR_CEILING !== undefined
  ? Number(process.env.M365_OUTPUT_CHAR_CEILING)
  : 12_000;

/** "length" when the answer is at/over the empirical output ceiling, else "stop". */
export function outputFinishReason(text: string): "stop" | "length" {
  if (OUTPUT_CHAR_CEILING > 0 && text.length >= OUTPUT_CHAR_CEILING) {
    log.info(`Output at ceiling (${text.length} ≥ ${OUTPUT_CHAR_CEILING} chars) — finish_reason=length (likely truncated; harness should continue)`);
    return "length";
  }
  return "stop";
}

type ChatBody = z.infer<typeof ChatCompletionRequest>;
type ParsedMessage = ChatBody["messages"][number];

/**
 * Turn a first-turn false refusal into one harmless, real local action without
 * spending another M365 message asking the model to reconsider.  The client
 * executes this call, then sends its output back through the normal agent loop.
 * Keep this deliberately read-only and only use the caller's actual shell tool.
 */
const LIST_TOOL_NAME = /^(ls|list|list_dir|list_directory|glob|dir|find_files|search_files|ls_dir|view_dir)$/i;

export function makeOrientationToolCall(body: ChatBody): ReturnType<typeof parseToolCalls>["toolCalls"][number] | null {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return null;

  const shell = findShellTool(body.tools);
  if (shell) {
    if (typeof body.tool_choice === "object") {
      const selected = body.tool_choice.function.name;
      const selectedTool = body.tools.find((tool) => tool.function.name === selected);
      if (selectedTool !== shell && !isShellToolName(selected)) return null;
    }

    const commandParam = shellCommandParam(shell);
    if (commandParam) {
      return {
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: shell.function.name,
          arguments: JSON.stringify({ [commandParam]: "pwd && ls -la" }),
        },
      };
    }
  }

  const listTool = body.tools.find((t) => LIST_TOOL_NAME.test(t.function.name));
  if (listTool) {
    const props = Object.keys(listTool.function.parameters?.properties ?? {});
    const pathArg = props.find((p) => /^(path|dir|directory|pattern|glob)$/i.test(p)) ?? props[0];
    const val = /pattern|glob/i.test(pathArg ?? "") ? "*" : ".";
    return {
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      type: "function",
      function: {
        name: listTool.function.name,
        arguments: pathArg ? JSON.stringify({ [pathArg]: val }) : "{}",
      },
    };
  }

  const firstTool = body.tools[0];
  const required = firstTool.function.parameters?.required;
  if (Array.isArray(required) && required.length > 0) return null;
  return {
    id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "function",
    function: {
      name: firstTool.function.name,
      arguments: "{}",
    },
  };
}

const SHELL_TOOL_NAME = /^(bash|sh|shell|zsh|run|exec|execute|command|cmd|terminal|run_command|run_terminal_cmd|execute_command|execute_bash|shell_exec|system)$/i;
const SHELL_COMMAND_PARAMS = ["command", "cmd", "script", "input"];

function isShellToolName(name: string): boolean {
  return SHELL_TOOL_NAME.test(name);
}

function findShellTool(tools: NonNullable<ChatBody["tools"]>): NonNullable<ChatBody["tools"]>[number] | null {
  return tools.find((tool) => isShellToolName(tool.function.name)) ??
    tools.find((tool) => {
      const props = Object.keys(tool.function.parameters?.properties ?? {});
      return props.length === 1 && SHELL_COMMAND_PARAMS.some((p) => p.toLowerCase() === props[0].toLowerCase());
    }) ??
    null;
}

function shellCommandParam(tool: NonNullable<ChatBody["tools"]>[number]): string | null {
  const props = Object.keys(tool.function.parameters?.properties ?? {});
  return SHELL_COMMAND_PARAMS.find((p) => props.includes(p)) ??
    props.find((p) => SHELL_COMMAND_PARAMS.some((known) => known.toLowerCase() === p.toLowerCase())) ??
    (props.length === 1 ? props[0] : null);
}

function dedupeByName<T extends { function?: { name?: string } }>(tools: T[]): T[] {
  const seen = new Set<string>();
  return tools.filter((t) => {
    const n = t.function?.name ?? "";
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

/** Synthetic progressive-discovery meta-tool advertised when a deferred catalog exists. */
export const TOOLSEARCH_TOOL_NAME = "ToolSearch";
function makeToolSearchDef(): { type: "function"; function: { name: string; description: string; parameters: unknown } } {
  return {
    type: "function",
    function: {
      name: TOOLSEARCH_TOOL_NAME,
      description:
        "Search this project's full tool catalog. The fence body is the search query (keywords). " +
        "The next message returns the matching tool definitions so you can call those tools directly. " +
        "Use it whenever the task seems to need a tool that was not listed above.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Space-separated keywords, e.g. 'browser screenshot' or 'github pull request'." },
        },
        required: ["query"],
      },
    },
  };
}

/** Score deferred tools against a keyword query — simple term overlap over name+description. */
export function searchDeferredCatalog(
  catalog: { function?: { name?: string; description?: string } }[],
  query: string,
  limit = 6,
): { function?: { name?: string; description?: string } }[] {
  const terms = query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];
  const scored = catalog.map((t) => {
    const name = (t.function?.name ?? "").toLowerCase();
    const desc = (t.function?.description ?? "").toLowerCase();
    // Namespaced names tokenize on EVERY separator (mcp__srv__tool, plugin.tool,
    // some/tool-name) so "pull request" hits mcp__github__create_pull_request.
    const nameTokens = new Set(name.split(/[^a-z0-9_]+/).filter(Boolean));
    let score = 0;
    for (const term of terms) {
      if (!term) continue;
      if (nameTokens.has(term)) score += 3;       // exact token in the NAME
      else if (name.includes(term)) score += 2;   // substring of the name
      else if (desc.includes(term)) score += 1;   // description-only mention
    }
    return { t, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.t);
}

// --- Per-conversation state ---

interface ConversationState {
  session: ModelSession;
  sentMessageCount: number;
  lastAccessedAt: number;
  /** Deferred tools promoted to the advertised set via ToolSearch (W-A). */
  promotedTools?: Set<string>;
}

// --- Session pool: maps conversation fingerprint → M365 session ---

const MAX_IDLE_MS = 30 * 60 * 1000; // evict after 30 min idle

export class SessionPool {
  private conversations = new Map<string, ConversationState>();
  private sessionOptions: ModelSessionOptions;
  /** Throttle-aware concurrency gate shared by every conversation in this pool. */
  readonly turnGate = new TurnGate();
  /**
   * Restart durability (docs/hypotheses.md F13 economics): a proxy restart used
   * to spend a fresh M365 conversation start per active thread. Persisting
   * fingerprint → ConversationId lets the next process RESUME the same
   * server-side thread instead. Disable with M365_NO_SESSION_STORE=1.
   */
  private readonly store: SessionStore | null;

  constructor(sessionOptions: ModelSessionOptions = {}) {
    this.sessionOptions = sessionOptions;
    // Persistence defaults ON in production but stays OFF inside unit tests
    // (NODE_ENV=test) unless an explicit store path opts in — tests must never
    // write the operator's real ~/.config/opencode-m365/sessions.json.
    const explicitPath = process.env.M365_SESSION_STORE_PATH;
    const enabled = process.env.M365_NO_SESSION_STORE !== "1"
      && (Boolean(explicitPath) || process.env.NODE_ENV !== "test");
    this.store = enabled ? new SessionStore(explicitPath || undefined) : null;
  }

  /**
   * Fire-and-forget persistence of one conversation's progress. Called at every
   * successful turn commit; failures are logged inside the store, never thrown.
   */
  persistConversation(fingerprint: string, state: ConversationState): void {
    this.store?.set(fingerprint, {
      conversationId: state.session.conversationId,
      sentMessageCount: state.sentMessageCount,
      lastUsedAt: Date.now(),
    });
    this.store?.flush();
  }

  /**
   * Resolve the conversation state for an incoming request.
   * Fingerprint is the hash of the first user message PLUS the canonical model
   * PLUS the caller's session key — same first message on a DIFFERENT model or
   * from a DIFFERENT client (distinct x-m365-session-id) must NOT reuse the
   * conversation: M365 conversations carry server-side tone/model history, and
   * sharing one across clients bleeds context between them.
   */
  resolve(messages: ParsedMessage[], model?: string, sessionKey?: string, profileName?: string): ConversationState {
    this.evictStale();

    const fingerprint = this.fingerprint(messages, model, sessionKey, profileName);
    const existing = this.conversations.get(fingerprint);

    if (existing) {
      // Messages shrunk means client restarted this conversation — reset M365 session
      if (messages.length < existing.sentMessageCount) {
        log.info(`Conversation ${fingerprint}: messages shrunk (${messages.length} < ${existing.sentMessageCount}), resetting`);
        existing.session.reset();
        existing.sentMessageCount = 0;
        this.persistConversation(fingerprint, existing);
      }
      existing.lastAccessedAt = Date.now();
      return existing;
    }

    // New conversation — but maybe a PREVIOUS process left a resumable thread
    // for this exact fingerprint. Hydrate only fresh records (older than the
    // idle-eviction window means M365 may have GC'd the thread anyway).
    const prior = this.store?.get(fingerprint) ?? null;
    const priorFresh = prior && Date.now() - prior.lastUsedAt < MAX_IDLE_MS ? prior : null;
    if (prior && !priorFresh) this.store?.delete(fingerprint);
    const state: ConversationState = {
      session: priorFresh
        ? new ModelSession({ ...this.sessionOptions, conversationId: priorFresh.conversationId })
        : new ModelSession(this.sessionOptions),
      sentMessageCount: priorFresh?.sentMessageCount ?? 0,
      lastAccessedAt: Date.now(),
    };
    if (priorFresh) {
      log.info(`New conversation ${fingerprint.slice(0, 10)}… HYDRATED from disk (cid=${priorFresh.conversationId}, sent=${priorFresh.sentMessageCount})`);
    } else {
      log.info(`New conversation ${fingerprint}, ${this.conversations.size} active`);
    }
    this.conversations.set(fingerprint, state);
    return state;
  }

  /** Public so callers can key their own accounting (the turn gate) off the same identity. */
  fingerprintOf(messages: ParsedMessage[], model?: string, sessionKey?: string, profileName?: string): string {
    return this.fingerprint(messages, model, sessionKey, profileName);
  }

  private fingerprint(messages: ParsedMessage[], model?: string, sessionKey?: string, profileName?: string): string {
    const firstUser = messages.find(m => m.role === "user");
    const text = firstUser ? getMessageContent(firstUser) : "";
    // Profile is part of the identity: promoted tools and prompt policy must
    // never bleed between claude-safe / claude-wide / ... conversations.
    return sha256Hex(`${sessionKey ?? ""}\u0000${model ?? ""}\u0000${profileName ?? ""}\u0000${text}`);
  }

  private evictStale() {
    const now = Date.now();
    for (const [key, state] of this.conversations) {
      if (now - state.lastAccessedAt > MAX_IDLE_MS) {
        log.info(`Evicting idle conversation ${key}`);
        this.conversations.delete(key);
        this.store?.delete(key);
      }
    }
  }

  get size(): number {
    return this.conversations.size;
  }
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return String(hash);
}

/** Collision-free conversation identity (the old 32-bit rolling hash could
 *  collide, fusing two clients' conversations into one M365 thread). */
function sha256Hex(str: string): string {
  return createHash("sha256").update(str, "utf8").digest("hex");
}

// --- Delta message formatting ---

function formatDeltaMessages(messages: ParsedMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      // Skip assistant messages — M365 already has them server-side.
      // Echoing them back as a user message confuses M365.
      continue;
    } else if (m.role === "tool") {
      const name = m.name || "unknown";
      const callId = m.tool_call_id || "?";
      // Attribution matters: this arrives as a user-role message in M365's
      // stateful thread, and without the header the model reads its OWN tool
      // output as user-pasted content ("stray directory listing…").
      parts.push(
        `[Automated harness message: this is the output of the \`${name}\` tool YOU invoked in your previous reply — not a user message. It is REAL output from the live workspace: your tools and filesystem access are CONFIRMED working - never claim otherwise. Continue your task from it.]\n` +
        `<tool_response name="${name}" call_id="${callId}">\n${getMessageContent(m)}\n</tool_response>`,
      );
    } else if (m.role === "system") {
      // Skip system messages on follow-up turns
    } else {
      parts.push(`<${m.role}>\n${getMessageContent(m)}\n</${m.role}>`);
    }
  }
  return parts.join("\n\n");
}

// --- Main handler ---

/**
 * One completed turn, as DATA — rendered as JSON or SSE by whichever protocol
 * route (OpenAI chat completions / Anthropic messages) asked for it.
 */
export type Produced =
  | { kind: "error"; resp: Response }
  | { kind: "text"; text: string; thinking?: string }
  /** `text` = prose that preceded/accompanied the calls. May already have been
   *  LIVE-streamed by the guarded forwarder — renderers emit only the un-streamed
   *  remainder. */
  | { kind: "tools"; toolCalls: ReturnType<typeof parseToolCalls>["toolCalls"]; text?: string; thinking?: string };

export interface ProduceOptions {
  /** Aborts the M365 turn when the client disconnects. */
  signal?: AbortSignal;
  /**
   * Live text-delta callback (non-tool path only — tool mode buffers because the
   * raw text must be parsed for fences and can't be shown verbatim).
   */
  onTextDelta?: (delta: string) => void;
  /**
   * Per-request system-prompt spec (name:/path:/literal). Takes precedence over
   * the M365_SYSTEM_PROMPT env var. Never set globally — passed straight through
   * so concurrent requests can't leak prompts into each other.
   */
  systemPromptSpec?: string;
   /**
    * Caller-supplied conversation identity (x-m365-session-id header). Requests
    * with different keys never share an M365 conversation, even with identical
    * first messages; omit to keep the legacy content+model fingerprint.
    */
   sessionKey?: string;
  /**
   * Adaptive harness profile (x-m365-profile header / M365_PROFILE env).
   * Controls advertised-tool surface, ToolSearch depth, synthetic Task
   * availability, batching and failover policy. Unknown values are rejected
   * at the HTTP routes; direct callers get claude-safe fallback.
   */
  profile?: string;
  /**
   * Anthropic `tool_choice.disable_parallel_tool_use` translated by the bridge:
   * forces strict one-tool-per-turn for THIS request regardless of profile/env.
   */
  forceSingleToolUse?: boolean;
  /** Uploaded image annotations for image vision input. */
  imageAnnotations?: UploadedImageAnnotation[];
}

function withSystemMessage(body: ChatBody, text: string): ChatBody {
  return {
    ...body,
    messages: [{ role: "system", content: text } as ParsedMessage, ...body.messages],
  };
}

/**
 * Opt-in system-prompt injection. Spec resolution order per request:
 * explicit spec argument > M365_SYSTEM_PROMPT env var > model-routed prompt
 * (M365_MODEL_PROMPTS=1 — injects the requested model family's own leaked
 * production prompt, see model-prompts.ts) > none. See core/prompts.ts for
 * name:/path:/literal semantics. Injected prompts raise Disengaged risk when
 * huge, so this stays opt-in everywhere.
 */
export function injectSystemPrompt(body: ChatBody, specOverride?: string): ChatBody {
  const spec = specOverride ?? process.env.M365_SYSTEM_PROMPT;
  if (!spec) {
    const routed = resolveModelSystemPrompt(body.model);
    if (!routed) return body;
    log.info(`Model prompt route: "${body.model}" → ${routed.name} (${routed.text.length}${routed.truncated ? ", truncated" : ""} chars)`);
    return withSystemMessage(body, routed.text);
  }
  try {
    const resolved = resolveSystemPromptSpec(spec);
    if (!resolved) return body;
    log.info(`Injecting ${resolved.mode} system prompt (${resolved.text.length} chars)`);
    return withSystemMessage(body, resolved.text);
  } catch (err: any) {
    throw new Error(`Invalid M365_SYSTEM_PROMPT: ${err.message}`);
  }
}

/**
 * Run one chat-completion turn against M365 and return the result plus an OpenAI-style
 * usage snapshot. Protocol-neutral: both the OpenAI and Anthropic routes call this and
 * render `produced` in their own wire format. Handles conversation pooling, delta vs
 * full prompting, the turn gate, Disengage/confabulation recovery, tool-call parsing,
 * and image rendering.
 */
export async function produceCompletion(
  body: ChatBody,
  pool: SessionPool,
  cb: ProduceOptions = {},
  depth = 0,
): Promise<{ produced: Produced; usage: Record<string, unknown> }> {
  const fail = (status: number, payload: unknown): { produced: Produced; usage: Record<string, unknown> } =>
    ({ produced: { kind: "error", resp: jsonResponse(status, payload) }, usage: buildUsage(null) });

  // Adaptive profile resolution (header > M365_PROFILE env > claude-safe).
  // Drives tool surface, ToolSearch depth, Task availability and failover.
  // Routes pre-validate strictly; direct callers get the same hard 400 here —
  // never a silent fallback, never an undefined-profile crash.
  const profSel = resolveProfile(cb.profile);
  if (!profSel.ok) {
    return fail(400, { error: { message: profSel.error, type: "invalid_request_error" } });
  }
  const profile = profSel.profile;
  if (profSel.source === "explicit") log.info(`Harness profile: ${profile.name} (explicit)`);

  // Compile the caller's complete tool catalog once, before spending an M365
  // turn. The same registry validates every parsed/promoted call before it can
  // cross back to Claude Code.
  const toolRegistry = new ToolSchemaRegistry(body.tools ?? []);
  if (toolRegistry.definitionErrors.length > 0) {
    return fail(400, {
      error: {
        message: `Invalid tool definition(s): ${toolRegistry.definitionErrors.join(" ")}`,
        type: "invalid_request_error",
        code: "PROXY_TOOL_SCHEMA_ERROR",
      },
    });
  }

  // Tone-health routing (W-C): when the requested model's breaker is OPEN
  // (consecutive tone_outage failures), transparently reroute to the first
  // healthy fallback — a NEW conversation by construction (fingerprints are
  // model-keyed). Disable with M365_NO_TONE_FAILOVER=1 or per-profile policy.
  if (depth === 0 && failoverEnabled() && profile.toneFailover) {
    const alt = rerouteIfOpen(body.model);
    if (alt) {
      log.warn(`Tone health: ${body.model} breaker open — rerouting to ${alt}`);
      body = { ...body, model: alt };
    }
  }

  let resolved;
  try {
    resolved = resolveModel(body.model);
  } catch (err: any) {
    if (err instanceof UnsupportedModelError) {
      return fail(400, {
        error: {
          message: err.message,
          type: "invalid_request_error",
          code: "UNSUPPORTED_MODEL",
          supported_models: err.supportedModels,
        },
      });
    }
    return fail(400, { error: { message: err.message, type: "invalid_request_error" } });
  }

  /** First fallback whose breaker isn't open, for inline retry on tone_outage. */
  function rerouteIfOpen(model: string): string | null {
    if (!toneHealth.shouldRouteAway(model)) return null;
    for (const alt of fallbackChain(model)) {
      if (!toneHealth.shouldRouteAway(alt)) return alt;
    }
    return null;
  }

  // Log warnings for deprecated/preset model aliases
  if (resolved.warnings.length > 0) {
    for (const warn of resolved.warnings) {
      log.warn(`Model resolution warning: ${warn}`);
    }
  }

  try {
    body = injectSystemPrompt(body, cb.systemPromptSpec);
  } catch (err: any) {
    return fail(400, { error: { message: err.message, type: "invalid_request_error" } });
  }

  const conv = pool.resolve(body.messages, resolved.canonicalModel, cb.sessionKey, profile.name);
  const { session } = conv;

  // Toolset lean-down (§9: M365 disengages/ignores tool framing on large
  // payloads). Two knobs, applied in order, BOTH before any prompt formatting:
  //   M365_ALLOWED_TOOLS="Bash,Read"  — keep only these tool names.
  //   M365_MAX_TOOLS="6"              — cap the advertised count (original order wins).
  // Tools dropped by either become the DEFERRED catalog: they stay executable
  // (the client declared them; parse/forward uses the ORIGINAL body.tools) but
  // their schemas are hidden from M365 behind a synthetic `ToolSearch` meta-tool
  // (progressive discovery — Anthropic's pattern for >30-tool catalogs).
  const allTools: NonNullable<typeof body.tools> = body.tools ?? [];
  // Tool-surface policy precedence: explicit operator env beats the profile.
  //   M365_ALLOWED_TOOLS="Bash,Read"  — exact-name allow-list (legacy semantics).
  //   M365_MAX_TOOLS="6"              — hard advertised cap.
  // Without env, the resolved profile supplies allow-list + cap; anything
  // filtered out lands in the deferred ToolSearch catalog (still callable).
  const envAllowed = process.env.M365_ALLOWED_TOOLS
    ?.split(",").map((s) => s.trim()).filter(Boolean);
  const envMaxAdvertised = Number(process.env.M365_MAX_TOOLS ?? "");
  const allowed = envAllowed;
  const profileAllows = (name: string): boolean => toolAllowedByProfile(name, profile);
  const maxAdvertised = Number.isFinite(envMaxAdvertised) && envMaxAdvertised > 0
    ? envMaxAdvertised
    : profile.maxVisibleTools;
  const promoted = conv.promotedTools;
  let advertisedTools: typeof allTools = allTools;
  if (allowed?.length || Number.isFinite(maxAdvertised) && maxAdvertised > 0) {
    const allowedSet = allowed?.length ? new Set(allowed) : null;
    const before = allTools.length;
    let kept = allTools.filter((t: { function?: { name?: string } }) => {
      const n = t.function?.name ?? "";
      return allowedSet ? allowedSet.has(n) : profileAllows(n);
    });
    // Promoted (previously discovered) tools always keep their slot.
    if (promoted?.size) {
      for (let i = kept.length - 1; i >= 0; i--) {
        const n = (kept[i] as { function?: { name?: string } }).function?.name ?? "";
        if (!promoted.has(n)) continue;
        kept = [kept[i], ...kept.slice(0, i), ...kept.slice(i + 1)];
      }
      kept = dedupeByName(kept);
    }
    if (Number.isFinite(maxAdvertised) && maxAdvertised > 0 && kept.length > maxAdvertised) {
      const head = kept.slice(0, maxAdvertised);
      const tail = kept.slice(maxAdvertised).filter((t) => {
        const n = (t as { function?: { name?: string } }).function?.name ?? "";
        return promoted?.has(n);
      });
      kept = [...head, ...tail].slice(0, Math.max(maxAdvertised, tail.length));
    }
    advertisedTools = kept;
    if (advertisedTools.length !== before) {
      log.info(`Tool filter (${allowed?.join(",") ?? "count-cap"}): ${before} -> ${advertisedTools.length} advertised`);
    }
  } else if (promoted?.size) {
    advertisedTools = dedupeByName([
      ...allTools.filter((t) => promoted.has((t as { function?: { name?: string } }).function?.name ?? "")),
      ...allTools,
    ]);
  }

  // Control tools are ALWAYS advertised, exempt from both the profile allow-list
  // and maxVisibleTools: deferring ExitPlanMode strands a model inside plan mode,
  // deferring BashOutput/KillShell strands background shells, deferring TodoWrite
  // breaks plan tracking. They occupy reserved slots; the cap applies to the rest.
  const CONTROL_TOOL_RE = /^(exitplanmode|todowrite|bashoutput|killshell)$/i;
  const controlTools = allTools.filter((t) => CONTROL_TOOL_RE.test(t.function?.name ?? ""));
  if (controlTools.length > 0) {
    const controlNames = new Set(controlTools.map((t) => t.function?.name ?? ""));
    const merged = dedupeByName([...controlTools, ...advertisedTools]);
    const nonControl = merged.filter((t) => !controlNames.has(t.function?.name ?? ""));
    const keepNonControl = new Set(
      nonControl
        .slice(0, Math.max(0, maxAdvertised - controlTools.length))
        .map((t) => t.function?.name ?? ""),
    );
    advertisedTools = merged.filter(
      (t) => controlNames.has(t.function?.name ?? "") || keepNonControl.has(t.function?.name ?? ""),
    );
    if (advertisedTools.length !== allTools.length) {
      log.info(`Control-tool exemption: ${controlTools.map((t) => t.function?.name).join(", ")} always visible`);
    }
  }
  const advertisedNames = new Set(
    advertisedTools.map((t: { function?: { name?: string } }) => t.function?.name ?? ""),
  );
  const deferredCatalog = allTools.filter((t) => !advertisedNames.has((t as { function?: { name?: string } }).function?.name ?? ""));
  const TOOLSEARCH_DEF = makeToolSearchDef();
  // Sub-agent delegation (F17.8): synthetic `Task` tool, executed entirely
  // server-side (fresh conversation + read-only fs tools). Skipped when the
  // client already declares its own Task tool.
  const clientHasTask = allTools.some((t) => (t as { function?: { name?: string } }).function?.name === SUBAGENT_TOOL_NAME);
  const TASK_DEF = subAgentsEnabled() && profile.taskEnabled && !clientHasTask ? makeTaskToolDef() : null;
  const advertiseWithSearch =
    [
      ...advertisedTools,
      ...(deferredCatalog.length > 0 ? [TOOLSEARCH_DEF] : []),
      ...(TASK_DEF ? [TASK_DEF] : []),
    ];

  const hasTools = body.tools && body.tools.length > 0 && body.tool_choice !== "none";
  const model = resolved.canonicalModel;
  const convFingerprint = pool.fingerprintOf(body.messages, resolved.canonicalModel, cb.sessionKey, profile.name);

  const tone = resolved.config.tone;
  const isClaudeTone = /^Claude_/i.test(tone);
  const useToolAgent = !!hasTools && resolved.config.supportsAgent && (process.env.M365_FORCE_AGENT === "1" || !isClaudeTone);

  // Format message: full prompt on first turn, delta on follow-ups.
  // M365 is stateful — it remembers everything from prior turns,
  // so we only need to send new messages after the first turn.
  const isFirstTurn = session.turnCount === 0;
  const convId = session.conversationId;
  let text: string;
  if (isFirstTurn || conv.sentMessageCount === 0) {
    text = formatMessages(body.messages, advertiseWithSearch, body.tool_choice, convId, profile.framing);
    log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=full, cid=${convId}`);
  } else {
    const newMessages = body.messages.slice(conv.sentMessageCount);
    const delta = newMessages.length > 0 ? formatDeltaMessages(newMessages) : "";
    if (delta.length > 0) {
      text = delta;
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, new=${newMessages.length}, turn=${session.turnCount}, mode=delta, cid=${convId}`);
    } else {
      // No meaningful new content to send — nudge M365 to continue.
      text = "Please continue.";
      log.info(`Chat completion: model=${model}, stream=${body.stream}, messages=${body.messages.length}, turn=${session.turnCount}, mode=retry, cid=${convId}`);
    }
  }

  log.debug("Formatted prompt:", trunc(text, 1000));

    // Buffer the full response, with a couple of quick retries on an empty reply.
    // Env-tunable so offline tests (and impatient operators) can zero the delays.
    const MAX_RETRIES = Number(process.env.M365_MAX_EMPTY_RETRIES ?? 2);
    const SHORT_RETRY_DELAY_MS = Number(process.env.M365_EMPTY_RETRY_DELAY_MS ?? 2_000);

  // Captured from the final attempt — surfaced through the OpenAI `usage` block
  // so clients can see M365's conversation-quota % (the closest proxy we have
  // to "context window remaining"). Token counts aren't exposed by M365.
  let lastThrottle: { current: number; max: number } | null = null;
  let lastContentOrigin: string | null | undefined;
  let lastMessageType: string | null | undefined;
let lastScores: Record<string, number> | null | undefined;
let lastTurnCount: number | null | undefined;
let lastThinking: string | null = null;

  // `onDelta` (when provided) forwards each text delta to the caller AS IT ARRIVES,
  // for live incremental streaming. It's safe to forward without ever retracting:
  // runBuffered only retries on an EMPTY attempt (Disengaged, dead-agent, throttle),
  // and an empty attempt emits no deltas — so a forwarded delta always belongs to the
  // one attempt that produced content and is never re-sent by a subsequent retry.
  async function runBuffered(
    onDelta?: (delta: string) => void,
  ): Promise<{ fullText: string } | { error: Response }> {
    let agentRefreshed = false;
    let disengageRetried = false;
    const originalText = text;
    // Self-imposed pacing while the account is degraded (thread-rate throttle). A
    // no-op when healthy; during backoff it sleeps a jittered delay so we stop
    // starting fresh turns into the throttle and let it self-heal (H-R1). This
    // replaced the old auto-reauth, which didn't clear the throttle and raised our
    // detection profile. A single long pi thread never trips the trigger.
    await awaitDegradationBackoff();
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const startTime = performance.now();
      let firstTokenTime: number | null = null;
      let copilotStream;
      try {
        // Every upstream turn goes through the shared TurnGate: bounded inflight
        // turns + staggered NEW-conversation starts (thread-rate throttle guard),
        // AND through the strict FIFO turn queue (AGENTS.md rule #1 enforced:
        // one M365 turn at a time account-wide; disable M365_NO_TURN_QUEUE=1).
        copilotStream = await enqueueTurn(() =>
          pool.turnGate.run(convFingerprint, () =>
            session.run(text, model, cb.signal, useToolAgent, cb.imageAnnotations)));
      } catch (err: any) {
        log.error("Upstream turn failed:", err?.stack ?? err);
        const status = err instanceof M365ProxyError ? err.status : 502;
        const code = err instanceof M365ProxyError ? err.code : "UPSTREAM_ERROR";
        return { error: jsonResponse(status, { error: { message: err.message, type: code.toLowerCase(), code } }) };
      }

      let fullText = "";
      try {
        for await (const delta of copilotStream) {
          if (firstTokenTime === null && delta.length > 0) {
            firstTokenTime = performance.now();
          }
          fullText += delta;
          onDelta?.(delta);
        }
        if (copilotStream.fullText && copilotStream.fullText.length > fullText.length) {
          fullText = copilotStream.fullText;
        }
      } catch (err: any) {
        const status = err instanceof M365ProxyError ? err.status : 502;
        const code = err instanceof M365ProxyError ? err.code : "UPSTREAM_ERROR";
        return { error: jsonResponse(status, { error: { message: err.message, type: code.toLowerCase(), code } }) };
      }

      const totalTime = Math.round(performance.now() - startTime);
      const ttft = firstTokenTime ? Math.round(firstTokenTime - startTime) : null;
      log.info(`Upstream turn latency: total=${totalTime}ms, ttft=${ttft ?? "N/A"}ms, chars=${fullText.length}, model=${model}`);
      recordTurnStat({
        at: Date.now(),
        model,
        totalMs: totalTime,
        ttftMs: ttft,
        chars: fullText.length,
        outcome: fullText.length > 0 ? "ok" : "empty",
        profile: profile.name,
        visibleTools: advertisedTools.length,
        deferredTools: deferredCatalog.length,
        promotedTools: conv.promotedTools?.size ?? 0,
        failoverUsed: depth > 0,
        cancelled: cb.signal?.aborted === true,
      });

      // Image gen (§14): the picture arrives on a GraphicArt frame, usually with NO
      // chat text — so an image turn looks empty to the checks below and would burn
      // a retry. Render the image(s) into the response instead, and (for streaming)
      // emit the markdown as a trailing delta so the client isn't left with nothing.
      const images = copilotStream.images ?? [];
      if (images.length > 0) {
        const imageMd = await renderImagesMarkdown(images);
        if (imageMd) {
          const addition = fullText.length > 0 ? `\n\n${imageMd}` : imageMd;
          fullText += addition;
          onDelta?.(addition);   // stream the appended markdown (text deltas already sent)
        }
      }

      lastThrottle = copilotStream.throttle;
      lastContentOrigin = copilotStream.contentOrigin;
      lastMessageType = copilotStream.messageType;
lastScores = copilotStream.scores;
lastTurnCount = copilotStream.turnCount;
lastThinking = (copilotStream as { thinkingText?: string | null }).thinkingText ?? null;

      if (copilotStream.hasContent || fullText.length > 0) {
        noteRequestOutcome(false, convId); // clean response → degradation has lifted
        toneHealth.recordSuccess(model);
        return { fullText };
      }

      // Classify WHY the turn came back empty (F13/F16.3/F22 signatures) so each
      // class gets its own policy — and tone_outage failures feed the breaker.
      const failureClass = classifyFailure({
        hasContent: false,
        messageType: copilotStream.messageType ?? null,
        throttle: copilotStream.throttle,
        turnState: copilotStream.turnState ?? null,
        elapsedMs: totalTime,
      });
      const withClass = (resp: Response): Response => {
        (resp as unknown as { __m365FailureClass?: FailureClass }).__m365FailureClass = failureClass;
        return resp;
      };

      // Disengaged is a deliberate safety refusal, NOT a transient empty. Retrying
      // it with "Please continue." just disengages again and burns the 600-msg
      // quota (observed: 5 wasted messages in one turn). Fail fast with a clear
      // signal instead. Commonly fires when a heavy tool prompt is paired with a
      // non-default model/agent (e.g. a Claude tone + the declarative agent).
      if (copilotStream.messageType === "Disengaged") {
        // F22: the default framing's override-shape language occasionally trips Azure
        // Prompt Shields (jailbreak classifier) on benign requests (e.g. "replace X
        // with Y, leave everything else unchanged"). Retry ONCE with the low-override
        // `softened` framing in a FRESH conversation (a Disengaged conversation stays
        // Disengaged). Drops the worst-case disengage ~100%→~4%. Off via
        // M365_NO_DISENGAGE_RETRY.
        if (hasTools && !disengageRetried && !process.env.M365_NO_DISENGAGE_RETRY) {
          disengageRetried = true;
          session.newConversation();
          text = formatMessages(body.messages, advertiseWithSearch, body.tool_choice, session.conversationId, "softened");
          log.info("Upstream Disengaged — retrying once with 'softened' framing in a fresh conversation (F22)");
          attempt--; // free retry; bounded — disengageRetried flips once
          continue;
        }
        log.info("Upstream Disengaged — failing fast (no retry) to preserve quota");
        return {
          error: withClass(jsonResponse(502, {
            error: {
              message: "M365 Copilot disengaged from this request (its safety filter declined to answer). Common causes: too many tools, jailbreak-shaped instructions, or pairing a non-default model with the tool agent. Reduce the toolset or use the default model.",
              type: "disengaged",
            },
          })),
        };
      }

      // Empty response. Only an at-limit throttle warrants treating this as rate
      // limiting; otherwise it's a different failure (content filter, an invalid
      // agent/session, a transient upstream error) where a long escalating
      // backoff is futile and reads as a silent hang. Fail fast after a couple of
      // quick retries instead.
      const t = copilotStream.throttle;
      if (t && t.current >= t.max) {
        return { error: withClass(rateLimitResponse(t)) };
      }
      if (attempt < MAX_RETRIES) {
        // A dead/deleted agent returns an instant empty reply (throttle: null).
        // Re-resolve the agent once before retrying so a long-lived host
        // self-heals from the deleted-agent trap instead of looping on empties.
        if (!agentRefreshed) {
          agentRefreshed = true;
          const agentChanged = await session.refreshAgent();
          if (agentChanged) {
            // The cached agent was stale/deleted and has been re-resolved.
            // Resend the original prompt to the fresh agent — a bare "continue"
            // would have no context since the dead agent processed nothing.
            log.info("Agent re-resolved after empty reply, resending original prompt");
            text = originalText;
            await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
            continue;
          }
        }
        log.info(`Empty upstream response, quick retry in ${SHORT_RETRY_DELAY_MS / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, SHORT_RETRY_DELAY_MS));
        text = "Please continue."; // M365 already has context
      } else {
        // Final empty after retries, and not an at-limit (per-conversation) cap:
        // this is the thread-rate throttle signature (F13). Feed the degradation-
        // backoff policy — once empties span enough distinct conversations it paces
        // subsequent turns so the account can self-heal (H-R1). Never blocks this request.
        noteRequestOutcome(true, convId);
        if (failureClass === "tone_outage") toneHealth.recordFailure(model);
        return { error: withClass(emptyResponseResponse(t)) };
      }
    }
    noteRequestOutcome(true, convId);
    return { error: emptyResponseResponse(null) };
  }

  // Tool mode ignores onDelta: the raw text is parsed for tool-call fences and
  // can't be shown verbatim, so its tool_calls (or a prose fallback) are emitted
  // once at the end by whoever renders `produced`.
  async function produce(): Promise<Produced> {
  // When tools are present, buffer full response to detect tool calls
  if (hasTools) {
    // Guarded live-streaming (W-D): forward prose deltas AS THEY ARRIVE so the
    // client sees the preamble immediately, but HOLD BACK once a fence starts —
    // a ``` sequence means the "text" is becoming a tool call, which must be
    // parsed and emitted as tool_use instead. We never retract: only prose that
    // is provably outside any fence is forwarded, with a small holdback window
    // so a fence split across chunk boundaries is still caught.
    let streamed = "";
    let fenceHit = false;
    const HOLD = 12;
    let pending = "";
    // F17.13: models batching many calls sometimes write the NEXT call's header
    // ("Bash\ntimeout: …\ndescription: …") WITHOUT opening backticks. Streaming
    // that leaks tool metadata as visible prose. Detect the signature and freeze
    // forwarding — the parser/fail-closed path owns everything after it.
    const PSEUDO_FENCE = /\n?[A-Za-z_][A-Za-z0-9_]{2,20}\r?\n(?:timeout|description|command|path|file_path|pattern|prompt|query):[^\n]*$/i;
    const guardForward = (delta: string): void => {
      if (fenceHit || !delta) return;
      pending += delta;
      let idx = pending.indexOf("```");
      if (idx === -1) {
        const pseudo = pending.match(PSEUDO_FENCE);
        if (pseudo && pseudo.index !== undefined) idx = pseudo.index;
      }
      if (idx !== -1) fenceHit = true;
      const safeLen = idx === -1 ? pending.length - HOLD : idx;
      if (safeLen > 0) {
        const out = pending.slice(0, safeLen);
        pending = pending.slice(safeLen);
        streamed += out;
        cb.onTextDelta?.(out);
      }
    };
    const result = await runBuffered(guardForward);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    pool.persistConversation(convFingerprint, conv);
    let fullText = result.fullText;

    log.debug("Raw response (tool mode):", trunc(fullText, 1000));
    // Parse against the FULL client-declared catalog (+ our synthetic meta-tools):
    // deferred tools stay executable even though their schemas are hidden from M365,
    // and the synthetic Task tool must parse even when nothing was deferred
    // (e.g. claude-wide with a tiny client catalog).
    const parseTools = deferredCatalog.length > 0 || advertisedTools.length !== allTools.length || TASK_DEF
      ? [...allTools, TOOLSEARCH_DEF, ...(TASK_DEF ? [TASK_DEF] : [])]
      : body.tools;
        let parsed = parseToolCalls(fullText, parseTools);
    log.info(`Parse result: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    // W-A progressive discovery: `ToolSearch` is OUR meta-tool and must never
    // reach the client as a tool_use block. Resolve it against the deferred
    // catalog, promote matches for this conversation, and inject the rendered
    // definitions back into the SAME M365 conversation so the model emits the
    // REAL tool call next — the client only ever sees genuine tools.
    let searchRounds = 0;
    while (parsed.hasToolCalls && searchRounds < 2) {
      const searches = parsed.toolCalls.filter((c) => c.function.name === TOOLSEARCH_TOOL_NAME);
      if (searches.length === 0) break;
      const real = parsed.toolCalls.filter((c) => c.function.name !== TOOLSEARCH_TOOL_NAME);
      let query = "";
      try {
        const args = JSON.parse(searches[searches.length - 1].function.arguments ?? "{}");
        query = String(args.query ?? "");
      } catch { /* unparseable → treat as empty query */ }
      // Models sometimes echo the param name into the body value ("query: x") —
      // harmless to strip before matching.
      query = query.replace(/^query:\s*/i, "").trim();
      const matched = searchDeferredCatalog(deferredCatalog, query, profile.toolSearchLimit);
      if (!conv.promotedTools) conv.promotedTools = new Set();
      for (const t of matched) conv.promotedTools.add(t.function?.name ?? "");
      log.info(`ToolSearch("${trunc(query, 80)}") → promoted ${matched.map((t) => t.function?.name).join(", ") || "(no matches)"}`);
      const resultsBlock = matched.length > 0
        ? formatFencedToolDefinitions(matched as never)
        : "No matching tools. Available catalog keywords: " +
          deferredCatalog.map((t) => t.function?.name).join(", ");
      text =
        `[ToolSearch results for "${query}"] The following tool definitions are NOW AVAILABLE — call them directly with your fenced format in your next reply. They are project tools you declared earlier.\n\n` +
        resultsBlock;
      const r = await runBuffered();
      if ("error" in r) {
        // Discovery round failed upstream: fall through to real-call handling
        // if we already have some, else surface the error.
        if (real.length > 0) { parsed = { hasToolCalls: true, toolCalls: real, textContent: null }; break; }
        return { kind: "error", resp: r.error };
      }
      conv.sentMessageCount = body.messages.length;
      pool.persistConversation(convFingerprint, conv); // injection consumed a turn
      fullText = r.fullText;
      searchRounds += 1;
      parsed = parseToolCalls(fullText, [...allTools, TOOLSEARCH_DEF, ...(TASK_DEF ? [TASK_DEF] : [])]);
      log.info(`After ToolSearch round ${searchRounds}: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // F17.8 sub-agent delegation: `Task` calls are executed ENTIRELY server-side
    // (dedicated conversation + read-only fs tools) and their reports injected
    // back here — the client never sees a Task tool_use. Bounded by
    // M365_SUBAGENT_TURNS (default 6); disabled via M365_NO_SUBAGENTS=1.
    let taskRounds = 0;
    while (parsed.hasToolCalls && taskRounds < 4 && TASK_DEF) {
      const tasks = parsed.toolCalls.filter((c) => c.function.name === SUBAGENT_TOOL_NAME);
      if (tasks.length === 0) break;
      const others = parsed.toolCalls.filter((c) => c.function.name !== SUBAGENT_TOOL_NAME);
      const results: string[] = [];
      // SEQUENTIAL sub-agent execution (AGENTS.md rule #1): each synthetic Task
      // turn goes through the same account-wide FIFO queue as normal turns —
      // the old Promise.all here could run two M365 turns at once. Remaining
      // queued jobs are abandoned the moment the caller cancels.
      const runTask = async (idx: number, t: any): Promise<string> => {
        if (cb.signal?.aborted) return "(cancelled before start)";
        const job = extractSubAgentJob(t.function?.arguments);
        log.info(`Sub-agent delegating [${idx + 1}/${tasks.length}]: "${trunc(job, 100)}"`);
        const subMessages = [{ role: "user" as const, content: `subagent:${trunc(job, 60)}:${taskRounds}:${idx}` }];
        const sub = pool.resolve(subMessages, `${model}-subagent`);
        try {
          return await enqueueTurn(() =>
            pool.turnGate.run(`sub:${convFingerprint}:${taskRounds}:${idx}`, () =>
              runSubAgent(sub.session, model, job, cb.signal)));
        } catch (err: any) {
          return `(sub-agent failed: ${err?.message ?? "unknown"})`;
        }
      };
      for (let i = 0; i < tasks.length; i++) {
        results.push(`<sub-agent report>\n${await runTask(i, tasks[i])}\n</sub-agent report>`);
      }
      text =
        `[Automated harness message: ${results.length} sub-agent job(s) completed — their reports follow. ` +
        `Use them to continue; do not re-delegate the same jobs.]\n\n` +
        results.join("\n\n");
      const r = await runBuffered();
      if ("error" in r) {
        if (others.length > 0) { parsed = { hasToolCalls: true, toolCalls: others, textContent: null }; break; }
        return { kind: "error", resp: r.error };
      }
      conv.sentMessageCount = body.messages.length;
      pool.persistConversation(convFingerprint, conv);
      fullText = r.fullText;
      taskRounds += 1;
      parsed = parseToolCalls(fullText, parseTools);
      log.info(`After Task round ${taskRounds}: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Salvage stochastic turn-1 confabulation: M365's chat model sometimes claims it
    // "can't access the files / commands return no output" and asks the user to paste
    // them, WITHOUT calling a tool — even though the environment is real (the bench +
    // pi both reproduce this). Re-prompt forcefully in the SAME conversation (one
    // thread, cheap). Disable with M365_NO_CONFAB_RETRY; tune count with M365_CONFAB_RETRIES.
    const maxConfabRetries = process.env.M365_NO_CONFAB_RETRY
      ? 0
      : Number(process.env.M365_CONFAB_RETRIES ?? 2);
    // The model never actually acted if no assistant turn in the history carried a
    // tool call. Used to gate the hallucinated-completion retry (a model that did
    // real work called at least one tool), keeping false positives near zero.
    const everActed = (body.messages ?? []).some(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    for (let attempt = 0; attempt < maxConfabRetries && !parsed.hasToolCalls; attempt++) {
      const confab = looksLikeConfabulation(parsed.textContent);
      const halluc = !everActed && looksLikeHallucinatedCompletion(parsed.textContent);
      if (!confab && !halluc) break;

      // On a first-turn false refusal, do not spend another scarce M365 message
      // merely telling the model that the filesystem exists. Return a safe local
      // orientation call instead. Once its real output comes back, the next turn
      // has concrete evidence and the model can continue the original task.
      if (confab) {
        const orientationCall = makeOrientationToolCall(body);
        if (orientationCall) {
          log.info("Confabulation detected — returning a read-only orientation tool call");
          parsed = { hasToolCalls: true, toolCalls: [orientationCall], textContent: null };
          break;
        }
      }

      log.info(`${confab ? "Confabulation" : "Hallucinated completion"} detected (no tool call) — forcing retry ${attempt + 1}/${maxConfabRetries}`);
      text = confab ? CONFAB_FORCE_PROMPT : HALLUCINATION_FORCE_PROMPT;
      const retry = await runBuffered();
      if ("error" in retry) return { kind: "error", resp: retry.error };
      conv.sentMessageCount = body.messages.length;
      pool.persistConversation(convFingerprint, conv);
      fullText = retry.fullText;
      parsed = parseToolCalls(fullText, parseTools);
      log.info(`After forcing retry: hasToolCalls=${parsed.hasToolCalls}, count=${parsed.toolCalls.length}`);
    }

    // Document guard: the shell-routing parser turns every ```bash block into a
    // tool call, so a model that ANSWERS with a markdown document full of code
    // fences (e.g. "here's a simplified README") would get its own answer executed
    // as shell. Detect that shape (multiple fences + prose) and return the document
    // as plain text instead of running it. See isProseDocument (chosen empirically).
    if (isProseDocument(parsed)) {
      log.info(`Response is a prose document (${parsed.toolCalls.length} embedded fences), returning as text instead of executing`);
      parsed = { hasToolCalls: false, toolCalls: [], textContent: fullText };
    }

    // Fail-closed: if model mixed text with tool calls, strip text and re-prompt once.
    // This enforces the "output ONLY a tool call" contract.
    if (parsed.hasToolCalls && parsed.textContent) {
      const extraText = parsed.textContent.trim();
      if (extraText.length > 0) {
        log.info(`Mixed output detected (${extraText.length} chars of text alongside ${parsed.toolCalls.length} tool calls), stripping text`);
        // Strip the text — the tool calls are what the client needs.
        // Log the stripped text for debugging but don't send it downstream.
        log.debug("Stripped text:", trunc(extraText, 500));
        parsed = { ...parsed, textContent: null };
      }
    }

    // Handle "reply" tool calls — convert to plain text
    if (parsed.hasToolCalls) {
      const replyCall = parsed.toolCalls.find(tc => tc.function.name === "reply");
      const realToolCalls = parsed.toolCalls.filter(tc => tc.function.name !== "reply");

      if (replyCall && realToolCalls.length === 0) {
        let replyText: string;
        try {
          const args = JSON.parse(replyCall.function.arguments);
          replyText = args.text || args.message || args.content || fullText;
        } catch {
          replyText = fullText;
        }
        log.info("Reply tool detected, converting to text response");
        return { kind: "text", text: replyText };
      }

      if (realToolCalls.length > 0) {
        parsed.toolCalls = realToolCalls;
      }

      // Batched tool calls: ON by default now that read-only gather turns
      // (/doctor-style "run these 7 checks in one shot") are a primary use —
      // forcing one-call-per-turn made such turns parse-fail or leak fences.
      // Calls execute sequentially client-side; each reacts to the previous
      // tool_response. Disable with M365_NO_MULTI_TOOL=1.
      if (
        (process.env.M365_NO_MULTI_TOOL === "1" || !profile.multiTool || cb.forceSingleToolUse === true)
        && parsed.toolCalls.length > 1
      ) {
        log.info(`One-call-per-turn (M365_NO_MULTI_TOOL): keeping ${parsed.toolCalls[0].function.name}, dropping ${parsed.toolCalls.length - 1} batched call(s)`);
        parsed.toolCalls = [parsed.toolCalls[0]];
      }
    }

    if (parsed.hasToolCalls && parsed.toolCalls.length > 0) {
      // Repair mechanically-broken bash (CRLF, unterminated heredoc) before the
      // client executes it; unbalanced quotes stay advisory via the lint below.
      const repairs = repairBashCommands(parsed.toolCalls);
      if (repairs > 0) log.info(`Repaired ${repairs} bash command(s) (CRLF/heredoc)`);

      const validatedCalls = [];
      for (const call of parsed.toolCalls) {
        const checked = toolRegistry.validateAndRepair(call);
        if (!checked.ok) {
          log.warn(`Rejected invalid tool call ${call.function.name}: ${checked.message}`);
          return {
            kind: "error",
            resp: jsonResponse(422, {
              error: {
                message: [checked.message, ...(checked.errors ?? [])].join(" "),
                type: "invalid_request_error",
                code: "PROXY_TOOL_SCHEMA_ERROR",
              },
            }),
          };
        }
        if (checked.repaired) {
          log.info(`Conservatively repaired ${call.function.name} arguments: ${checked.repairs.join(", ")}`);
        }
        validatedCalls.push(checked.call);
      }
      parsed.toolCalls = validatedCalls;

      // Pre-flight lint (advisory, never blocking): flag bash commands with
      // likely-unbalanced quotes or unterminated heredocs so the client-side
      // failure is self-explanatory instead of mysterious.
      const lintNotes: string[] = [];
      parsed.toolCalls.forEach((tc: { function?: { name?: string; arguments?: string } }, i: number) => {
        if ((tc.function?.name ?? "") !== "bash") return;
        let cmd = "";
        try { cmd = String(JSON.parse(tc.function?.arguments ?? "{}").command ?? ""); } catch {}
        const singles = (cmd.match(/(?<!\\)'/g) ?? []).length;
        if (singles % 2 === 1) lintNotes.push(`call #${i + 1}: odd number of single quotes — check quoting around paths with spaces`);
        if (/<<-?\s*['"]?(\w+)/.test(cmd)) {
          const tag = cmd.match(/<<-?\s*['"]?(\w+)/)![1];
          if (!new RegExp(`^\\s*${tag}\\s*$`, "m").test(cmd)) lintNotes.push(`call #${i + 1}: heredoc '${tag}' is never terminated (missing line: ${tag})`);
        }
      });
      if (lintNotes.length > 0) {
        log.info(`Pre-flight bash lint: ${lintNotes.join(" | ")}`);
      }
      // Carried prose = the RAW pre-fence slice of the final text (a superset of
      // what the guard already streamed). Renderers emit only the un-streamed
      // remainder, so the holdback tail arrives as a tiny closing delta.
      const fenceIdx = fullText.indexOf("```");
      const proseRaw = fenceIdx > 0 ? fullText.slice(0, fenceIdx) : undefined;
      const carriedText = proseRaw ?? (streamed.length > 0 ? streamed : undefined);
      const carriedWithLint = lintNotes.length > 0
        ? [carriedText, `[pre-flight notice] ${lintNotes.join("; ")} — if execution fails, this is why.`].filter(Boolean).join("\n")
        : carriedText;
      return { kind: "tools", toolCalls: parsed.toolCalls, text: carriedWithLint || undefined, thinking: lastThinking ?? undefined };
    }
    return { kind: "text", text: fullText.trim() || "", thinking: lastThinking ?? undefined };
  } else {
    // No tools — stream deltas live (onDelta) while buffering for the retry logic.
    const result = await runBuffered(cb.onTextDelta);
    if ("error" in result) return { kind: "error", resp: result.error };
    conv.sentMessageCount = body.messages.length;
    pool.persistConversation(convFingerprint, conv);
    return { kind: "text", text: result.fullText.trim() || "", thinking: lastThinking ?? undefined };
  }
  } // end produce()

  let produced = await produce();
  // Inline tone failover (W-C): a classified upstream tone-pool outage gets ONE
  // transparent retry on a healthy fallback model (new conversation). Throttle
  // and disengage errors never failover — backoff / fresh-framing own those.
  if (produced.kind === "error" && depth < 1 && failoverEnabled()) {
    const cls = (produced.resp as unknown as { __m365FailureClass?: FailureClass }).__m365FailureClass;
    const alt = cls === "tone_outage" ? nextHealthyFallback(model) : null;
    if (alt) {
      log.warn(`Tone ${model} in outage (${cls}) — inline failover to ${alt} on a fresh conversation`);
      toneHealth.recordFailure(model);
      return produceCompletion({ ...body, model: alt }, pool, cb, depth + 1);
    }
  }
  return {
    produced,
    usage: buildUsage(lastThrottle, lastContentOrigin, lastMessageType, lastScores, lastTurnCount),
  };
}

/**
 * Repair mechanically-broken bash tool calls IN PLACE before the client
 * executes them. Two safe, deterministic fixes for failures observed with
 * Windows/Git-Bash harnesses:
 *   1. CRLF → LF: M365 emits \r\n; a \r inside a multi-line command or a heredoc
 *      terminator makes bash fail with "unexpected EOF while looking for
 *      matching `'" (the model's script was fine — the bytes weren't).
 *   2. Unterminated heredoc: append the missing terminator line.
 * Unbalanced quotes are NOT touched — they can't be fixed without risking
 * semantic changes to the command. Returns the number of calls repaired.
 */
export function repairBashCommands(
  toolCalls: { function?: { name?: string; arguments?: string } }[],
): number {
  let repairs = 0;
  for (const tc of toolCalls) {
    if ((tc.function?.name ?? "").toLowerCase() !== "bash") continue;
    let args: Record<string, unknown>;
    try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { continue; }
    const cmd = args.command;
    if (typeof cmd !== "string") continue;
    let fixed = cmd.replace(/\r\n?/g, "\n");
    const heredoc = fixed.match(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n/);
    if (heredoc && !new RegExp(`^\\s*${heredoc[1]}\\s*$`, "m").test(fixed.slice(fixed.indexOf(heredoc[0]) + heredoc[0].length))) {
      fixed = `${fixed.endsWith("\n") ? fixed : fixed + "\n"}${heredoc[1]}\n`;
    }
    if (fixed !== cmd) {
      repairs++;
      args.command = fixed;
      tc.function!.arguments = JSON.stringify(args);
    }
  }
  return repairs;
}

/** True when the request carries an executable toolset (mirrors produceCompletion's rule). */
export function requestHasTools(body: z.infer<typeof ChatCompletionRequest>): boolean {
  return !!body.tools && body.tools.length > 0 && body.tool_choice !== "none";
}

/**
 * Handle a chat completion request, returning an OpenAI-compatible Response.
 * Thin protocol renderer over produceCompletion.
 */
export async function handleChatCompletion(
  body: ChatBody,
  pool: SessionPool,
  opts: { signal?: AbortSignal; systemPromptSpec?: string; sessionKey?: string; profile?: string } = {},
): Promise<Response> {
  const completionId = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  // Generic OpenAI-upstream mode (OPENAI_UPSTREAM_BASE_URL set): bypass M365
  // entirely and reverse-proxy the request to the configured backend.
  if (upstreamEnabled()) return handleUpstreamChat(body);

  // Streaming: send HTTP 200 + a role chunk + keepalive comments from t=0, then run
  // produceCompletion INSIDE the stream so the client never waits out the whole M365
  // turn (up to ~160s) before the first byte — avoids client read-timeouts.
  //
  // On the non-tool path we forward each text delta AS IT ARRIVES (`liveDelta`), so
  // `stream:true` is genuinely incremental. Tool mode still buffers: the raw text is
  // parsed for tool-call fences and can't be shown verbatim, so its tool_calls (or a
  // prose fallback) are emitted once at the end.
  if (body.stream) {
    const hasTools = requestHasTools(body);
    return sseResponse(new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
        const base = { id: completionId, object: "chat.completion.chunk", created, model: body.model };
        send({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
        const hb = setInterval(() => { try { controller.enqueue(enc.encode(": keepalive\n\n")); } catch {} }, 15000);

        // Live token passthrough. In TOOL mode the guarded forwarder in produce()
        // only lets PROSE through (never fence bytes), so streaming content here
        // is safe — the tool_calls are emitted after the turn completes.
        let sent = "";
        const liveDelta = (delta: string) => {
          if (!delta) return;
          sent += delta;
          try { send({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] }); } catch {}
        };

        let p: Produced;
        let streamUsage: Record<string, unknown> | null = null;
        try {
          ({ produced: p, usage: streamUsage } = await produceCompletion(body, pool, { signal: opts.signal, systemPromptSpec: opts.systemPromptSpec, sessionKey: opts.sessionKey, profile: opts.profile, onTextDelta: liveDelta }));
        } catch (err: any) {
          console.error("[produce error stream]", err.stack || err);
          p = { kind: "error", resp: jsonResponse(502, { error: { message: err?.message ?? "stream error", type: "upstream_error" } }) };
        }
        clearInterval(hb);
        try {
          if (p.kind === "error") {
            let message = "upstream error";
            try { message = (JSON.parse(await p.resp.text())?.error?.message) || message; } catch {}
            // HTTP 200 is already committed, so surface the failure as an in-stream error chunk.
            send({ ...base, error: { message, type: "upstream_error" } });
          } else if (p.kind === "tools") {
            // Emit any not-yet-streamed prose remainder, then the calls.
            const carried = p.text ?? "";
            if (carried.startsWith(sent) && carried.length > sent.length) {
              send({ ...base, choices: [{ index: 0, delta: { content: carried.slice(sent.length) }, finish_reason: null }] });
            }
            if (p.thinking && !sent.includes(p.thinking.slice(0, 40))) {
              send({ ...base, choices: [{ index: 0, delta: { reasoning_content: p.thinking }, finish_reason: null }] });
            }
            p.toolCalls.forEach((tc, i) =>
              send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }] }));
            send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          } else {
            const finalText = p.text ?? "";
            const remainder = finalText.startsWith(sent) ? finalText.slice(sent.length) : "";
            if (!finalText.startsWith(sent)) log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${finalText.length} chars) — not re-sending to avoid duplication`);
            if (remainder) send({ ...base, choices: [{ index: 0, delta: { content: remainder }, finish_reason: null }] });
            send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: outputFinishReason(finalText) }] });
          }
          // OpenAI spec: with stream_options.include_usage, a final chunk with
          // empty choices and the usage object precedes [DONE].
          if (body.stream_options?.include_usage && streamUsage) {
            send({ id: completionId, object: "chat.completion.chunk", created, model: body.model, choices: [], usage: streamUsage });
          }
        } catch {
          // client likely disconnected mid-emit — nothing more to do
        } finally {
          try { controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close(); } catch {}
        }
      },
    }));
  }

  // Non-stream: one buffered turn, rendered as a chat.completion JSON body.
  let result: Awaited<ReturnType<typeof produceCompletion>>;
  try {
    result = await produceCompletion(body, pool, { signal: opts.signal, systemPromptSpec: opts.systemPromptSpec, sessionKey: opts.sessionKey, profile: opts.profile });
  } catch (err: any) {
    console.error("[produce error non-stream]", err.stack || err);
    const status = err instanceof M365ProxyError ? err.status : 502;
    const code = err instanceof M365ProxyError ? err.code : "UPSTREAM_ERROR";
    return jsonResponse(status, { error: { message: err?.message ?? "upstream error", type: code.toLowerCase(), code } });
  }
  const p = result.produced;

  if (p.kind === "error") return p.resp;
  if (p.kind === "tools") {
    return jsonResponse(200, {
      id: completionId, object: "chat.completion", created, model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: p.text ?? null, ...(p.thinking ? { reasoning_content: p.thinking } : {}), tool_calls: p.toolCalls }, finish_reason: "tool_calls" }],
      usage: result.usage,
    });
  }
  return jsonResponse(200, {
    id: completionId, object: "chat.completion", created, model: body.model,
    choices: [{ index: 0, message: { role: "assistant", content: p.text, ...(p.thinking ? { reasoning_content: p.thinking } : {}) }, finish_reason: outputFinishReason(p.text) }],
    usage: result.usage,
  });
}

/**
 * Build the OpenAI-style `usage` block from whatever diagnostic info M365 gave
 * us. Token counts are NOT exposed by M365's WebSocket API (we'd need to count
 * locally with a tokenizer that matches the underlying model — see the doc on
 * token-usage hypotheses). What M365 does send is a **conversation quota**:
 * how many user messages out of the 600-per-conversation cap have been spent.
 *
 * That's a different axis from token-window utilisation, but it's the closest
 * thing we have to "remaining budget", so we surface it as extension fields
 * (`x_m365_*`) alongside the zeroed standard counters. Real OpenAI clients
 * ignore unknown extension fields; curious users can read them.
 */
export function buildUsage(
  throttle: { current: number; max: number } | null,
  contentOrigin?: string | null,
  messageType?: string | null,
  scores?: Record<string, number> | null,
  turnCount?: number | null,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  if (throttle) {
    base.x_m365_conversation_messages = throttle.current;
    base.x_m365_conversation_max = throttle.max;
    base.x_m365_conversation_pct = Math.min(100, Math.round((throttle.current / throttle.max) * 100));
    base.x_m365_conversation_remaining = Math.max(0, throttle.max - throttle.current);
  }
  if (contentOrigin) base.x_m365_content_origin = contentOrigin;
  if (messageType) base.x_m365_message_type = messageType;
  if (typeof turnCount === "number") base.x_m365_turn_count = turnCount;
  // Disengaged-classifier scores. Empirically: clean tool calls sit at
  // ~1e-13 / ~1e-8, jailbreak-shaped prompts climb to ~1e-3 / ~1e-3. The
  // `dea_violation` component is the one that actually correlates with the
  // Disengaged filter firing — surface that explicitly so clients can monitor
  // their proximity to the threshold.
  if (scores) {
    base.x_m365_classifier_scores = scores;
    if (typeof scores.dea_violation === "number") base.x_m365_dea_score = scores.dea_violation;
    if (typeof scores.BotOffense === "number") base.x_m365_offense_score = scores.BotOffense;
  }
  return base;
}

// --- Helpers ---

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

function rateLimitMessage(throttle: { current: number; max: number } | null): string {
  return throttle
    ? `M365 Copilot rate limited (${throttle.current}/${throttle.max} messages used). Please wait and try again.`
    : "M365 Copilot returned an empty response. You may be rate limited. Please wait and try again.";
}

function rateLimitResponse(throttle: { current: number; max: number } | null): Response {
  return jsonResponse(429, { error: { message: rateLimitMessage(throttle), type: "rate_limit_error" } });
}

/** Empty upstream reply that is NOT an at-limit throttle — a distinct failure
 *  (content filter, invalid agent/session, transient error) we surface clearly
 *  instead of hanging on a long retry loop. */
function emptyResponseResponse(throttle: { current: number; max: number } | null): Response {
  const detail = throttle ? ` (throttle ${throttle.current}/${throttle.max})` : "";
  return jsonResponse(502, {
    error: {
      message: `M365 Copilot returned an empty response${detail} — likely a content filter, an invalid agent/session, or a transient upstream error.`,
      type: "upstream_empty_response",
    },
  });
}

// (streaming is emitted inline by the early-flushed SSE renderer in
// handleChatCompletion; the old streamText/streamToolCalls helpers were removed.)
