import { z } from "zod/v4";
import {
  getAvailableModels,
  resolveModel,
  getModelDefinition,
  extractAnthropicImages,
  uploadImageToSubstrate,
  getToken,
  type InputImage,
  type UploadedImageAnnotation,
  type ModelDefinition,
  createLogger,
} from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { handleChatCompletion, produceCompletion, outputFinishReason, type SessionPool } from "./handler.js";
import { upstreamEnabled, handleUpstreamMessages } from "./upstream.js";

const log = createLogger("anthropic");

const TextBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
}).passthrough();

const ToolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional().default({}),
}).passthrough();

const ToolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown().optional().default(""),
  is_error: z.boolean().optional(),
}).passthrough();

const ImageBlock = z.object({
  type: z.literal("image"),
  source: z.object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  }).passthrough(),
}).passthrough();

const IgnoredBlock = z.object({ type: z.string() }).passthrough();
const ContentBlock = z.union([TextBlock, ToolUseBlock, ToolResultBlock, ImageBlock, IgnoredBlock]);

const AnthropicMessage = z.object({
  // Accept 'system' role in the messages array — some clients (Cursor, older Claude Code)
  // send system instructions as a message rather than in the top-level `system` field.
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ContentBlock)]),
});

const AnthropicTool = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.unknown().optional(),
}).passthrough();

const AnthropicToolChoice = z.union([
  z.object({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().optional() }),
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("tool"), name: z.string(), disable_parallel_tool_use: z.boolean().optional() }),
]);

export const AnthropicMessagesRequest = z.object({
  model: z.string().min(1),
  max_tokens: z.number().int().positive().optional().default(8192),
  messages: z.array(AnthropicMessage).min(1),
  system: z.union([z.string(), z.array(TextBlock)]).optional(),
  tools: z.array(AnthropicTool).optional(),
  tool_choice: AnthropicToolChoice.optional(),
  stream: z.boolean().optional().default(false),
  temperature: z.number().optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.unknown().optional(),
}).passthrough();

export type AnthropicBody = z.infer<typeof AnthropicMessagesRequest>;

type OpenAIMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        // Image blocks inside tool_result content: never silently drop them —
        // the model must at least know an attachment existed.
        if (item && typeof item === "object" && (item as { type?: string }).type === "image") {
          const src = (item as { source?: { media_type?: string; data?: string } }).source ?? {};
          const bytes = typeof src.data === "string" ? Math.round(src.data.length * 0.75) : 0;
          return `[IMAGE ATTACHED: ${src.media_type ?? "unknown"}${bytes ? `, ~${bytes} bytes` : ""} — vision is not supported by this backend]`;
        }
        if (item && typeof item === "object" && (item as { type?: string }).type === "document") {
          const src = (item as { source?: { media_type?: string; data?: string } }).source ?? {};
          const bytes = typeof src.data === "string" ? Math.round(src.data.length * 0.75) : 0;
          return `[DOCUMENT ATTACHED: ${src.media_type ?? "application/pdf"}${bytes ? `, ~${bytes} bytes` : ""} — content not interpreted]`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function systemText(system: AnthropicBody["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((block: any) => (typeof block === "string" ? block : block?.text ?? ""))
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof system === "object" && system !== null) {
    const s = system as any;
    if (typeof s.text === "string") return s.text;
    try { return JSON.stringify(system); } catch { return String(system); }
  }
  return String(system);
}

export function anthropicMessagesToOpenAI(body: AnthropicBody): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  // Collect system content from both the top-level `system` field and any
  // system-role messages in the messages array (sent by Cursor / older clients).
  const systemParts: string[] = [];
  const topLevel = systemText(body.system);
  if (topLevel) systemParts.push(topLevel);

  // Extract system-role messages so they don't pollute the turn array.
  const nonSystemMessages = body.messages.filter((m) => {
    if ((m as any).role === "system") {
      const text = typeof m.content === "string" ? m.content : textFromUnknown(m.content);
      if (text) systemParts.push(text);
      return false;
    }
    return true;
  });

  const combinedSystem = systemParts.join("\n\n");
  if (combinedSystem) messages.push({ role: "system", content: combinedSystem });

  for (const message of nonSystemMessages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          const t = (block as z.infer<typeof TextBlock>).text;
          if (t) textParts.push(t);
        } else if (block.type === "tool_use") {
          const tb = block as z.infer<typeof ToolUseBlock>;
          toolCalls.push({
            id: tb.id,
            type: "function" as const,
            function: { name: tb.name, arguments: JSON.stringify(tb.input ?? {}) },
          });
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          // Claude Code replays prior thinking blocks verbatim; OpenAI-format
          // upstreams have no slot for them. Preserve the reasoning CONTEXT as a
          // lossy text marker instead of dropping it silently.
          const think = block as { type: string; thinking?: string; data?: string };
          const body = think.thinking ?? "[reasoning withheld]";
          textParts.push(`[previous reasoning (${block.type})]: ${body.slice(0, 2000)}`);
        }
        // Unknown block types: tolerated + dropped (IgnoredBlock catch-all).
      }
      const text = textParts.join("\n");
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    let pendingText: string[] = [];
    const flushText = () => {
      if (pendingText.length) {
        messages.push({ role: "user", content: pendingText.join("\n") });
        pendingText = [];
      }
    };
    for (const block of message.content) {
      if (block.type === "text") {
        pendingText.push(block.text);
      } else if ((block as { type?: string }).type === "image") {
        // Keep the placeholder ADJACENT to its question: push into pendingText
        // instead of flushing, so text+attachment travel as one user message.
        const src = (block as { source?: { media_type?: string; data?: string } }).source ?? {};
        const bytes = typeof src.data === "string" ? Math.round(src.data.length * 0.75) : 0;
        pendingText.push(
          `[IMAGE ATTACHED: ${src.media_type ?? "unknown"}${bytes ? `, ~${bytes} bytes` : ""} — vision is not supported by this backend]`,
        );
      } else if ((block as { type?: string }).type === "document") {
        const src = (block as { source?: { media_type?: string; data?: string } }).source ?? {};
        const bytes = typeof src.data === "string" ? Math.round(src.data.length * 0.75) : 0;
        pendingText.push(
          `[DOCUMENT ATTACHED: ${src.media_type ?? "application/pdf"}${bytes ? `, ~${bytes} bytes` : ""} — document content was not interpreted by this backend]`,
        );
      } else if ((block as { source?: unknown }).source && block.type !== "text") {
        // Unknown future content-block kinds that carry binary sources.
        const bType = (block as { type?: string }).type ?? "unknown";
        const src = (block as { source?: { media_type?: string; data?: string } }).source ?? {};
        const bytes = typeof src.data === "string" ? Math.round(src.data.length * 0.75) : 0;
        pendingText.push(
          `[ATTACHMENT NOT INTERPRETED: type=${bType}${src.media_type ? `, ${src.media_type}` : ""}${bytes ? `, ~${bytes} bytes` : ""}]`,
        );
      } else if (block.type === "tool_result") {
        flushText();
        const result = textFromUnknown(block.content);
        // Orphan guard: OpenAI backends 400 when a `tool` message has no
        // preceding assistant tool_call (e.g. history was trimmed). Synthesize
        // a stub assistant turn so the pair stays valid.
        const prev = messages[messages.length - 1];
        const prevCalls = prev?.role === "assistant" ? (prev as { tool_calls?: Array<{ id: string }> }).tool_calls : undefined;
        if (!prevCalls?.some((c) => c.id === block.tool_use_id)) {
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: [{
              id: block.tool_use_id,
              type: "function" as const,
              function: { name: "unknown_tool", arguments: "{}" },
            }],
          });
        }
        messages.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: block.is_error ? `[tool error]\n${result}` : result,
        });
      }
    }
    flushText();
    if (message.content.length === 0) messages.push({ role: "user", content: "" });
  }

  return messages;
}

function mapToolChoice(choice: AnthropicBody["tool_choice"]) {
  if (!choice || choice.type === "auto") return "auto" as const;
  if (choice.type === "any") return "required" as const;
  if (choice.type === "none") return "none" as const;
  return { type: "function" as const, function: { name: choice.name } };
}

/**
 * Anthropic's `tool_choice.disable_parallel_tool_use` translated into proxy
 * terms: strict one-tool-per-turn for THIS request, overriding profile/env
 * batching defaults. Exported so both protocol paths (and tests) share it.
 */
