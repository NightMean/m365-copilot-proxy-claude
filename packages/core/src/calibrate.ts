import { createLogger } from "./log.js";

const log = createLogger("calibrate");

export interface ObservedProtocolRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  optionsSets?: string[];
  allowedMessageTypes?: string[];
  sliceIds?: string[];
  clientInfo?: Record<string, unknown>;
  extraExtensionParameters?: Record<string, unknown>;
  messageAnnotations?: unknown[];
}

export interface SanitizedRequestCapture {
  url: string;
  method: string;
  headers: Record<string, string>;
  optionsSets: string[];
  allowedMessageTypes: string[];
  sliceIds: string[];
  clientInfo?: Record<string, unknown>;
  capturedAt: string;
}

export type DiffStatus = "match" | "added" | "missing" | "modified";
export type DiffSeverity = "info" | "warning" | "breaking";

export interface ProtocolDiffItem {
  category: "optionsSets" | "allowedMessageTypes" | "sliceIds" | "clientInfo" | "headers";
  item: string;
  status: DiffStatus;
  severity: DiffSeverity;
  details?: string;
}

export interface CalibrationReport {
  timestamp: string;
  source: "browser-capture" | "synthetic-fixture" | "manual-trace";
  isCompatible: boolean;
  breakingCount: number;
  warningCount: number;
  infoCount: number;
  diffs: ProtocolDiffItem[];
  sanitizedCapture: SanitizedRequestCapture;
  recommendations: string[];
}

/** Baseline protocol values matching the gateway's current session defaults. */
export const BASELINE_PROTOCOL = {
  optionsSets: [
    "optionsets_284",
    "flux_prompt_v1",
    "prompt_v1",
    "enforcesharptone",
    "enforcecopilotmodes",
    "refine_query_api",
    "enable_autosuggestion",
  ],
  allowedMessageTypes: [
    "Chat",
    "Suggestion",
    "InternalSearchQuery",
    "Disengaged",
    "InternalLoaderMessage",
    "Progress",
    "RenderCardRequest",
    "SemanticSerp",
    "GenerateContentQuery",
    "SearchQuery",
    "ConfirmationCard",
    "DeveloperLogs",
    "EndOfRequest",
    "ReferencesListComplete",
    "GeneratedCode",
  ],
  requiredHeaders: [
    "accept",
    "authorization",
    "content-type",
    "x-ms-client-request-id",
  ],
};

const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "cookie",
  "x-ms-token",
  "x-ms-refreshtoken",
  "proxy-authorization",
  "set-cookie",
]);

/**
 * Sanitize captured HTTP headers so tokens, session cookies, and credentials
 * are never recorded to disk or surfaced in reports.
 */
export function sanitizeHeaders(rawHeaders: Record<string, string> = {}): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_KEYS.has(lowerKey)) {
      sanitized[lowerKey] = "[REDACTED_SECRET]";
    } else if (lowerKey.includes("token") || lowerKey.includes("secret") || lowerKey.includes("auth")) {
      sanitized[lowerKey] = "[REDACTED_SENSITIVE]";
    } else {
      sanitized[lowerKey] = value;
    }
  }
  return sanitized;
}

/**
 * Compare an observed M365 Copilot request against the gateway's baseline.
 * Detects new feature flags, removed message types, or missing headers.
 */
