# AGENTS.md

## Project

A local Microsoft 365 Copilot gateway proxy exposing the Anthropic Messages API (`/v1/messages`) so that CLI tools can use Microsoft 365 Copilot models as backend inference engines.

## Commands & Verification

- Install dependencies: `pnpm install`
- Run test suite: `pnpm test` (or `npx vitest run`)
- Check TypeScript compilation: `pnpm build`
- Start local proxy daemon: `pnpm start`
- CLI status check: `pnpm m365-copilot status`

## Architecture & Workspaces

Pnpm monorepo containing:
- `packages/core/` — core protocol translation, model registry, tool extraction, and auth.
- `packages/proxy-lib/` — session management, SQLite persistence, and Anthropic HTTP server.
- `packages/proxy/` — CLI application and standalone server entry points.

## Repository policy

The repository is permanently private. The owner authorized tracking this AGENTS.md.
The owner authorizes automatic pushes of verified changes to origin/main while GitHub confirms this repository is private. Check visibility before pushing; do not automatically push if it is public or visibility cannot be confirmed.

---

Build a production-quality local Microsoft 365 Copilot gateway whose **primary client is Claude Code CLI**.

The main objective is:

```text
Claude Code CLI
      │
      │ Anthropic Messages API
      ▼
Local M365 gateway
      │
      │ Microsoft 365 Copilot private web protocol
      ▼
Microsoft 365 Copilot
      ├── GPT-5.6
      └── Claude Opus / Opus 5 when actually available
```

The implementation should combine the strongest parts of several existing Microsoft 365 Copilot projects rather than reinventing the protocol or merging repositories blindly.

## Implementation Progress & Status Tracker

> **Network / Environment Notice:** Live testing against Microsoft 365 Copilot (`login`, live SignalR inference) is currently unavailable due to corporate network/VPN access constraints. All gateway functionality, Anthropic Messages protocol compliance, tool loops, and session handling are validated offline via `vitest` and the deterministic `FakeTransport` fixture suite.

### Phase 0: Upstream Provenance & Research
- [x] Cloned and analyzed all 4 upstream repositories (`mahmoudsallem`, `cramt`, `theprosonce`, `iv0rish`).
- [x] Pinned exact HEAD commit SHAs, dates, licenses, and divergence metrics (`mahmoudsallem` is 27 commits ahead and 9 commits behind `cramt`).
- [x] Created `docs/upstream-provenance.md` containing the complete feature traceability matrix and licensing analysis.

### Workspace Setup & Base Codebase
- [x] Populated monorepo workspace from primary base `mahmoudsallem/m365-copilot-proxy-claude`.
- [x] Configured `pnpm` workspaces (`packages/core`, `packages/proxy-lib`, `packages/proxy`).
- [x] Configured root `vitest.config.ts` excluding `.scratch/` and node_modules.
- [x] Installed dependencies (`pnpm install`) and verified baseline test suite (25 test files, 256 tests passing).

### Upstream Protocol Fixes (Ported from `cramt`)
- [x] Windows shell routing: unconditionally route `powershell`, `pwsh`, `cmd`, `bat` in `packages/core/src/fenced.ts`.
- [x] Host platform note: inject `hostPlatformNote()` on Windows to steer model away from POSIX heredocs/sed.
- [x] Remote artifact completion guard: `looksLikeRemoteArtifactCompletion` detecting Teams asyncgw diff links and citation markers in `packages/core/src/tools.ts`.
- [x] GPT-5.6 remote runtime confabulation patterns added to `CONFABULATION_PATTERNS`.
- [x] Power Platform host derivation fix in `packages/core/src/agent.ts`.
- [x] Interactive login race timer clearing in `packages/core/src/auth.ts`.

### Core Architecture & Routing
- [x] Centralized Model Registry (`packages/core/src/model-registry.ts`) enforcing strict model truthfulness (zero silent fallback for `claude-opus`, `claude-opus-5`, `gpt-5.6-think-deeper`).
- [x] Explicit error hierarchy (`packages/core/src/errors.ts`) mapping M365 issues (Disengaged, Throttled, AuthExpired, ModelUnavailable) to Anthropic HTTP codes.
- [x] Input vision support: TypeScript implementation of `UploadFile` multipart endpoint with `docId` annotations in `packages/core/src/vision.ts` and `anthropic.ts`.
- [x] SQLite + JSON session persistence with TTL and LRU eviction in `packages/proxy-lib/src/session-store.ts`.
- [x] Grounding controls (`agent=web` default for coding, `agent=work` opt-in) and temporary chat (`disableMemory=1`) in `packages/core/src/session.ts`.