export function requestsSingleToolUse(body: AnthropicBody): boolean {
  if (!body.tools?.length) return false;
  const choice = body.tool_choice as { disable_parallel_tool_use?: boolean; type?: string } | undefined;
  if (!choice || choice.type === "none") return false;
  return choice.disable_parallel_tool_use === true;
}

/**
 * Claude Code's /model picker sends Anthropic model names or custom model aliases.
 * Resolve against our centralized capability-aware model registry.
 *
 * Two cases are surfaced rather than resolved silently, because both change
 * which model the caller is actually talking to: an unresolvable request
 * falling back to a default, and a resolved alias (e.g. any "haiku" name)
 * that maps to a materially different canonical model. `console.warn` here
 * (not the M365_DEBUG-gated logger) is deliberate — this is a correctness/
 * honesty signal an operator should see by default, matching the mission's
 * "never silently tell the user they're on a different model" requirement.
 */
export function resolveM365Model(requested: string): string {
  try {
    const resolved = resolveModel(requested);
    for (const warning of resolved.warnings) {
      log.warn(`Model resolution warning: ${warning}`);
      console.warn(`[anthropic] ${warning}`);
    }
    return resolved.canonicalModel;
  } catch (err) {
    const fallback = process.env.M365_CLAUDE_CODE_MODEL ?? "gpt-5.5";
    const reason = err instanceof Error ? err.message : String(err);
    log.warn(`Unresolvable model "${requested}" (${reason}) — falling back to "${fallback}".`);
    console.warn(
      `[anthropic] Unresolvable model "${requested}" — falling back to "${fallback}". ` +
        `Set M365_CLAUDE_CODE_MODEL to override, or use an exact M365 model id from GET /v1/models.`,
    );
    return fallback;
  }
}

/** Translate Claude's Messages API request into the proxy's OpenAI Chat request. */
export function toOpenAIChatRequest(body: AnthropicBody) {
  return ChatCompletionRequest.parse({
    model: resolveM365Model(body.model),
    messages: anthropicMessagesToOpenAI(body),
    stream: false,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    stop: (body as any).stop_sequences,
    tools: body.tools?.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    })),
    tool_choice: body.tools?.length ? mapToolChoice(body.tool_choice) : undefined,
  });
}

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string; signature: string };

export interface AnthropicMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContent[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  /** M365 diagnostics (conversation quota %, classifier scores) as extension data. */
  m365?: Record<string, unknown>;
}

function parseToolInput(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return {}; }
}

/** Translate one completed OpenAI response into Anthropic Messages format. */
export function fromOpenAIChatResponse(payload: any, requestedModel: string): AnthropicMessageResponse {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const content: AnthropicContent[] = [];

  if (typeof message.content === "string" && message.content.trim().length > 0) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (typeof item === "string" && item.trim().length > 0) {
        content.push({ type: "text", text: item });
      } else if (item && typeof item === "object") {
        if (item.type === "text" && typeof item.text === "string" && item.text.trim().length > 0) {
          content.push({ type: "text", text: item.text });
        } else if (item.type === "tool_use") {
          content.push(item);
        }
      }
    }
  }

  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: String(call.id),
      name: String(call.function?.name ?? "unknown"),
      input: parseToolInput(String(call.function?.arguments ?? "{}")),
    });
  }

  if (content.length === 0) content.push({ type: "text", text: "Okay." });

  const finish = choice.finish_reason;
  const stopReason = finish === "tool_calls"
    ? "tool_use"
    : finish === "length" ? "max_tokens" : "end_turn";
  return {
    id: String(payload?.id ?? `msg_${crypto.randomUUID().replace(/-/g, "")}`),
    type: "message",
    role: "assistant",
    model: String(payload?.model ?? requestedModel),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Number(payload?.usage?.prompt_tokens ?? 0),
      output_tokens: Number(payload?.usage?.completion_tokens ?? 0),
    },
  };
}

function anthropicError(status: number, message: string, type = "api_error", code?: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message, ...(code ? { code } : {}) } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const DISENGAGED_EXPLANATION =
  "M365 Copilot declined this request (its safety filter engaged). Rephrase the task, reduce the attached tools or context, or switch to the default model - then retry.";

