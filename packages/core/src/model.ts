import { getToken, getTokenSilent } from "./auth.js";
import { getOrCreateAgent, getOrCreateAgentSingleFlight } from "./agent.js";
import { CopilotSession } from "./session.js";
import { createLogger, trunc } from "./log.js";
import { resolveModel } from "./copilot.js";
import type { CopilotStream } from "./copilot.js";
import type { UploadedImageAnnotation } from "./vision.js";

const log = createLogger("model");

export interface ModelSessionOptions {
  /** Pre-resolved auth token. If not provided, getToken() is called. */
  getToken?: () => Promise<string>;
  /**
   * Proactive re-acquirer, used ONLY when the current token is already near
   * expiry (see isTokenNearExpiry). Default: core getTokenSilent() — an MSAL
   * silent refresh. Failures never block the turn (the current token stays
   * valid until its own exp).
   */
  refreshToken?: () => Promise<string>;
  /**
   * Seed an EXISTING M365 conversation id (proxy session-store hydration) so a
   * restarted host resumes the server-side thread instead of spending a fresh
   * conversation start (thread-rate throttle, docs/hypotheses.md F13).
   */
  conversationId?: string;
  /** Whether to attempt agent resolution. Default: true. */
  useAgent?: boolean;
  /** Inject a transport (the thing that actually talks to a backend). Defaults to the real M365 WebSocket transport. */
  transport?: ModelTransport;
  /** Grounding scope: "web" (default) or "work" (corporate grounding). */
  grounding?: "web" | "work";
  /** Temporary private chat: disable server-side memory persistence. Default: true (disableMemory=1). */
  disableMemory?: boolean;
}

/**
 * The pluggable bottom edge of a ModelSession: one text turn in, stream out.
 * The default implementation opens a real CopilotSession (M365 SignalR).
 * Tests and M365_FAKE_MODE swap in a scripted transport instead.
 */
export interface ModelTransport {
  chat(args: {
    token: string;
    text: string;
    tone: string;
    signal?: AbortSignal;
    agentId?: string;
    sessionId: string;
    conversationId: string;
    generateImages: boolean;
    imageAnnotations?: UploadedImageAnnotation[];
  }): Promise<CopilotStream>;
  /** Drop any cached underlying connection (called on turn errors before the one retry). */
  reset?(): void;
}

/** The real M365 transport — wraps CopilotSession with the reuse/recreate rules. */
export class RealM365Transport implements ModelTransport {
  private copilotSession: CopilotSession | null = null;
  private agentId: string | undefined = undefined;

  constructor(
    private sessionOptions?: {
      grounding?: "web" | "work";
      disableMemory?: boolean;
    },
  ) {}

  private ensure(agentId: string | undefined, sessionId: string, conversationId: string): CopilotSession {
    if (!this.copilotSession || this.agentId !== agentId) {
      this.copilotSession = new CopilotSession({
        agentId,
        sessionId,
        conversationId,
        grounding: this.sessionOptions?.grounding,
        disableMemory: this.sessionOptions?.disableMemory,
      });
      this.agentId = agentId;
    }
    return this.copilotSession;
  }

  async chat(args: {
    token: string;
    text: string;
    tone: string;
    signal?: AbortSignal;
    agentId?: string;
    sessionId: string;
    conversationId: string;
    generateImages: boolean;
    imageAnnotations?: UploadedImageAnnotation[];
  }): Promise<CopilotStream> {
    const sess = this.ensure(args.agentId, args.sessionId, args.conversationId);
    // Pass the resolved tone explicitly — the positional `model` param would
    // otherwise re-resolve the TONE string through getToneForModel and collapse
    // every non-default Claude tone to Claude_Sonnet.
    return sess.chat(args.token, args.text, args.tone, args.signal, {
      generateImages: args.generateImages,
      tone: args.tone,
      imageAnnotations: args.imageAnnotations,
    });
  }

