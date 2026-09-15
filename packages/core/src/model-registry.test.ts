import { describe, it, expect } from "vitest";
import {
  getModelDefinition,
  resolveModelStrict,
  listAllModels,
  formatModelCapabilityTable,
  CANONICAL_REGISTRY,
} from "./model-registry.js";
import { ModelUnavailableError, ModelCapabilityUnsupportedError } from "./errors.js";

describe("Model Registry", () => {
  it("resolves canonical model IDs", () => {
    const gpt56 = getModelDefinition("gpt-5.6-think-deeper");
    expect(gpt56).toBeDefined();
    expect(gpt56?.m365Tone).toBe("Gpt_5_6_Reasoning");
    expect(gpt56?.supportsReasoning).toBe(true);

    const opus = getModelDefinition("claude-opus");
    expect(opus).toBeDefined();
    expect(opus?.m365Tone).toBe("Claude_Opus");

    const sonnet = getModelDefinition("claude-sonnet");
    expect(sonnet).toBeDefined();
    expect(sonnet?.m365Tone).toBe("Claude_Sonnet");
  });

  it("resolves aliases truthfully without silent demotion", () => {
    // gpt-5.6 aliases must resolve to Gpt_5_6_Reasoning, NEVER Gpt_5_5_Reasoning
    expect(resolveModelStrict("gpt-5.6").m365Tone).toBe("Gpt_5_6_Reasoning");
    expect(resolveModelStrict("gpt-5.6-sol").m365Tone).toBe("Gpt_5_6_Reasoning");
    expect(resolveModelStrict("sol").m365Tone).toBe("Gpt_5_6_Reasoning");

    // claude-opus aliases must resolve to Claude_Opus, NEVER GPT or magic
    expect(resolveModelStrict("claude-opus-5").m365Tone).toBe("Claude_Opus");
    expect(resolveModelStrict("opus").m365Tone).toBe("Claude_Opus");
    expect(resolveModelStrict("opus-5").m365Tone).toBe("Claude_Opus");
    expect(resolveModelStrict("claude-3-opus").m365Tone).toBe("Claude_Opus");
    expect(resolveModelStrict("claude-opus-4.8").m365Tone).toBe("Claude_Opus");

    // Enterprise policy spoof: opus-4.6 explicitly aliases GPT-5.5 Reasoning
    expect(resolveModelStrict("claude-opus-4.6").m365Tone).toBe("Gpt_5_5_Reasoning");
    expect(resolveModelStrict("opus-4.6").m365Tone).toBe("Gpt_5_5_Reasoning");
    expect(resolveModelStrict("eu.anthropic.claude-opus-4.6").m365Tone).toBe("Gpt_5_5_Reasoning");

    // Enterprise Sonnet aliases resolve to Claude_Sonnet
    expect(resolveModelStrict("claude-sonnet-4.6").m365Tone).toBe("Claude_Sonnet");
    expect(resolveModelStrict("eu.anthropic.claude-sonnet-5").m365Tone).toBe("Claude_Sonnet");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveModelStrict("  GPT-5.6-THINK-DEEPER  ").m365Tone).toBe("Gpt_5_6_Reasoning");
    expect(resolveModelStrict("Claude-Opus-5").m365Tone).toBe("Claude_Opus");
  });

  it("throws ModelUnavailableError for unknown models", () => {
    expect(() => resolveModelStrict("non-existent-model-xyz")).toThrow(ModelUnavailableError);
  });

  it("validates requested capabilities strictly", () => {
    // Test capability requirements
    expect(() => resolveModelStrict("claude-sonnet", { requireVision: true })).not.toThrow();
  });

  it("formats a human-readable CLI table with all models", () => {
    const table = formatModelCapabilityTable();
    expect(table).toContain("ID");
    expect(table).toContain("M365 Tone");
    expect(table).toContain("Gpt_5_6_Reasoning");
    expect(table).toContain("Claude_Opus");
  });

  it("lists all registered models", () => {
    const list = listAllModels();
    expect(list.length).toBe(Object.keys(CANONICAL_REGISTRY).length);
    expect(list.some((m) => m.id === "gpt-5.6-think-deeper")).toBe(true);
    expect(list.some((m) => m.id === "claude-opus")).toBe(true);
  });
});