/** A normal assistant turn explaining a Disengage — no scary protocol error for the user. */
function disengagedTurn(model: string): AnthropicMessageResponse {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: DISENGAGED_EXPLANATION }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: estimateOutputTokens(DISENGAGED_EXPLANATION) },
  };
}

async function errorPayload(resp: Response): Promise<{ type?: string; message?: string; code?: string } | null> {
  try {
    const parsed = (await resp.json()) as { error?: { type?: string; message?: string; code?: string } };
    return parsed?.error ?? null;
  } catch {
    return null;
  }
}

function anthropicErrorFromPayload(
  status: number,
  payload: { type?: string; message?: string; code?: string } | null,
): Response {
  let message = `M365 upstream returned HTTP ${status}`;
  let upstreamType = "upstream_error";
  if (payload) {
    message = payload.message ?? message;
    upstreamType = payload.type ?? upstreamType;
  }
  const nonRetryable = upstreamType === "upstream_empty_response" || upstreamType === "disengaged";
  const mappedStatus = nonRetryable ? 400 : status;
  const type = nonRetryable
    ? "invalid_request_error"
    : status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404
          ? "not_found_error"
          : status === 429
            ? "rate_limit_error"
            : "api_error";
  return anthropicError(mappedStatus, message, type, payload?.code);
}

function event(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Render a completed Anthropic message as a standards-shaped SSE event stream. */
export function anthropicSse(message: AnthropicMessageResponse): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      const send = (name: string, data: unknown) => controller.enqueue(encoder.encode(event(name, data)));
      send("message_start", {
        type: "message_start",
        message: { ...message, content: [], stop_reason: null, stop_sequence: null },
      });
      (message?.content ?? []).forEach((block, index) => {
        if (block.type === "text") {
          const textVal = block.text?.trim() ? block.text : "Okay.";
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: textVal } });
        } else {
          send("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
          });
          send("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
          });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: message.stop_reason, stop_sequence: null },
        usage: { output_tokens: message.usage.output_tokens },
      });
      send("message_stop", { type: "message_stop" });
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

export interface HandleAnthropicOptions {
  /** Aborts the M365 turn when the client disconnects. */
  signal?: AbortSignal;
  /**
   * Opt-in system-prompt spec (name:/path:/literal — see core/prompts.ts).
   * Falls back to M365_SYSTEM_PROMPT env. Both spellings are accepted because
   * the Nitro route passes `systemPromptSpec` while embedders historically
   * passed `systemPrompt`; before unification one of the two paths silently
   * dropped it.
   */
  systemPromptSpec?: string;
  /** Deprecated alias of {@link systemPromptSpec}. */
  systemPrompt?: string;
  /** Caller conversation identity (x-m365-session-id header) — isolates the M365 thread per caller. */
  sessionKey?: string;
  /** Adaptive harness profile (x-m365-profile header / M365_PROFILE env); invalid values fall back to claude-safe here (routes enforce strictly). */
  profile?: string;
}

/** Rough output-token estimate — M365 exposes no tokenizer (see handler buildUsage notes). */
function estimateOutputTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function applyStopSequences(text: string, sequences: string[] | undefined): {
  text: string;
  stopReason: "end_turn" | "stop_sequence";
  stopSequence: string | null;
} {
  let hit: { index: number; sequence: string } | null = null;
  for (const sequence of sequences ?? []) {
    if (!sequence) continue;
    const index = text.indexOf(sequence);
    if (index >= 0 && (!hit || index < hit.index)) hit = { index, sequence };
  }
  return hit
    ? { text: text.slice(0, hit.index), stopReason: "stop_sequence", stopSequence: hit.sequence }
    : { text, stopReason: "end_turn", stopSequence: null };
}

export function extractImagesFromAnthropicBody(body: AnthropicBody): InputImage[] {
  const images: InputImage[] = [];
  for (const msg of body.messages) {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      images.push(...extractAnthropicImages(msg.content));
    }
  }
  return images;
}