### Fake Simulator & Offline Test Suite
- [x] Extended `FakeTransport` supporting all 12 protocol test fixtures (normal text, streamed text, tool call, multi-tool, malformed tool, confabulated prose, Disengaged, 429 throttle, expired auth, conversation expiry, image response, unknown frame).
- [x] Offline end-to-end acceptance tests verifying complete Claude Code bridge.

### CLI, Observability & Claude Code Integration
- [x] Reversible Claude Code connection scripts (`connect-claude.ps1`, `disconnect-claude.ps1`).
- [x] CLI commands: `m365-copilot status`, `models`, `doctor`, `calibrate`.
- [x] Live benchmark scripts prepared for when network connectivity to O365 is restored.

---

## Source repositories

Use these exact GitHub repositories:

1. `mahmoudsallem/m365-copilot-proxy-claude`

   * PRIMARY BASE.
   * This should be the starting codebase unless investigation finds a compelling architectural reason otherwise.

2. `cramt/m365-copilot-proxy`

   * Treat this as the upstream/reference implementation for the Microsoft 365 Copilot protocol, tool emulation, model/tone research, throttling behavior, session handling, and current upstream fixes.

3. `Theprosonce/m365-copilot-proxy`

   * Use selectively for features such as input vision/file upload, persistent session concepts, temporary/private conversations, grounding controls, and potentially browser-token/session-management ideas.
   * Do NOT replace the cramt-lineage tool implementation with this project's simpler tool translation.

4. `iv0rish/m365-copilot-proxy`

   * Use only as a DESIGN REFERENCE for its browser calibration approach, in which a dedicated M365 browser session observes the current same-origin web request shape and stores a sanitized calibration.
   * Do not copy source from this repository unless you first establish that its license permits it. If no explicit license exists, reproduce the architectural idea independently.

Do not introduce unrelated gateway projects.

---

# Phase 0 — investigate and pin upstream provenance

Before modifying code, clone/fetch all four repositories and inspect them carefully.

Record:

* current branch
* exact HEAD SHA
* commit date
* repository license
* relevant feature-introducing commits
* relevant source files
* whether the primary repository is ahead/behind/diverged from `cramt`

Create:

```text
docs/upstream-provenance.md
```

containing this information.

Do not rely only on README claims. Verify features against source and tests.

Use Git history searches such as:

```bash
git log --all --oneline -S'Gpt_5_6_Reasoning'
git log --all --oneline -S'Claude_Opus'
git log --all --oneline -S'/v1/messages'
git log --all --oneline -S'count_tokens'
git log --all --oneline -S'M365_ALLOW_MULTI_TOOL'
git log --all --oneline -S'M365_CONFAB_RETRIES'
git log --all --oneline -S'UploadFile'
git log --all --oneline -S'sessions.db'
git log --all --oneline -- docs/claude-code.md
```

Also inspect blame/file history for the implementations, not just commit messages.

If a useful feature has subsequently been improved upstream, take the newest sound implementation rather than an older feature-introducing commit.

Keep a table documenting:

```text
Feature
Source repository
Source commit
Source files
Copied / adapted / reimplemented
Reason
License implications
```

---

# Architectural direction

Prefer keeping the TypeScript/Node architecture of the `cramt` lineage.

Do NOT combine entire applications wholesale.

The resulting architecture should have explicit layers:

```text
┌─────────────────────────────────────┐
│ Claude Code / Anthropic API layer   │
├─────────────────────────────────────┤
│ Model + capability routing          │
├─────────────────────────────────────┤
│ Tool emulation / agent layer        │
├─────────────────────────────────────┤
│ M365 conversation/session layer     │
├─────────────────────────────────────┤
│ M365 SignalR/WebSocket transport    │
├─────────────────────────────────────┤
│ Authentication / token management   │
└─────────────────────────────────────┘
```

