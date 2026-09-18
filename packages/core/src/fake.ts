import { createLogger } from "./log.js";
import type { CopilotStream, CapturedImage } from "./copilot.js";
import type { ModelTransport } from "./model.js";
import {
  AuthenticationExpiredError,
  ConversationExpiredError,
} from "./errors.js";

const log = createLogger("fake");

export type FakeProtocolFixture =
  | "normal-text"
  | "streamed-text"
  | "tool-call"
  | "multi-tool"
  | "malformed-tool"
  | "confabulated-prose"
  | "disengaged"
  | "throttle-429"
  | "expired-auth"
  | "conversation-expired"
  | "image-response"
  | "unknown-frame";

/**
 * Scripted offline backend for M365_FAKE_MODE and tests.
 *
 * Speaks the same protocol shape as the real pipeline so the FULL stack
 * (fenced tool formatting → response parsing → OpenAI/Anthropic translation)
 * is exercised without auth, WebSockets, or quota.
 *
 * Supports all 12 protocol test fixtures for complete offline test coverage.
 */

export interface FakeTransportOptions {
  /** Called with each incoming prompt — lets tests assert formatting/injection. */
  onPrompt?: (text: string, conversationId: string) => void;
  /** Override the generated ```bash command on tool turns. */
  command?: string;
  /** Override the final-answer template; `${responses}` = number of tool results seen. */
  finalText?: (responses: number) => string;
  /** Split streamed output into chunks of this many chars (default 7). */
  chunkSize?: number;
  /** Per-turn artificial latency in ms (default 0). */
  latencyMs?: number;
  /** Test harness mode: make the fake model's final answer equal the real tool result. */
  echoToolResult?: boolean;
  /** Scripted protocol fixture or dynamic turn selector. */
  fixture?:
    | FakeProtocolFixture
    | ((turn: number, conversationId: string, prompt: string) => FakeProtocolFixture | undefined);
  /** Custom images to return on image turns. */
  customImages?: CapturedImage[];
  /** Custom throttle state. */
  customThrottle?: { current: number; max: number };
}

function makeStream(
  text: string,
  opts: {
    chunkSize: number;
    throttle: { current: number; max: number };
    turnCount: number;
    images?: CapturedImage[];
    scores?: Record<string, number>;
    messageType?: string | null;
    contentOrigin?: string;
  },
): CopilotStream {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += opts.chunkSize) chunks.push(text.slice(i, i + opts.chunkSize));
  if (chunks.length === 0) chunks.push("");
  return {
    fullText: text,
    hasContent: text.length > 0,
    images: opts.images ?? [],
    throttle: opts.throttle,
    contentOrigin: opts.contentOrigin ?? "Fake",
    messageType: opts.messageType ?? null,
    messageId: `fake-${crypto.randomUUID()}`,
    scores: opts.scores ?? { dea_violation: 1e-13 },
    turnCount: opts.turnCount,
    turnState: "Completed",
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        await new Promise((r) => setTimeout(r, 0));
        yield c;
      }
    },
  };
}

export class FakeTransport implements ModelTransport {
  private turns = new Map<string, { n: number; responses: number }>();
  readonly prompts: Array<{ text: string; conversationId: string }> = [];

  constructor(private options: FakeTransportOptions = {}) {}

  private stateFor(conversationId: string): { n: number; responses: number } {
    let s = this.turns.get(conversationId);
    if (!s) {
      s = { n: 0, responses: 0 };
      this.turns.set(conversationId, s);
    }
    return s;
  }

  reset(): void {
    // A "reconnect" keeps scripted per-conversation counters — nothing to drop.
  }