async function resolveImageAnnotations(
  body: AnthropicBody,
  sessionKey?: string,
): Promise<UploadedImageAnnotation[] | undefined> {
  const images = extractImagesFromAnthropicBody(body);
  if (images.length === 0) return undefined;

  let modelDef: ModelDefinition | undefined;
  try {
    modelDef = getModelDefinition(body.model);
  } catch {
    // ignore
  }

  if (modelDef && !modelDef.supportsVision) {
    log.warn(`Model ${body.model} does not support vision input; image attachments may not be interpreted`);
    return undefined;
  }

  try {
    if (process.env.M365_FAKE_MODE === "1" || process.env.NODE_ENV === "test") {
      return images.map((img, i) => ({
        id: `doc_mock_vision_${i + 1}`,
        messageAnnotationMetadata: {
          "@type": "File" as const,
          annotationType: "File" as const,
          fileType: img.mediaType,
          fileName: img.fileName ?? `image_${i + 1}.png`,
        },
        messageAnnotationType: "ImageFile" as const,
      }));
    }

    const token = await getToken();
    return await Promise.all(
      images.map((img) => uploadImageToSubstrate(token, sessionKey ?? crypto.randomUUID(), img)),
    );
  } catch (err: any) {
    log.error("Failed to upload image annotations to Substrate:", err?.message ?? err);
    return undefined;
  }
}

/**
 * Run one Anthropic Messages turn through the shared produceCompletion engine and
 * translate the result back into Anthropic wire shapes. Protocol-neutral errors
 * come back as OpenAI-style Responses and are converted by the caller.
 */
