export {
  getToken,
  getTokenSilent,
  getTokenForScope,
  getImageArtifactToken,
  loginAutomated,
  loginInteractive,
  loginInteractiveForScopes,
  loginDeviceCode,
  loginDeviceCodeForScopes,
  loadSecrets,
  forceReauth,
  type DeviceCodePrompt,
} from "./auth.js";

export {
  generateImage,
  fetchImageBytes,
  buildImagePrompt,
  classifyImageFailure,
  ImageGenerationError,
  type GeneratedImage,
  type GenerateImageOptions,
  type ImageOrientation,
  type ImageStyle,
  type ImageGenFailureReason,
} from "./image.js";

export {
  UPLOAD_FILE_URL,
  UPLOAD_VARIANTS,
  UPLOAD_OPTIONS_SETS,
  IMAGE_FRAME_OPTIONS_SETS,
  SUPPORTED_IMAGE_TYPES,
  MAX_IMAGE_SIZE_BYTES,
  validateInputImage,
  extractAnthropicImages,
  uploadImageToSubstrate,
  type InputImage,
  type UploadedImageAnnotation,
} from "./vision.js";

export {
  noteRequestOutcome,
  awaitDegradationBackoff,
  isDegradationBackoff,
  createBackoffController,
  type BackoffController,
  type BackoffOptions,
} from "./auth-recovery.js";

export {
  M365ProxyError,
  UnsupportedModelError,
  AuthenticationRequiredError,
  AuthenticationExpiredError,
  ConditionalAccessRejectedError,
  ModelUnavailableError,
  ModelCapabilityUnsupportedError,
  M365DisengagedError,
  M365ThrottledError,
  ConversationExpiredError,
  InvalidToolCallError,
  ToolSchemaTooLargeError,
  UpstreamProtocolChangedError,
  UpstreamTimeoutError,
  redactSensitive,
  toAnthropicError,
  type ProxyErrorCode,
  type AnthropicErrorType,
} from "./errors.js";

export {
  CANONICAL_REGISTRY,
  getModelDefinition,
  resolveModelStrict,
  listAllModels,
  formatModelCapabilityTable,
  loadCustomAliases,
  setCustomAliases,
  clearCustomAliasesCache,
  type ModelDefinition,
  type ResolveModelOptions,
} from "./model-registry.js";

export { getOrCreateAgent, getOrCreateAgentSingleFlight } from "./agent.js";

export {
  decodeJwt,
  getToneForModel,
  getAvailableModels,
  resolveModel,
  normalizeModelName,
  CANONICAL_MODELS,
  MODEL_ALIASES,
  type ModelConfig,
  type ResolvedModel,
  type BackendFamily,
  type ToolMode,
  type CopilotStream,
  type CapturedImage,
} from "./copilot.js";

export {
  CopilotSession,
  type CopilotSessionOptions,
  type ChatTurnOptions,
  type NativeActionConfig,
} from "./session.js";

export {
  parseActionConfirmation,
  buildResumeInvokeAction,
  shouldAutoConfirm,
  buildNativeActionPrompt,
  NATIVE_ACTION_INSTRUCTIONS,
  ACTION_ALLOWED_MESSAGE_TYPES,
  ACTION_CONFIRM_MESSAGE_TYPES,
  type ActionConfirmation,
} from "./native-actions.js";

export {
  ModelSession,
  RealM365Transport,
  type ModelSessionOptions,
  type ModelTransport,
} from "./model.js";

export {
  FakeTransport,
  type FakeTransportOptions,
  type FakeProtocolFixture,
} from "./fake.js";

export {
  listSystemPrompts,
  getSystemPrompt,
  resolveSystemPromptSpec,
  findSystemPromptIndex,
  clearSystemPromptCache,
  type SystemPromptMeta,
} from "./prompts.js";

export {
  formatMessages,
  formatToolDefinitions,
  formatToolChoiceInstruction,
  getMessageContent,
  parseToolCalls,
  looksLikeConfabulation,
  looksLikeHallucinatedCompletion,
  looksLikeRemoteArtifactCompletion,
  isProseDocument,
  type Message,
  type ToolDef,
  type ToolFunction,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "./tools.js";

export { createLogger, trunc, LOG_PATH } from "./log.js";

export {
  formatFencedToolDefinitions,
  deriveFencedSpec,
  parseFencedToolCalls,
  FRAMING_VARIANT_NAMES,
  hostPlatformNote,
  findShellTool,
} from "./fenced.js";

export {
  sanitizeHeaders,
  compareProtocol,
  formatCalibrationMarkdown,
  BASELINE_PROTOCOL,
  type ObservedProtocolRequest,
  type SanitizedRequestCapture,
  type ProtocolDiffItem,
  type CalibrationReport,
  type DiffStatus,
  type DiffSeverity,
} from "./calibrate.js";