  reset(): void {
    this.copilotSession = null;
  }
}

/**
 * A stateful session for running M365 Copilot.
 * Manages auth, agent resolution, and conversation continuity.
 * String in, stream out.
 *
 * The same sessionId and conversationId are reused across transport
 * reconnections so M365 finds the existing server-side conversation
 * instead of creating a new one.
 */
export class ModelSession {
  private resolveToken: () => Promise<string>;
  private refreshTokenFn: (() => Promise<string>) | null;
  private useAgent: boolean;
  private transport: ModelTransport;
  private cachedAgentId: string | null | undefined = undefined;
  private agentResolutionPromise: Promise<string | null> | null = null;

  /** Stable IDs reused across transport reconnections. */
  readonly sessionId: string = crypto.randomUUID();
  private _conversationId: string;
  /** Current M365 ConversationId (the throttle/Disengage state keys on this). */
  get conversationId(): string {
    return this._conversationId;
  }

  /**
   * Rotate to a FRESH conversation. A conversation that has Disengaged appears to
   * STAY Disengaged (a clean retry in the same conversation kept refusing), so the
   * Disengage-recovery retry needs a new ConversationId, not just a different prompt.
   * See docs §10 F22.
   */
  newConversation(): void {
    this._conversationId = crypto.randomUUID();
    this.transport.reset?.();
    this.currentAgentId = undefined;
  }

  constructor(options: ModelSessionOptions = {}) {
    this.resolveToken = options.getToken ?? getToken;
    this.refreshTokenFn = options.refreshToken ?? null;
    this.useAgent = options.useAgent !== false;
    this.transport =
      options.transport ??
      new RealM365Transport({
        grounding: options.grounding,
        disableMemory: options.disableMemory,
      });
    this._conversationId = options.conversationId ?? crypto.randomUUID();
  }

  /** Number of turns completed against the current conversation. */
  get turnCount(): number {
    return this.turnCounter;
  }

  private turnCounter = 0;

  /** Agent id baked into the current transport state (undefined = no agent). */
  private currentAgentId: string | undefined = undefined;

  private async resolveAgentId(): Promise<string | null> {
    if (this.cachedAgentId !== undefined) {
      return this.cachedAgentId;
    }
    if (this.agentResolutionPromise) {
      return this.agentResolutionPromise;
    }
    this.agentResolutionPromise = getOrCreateAgentSingleFlight()
      .then((agentId) => {
        this.cachedAgentId = agentId;
        return agentId;
      })
      .finally(() => {
        this.agentResolutionPromise = null;
      });
    return this.agentResolutionPromise;
  }