async function completeAnthropic(
  body: AnthropicBody,
  pool: SessionPool,
  opts: HandleAnthropicOptions,
): Promise<{ message: AnthropicMessageResponse } | { error: Response }> {
  const imageAnnotations = await resolveImageAnnotations(body, opts.sessionKey);
  const chat = toOpenAIChatRequest(body);
  const { produced, usage } = await produceCompletion(chat, pool, {
    signal: opts.signal,
    systemPromptSpec: opts.systemPromptSpec ?? opts.systemPrompt,
    sessionKey: opts.sessionKey,
    profile: opts.profile,
    forceSingleToolUse: requestsSingleToolUse(body),
    imageAnnotations,
  });
  if (produced.kind === "error") return { error: produced.resp };

  const inputTokens = estimateAnthropicInputTokens(body);

  if (produced.kind === "tools") {
    const carried = typeof produced.text === "string" ? produced.text : "";
    const content: AnthropicMessageResponse["content"] = [
      ...(produced.thinking ? [{ type: "thinking" as const, thinking: produced.thinking, signature: "" }] : []),
      ...(carried.trim() ? [{ type: "text" as const, text: carried }] : []),
      ...produced.toolCalls.map((tc) => ({
        type: "tool_use" as const,
        id: String(tc.id),
        name: String(tc.function?.name ?? "unknown"),
        input: parseToolInput(String(tc.function?.arguments ?? "{}")),
      })),
    ];
    const outChars = produced.toolCalls.reduce(
      (n, tc) => n + tc.function.name.length + String(tc.function.arguments ?? "").length + 20, 0);
    return {
      message: {
        id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
        type: "message",
        role: "assistant",
        model: body.model,
        content,
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: estimateOutputTokens("x".repeat(outChars)),
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        m365: usage,
      },
    };
  }

  const stopped = applyStopSequences(produced.text, body.stop_sequences);
  const text = stopped.text;
  const content: AnthropicMessageResponse["content"] = [
    ...(produced.thinking ? [{ type: "thinking" as const, thinking: produced.thinking, signature: "" }] : []),
    { type: "text", text },
  ];
  return {
    message: {
      id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: outputFinishReason(text) === "length" ? "max_tokens" : stopped.stopReason,
      stop_sequence: stopped.stopSequence,
      usage: {
        input_tokens: inputTokens,
        output_tokens: estimateOutputTokens(text),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      m365: usage,
    },
  };
}

/** Handle an Anthropic Messages request, including genuinely incremental streaming. */
export async function handleAnthropicMessages(
  body: AnthropicBody,
  pool: SessionPool,
  opts: HandleAnthropicOptions | AbortSignal = {},
): Promise<Response> {
  const options: HandleAnthropicOptions = opts instanceof AbortSignal ? { signal: opts } : opts;

  // Visibility: Claude Code sends fields we deliberately don't emulate (thinking
  // budgets, metadata.user_id, output_config.effort, context_management…). Log
  // once per request so operators can see what's being ignored.
  const ignored = (["thinking", "metadata", "output_config", "context_management"] as const)
    .filter((k) => (body as Record<string, unknown>)[k] !== undefined);
  if (ignored.length > 0) {
    log.info(`Ignoring Anthropic-only request field(s): ${ignored.join(", ")} (M365 backend has no equivalent)`);
  }

  // Generic OpenAI-upstream mode (OPENAI_UPSTREAM_BASE_URL set).
  if (upstreamEnabled()) {
    return handleUpstreamMessages(body, options.signal);
  }

  if (!body.stream) {
    const result = await completeAnthropic(body, pool, options);
    if ("error" in result) {
      const payload = await errorPayload(result.error);
      // Explicit M365 Disengage -> a normal assistant turn explaining what
      // happened, NOT a protocol error (Claude Code would retry-storm and the
      // user would just see a red failure for what is really a content filter).
      if (payload?.type === "disengaged") {
        log.info("Disengaged -> graceful assistant turn (non-stream)");
        return new Response(JSON.stringify(disengagedTurn(body.model)), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return anthropicErrorFromPayload(result.error.status, payload);
    }
    return new Response(JSON.stringify(result.message), { headers: { "Content-Type": "application/json" } });
  }

  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const send = (name: string, data: unknown) => controller.enqueue(encoder.encode(event(name, data)));
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch {}
        // Native CC also tolerates ping events; send both for maximum compat.
        try { controller.enqueue(encoder.encode(`event: ping\ndata: {"type":"ping"}\n\n`)); } catch {}
      }, 15_000);

      const inputTokens = estimateAnthropicInputTokens(body);

      let nextIndex = 0;
      let openTextIndex: number | null = null;
      let sent = "";
      const openTextBlock = (): number => {
        if (openTextIndex == null) {
          openTextIndex = nextIndex++;
          send("content_block_start", {
            type: "content_block_start",
            index: openTextIndex,
            content_block: { type: "text", text: "" },
          });
        }
        return openTextIndex;
      };
      const closeOpenBlocks = () => {
        if (openTextIndex != null) {
          send("content_block_stop", { type: "content_block_stop", index: openTextIndex });
          openTextIndex = null;
        }
      };

      try {
        // message_start goes out immediately — Claude Code renders its frame before
        // the (up to ~160s) M365 turn completes; keepalives hold the connection.
        send("message_start", {
          type: "message_start",
          message: {
            id: `msg_${crypto.randomUUID().replace(/-/g, "")}`,
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
            input_tokens: inputTokens,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
          },
        });

        const imageAnnotations = await resolveImageAnnotations(body, options.sessionKey);
        const chat = toOpenAIChatRequest(body);
        const { produced, usage } = await produceCompletion(chat, pool, {
          signal: options.signal,
          // The streaming path previously dropped the per-request system prompt
          // entirely — only the non-stream route honored it. Same resolution as
          // completeAnthropic so both paths behave identically.
          systemPromptSpec: options.systemPromptSpec ?? options.systemPrompt,
          sessionKey: options.sessionKey,
          profile: options.profile,
          forceSingleToolUse: requestsSingleToolUse(body),
          imageAnnotations,
          // Live passthrough: every upstream delta becomes a text_delta AS IT ARRIVES.
          onTextDelta: body.stop_sequences?.length ? undefined : (delta) => {
            if (!delta) return;
            sent += delta;
            send("content_block_delta", {
              type: "content_block_delta",
              index: openTextBlock(),
              delta: { type: "text_delta", text: delta },
            });
          },
        });

        let stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
        let stopSequence: string | null = null;
        let outputChars: number;
        if (produced.kind === "error") {
          closeOpenBlocks();
          const payload = await errorPayload(produced.resp);
          if (payload?.type === "disengaged") {
            // Graceful turn: explanation text + clean end, never an SSE error event.
            log.info("Disengaged -> graceful assistant turn (stream)");
            const idx = openTextBlock();
            send("content_block_delta", {
              type: "content_block_delta",
              index: idx,
              delta: { type: "text_delta", text: DISENGAGED_EXPLANATION },
            });
            closeOpenBlocks();
            send("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: estimateOutputTokens(DISENGAGED_EXPLANATION) },
            });
            send("message_stop", { type: "message_stop" });
            return;
          }
          let error = { type: payload?.type ?? "api_error", message: payload?.message ?? "M365 upstream error" };
          send("error", { type: "error", error });
          return;
        } else if (produced.kind === "tools") {
          stopReason = "tool_use";
          outputChars = 0;
          // Emit the un-streamed remainder of the carried prose, if any.
          const carried = typeof produced.text === "string" ? produced.text : "";
          let remainder = "";
          if (carried) {
            outputChars += carried.length;
            if (carried.startsWith(sent)) {
              remainder = carried.slice(sent.length);
            } else {
              remainder = carried; // diverged — resend authoritatively
              log.info(`Tool-mode streamed prefix diverged from carried text (sent ${sent.length}, carried ${carried.length} chars)`);
            }
          }
          closeOpenBlocks();
          if (remainder) {
            const index = openTextBlock();
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: remainder } });
          }
          closeOpenBlocks();
          // ChainOfThought → real Anthropic thinking block (F17.10). signature is
          // empty: we're the terminal endpoint, nothing will verify it upstream.
          if (produced.thinking) {
            const index = nextIndex++;
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: produced.thinking } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "" } });
            send("content_block_stop", { type: "content_block_stop", index });
          }
          for (const tc of produced.toolCalls) {
            const argsJson = String(tc.function.arguments ?? "{}");
            outputChars += tc.function.name.length + argsJson.length + 20;
            const index = nextIndex++;
            send("content_block_start", {
              type: "content_block_start",
              index,
              content_block: { type: "tool_use", id: String(tc.id), name: String(tc.function.name), input: {} },
            });
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "input_json_delta", partial_json: argsJson },
            });
            send("content_block_stop", { type: "content_block_stop", index });
          }
        } else {
          const stopped = applyStopSequences(produced.text ?? "", body.stop_sequences);
          const finalText = stopped.text;
          stopReason = outputFinishReason(finalText) === "length" ? "max_tokens" : stopped.stopReason;
          stopSequence = stopped.stopSequence;
          outputChars = finalText.length;
          // ChainOfThought → thinking block (F17.10), emitted ahead of text.
          if (produced.thinking && !sent.includes(produced.thinking.slice(0, 40))) {
            const index = nextIndex++;
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: produced.thinking } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "" } });
            send("content_block_stop", { type: "content_block_stop", index });
          }
          // Three-way prefix comparison: produceCompletion returns TRIMMED text while
          // live deltas carried the raw stream, so `sent` may be slightly LONGER than
          // finalText (trailing whitespace) without being a real divergence.
          let remainder: string;
          if (finalText.startsWith(sent)) {
            remainder = finalText.slice(sent.length);
          } else if (sent.startsWith(finalText)) {
            remainder = ""; // everything streamed already (final was only trimmed)
          } else {
            remainder = finalText; // genuine retry-path divergence — re-send authoritatively
            closeOpenBlocks();
          }
          if (!finalText.startsWith(sent) && !sent.startsWith(finalText)) {
            log.info(`Streamed prefix diverged from final text (sent ${sent.length}, final ${finalText.length} chars) — resending authoritative full text`);
          }
          if (remainder) {
            const index = openTextBlock();
            send("content_block_delta", {
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: remainder },
            });
          }
          closeOpenBlocks();
        }

        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: stopSequence },
          usage: { input_tokens: inputTokens, output_tokens: estimateOutputTokens("x".repeat(outputChars)) },
          m365: usage,
        });
        send("message_stop", { type: "message_stop" });
      } catch (error: any) {
        closeOpenBlocks();
        send("error", {
          type: "error",
          error: { type: "api_error", message: error?.message ?? "M365 upstream error" },
        });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

/** Approximation only: M365 exposes no tokenizer compatible with all routed models. */
export function estimateAnthropicInputTokens(value: unknown): number {
  let serialized = "";
  try { serialized = JSON.stringify(value); } catch { serialized = String(value); }
  return Math.max(1, Math.ceil(serialized.length / 4));
}