Avoid mixing client protocol conversion directly into low-level Microsoft transport code.

The Microsoft-facing core should ideally be usable independently of Claude Code.

---

# 1. Start from `mahmoudsallem/m365-copilot-proxy-claude`

Use this repository as the initial base because it already contains Claude Code-oriented integration on top of the cramt architecture.

Preserve and audit its implementations for:

### Anthropic API

Support at minimum:

```text
POST /v1/messages
POST /v1/messages/count_tokens
GET  /v1/models
```

Implement both streaming and non-streaming Anthropic Messages responses.

Correctly support:

* `system`
* text content blocks
* user messages
* assistant messages
* `tool_use`
* `tool_result`
* multiple content blocks
* stop reasons
* errors
* request IDs
* streaming event ordering
* SSE heartbeats where upstream M365 cannot produce token-live output

Do not falsely report exact token usage when M365 does not provide it.

If `count_tokens` must remain approximate, clearly expose/document that fact.

### Claude Code integration

Retain or improve the reversible Claude Code connection mechanism.

The expected workflow should be approximately:

```text
m365-copilot login
m365-copilot start
m365-copilot connect-claude

claude
```

And support:

```text
claude-direct
m365-copilot disconnect-claude
```

Connecting the gateway must NOT destroy or overwrite the user's normal Claude credentials.

Use:

```text
ANTHROPIC_BASE_URL
ANTHROPIC_AUTH_TOKEN
```

or whatever current Claude Code expects after verifying against the installed/current Claude Code behavior.

Back up any settings before modifying them.

Never configure conflicting authentication mechanisms simultaneously.

---

# 2. Continuously diff against `cramt/m365-copilot-proxy`

Do not treat the primary fork as authoritative when `cramt` contains newer fixes.

The cramt implementation should be the main reference for the actual Microsoft protocol.

Preserve or port its strongest implementation of:

## SignalR/WebSocket transport

Use Microsoft's observed M365 Copilot transport rather than UI DOM automation for normal inference.

Keep transport concerns isolated.

Handle:

* SignalR framing
* reconnects
* request correlation
* conversation IDs
* session IDs
* content frames
* completion frames
* errors
* timeouts
* throttling
* unexpected/unknown frames without crashing

Keep raw-frame debug dumping available behind an explicit debug option.

## Conversation reuse and delta sending

Reuse the same M365 conversation for follow-up turns wherever appropriate.

Do not retransmit the entire Claude Code history to Microsoft on every turn if M365 already retains that conversation state.

Detect when a new client conversation starts.

Preserve the quota-saving delta behavior from `cramt`.

Avoid accidentally mixing two independent Claude Code sessions into one M365 conversation.

## Tool calling

This is one of the most important parts of the project.

M365 Copilot does not expose normal Anthropic/OpenAI native function calling through this interface.

Use the proven cramt approach:

* inject concise tool definitions into the model instructions
* use fenced tool-call syntax
* parse the model's fenced tool call
* validate tool name
* validate arguments against the client tool schema
* repair safely when possible
* convert the validated result into an Anthropic `tool_use`
* return it to Claude Code
* let Claude Code execute the tool
* receive Claude Code's `tool_result`
* continue the same M365 conversation

The gateway MUST NOT execute Claude Code's Bash/Read/Edit/etc. itself.

Claude Code remains the tool executor and permission boundary.

### Shell routing

Preserve the shell-routing technique from `cramt`.

M365 models have shown significantly better action compliance when a shell-like tool is represented through a bash fenced block rather than simply asking the model to behave like a generic tool-calling agent.

Do not simplify this away without benchmarking the replacement.

### Copilot Studio agent

Preserve the optional/necessary Copilot Studio agent mechanism used by `cramt` for reliable GPT tool calling.

Keep agent creation, publication and cached agent ID handling isolated in its own subsystem.

Do not recreate/publish an agent unnecessarily on every startup.

### Multi-tool behavior

Support multiple tool calls per turn if upstream behavior is sufficiently reliable.

Keep a configuration switch if necessary.

Ensure Anthropic output looks like valid multiple `tool_use` content blocks.

### Confabulation recovery

