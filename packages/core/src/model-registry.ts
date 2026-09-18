import { ModelUnavailableError, ModelCapabilityUnsupportedError } from "./errors.js";

export interface ModelDefinition {
  id: string;
  displayName: string;
  m365Tone: string;
  aliases: string[];
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsAgent: boolean;
  supportsReasoning: boolean;
  experimental: boolean;
  toolMode: "fenced" | "agent" | "none";
  fallback?: string;
  description?: string;
}

export const CANONICAL_REGISTRY: Record<string, ModelDefinition> = {
  "gpt-5.6-think-deeper": {
    id: "gpt-5.6-think-deeper",
    displayName: "GPT-5.6 Reasoning",
    m365Tone: "Gpt_5_6_Reasoning",
    aliases: [
      "gpt-5.6",
      "gpt-5.6-reasoning",
      "gpt-5.6-sol",
      "sol",
      "gpt-5.6-terra",
      "terra",
      "gpt-5.6-luna",
      "luna",
    ],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: false,
    supportsReasoning: true,
    experimental: false,
    toolMode: "fenced",
    description: "Frontier GPT reasoning model on Microsoft 365 Copilot with live Gpt_5_6_Reasoning tone.",
  },
  "gpt-5.5-think-deeper": {
    id: "gpt-5.5-think-deeper",
    displayName: "GPT-5.5 Reasoning",
    m365Tone: "Gpt_5_5_Reasoning",
    aliases: [
      "gpt-5.5",
      "gpt-5.5-reasoning",
      "think-deeper",
      "gpt-deep",
      "codex",
      "openai-codex",
      "gpt-codex",
      "codex-5",
    ],
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: false,
    supportsReasoning: true,
    experimental: false,
    toolMode: "fenced",
    description: "GPT-5.5 deep reasoning baseline on Microsoft 365 Copilot.",
  },
  "claude-opus": {
    id: "claude-opus",
    displayName: "Claude Opus",
    m365Tone: "Claude_Opus",
    aliases: [
      "claude-opus-5",
      "claude-opus-4",
      "claude-opus-4-5",
      "opus",
      "opus-5",
      "claude-3-opus",
      "claude-opus-5[1m]",
      "opus[1m]",
      "claude-opus-4-20250514",
      "claude-opus-4-5-20250514",
    ],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: false,
    supportsReasoning: false,
    experimental: true,
    toolMode: "fenced",
    description: "Claude Opus tone on M365 Copilot. Truthfully routed to Claude_Opus (never silently demoted to GPT).",
  },
  "claude-sonnet": {
    id: "claude-sonnet",
    displayName: "Claude Sonnet",
    m365Tone: "Claude_Sonnet",
    aliases: [
      "claude",
      "sonnet",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "claude-sonnet-4.5",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
      "sonnet-5",
      "sonnet-4",
      "claude-sonnet-5-20251219",
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-3-5-sonnet-20240620",
      "haiku",
      "claude-haiku",
      "claude-3-5-haiku",
      "claude-haiku-4-5",
      "claude-haiku-4.5",
    ],
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: false,
    supportsReasoning: false,
    experimental: false,
    toolMode: "fenced",
    description: "Claude Sonnet on M365 Copilot.",
  },
  "claude-sonnet-think-deeper": {
    id: "claude-sonnet-think-deeper",
    displayName: "Claude Sonnet Reasoning",
    m365Tone: "Claude_Sonnet_Reasoning",
    aliases: [
      "claude-sonnet-5-thinking",
      "claude-sonnet-5-20251219-thinking",
      "claude-3-7-sonnet-thinking",
    ],
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: false,
    supportsReasoning: true,
    experimental: false,
    toolMode: "fenced",
    description: "Claude Sonnet reasoning tone on M365 Copilot.",
  },
  "quick": {
    id: "quick",
    displayName: "GPT Quick",
    m365Tone: "Gpt_Quick",
    aliases: [
      "gpt-quick",
      "gpt-5.4-quick",
      "gpt-5.3-quick",
      "gpt-5.2-quick",
      "gpt-5.4",
      "gpt-5.3",
      "gpt-5.2",
    ],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: true,
    supportsReasoning: false,
    experimental: false,
    toolMode: "agent",
    description: "Fast GPT chat model with Studio agent tool support.",
  },
  "auto": {
    id: "auto",
    displayName: "M365 Auto (Magic)",
    m365Tone: "magic",
    aliases: ["m365-auto", "magic", "default"],
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
    supportsAgent: true,
    supportsReasoning: false,
    experimental: false,
    toolMode: "fenced",
    description: "Microsoft 365 Copilot automatic tone selection.",
  },
};

// Build fast alias lookup map (case-insensitive)
const ALIAS_MAP = new Map<string, ModelDefinition>();
for (const model of Object.values(CANONICAL_REGISTRY)) {
  ALIAS_MAP.set(model.id.toLowerCase(), model);
  for (const alias of model.aliases) {
    ALIAS_MAP.set(alias.toLowerCase(), model);
  }
}

/**
 * Resolve model identifier or alias to its ModelDefinition.
 * Returns undefined if unknown.
 */
export function getModelDefinition(idOrAlias: string | null | undefined): ModelDefinition | undefined {
  if (!idOrAlias) return undefined;
  const normalized = idOrAlias.trim().toLowerCase();
  return ALIAS_MAP.get(normalized);
}

export interface ResolveModelOptions {
  /**
   * If true, allows fallback for experimental models when unavailable.
   * Default: false (STRICT model truthfulness — zero silent fallbacks).
   */
  allowFallback?: boolean;
  requireTools?: boolean;
  requireVision?: boolean;
}

/**
 * Resolve a model strictly, enforcing zero silent fallback.
 * Throws ModelUnavailableError if the model is unknown or unavailable.
 * Throws ModelCapabilityUnsupportedError if a required capability is unsupported.
 */
export function resolveModelStrict(
  idOrAlias: string | null | undefined,
  options: ResolveModelOptions = {},
): ModelDefinition {
  const modelName = (idOrAlias ?? "claude-sonnet").trim();
  const def = getModelDefinition(modelName);

  if (!def) {
    const available = Object.keys(CANONICAL_REGISTRY);
    throw new ModelUnavailableError(modelName, available);
  }

  // Capability validation
  if (options.requireTools && !def.supportsTools) {
    throw new ModelCapabilityUnsupportedError(def.id, "tools");
  }
  if (options.requireVision && !def.supportsVision) {
    throw new ModelCapabilityUnsupportedError(def.id, "vision");
  }

  return def;
}

/** Return list of all registered canonical models */
export function listAllModels(): ModelDefinition[] {
  return Object.values(CANONICAL_REGISTRY);
}

/**
 * Render a human-readable CLI table of model capabilities.
 */
export function formatModelCapabilityTable(): string {
  const headers = ["ID", "M365 Tone", "Chat", "Tools", "Vision", "Reasoning", "Status"];
  const rows: string[][] = [];

  for (const m of Object.values(CANONICAL_REGISTRY)) {
    rows.push([
      m.id,
      m.m365Tone,
      "yes",
      m.supportsTools ? (m.experimental ? "experimental" : "yes") : "no",
      m.supportsVision ? "yes" : "no",
      m.supportsReasoning ? "yes" : "no",
      m.experimental ? "experimental" : "production",
    ]);
  }

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const headerLine = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const rowLines = rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join("  "));

  return [headerLine, sep, ...rowLines].join("\n");
}
