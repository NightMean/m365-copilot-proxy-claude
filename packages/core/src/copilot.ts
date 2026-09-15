import { JwtClaims } from "./schemas.js";
import { UnsupportedModelError } from "./errors.js";

export type BackendFamily = "auto" | "gpt" | "claude";
export type ToolMode = "agent" | "fenced" | "none";

export interface ModelConfig {
  canonicalModel: string;
  displayName: string;
  tone: string;
  backendFamily: BackendFamily;
  supportsAgent: boolean;
  supportsTools: boolean;
  toolMode: ToolMode;
  isPreset?: boolean;
  deprecated?: boolean;
  replacement?: string;
  description?: string;
}

export interface ResolvedModel {
  requestedModel: string;
  normalizedModel: string;
  canonicalModel: string;
  config: ModelConfig;
  warnings: string[];
}

export const CANONICAL_MODELS: Record<string, ModelConfig> = {
  "m365-copilot": {
    canonicalModel: "m365-copilot",
    displayName: "Microsoft 365 Copilot",
    tone: "magic",
    backendFamily: "auto",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  auto: {
    canonicalModel: "auto",
    displayName: "Auto (Default)",
    tone: "magic",
    backendFamily: "auto",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.5": {
    canonicalModel: "gpt-5.5",
    displayName: "GPT-5.5 Chat",
    tone: "Gpt_5_5_Chat",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.5-quick": {
    canonicalModel: "gpt-5.5-quick",
    displayName: "GPT-5.5 Quick",
    tone: "Gpt_5_5_Chat",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.5-think-deeper": {
    canonicalModel: "gpt-5.5-think-deeper",
    displayName: "GPT-5.5 Reasoning",
    tone: "Gpt_5_5_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "gpt-5.4-quick": {
    canonicalModel: "gpt-5.4-quick",
    displayName: "GPT-5.4 Quick",
    tone: "Gpt_5_4_Quick",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.4-think-deeper": {
    canonicalModel: "gpt-5.4-think-deeper",
    displayName: "GPT-5.4 Reasoning",
    tone: "Gpt_5_4_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "gpt-5.3-quick": {
    canonicalModel: "gpt-5.3-quick",
    displayName: "GPT-5.3 Quick",
    tone: "Gpt_5_3_Quick",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.3-think-deeper": {
    canonicalModel: "gpt-5.3-think-deeper",
    displayName: "GPT-5.3 Reasoning",
    tone: "Gpt_5_3_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "gpt-5.2-quick": {
    canonicalModel: "gpt-5.2-quick",
    displayName: "GPT-5.2 Quick",
    tone: "Gpt_5_2_Quick",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.2-think-deeper": {
    canonicalModel: "gpt-5.2-think-deeper",
    displayName: "GPT-5.2 Reasoning",
    tone: "Gpt_5_2_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  quick: {
    canonicalModel: "quick",
    displayName: "GPT Quick",
    tone: "Gpt_Quick",
    backendFamily: "gpt",
    supportsAgent: true,
    supportsTools: true,
    toolMode: "agent",
  },
  "gpt-5.6-reasoning": {
    canonicalModel: "gpt-5.6-reasoning",
    displayName: "GPT-5.6 Reasoning",
    tone: "Gpt_5_6_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "think-deeper": {
    canonicalModel: "think-deeper",
    displayName: "GPT Reasoning",
    tone: "Gpt_Reasoning",
    backendFamily: "gpt",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "claude-sonnet": {
    canonicalModel: "claude-sonnet",
    displayName: "Claude Sonnet",
    tone: "Claude_Sonnet",
    backendFamily: "claude",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "claude-sonnet-think-deeper": {
    canonicalModel: "claude-sonnet-think-deeper",
    displayName: "Claude Sonnet Reasoning",
    tone: "Claude_Sonnet_Reasoning",
    backendFamily: "claude",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
  "claude-opus": {
    canonicalModel: "claude-opus",
    displayName: "Claude Opus",
    tone: "Claude_Opus",
    backendFamily: "claude",
    supportsAgent: false,
    supportsTools: true,
    toolMode: "fenced",
  },
};

export const MODEL_ALIASES: Record<string, string> = {
  // Claude aliases
  claude: "claude-sonnet",
  "claude-sonnet-4.5": "claude-sonnet",
  "claude-sonnet-4.6": "claude-sonnet",
  "claude-sonnet-4-6": "claude-sonnet",
  "sonnet-4-6": "claude-sonnet",
  "claude-3-7-sonnet": "claude-sonnet",
  "claude-3-5-sonnet": "claude-sonnet",
  "claude-sonnet-5": "claude-sonnet",
  "claude-sonnet-5[1m]": "claude-sonnet",
  "sonnet": "claude-sonnet",
  "sonnet-5": "claude-sonnet",
  "sonnet-4": "claude-sonnet",
  "claude-sonnet-5-20251219": "claude-sonnet",
  "claude-3-7-sonnet-20250219": "claude-sonnet",
  "claude-3-5-sonnet-20241022": "claude-sonnet",
  "claude-3-5-sonnet-20240620": "claude-sonnet",

  // Regional Anthropic prefixes allowed by corporate / Bedrock policies
  "eu.anthropic.claude-sonnet-5": "claude-sonnet",
  "eu.anthropic.claude-sonnet-4-6": "claude-sonnet",
  "eu.anthropic.claude-sonnet-4.6": "claude-sonnet",
  "us.anthropic.claude-sonnet-5": "claude-sonnet",
  "us.anthropic.claude-sonnet-4-6": "claude-sonnet",

  "claude-sonnet-5-thinking": "claude-sonnet-think-deeper",
  "claude-sonnet-5-20251219-thinking": "claude-sonnet-think-deeper",
  "claude-3-7-sonnet-thinking": "claude-sonnet-think-deeper",

  "claude-opus-4": "claude-opus",
  "claude-opus-4-5": "claude-opus",
  "claude-opus-4-6": "gpt-5.5-think-deeper",
  "claude-opus-4.6": "gpt-5.5-think-deeper",
  "opus-4-6": "gpt-5.5-think-deeper",
  "opus-4.6": "gpt-5.5-think-deeper",
  "claude-opus-4-7": "claude-opus",
  "claude-opus-4.7": "claude-opus",
  "claude-opus-4-8": "claude-opus",
  "claude-opus-4.8": "claude-opus",
  "claude-opus-4-20250514": "claude-opus",
  "opus-4": "claude-opus",
  "claude-opus-4-5-20250514": "claude-opus",
  opus: "claude-opus",
  "opus-5": "claude-opus",
  "claude-3-opus": "claude-opus",
  "claude-opus-5": "claude-opus",
  "claude-opus-5[1m]": "claude-opus",
  "opus[1m]": "claude-opus",

  // Regional Anthropic Opus aliases allowed by corporate / Bedrock policies
  "eu.anthropic.claude-opus-4-8": "claude-opus",
  "eu.anthropic.claude-opus-4-7": "claude-opus",
  "eu.anthropic.claude-opus-5": "claude-opus",
  "eu.anthropic.claude-opus-4-6": "gpt-5.5-think-deeper",
  "eu.anthropic.claude-opus-4.6": "gpt-5.5-think-deeper",
  "us.anthropic.claude-opus-4-8": "claude-opus",
  "us.anthropic.claude-opus-5": "claude-opus",

  // Haiku aliases (map to claude-sonnet with warning)
  haiku: "claude-sonnet",
  "claude-haiku": "claude-sonnet",
  "claude-3-5-haiku": "claude-sonnet",
  "claude-haiku-4-5": "claude-sonnet",
  "claude-haiku-4.5": "claude-sonnet",
  "claude-haiku-4-5-20250514": "claude-sonnet",
  "claude-3-5-haiku-20241022": "claude-sonnet",

  // GPT-5.6 / Sol / Terra / Luna — REAL distinct upstream tone Gpt_5_6_Reasoning
  // (verified live; tone accepted where gpt-5.5=magic. Effort presets low/medium
  // are cosmetic until an effort-transmission channel is confirmed.)
  "gpt-5.6": "gpt-5.6-reasoning",
  "gpt-5.6-sol": "gpt-5.6-reasoning",
  "gpt-5.6-terra": "gpt-5.6-reasoning",
  "gpt-5.6-luna": "gpt-5.6-reasoning",
  sol: "gpt-5.6-reasoning",
  terra: "gpt-5.6-reasoning",
  luna: "gpt-5.6-reasoning",

  // Codex presets
  codex: "gpt-5.5",
  "openai-codex": "gpt-5.5",
  "gpt-codex": "gpt-5.5",
  "codex-5": "gpt-5.5",

  // GPT-5.4 / 5.3 / 5.2 convenience aliases
  "gpt-5.4": "gpt-5.4-quick",
  "gpt-5.3": "gpt-5.3-quick",
  "gpt-5.2": "gpt-5.2-quick",
  "gpt-deep": "think-deeper",
  "gpt-quick": "quick",
};

export function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveModel(value: string): ResolvedModel {
  const normalized = normalizeModelName(value);
  if (!normalized) {
    throw new UnsupportedModelError("", getAvailableModels());
  }

  // Explicitly check for misleading, unsupported model names (e.g. fable/mythos)
  if (/^(fable|claude-fable|fable-4|mythos|claude-mythos|gpt-mythos|mythos-1)$/i.test(normalized)) {
    throw new UnsupportedModelError(
      value,
      getAvailableModels(),
      `Unsupported model "${value}". This alias does not select a distinct upstream model. Use "gpt-5.5" or "auto".`,
    );
  }

  // 1. Direct match in canonical models
  if (CANONICAL_MODELS[normalized]) {
    const config = CANONICAL_MODELS[normalized];
    return {
      requestedModel: value,
      normalizedModel: normalized,
      canonicalModel: config.canonicalModel,
      config,
      warnings: config.deprecated && config.replacement ? [`"${value}" is deprecated. Use "${config.replacement}".`] : [],
    };
  }

  // 2. Direct match in aliases
  const targetCanonical = MODEL_ALIASES[normalized];
  if (targetCanonical && CANONICAL_MODELS[targetCanonical]) {
    const config = CANONICAL_MODELS[targetCanonical];
    const warnings: string[] = [];
    if (/^(sol|terra|luna|codex|openai-codex|gpt-codex|codex-5|gpt-5\.6)/i.test(normalized)) {
      warnings.push(`"${value}" is a preset backed by canonical model "${config.canonicalModel}".`);
    } else if (normalized.includes("haiku")) {
      warnings.push(`"${value}" is a compatibility alias resolving to canonical model "${config.canonicalModel}".`);
    }
    return {
      requestedModel: value,
      normalizedModel: normalized,
      canonicalModel: config.canonicalModel,
      config,
      warnings,
    };
  }

  // 3. Fallback for unmapped claude-* variants
  if (/^claude/i.test(normalized)) {
    const config = CANONICAL_MODELS["claude-sonnet"];
    return {
      requestedModel: value,
      normalizedModel: normalized,
      canonicalModel: "claude-sonnet",
      config,
      warnings: [`Unrecognized Claude model "${value}" mapped to canonical model "claude-sonnet".`],
    };
  }

  throw new UnsupportedModelError(value, getAvailableModels());
}

export function getToneForModel(model: string): string {
  try {
    const resolved = resolveModel(model);
    return resolved.config.tone;
  } catch {
    return CANONICAL_MODELS["m365-copilot"].tone;
  }
}

export function getAvailableModels(): string[] {
  const canonical = Object.keys(CANONICAL_MODELS);
  const aliases = Object.keys(MODEL_ALIASES);
  return Array.from(new Set([...canonical, ...aliases]));
}

export function decodeJwt(token: string) {
  const payload = token.split(".")[1];
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const raw = JSON.parse(Buffer.from(padded, "base64").toString());
  return JwtClaims.parse(raw);
}

export interface CapturedImage {
  referenceUrls: string[];
  fileToken?: string;
  pollUrl?: string;
  size?: string;
  orientation?: string;
  status?: number;
}

export interface CopilotStream {
  [Symbol.asyncIterator](): AsyncIterator<string>;
  fullText: string;
  /** ChainOfThought reasoning transcript for this turn (null when absent). */
  thinkingText?: string | null;
  hasThinking?: boolean;
  images: CapturedImage[];
  hasContent: boolean;
  throttle: { current: number; max: number } | null;
  contentOrigin?: string | null;
  messageType?: string | null;
  messageId?: string | null;
  scores?: Record<string, number> | null;
  turnCount?: number | null;
  turnState?: string | null;
  sawAction?: boolean;
}