  async chat(args: {
    text: string;
    sessionId: string;
    conversationId: string;
    latencyMs?: number;
  } & Record<string, unknown>): Promise<CopilotStream> {
    this.prompts.push({ text: args.text, conversationId: args.conversationId });
    this.options.onPrompt?.(args.text, args.conversationId);

    const state = this.stateFor(args.conversationId);
    state.n += 1;
    // Count REAL tool results only
    if (/<tool_response\s+name=/.test(args.text)) state.responses += 1;

    const fixture =
      typeof this.options.fixture === "function"
        ? this.options.fixture(state.n, args.conversationId, args.text)
        : this.options.fixture;

    if (fixture === "expired-auth") {
      throw new AuthenticationExpiredError("The Microsoft 365 access token has expired or is invalid.");
    }
    if (fixture === "conversation-expired") {
      throw new ConversationExpiredError("M365 conversation has reached maximum turns or expired.");
    }
    if (fixture === "throttle-429") {
      return makeStream("", {
        chunkSize: 7,
        throttle: this.options.customThrottle ?? { current: 600, max: 600 },
        turnCount: state.n,
        messageType: null,
      });
    }
    if (fixture === "disengaged") {
      return makeStream("", {
        chunkSize: 7,
        throttle: this.options.customThrottle ?? { current: state.n, max: 600 },
        turnCount: state.n,
        scores: { dea_violation: 0.999 },
        messageType: "Disengaged",
      });
    }
    if (fixture === "image-response") {
      const images: CapturedImage[] = this.options.customImages ?? [
        {
          referenceUrls: ["https://designerapp.officeapps.live.com/designerapp/document.ashx?path=fake.png"],
          fileToken: "fake-file-token-123",
          status: 2,
        },
      ];
      return makeStream("Here is the generated image:", {
        chunkSize: 7,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
        images,
        contentOrigin: "ImageGeneration",
        messageType: "GraphicArt",
      });
    }
    if (fixture === "multi-tool") {
      const multiText = "```bash\necho step1\n```\n\n```bash\necho step2\n```";
      return makeStream(multiText, {
        chunkSize: 7,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
      });
    }
    if (fixture === "malformed-tool") {
      const malformedText = "```tool:read_file\n{\"path\": unclosed\n```";
      return makeStream(malformedText, {
        chunkSize: 7,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
      });
    }
    if (fixture === "confabulated-prose") {
      const prose = "I have reviewed and edited the file to add the missing implementation. All tests are passing.";
      return makeStream(prose, {
        chunkSize: 7,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
      });
    }
    if (fixture === "unknown-frame") {
      return makeStream("Response with future protocol frame", {
        chunkSize: 7,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
        messageType: "FutureProtocolSyntheticFrame",
      });
    }
    if (fixture === "normal-text") {
      return makeStream("This is a complete normal text response.", {
        chunkSize: 1000,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
      });
    }
    if (fixture === "streamed-text") {
      return makeStream("Streamed response chunk by chunk over SSE.", {
        chunkSize: 4,
        throttle: { current: state.n, max: 600 },
        turnCount: state.n,
      });
    }

    // Default scripted tool/echo behavior
    const hasToolManifest = args.text.includes("<system>") && args.text.includes("```bash");
    let text: string;
    if (state.responses > 0) {
      const responses = state.responses;
      const resultMatch = [...args.text.matchAll(/<tool_response\b[^>]*>([\s\S]*?)<\/tool_response>/g)].at(-1);
      const echoedResult = resultMatch?.[1]?.trim() ?? "";
      text =
        this.options.echoToolResult && echoedResult
          ? echoedResult
          : this.options.finalText?.(responses) ??
            `Task complete after ${responses} tool result(s). FAKE_FINAL cid=${args.conversationId.slice(0, 8)} turn=${state.n}`;
    } else if (hasToolManifest || fixture === "tool-call") {
      const cmd = this.options.command ?? `echo fake-turn-${state.n}`;
      text = "```bash\n" + cmd + "\n```";
    } else {
      text = `FAKE_ECHO turn=${state.n}: ${args.text.slice(0, 80).replace(/\s+/g, " ")}`;
    }

    log.info(`fake turn n=${state.n} responses=${state.responses} -> ${text.length} chars`);
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));
    return makeStream(text, {
      chunkSize: this.options.chunkSize ?? 7,
      throttle: this.options.customThrottle ?? { current: Math.min(state.n, 599), max: 600 },
      turnCount: state.n,
    });
  }
}