Preserve the cramt behavior for cases where M365:

* claims it edited a file without making a tool call
* says it cannot access files despite tools being available
* responds with prose when action is clearly required

Allow a bounded corrective retry within the same conversation.

Never create an unbounded retry loop.

### Disengaged handling

Treat M365 `Disengaged`/empty filtered responses explicitly.

Do NOT let Claude Code automatically trigger a retry storm that consumes large numbers of M365 messages.

Return a suitable non-retryable or carefully classified error when appropriate.

Implement sensible backoff for account-level degradation/thread-rate throttling.

---

# 3. GPT-5.6 support

The current `cramt` research identifies:

```text
gpt-5.6-think-deeper
→ Gpt_5_6_Reasoning
```

Implement this model explicitly.

Expose at least:

```text
gpt-5.6
gpt-5.6-think-deeper
```

If both aliases resolve to the same currently available M365 tone, document that.

Do not assume GPT-5.6 has the same tool reliability as GPT-5.5 merely because the tone is accepted.

Create a live benchmark covering:

* text generation
* Read
* Bash
* Edit
* multi-turn tool loop
* multiple tool calls
* confabulation rate
* Disengaged rate
* latency

Keep GPT-5.5 reasoning available as a fallback/testing baseline while GPT-5.6 tool reliability is being validated.

Do NOT silently route a requested GPT-5.6 call to GPT-5.5 unless the user explicitly enables fallback behavior.

---

# 4. Claude Opus / Opus 5 support

The cramt protocol research identifies the M365 tone:

```text
Claude_Opus
```

and exposes/experiments with a `claude-opus` model.

Implement aliases such as:

```text
claude-opus
claude-opus-5
```

but be extremely strict about model truthfulness.

A request for:

```text
claude-opus-5
```

must NEVER silently become:

```text
GPT-5.5
GPT-5.6
magic/auto
```

unless the user has explicitly enabled model fallback.

This changes behavior currently present in some Claude Code integration code where unsupported Anthropic picker models are mapped back to a GPT reasoning model. Remove that behavior for explicit model requests.

Instead:

```text
requested Claude Opus
        │
        ├── supported and validated
        │      → use Claude_Opus
        │
        └── unavailable / incompatible
               → return an explicit model-unavailable error
```

Do not claim that `Claude_Opus` is definitely "Claude Opus 5" solely because the tone is accepted.

Validate as much as the M365 protocol allows and distinguish:

```text
requested model alias
requested M365 tone
server-observed metadata
empirically observed identity
verified exact model generation
```

in diagnostics.

If Microsoft does not expose authoritative exact-version metadata, say so.

## Critical Opus + tool investigation

Investigate whether attaching the Copilot Studio tool agent causes Microsoft to ignore/override the requested Claude tone.

Test at minimum:

```text
Claude_Opus without tools/agent
Claude_Opus with tool definitions but no Studio agent
Claude_Opus with Studio agent
Claude_Opus across multiple conversations
Claude_Opus with Bash/Read/Edit loops
```

Do not hide the result.

If M365 currently supports real Opus only on the agent-less path, architect capabilities accordingly:

```text
Claude Opus:
    chat       supported
    vision     maybe supported after testing
    tools      unsupported/experimental

GPT-5.6:
    chat       supported
    tools      supported if benchmarks pass
```

A truthful capability matrix is better than secretly substituting GPT.

---

# 5. Claude Code tool-set pressure

Claude Code can advertise many tools, while M365 may disengage when tool schemas become too large.

Keep the default M365-facing tool payload deliberately small.

Start with the proven core:

```text
Bash
Read
Edit
Write
Glob
Grep
```

Make the allowlist configurable.

Do not remove tools from Claude Code globally; only control which tools are advertised to M365 for a particular request.

Log at debug level which tools were:

```text
received from Claude Code
advertised to M365
filtered
```

without logging secrets/tool results unnecessarily.

Investigate better approaches for supporting additional Claude Code/MCP tools without exceeding the M365 prompt/filter threshold, but do not regress the reliable six-tool path merely to advertise everything.

---

# 6. Authentication

Prefer the safer interactive-login behavior from the primary Claude-oriented implementation.

Desired behavior:

