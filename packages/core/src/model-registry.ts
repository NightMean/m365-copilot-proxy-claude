import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
      "claude-opus-4.5",
      "claude-opus-4-6",
      "claude-opus-4.6",
      "opus-4-6",
      "opus-4.6",
      "opus",
      "opus-5",
      "claude-3-opus",
      "claude-opus-5[1m]",
      "opus[1m]",
      "claude-opus-4-7",
      "claude-opus-4.7",
      "claude-opus-4-8",
      "claude-opus-4.8",
      "eu.anthropic.claude-opus-4-8",
      "eu.anthropic.claude-opus-4-7",
      "eu.anthropic.claude-opus-4-6",
      "eu.anthropic.claude-opus-4.6",
      "eu.anthropic.claude-opus-5",
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-5",
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
      "claude-sonnet-4.6",
      "claude-sonnet-4-6",
      "sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5[1m]",
      "sonnet-5",
      "sonnet-4",
      "eu.anthropic.claude-sonnet-5",
      "eu.anthropic.claude-sonnet-4-6",
      "eu.anthropic.claude-sonnet-4.6",
      "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-sonnet-4-6",
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

let _customAliasesCache: Record<string, string> | null = null;

/**
 * Load user-defined custom model aliases dynamically.
 * Priority:
 * 1. In-memory override via setCustomAliases(...)
 * 2. Process environment variable M365_MODEL_ALIASES (JSON object or comma-separated pairs)
 * 3. File explicitly defined in M365_MODEL_ALIASES_FILE
 * 4. ~/.config/m365-copilot-proxy/model-aliases.json
 * 5. ~/.config/opencode-m365/model-aliases.json
 */
export function loadCustomAliases(): Record<string, string> {
  if (_customAliasesCache !== null) {
    return _customAliasesCache;
  }

  const result: Record<string, string> = {};

  // 1. Check custom file path if specified or standard paths
  const candidateFiles = [
    process.env.M365_MODEL_ALIASES_FILE,
    join(homedir(), ".config", "m365-copilot-proxy", "model-aliases.json"),
    join(homedir(), ".config", "opencode-m365", "model-aliases.json"),
  ].filter(Boolean) as string[];

  for (const filePath of candidateFiles) {
    if (existsSync(filePath)) {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") {
              result[k.trim().toLowerCase()] = v.trim();
            }
          }
          break; // Use the first valid configuration file found
        }
      } catch (e) {
        console.warn(`[model-registry] Failed to parse model aliases from ${filePath}: ${e}`);
      }
    }
  }

  // 2. Check M365_MODEL_ALIASES environment variable (takes precedence over file)
  if (process.env.M365_MODEL_ALIASES) {
    const rawEnv = process.env.M365_MODEL_ALIASES.trim();
    if (rawEnv.startsWith("{")) {
      try {
        const parsed = JSON.parse(rawEnv);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string") {
              result[k.trim().toLowerCase()] = v.trim();
            }
          }
        }
      } catch (e) {
        console.warn(`[model-registry] Failed to parse M365_MODEL_ALIASES JSON: ${e}`);
      }
    } else {
      // Parse key=value,key2=value2 or key:value
      const pairs = rawEnv.split(/[,;\n]/);
      for (const pair of pairs) {
        const sep = pair.includes("=") ? "=" : pair.includes(":") ? ":" : null;
        if (sep) {
          const [alias, target] = pair.split(sep);
          if (alias && target) {
            result[alias.trim().toLowerCase()] = target.trim();
          }
        }
      }
    }
  }

  _customAliasesCache = result;
  return result;
}

/** Set custom aliases programmatically (e.g. for testing) */
export function setCustomAliases(aliases: Record<string, string> | null): void {
  if (aliases === null) {
    _customAliasesCache = null;
    return;
  }
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(aliases)) {
    normalized[k.trim().toLowerCase()] = v.trim();
  }
  _customAliasesCache = normalized;
}

/** Reset the custom aliases cache so next call re-reads files/env */
export function clearCustomAliasesCache(): void {
  _customAliasesCache = null;
}

/**
 * Resolve model identifier or alias to its ModelDefinition.
 * Checks dynamic custom aliases first, then static registry aliases.
 * Returns undefined if unknown.
 */
export function getModelDefinition(idOrAlias: string | null | undefined): ModelDefinition | undefined {
  if (!idOrAlias) return undefined;
  const normalized = idOrAlias.trim().toLowerCase();

  // 1. Check custom dynamically loaded aliases
  const custom = loadCustomAliases();
  if (custom[normalized]) {
    const target = custom[normalized].trim().toLowerCase();
    const targetDef = ALIAS_MAP.get(target);
    if (targetDef) return targetDef;
  }

  // 2. Check canonical registry and built-in aliases
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