  /**
   * Send text to M365 Copilot and stream back the response.
   *
   * `useAgent` decides whether THIS turn attaches the tool-calling Copilot Studio
   * agent (`threadLevelGptId`). `useAgent` is ONLY enabled if the resolved model
   * explicitly supports agent attachment (`config.supportsAgent`).
   */
  async run(
    text: string,
    model: string = "m365-copilot",
    signal?: AbortSignal,
    useAgent: boolean = true,
    imageAnnotations?: UploadedImageAnnotation[],
  ): Promise<CopilotStream> {
    let token = await this.resolveToken();
    // Proactive refresh (restart-durability companion): MSAL access tokens live
    // ~1h; a long-lived host otherwise spends the last minutes of every hour
    // failing mid-turn. When inside the expiry margin, try ONE silent refresh
    // before the turn. Failure keeps the current token — it still works until
    // its own exp, and the next successful refresh catches us back up.
    if (isTokenNearExpiry(token)) {
      const refresher = this.refreshTokenFn ?? defaultRefreshToken;
      try {
        const fresh = await refresher();
        if (fresh && fresh !== token) {
          log.info("Token proactively refreshed (inside expiry margin)");
          token = fresh;
        }
      } catch (err: any) {
        log.warn("Proactive token refresh failed; continuing on current token:", err.message);
      }
    }
    const resolvedModel = resolveModel(model);
    const wantAgent = this.useAgent && useAgent && resolvedModel.config.supportsAgent;

    // Resolve agent ID lazily (persists across resets), single-flighted across concurrent calls
    if (wantAgent && this.cachedAgentId === undefined) {
      try {
        await this.resolveAgentId();
        if (this.cachedAgentId) log.info(`Using agent: ${this.cachedAgentId}`);
        else log.info("No agent available");
      } catch {
        this.cachedAgentId = null;
      }
    }
    const agentForTurn = wantAgent ? (this.cachedAgentId ?? undefined) : undefined;

    log.info(
      `run: model=${resolvedModel.canonicalModel}, tone=${resolvedModel.config.tone}, agent=${
        agentForTurn ?? "none"
      }, turn=${this.turnCounter}, sid=${this.sessionId}, cid=${this.conversationId}, text=${JSON.stringify(
        trunc(text, 200),
      )}`,
    );

    const generateImages = !agentForTurn && !process.env.M365_NO_IMAGE_GEN;

    try {
      const stream = await this.transport.chat({
        token,
        text,
        tone: resolvedModel.config.tone,
        signal,
        agentId: agentForTurn,
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        generateImages,
        imageAnnotations,
      });
      this.currentAgentId = agentForTurn;
      this.turnCounter += 1;
      return stream;
    } catch (err: any) {
      // Connection might be stale — recreate via transport.reset() and retry once
      log.info("Session error, reconnecting:", err.message);
      this.transport.reset?.();
      const stream = await this.transport.chat({
        token,
        text,
        tone: resolvedModel.config.tone,
        signal,
        agentId: agentForTurn,
        sessionId: this.sessionId,
        conversationId: this.conversationId,
        generateImages,
        imageAnnotations,
      });
      this.currentAgentId = agentForTurn;
      this.turnCounter += 1;
      return stream;
    }
  }

  async refreshAgent(): Promise<boolean> {
    if (this.useAgent === false) return false;
    try {
      const fresh = await getOrCreateAgent({ forceRefresh: true });
      if (fresh !== this.cachedAgentId) {
        log.info(`Agent ID refreshed: ${this.cachedAgentId ?? "none"} -> ${fresh ?? "none"}`);
        this.cachedAgentId = fresh;
        this.transport.reset?.();
        this.currentAgentId = undefined;
        return true;
      }
    } catch (err: any) {
      log.warn("Agent refresh failed:", err.message);
    }
    return false;
  }

  reset(): void {
    this.transport.reset?.();
    this.currentAgentId = undefined;
    this.turnCounter = 0;
  }
}

// --- Proactive token expiry helpers ---

/** Refresh when closer to expiry than this. Tune via env; 0 disables the check. */
const TOKEN_REFRESH_MARGIN_MS = Number(process.env.M365_TOKEN_REFRESH_MARGIN_MS ?? 300_000);

function jwtExpMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const raw = JSON.parse(Buffer.from(padded, "base64").toString());
    return typeof raw?.exp === "number" ? raw.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * True when an MSAL access token is missing, unparseable-without-exp (treat
 * conservatively: let it be — only tokens WITH exp are proactively refreshed),
 * or inside the refresh margin before its exp.
 */
export function isTokenNearExpiry(
  token: string,
  marginMs: number = TOKEN_REFRESH_MARGIN_MS,
  now: number = Date.now(),
): boolean {
  if (!token) return false;
  if (marginMs <= 0) return false;
  const exp = jwtExpMs(token);
  if (exp == null) return false;
  return exp - now < marginMs;
}

/**
 * Default proactive refresher: an MSAL SILENT re-acquisition. Never falls back
 * to browser logins here — a refresh attempt must stay invisible and cheap;
 * the next regular getToken() owns the loud recovery paths.
 */
const defaultRefreshToken = async (): Promise<string> => (await getTokenSilent()) ?? "";