```text
m365-copilot login
```

opens an isolated Chromium/Edge profile.

The user enters:

* email
* password
* MFA

only on Microsoft's own login page.

The application should store reusable OAuth/MSAL state, not the user's Microsoft password or MFA seed.

Support silent token refresh using the cached authenticated state.

Device-code login may be provided as an optional alternative where tenant policy permits it.

For server/headless deployments, retain the possibility of the cramt automated/headless mechanism if useful, but do not make storing a raw password + TOTP secret the default requirement for desktop/local usage.

Never read cookies from the user's ordinary browser profile.

Never log OAuth tokens.

---

# 7. Local gateway security

Bind to:

```text
127.0.0.1
```

by default.

Require a generated local bearer token for model-consuming endpoints.

Store it with restrictive permissions.

Refuse public/non-loopback binding unless explicitly configured.

Never print:

* Microsoft passwords
* MFA seeds
* refresh tokens
* access tokens
* Claude credentials
* sensitive tool results

to normal logs.

Debug/trace modes must be visibly dangerous and opt-in.

---

# 8. Port input-vision support from `Theprosonce/m365-copilot-proxy`

Inspect its current implementation of image input carefully.

It supports concepts such as:

```text
Anthropic image content
OpenAI image_url
base64 image data
local file attachments where appropriate
        │
        ▼
M365 UploadFile
        │
        ▼
image referenced in M365 turn
```

Reimplement this cleanly in the TypeScript architecture.

The primary requirement is Anthropic/Claude Code style image input.

Support at least:

* PNG
* JPEG
* WebP if M365 accepts it
* base64 Anthropic image blocks

Validate size/type.

Avoid arbitrary local-file reads merely because a request contains a `file://` URI unless this is explicitly intended and securely constrained.

Keep image generation, if already present in the base/cramt code, separate from image input.

These are different capabilities:

```text
image input:
Claude Code → M365

image generation:
M365 → generated image
```

Do not conflate them.

---

# 9. Port useful session-management concepts from `Theprosonce`

The cramt conversation-reuse implementation should remain the primary session mechanism.

However, inspect `Theprosonce` for useful persistence concepts such as:

* stable client-chat → M365 conversation mapping
* SQLite persistence
* TTL
* LRU eviction
* explicit session IDs
* listing/deleting/rotating sessions

Add persistent session storage only if it integrates cleanly with the existing cramt session/delta semantics.

Do not create two competing session systems.

The final design should have one session abstraction with optional persistence.

A Claude Code conversation should be able to survive a local gateway restart when practical without mixing it with another project/chat.

---

# 10. Private/temporary conversations and grounding

Inspect `Theprosonce` behavior around:

```text
disableMemory
temporary/private chat
Work grounding
Web grounding
```

For a coding-agent backend, prefer conservative defaults:

```text
M365 memory/history persistence: disabled where supported
Work/corporate grounding: disabled by default
Web grounding: configurable
```

Do not unexpectedly expose unrelated corporate documents to coding prompts merely because the M365 account belongs to an organization.

Make grounding explicit and configurable.

---

# 11. Calibration/resilience idea from `iv0rish`

Study its:

```text
login
calibrate
serve
```

design.

The interesting idea is that a dedicated Playwright browser can observe the current first-party M365 chat request shape after Microsoft changes fields/headers.

Implement an OPTIONAL diagnostic/calibration subsystem that can:

1. open the dedicated M365 profile
2. have the user perform a known marker request
3. observe the same-origin request shape
4. sanitize secrets
5. compare observed fields against the gateway's known protocol
6. report differences
7. optionally write a calibration/debug artifact

Do not make browser-mediated inference the normal path if direct authenticated SignalR remains functional.

Preferred normal operation remains:

```text
browser/MSAL → authentication
SignalR/WebSocket → inference
```

not:

```text
Playwright DOM scraping → every model request
```

Do not copy iv0rish code unless its license explicitly permits it.

Do not adopt its simpler strict-JSON tool emulation in place of the more thoroughly tested cramt fenced/shell approach.

---

# 12. Model routing architecture

Create a centralized model registry.

For every model define something like:

