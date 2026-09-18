# Claude Code through the local M365 proxy

The standalone proxy exposes an Anthropic Messages compatibility endpoint at
`POST /v1/messages`, plus `POST /v1/messages/count_tokens`. This lets Claude Code use
the M365-backed model catalog without reading or replacing Claude's stored subscription
credentials.

## Install and start

On Windows, prefer the process-scoped three-command workflow:

```powershell
.\proxy-up.ps1
.\claude-m365.ps1
.\claude-m365.ps1 -Model gpt-5.5-think-deeper
.\proxy-down.ps1
```

The first command generates a private bearer key and opens the legitimate
interactive Microsoft login when needed. `claude-m365.ps1` validates the model,
creates an isolated proxy session, and launches the existing Claude executable
without changing global credentials or disabling permissions.

From the repository (or via global command):

```sh
m365-copilot login
m365-copilot start
m365-copilot connect-claude
```

Then, from the project Claude Code may access:

```sh
claude
```

Choose another proxy model for one session with `MODEL`, for example:

```sh
MODEL=quick claude
```

The managed `claude` wrapper points `ANTHROPIC_BASE_URL` at localhost, reads the
generated bearer token from the existing mode-0600 `proxy.env`, disables nonessential
Anthropic traffic, and limits the advertised Claude Code tools to Bash, Read, Edit,
Write, Glob, and Grep. Normal Claude Code permissions still apply. The manager keeps
restore metadata under `~/.local/state/m365-copilot-proxy/`.

The original installed binary is preserved. Use `claude-direct` when temporarily
returning to the Claude.ai/Max provider, or run `m365-copilot disconnect-claude` to
restore the plain `claude` command permanently. Restart Claude Code after switching;
an already-running session keeps the provider it started with. The saved Claude.ai
login may remain visible in `claude auth status`, but model requests use the gateway
whenever the managed wrapper is connected to `127.0.0.1:4141`.

The connector does not set both `apiKeyHelper` and `ANTHROPIC_AUTH_TOKEN`. During
migration it removes only legacy localhost proxy fields from global Claude settings,
backs up the original JSON, and leaves unrelated theme, permission, and model settings
untouched.

## Important limitations

- This is wire compatibility, not an Anthropic model guarantee. The selected model is
  whichever M365 tone/model the proxy resolves.
- M365 tool calling is prompt-emulated. It is less reliable than Claude's native tool
  API, and the proxy intentionally keeps the tool set lean because large tool schemas
  can trigger `Disengaged`.
- Every parsed call is validated against the exact client-provided draft-2020-12
  JSON Schema. A small deterministic alias repair (for example `path` to an
  otherwise-missing `file_path`) is revalidated; malformed/invalid calls fail
  closed and are never emitted as `tool_use`. This is adapter validation, not
  upstream grammar-constrained decoding.
- Streaming is genuinely incremental for prose: text deltas are forwarded as they
  arrive (with a short holdback window in tool mode so fence bytes never leak).
  Tool-call blocks and thinking blocks are emitted once the turn's fences are parsed.
- `/v1/messages/count_tokens` is a character-based estimate because M365 does not expose
  a matching tokenizer.
- Microsoft account/tenant policy and current M365 service health still control whether
  a request succeeds. The bridge cannot bypass Conditional Access, licensing, throttling,
  or an M365 upstream server error.
- Empty/disengaged M365 turns are exposed as non-retryable errors. This prevents
  Claude Code's automatic retries from consuming many messages on a dead conversation;
  retry manually after waiting or restarting the session.
- Claude Code's `/model` picker contains Anthropic subscription models, not the M365
  catalog. Unsupported picker IDs fall back to `gpt-5.5` (override with
  `M365_CLAUDE_CODE_MODEL`); explicit M365 model IDs pass through.
- Every launcher process injects its own `x-m365-session-id` header
  (`ANTHROPIC_CUSTOM_HEADERS`). Distinct CLI processes — or hosts — therefore never
  fuse into one shared M365 conversation, even with identical first prompts.
- M365 conversations survive proxy restarts: the pool persists ConversationId +
  delta position to `~/.config/opencode-m365/sessions.json` and rehydrates on the
  next request with the same conversation fingerprint (disable with
  `M365_NO_SESSION_STORE=1`).

## Harness profiles

Pick a tooling policy per request with the `x-m365-profile` header, or set a
default with the `M365_PROFILE` env var. Unknown names are rejected with HTTP 400
listing the supported set.

| Profile | Advertised surface | Deferred (ToolSearch) | Synthetic Task |
|---|---|---|---|
| `claude-safe` *(default)* | bash / read / edit / write / glob / grep / todowrite | rest, 4 matches/round | off |
| `claude-web` | coding + webfetch / websearch | rest, 5/round | off |
| `claude-diagnose` | read-only investigation (bash/read/glob/grep) | write/edit deferred, 6/round | off |
| `claude-wide` | nothing filtered, cap 10 | everything else, 8/round | **on** |

Operator env vars (`M365_ALLOWED_TOOLS`, `M365_MAX_TOOLS`, `M365_NO_MULTI_TOOL`,
`M365_NO_SUBAGENTS`) override profile values. Control tools (`ExitPlanMode`,
`TodoWrite`, `BashOutput`, `KillShell`) are always advertised — exempt from both the
allow-list and the cap, since deferring them strands plan mode or background shells.
`tool_choice.disable_parallel_tool_use` forces strict one-call-per-turn for that
request regardless of profile. Pasted images are never silently dropped: they become
an explicit `[IMAGE ATTACHED: …]` placeholder the model can see. The resolved profile
is part of the conversation identity — switching profiles forks the M365 thread so
promoted-tool state never bleeds across policies. All M365 turns (normal, ToolSearch
follow-ups, Task sub-agent jobs) execute through one account-wide FIFO queue.

Keep the proxy bound to `127.0.0.1`. Do not expose the endpoint or its bearer token over
the network.
