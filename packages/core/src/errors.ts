export type ProxyErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_EXPIRED"
  | "CONDITIONAL_ACCESS_REJECTED"
  | "MODEL_UNAVAILABLE"
  | "MODEL_CAPABILITY_UNSUPPORTED"
  | "M365_DISENGAGED"
  | "M365_THROTTLED"
  | "CONVERSATION_EXPIRED"
  | "INVALID_TOOL_CALL"
  | "TOOL_SCHEMA_TOO_LARGE"
  | "UPSTREAM_PROTOCOL_CHANGED"
  | "UPSTREAM_TIMEOUT"
  | "UNSUPPORTED_MODEL"
  | "M365_THREAD_THROTTLED"
  | "M365_AGENT_INCOMPATIBLE"
  | "M365_INVALID_SESSION"
  | "M365_CONTENT_FILTERED"
  | "M365_EMPTY_RESPONSE"
  | "M365_UPSTREAM_ERROR"
  | "M365_AUTHENTICATION_FAILED"
  | "M365_BAD_REQUEST";

export class M365ProxyError extends Error {
  readonly status: number;
  readonly code: ProxyErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(options: {
    message: string;
    status: number;
    code: ProxyErrorCode;
    retryable: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "M365ProxyError";
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

export class AuthenticationRequiredError extends M365ProxyError {
  constructor(message = "Microsoft 365 authentication required. Please run `m365-copilot login`.") {
    super({ message, status: 401, code: "AUTHENTICATION_REQUIRED", retryable: false });
    this.name = "AuthenticationRequiredError";
  }
}

export class AuthenticationExpiredError extends M365ProxyError {
  constructor(message = "Microsoft 365 authentication token has expired.") {
    super({ message, status: 401, code: "AUTHENTICATION_EXPIRED", retryable: true });
    this.name = "AuthenticationExpiredError";
  }
}

export class ConditionalAccessRejectedError extends M365ProxyError {
  constructor(message = "Microsoft Conditional Access policy rejected the authentication request.") {
    super({ message, status: 403, code: "CONDITIONAL_ACCESS_REJECTED", retryable: false });
    this.name = "ConditionalAccessRejectedError";
  }
}

export class ModelUnavailableError extends M365ProxyError {
  readonly requestedModel: string;
  readonly supportedModels?: string[];

  constructor(requestedModel: string, supportedModels?: string[], customMessage?: string) {
    const message =
      customMessage ??
      `Model "${requestedModel}" is unavailable on Microsoft 365 Copilot.${
        supportedModels?.length ? ` Available models: ${supportedModels.slice(0, 10).join(", ")}.` : ""
      }`;
    super({
      message,
      status: 404,
      code: "MODEL_UNAVAILABLE",
      retryable: false,
      details: { requestedModel, supportedModels },
    });
    this.name = "ModelUnavailableError";
    this.requestedModel = requestedModel;
    this.supportedModels = supportedModels;
  }
}

export class ModelCapabilityUnsupportedError extends M365ProxyError {
  readonly modelId: string;
  readonly capability: string;

  constructor(modelId: string, capability: string, customMessage?: string) {
    const message =
      customMessage ??
      `Model "${modelId}" does not support requested capability "${capability}".`;
    super({
      message,
      status: 400,
      code: "MODEL_CAPABILITY_UNSUPPORTED",
      retryable: false,
      details: { modelId, capability },
    });
    this.name = "ModelCapabilityUnsupportedError";
    this.modelId = modelId;
    this.capability = capability;
  }
}

export class M365DisengagedError extends M365ProxyError {
  constructor(message = "Microsoft 365 Copilot disengaged from the conversation turn.") {
    // Return 502 with retryable=false to prevent automatic Claude Code retry storms
    super({ message, status: 502, code: "M365_DISENGAGED", retryable: false });
    this.name = "M365DisengagedError";
  }
}

export class M365ThrottledError extends M365ProxyError {
  constructor(retryAfterMs = 5000, message = "Microsoft 365 Copilot rate limit or thread quota reached.") {
    super({
      message,
      status: 429,
      code: "M365_THROTTLED",
      retryable: true,
      retryAfterMs,
      details: { retryAfterMs },
    });
    this.name = "M365ThrottledError";
  }
}

export class ConversationExpiredError extends M365ProxyError {
  constructor(message = "The Microsoft 365 Copilot conversation session has expired or is no longer found.") {
    super({ message, status: 410, code: "CONVERSATION_EXPIRED", retryable: true });
    this.name = "ConversationExpiredError";
  }
}

export class InvalidToolCallError extends M365ProxyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super({ message, status: 400, code: "INVALID_TOOL_CALL", retryable: false, details });
    this.name = "InvalidToolCallError";
  }
}

export class ToolSchemaTooLargeError extends M365ProxyError {
  constructor(message = "Tool definitions exceed Microsoft 365 prompt threshold. Try narrowing tool allowlist.") {
    super({ message, status: 400, code: "TOOL_SCHEMA_TOO_LARGE", retryable: false });
    this.name = "ToolSchemaTooLargeError";
  }
}

export class UpstreamProtocolChangedError extends M365ProxyError {
  constructor(message = "Unexpected frame or schema format from Microsoft 365 Copilot.") {
    super({ message, status: 502, code: "UPSTREAM_PROTOCOL_CHANGED", retryable: false });
    this.name = "UpstreamProtocolChangedError";
  }
}

export class UpstreamTimeoutError extends M365ProxyError {
  constructor(message = "Timed out waiting for response from Microsoft 365 Copilot.") {
    super({ message, status: 504, code: "UPSTREAM_TIMEOUT", retryable: true });
    this.name = "UpstreamTimeoutError";
  }
}

/** Legacy alias kept for backwards compatibility */
export class UnsupportedModelError extends ModelUnavailableError {}

const SENSITIVE_KEYS = /^(authorization|cookie|token|access_token|refresh_token|secret|api_key|password)$/i;

/** Recursively redact sensitive fields from objects before logging or error responses. */
export function redactSensitive<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  if (Array.isArray(value)) {
    return value.map(redactSensitive) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.test(k)) {
      result[k] = "[REDACTED]";
    } else if (typeof v === "object" && v !== null) {
      result[k] = redactSensitive(v);
    } else {
      result[k] = v;
    }
  }
  return result as T;
}

export type AnthropicErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export function toAnthropicError(err: unknown): {
  status: number;
  body: {
    type: "error";
    error: {
      type: AnthropicErrorType;
      message: string;
      code?: string;
    };
  };
} {
  if (err instanceof M365ProxyError) {
    let errorType: AnthropicErrorType = "api_error";
    if (err.status === 401) errorType = "authentication_error";
    else if (err.status === 403) errorType = "permission_error";
    else if (err.status === 404) errorType = "not_found_error";
    else if (err.status === 400) errorType = "invalid_request_error";
    else if (err.status === 429) errorType = "rate_limit_error";
    else if (err.status === 502 || err.status === 504) errorType = "api_error";

    return {
      status: err.status,
      body: {
        type: "error",
        error: {
          type: errorType,
          message: err.message,
          code: err.code,
        },
      },
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    body: {
      type: "error",
      error: {
        type: "api_error",
        message: message || "Internal gateway error",
      },
    },
  };
}