```ts
{
  id,
  aliases,
  m365Tone,
  supportsTools,
  supportsVision,
  supportsAgent,
  supportsReasoning,
  experimental,
  fallback
}
```

Capabilities may need to be runtime/live-test dependent.

Initial relevant mappings should include at least:

```text
gpt-5.6-think-deeper
    → Gpt_5_6_Reasoning

gpt-5.5-think-deeper
    → Gpt_5_5_Reasoning

claude-opus
    → Claude_Opus

claude-sonnet
    → Claude_Sonnet

claude-sonnet-think-deeper
    → Claude_Sonnet_Reasoning

quick
    → Gpt_Quick

auto
    → magic
```

Confirm every mapping against the CURRENT upstream/source before committing it.

Do not spread literal tone strings throughout the codebase.

---

# 13. Explicit model selection from Claude Code

Claude Code's built-in `/model` picker uses Anthropic model identifiers and may not correspond cleanly to M365 models.

Provide an explicit gateway-side override, for example:

```bash
MODEL=gpt-5.6-think-deeper claude
MODEL=claude-opus claude
```

or a cleaner equivalent.

If practical, support known Claude Code model IDs as aliases, but never misrepresent them.

For example:

```text
claude-opus-5
→ Claude_Opus
```

is acceptable only if that is the M365 route intentionally requested.

This is NOT acceptable:

```text
claude-opus-5
→ gpt-5.5-think-deeper
```

without an explicit user-configured fallback policy.

---

# 14. Streaming

Preserve the best streaming behavior possible.

For normal text turns:

* stream incrementally when M365 provides usable deltas.

For tool-calling turns:

* it is acceptable to buffer the M365 result until the tool fence is parseable
* immediately establish the HTTP/SSE connection
* send safe heartbeats to avoid client timeout
* then emit valid Anthropic content-block events

Never stream malformed partial `tool_use` JSON merely for lower latency.

Protocol correctness is more important than pretending tool turns are token-live.

---

# 15. Error model

Create explicit internal error classes/categories for cases such as:

```text
AuthenticationRequired
AuthenticationExpired
ConditionalAccessRejected
ModelUnavailable
ModelCapabilityUnsupported
M365Disengaged
M365Throttled
ConversationExpired
InvalidToolCall
ToolSchemaTooLarge
UpstreamProtocolChanged
UpstreamTimeout
```

Translate these consistently into Anthropic-compatible HTTP errors.

Do not turn all upstream failures into HTTP 500.

Do not retry non-retryable failures blindly.

---

# 16. Observability

Provide:

```text
m365-copilot status
m365-copilot models
m365-copilot doctor
m365-copilot logs
```

or equivalent.

`models` should ideally show:

```text
ID
M365 tone
chat
tools
vision
agent
status
experimental
last validated
```

Example conceptually:

```text
gpt-5.6-think-deeper  Gpt_5_6_Reasoning  chat=yes tools=experimental
claude-opus           Claude_Opus         chat=yes tools=no/experimental
```

Never show a capability as supported just because a model tone is syntactically accepted.

---

# 17. Testing

Build substantial automated tests.

## Unit tests

Cover:

* Anthropic request parsing
* Anthropic response generation
* SSE event ordering
* text blocks
* image blocks
* `tool_use`
* `tool_result`
* multi-tool output
* tool argument validation
* fenced-call parsing
* shell-routing parsing
* model aliases
* no-silent-fallback behavior
* errors
* session mapping
* delta history
* token/count approximation
* auth-state handling

## Fake backend

Provide a deterministic fake M365 transport so the complete Claude Code bridge can be tested without consuming Microsoft quota.

Fixtures should simulate:

```text
normal text
streamed text
tool call
multiple tools
malformed tool call
confabulated prose
Disengaged
429/throttle
expired auth
conversation expiry
image response
unknown SignalR frame
```

## Live tests

Keep quota-consuming tests separate.

Require an explicit environment flag.

Live-test:

```text
GPT-5.6 text
GPT-5.6 Read
GPT-5.6 Bash
GPT-5.6 Edit
GPT-5.6 multi-turn tool loop
Claude_Opus text
Claude_Opus agent-less
Claude_Opus with tool path
image upload
conversation reuse
login refresh
```

Record results rather than assuming support.