export function compareProtocol(
  observed: ObservedProtocolRequest,
  source: CalibrationReport["source"] = "browser-capture",
): CalibrationReport {
  const diffs: ProtocolDiffItem[] = [];
  const recommendations: string[] = [];

  const obsOptionsSets = new Set(observed.optionsSets ?? []);
  const baseOptionsSets = new Set(BASELINE_PROTOCOL.optionsSets);

  // Check optionsSets
  for (const opt of obsOptionsSets) {
    if (!baseOptionsSets.has(opt)) {
      diffs.push({
        category: "optionsSets",
        item: opt,
        status: "added",
        severity: "info",
        details: `Microsoft added new optionsSet: "${opt}". Can be tested with M365_EXTRA_OPTIONSSETS="${opt}".`,
      });
    }
  }
  for (const opt of baseOptionsSets) {
    if (!obsOptionsSets.has(opt)) {
      diffs.push({
        category: "optionsSets",
        item: opt,
        status: "missing",
        severity: "warning",
        details: `Baseline optionsSet "${opt}" was not observed in upstream request.`,
      });
    }
  }

  // Check allowedMessageTypes
  const obsMsgTypes = new Set(observed.allowedMessageTypes ?? []);
  const baseMsgTypes = new Set(BASELINE_PROTOCOL.allowedMessageTypes);

  for (const mt of obsMsgTypes) {
    if (!baseMsgTypes.has(mt)) {
      diffs.push({
        category: "allowedMessageTypes",
        item: mt,
        status: "added",
        severity: "info",
        details: `New message type "${mt}" available from upstream.`,
      });
    }
  }
  for (const mt of baseMsgTypes) {
    if (!obsMsgTypes.has(mt)) {
      diffs.push({
        category: "allowedMessageTypes",
        item: mt,
        status: "missing",
        severity: "warning",
        details: `Expected message type "${mt}" missing from observed request.`,
      });
    }
  }

  // Check sliceIds (A/B testing experiments)
  const sliceIds = observed.sliceIds ?? [];
  if (sliceIds.length > 0) {
    for (const slice of sliceIds) {
      diffs.push({
        category: "sliceIds",
        item: slice,
        status: "added",
        severity: "info",
        details: `Active Microsoft flight experiment slice: "${slice}".`,
      });
    }
  }

  // Check headers
  const sanitized = sanitizeHeaders(observed.headers);
  for (const requiredHeader of BASELINE_PROTOCOL.requiredHeaders) {
    if (!sanitized[requiredHeader]) {
      diffs.push({
        category: "headers",
        item: requiredHeader,
        status: "missing",
        severity: "breaking",
        details: `Required HTTP header "${requiredHeader}" was absent.`,
      });
      recommendations.push(`Ensure header "${requiredHeader}" is supplied by the transport layer.`);
    }
  }

  let breakingCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  for (const diff of diffs) {
    if (diff.severity === "breaking") breakingCount++;
    else if (diff.severity === "warning") warningCount++;
    else infoCount++;
  }

  const isCompatible = breakingCount === 0;
  if (!isCompatible) {
    recommendations.push("Upstream request shape has breaking differences. Review diffs and update session framing.");
  } else if (diffs.some((d) => d.status === "added" && d.category === "optionsSets")) {
    recommendations.push("New optionsSets detected. Consider evaluating them for enhanced reasoning or tool latency.");
  } else {
    recommendations.push("Upstream protocol is fully compatible with local gateway baseline.");
  }

  return {
    timestamp: new Date().toISOString(),
    source,
    isCompatible,
    breakingCount,
    warningCount,
    infoCount,
    diffs,
    sanitizedCapture: {
      url: observed.url ?? "https://copilot.microsoft.com/c/api/chat",
      method: observed.method ?? "POST",
      headers: sanitized,
      optionsSets: Array.from(obsOptionsSets),
      allowedMessageTypes: Array.from(obsMsgTypes),
      sliceIds,
      clientInfo: observed.clientInfo,
      capturedAt: new Date().toISOString(),
    },
    recommendations,
  };
}

/** Formats a calibration report as a readable markdown document. */
export function formatCalibrationMarkdown(report: CalibrationReport): string {
  const lines: string[] = [
    `# M365 Copilot Protocol Calibration Report`,
    ``,
    `- **Captured At:** ${report.timestamp}`,
    `- **Source:** ${report.source}`,
    `- **Compatible:** ${report.isCompatible ? "YES" : "NO (Breaking changes detected)"}`,
    `- **Summary:** ${report.breakingCount} breaking, ${report.warningCount} warnings, ${report.infoCount} notices`,
    ``,
    `## Recommendations`,
    ...report.recommendations.map((r) => `- ${r}`),
    ``,
    `## Protocol Differences`,
    `| Category | Item | Status | Severity | Details |`,
    `| --- | --- | --- | --- | --- |`,
    ...report.diffs.map(
      (d) => `| ${d.category} | \`${d.item}\` | ${d.status} | **${d.severity}** | ${d.details ?? ""} |`,
    ),
    ``,
    `## Sanitized Captured Headers`,
    `\`\`\`json`,
    JSON.stringify(report.sanitizedCapture.headers, null, 2),
    `\`\`\``,
  ];
  return lines.join("\n");
}