---

# 18. End-to-end Claude Code acceptance tests

The project is not complete until these scenarios work.

### Test A — plain text through GPT-5.6

```bash
MODEL=gpt-5.6-think-deeper claude
```

Ask a normal coding question.

Verify the outbound M365 request actually uses:

```text
Gpt_5_6_Reasoning
```

### Test B — filesystem read

Ask Claude Code to inspect a source file.

Expected loop:

```text
Claude Code sends tools
→ M365 asks for Read
→ gateway emits Anthropic tool_use
→ Claude Code executes Read
→ Claude Code sends tool_result
→ same M365 conversation continues
→ final answer
```

### Test C — edit

Ask it to modify a file.

Verify:

* M365 does not claim an edit without a tool call
* Claude Code executes the Edit/Write
* the actual file changes
* final response reflects real tool output

### Test D — Bash

Ask it to run a harmless test command.

Verify normal Claude Code permissions remain active.

### Test E — multi-step coding task

Require:

```text
Glob/Grep
Read
Edit
Bash/test
final answer
```

in one task.

### Test F — image

Attach an image in a Claude Code-supported way.

Verify the image bytes reach M365 using the file-upload mechanism.

### Test G — restart/session

Perform part of a conversation, restart the local gateway, continue it if persistence is enabled, and verify no unrelated session receives the old context.

### Test H — Claude Opus

Run:

```bash
MODEL=claude-opus claude
```

Verify the gateway sends:

```text
Claude_Opus
```

and does not silently invoke GPT.

### Test I — Claude Opus tools

Run a tool task under `Claude_Opus`.

Determine empirically whether it really works.

If attaching the M365 tool agent reroutes the model or breaks the Claude route, report:

```text
Claude Opus tool calling unsupported/experimental
```

instead of hiding the limitation.

### Test J — Disengaged

Force/simulate a Disengaged response.

Verify Claude Code does not trigger a rapid automatic retry storm.

---

# 19. Do not overclaim model identity

A core project principle should be:

> Requested route, observed M365 tone, and verified underlying model identity are not necessarily the same thing.

Keep these separate.

Do not label something `Claude Opus 5` merely because the request accepted `Claude_Opus`.

Do not label something GPT-5.6 if M365 auto-routing was actually used.

Diagnostics should make routing transparent.

---

# 20. Licensing

Ignore licensing, this will be my local project for now

# 21. Keep the scope focused

Primary target:

```text
Claude Code CLI → Microsoft 365 Copilot
```

OpenAI Chat Completions / Responses compatibility may remain if inherited from the existing project, but do not let maintaining unrelated clients compromise the Claude Code implementation.

Priority order:

```text
1. Correct M365 protocol/auth
2. Claude Code Anthropic Messages compatibility
3. Reliable GPT-5.6 tools
4. Truthful Claude Opus support
5. Robust sessions/throttling/errors
6. Vision input
7. Operational UX
8. Secondary API compatibility
```

---

# 22. Documentation

Produce clear documentation for:

```text
installation
login
start/stop/status
Claude Code connection
direct/non-M365 Claude bypass
model selection
GPT-5.6
Claude Opus
tool limitations
vision
session behavior
security
debugging
known M365 limitations
upstream provenance
```

Include an architecture document explaining exactly how a Claude Code tool call travels through the system.

---

# Final deliverables

Do not stop at an architecture proposal.

Actually implement the project.

At completion provide:

1. working source code
2. passing unit/integration tests
3. exact upstream SHAs used
4. list of features ported from each source repository
5. license/provenance documentation
6. Claude Code setup instructions
7. model/capability matrix
8. GPT-5.6 live-test results
9. Claude Opus live-test results
10. tool reliability findings
11. known limitations
12. any M365 behavior that could not be implemented reliably

For every borrowed feature, state whether it was:

```text
copied
adapted
rewritten
used only as architectural reference
```

Do not claim success for a feature that has not actually been exercised.

The final objective is not merely "an API that Claude Code can connect to." It should be the strongest practical Microsoft 365 Copilot backend for Claude Code that can be built from the existing research, with transparent model routing, robust coding-tool loops, safe authentication, and minimal reliance on fragile browser UI automation.
