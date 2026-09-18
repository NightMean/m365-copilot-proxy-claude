# m365-copilot-proxy

Use an eligible Microsoft 365 work or university account as a local LLM backend for
Claude Code, [pi](https://pi.dev/), [OpenClaw](https://docs.openclaw.ai/), and other
OpenAI-compatible clients. The proxy translates M365 Copilot's WebSocket/SignalR
protocol into OpenAI and Anthropic-compatible localhost APIs with agent tool support.

> [!WARNING]
> This is an independent, unofficial compatibility project built on an undocumented
> Microsoft endpoint. It can stop working when Microsoft changes the service. Confirm
> that your account and tenant policies allow this use. Keep the proxy on
> `127.0.0.1`; never publish its port or bearer key.

> **Want the gory protocol details?** See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) — a full write-up of M365 Copilot's undocumented WebSocket API: auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that makes tool calling work.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **Standalone proxy** — HTTP server with `/v1/chat/completions` and `/v1/models` endpoints. Works with any OpenAI-compatible client (pi, OpenClaw, etc.).
2. **OpenClaw plugin** — Config generator + setup CLI for OpenClaw's provider system.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead, tools are
emulated via a **Markdown-fence format** (the JSON `{"tool":...}` format was removed —
it scored 0/5 on real agentic tasks; see [hypotheses §9](docs/hypotheses.md)):

- Tool definitions are injected into the prompt as fenced templates inside a `<tools>` block
- The model emits a fenced tool call — a code block whose info-string is the tool name
  (scalar args as `key: value` header lines, one free-form body arg as the fence body,
  `old`/`new` edits as aider-style `SEARCH/REPLACE` diffs)
- The proxy/handler parses that and converts it to OpenAI `tool_calls` format
- **Shell-routing (the key lever):** M365's chat-tuned model won't "act as an agent" on
  demand but *will* reflexively write a ```` ```bash ```` block. When the toolset includes a
  shell tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the
  whole step by writing one ```` ```bash ```` block" framing and routes that block to the
  shell tool. This exploits the one agentic behavior Microsoft's system prompt permits, and
  is what turns 0/5 into real multi-turn loops (verified 9-tool-call bug fix).
- **Reliability comes from the Copilot Studio agent (below) + the fenced/shell framing** —
  without the agent, M365 ignores tool instructions and answers in prose

### Agent mode

On first use, the system creates a **Copilot Studio agent** with tool-calling instructions baked into its server-side system prompt. This is done via the PowerPlatform API:

1. Discovers the environment URL via the BAP API (`api.bap.microsoft.com`)
2. Creates a bot with instructions in the Copilot Studio `minimalBots` API
3. Publishes the bot to get a `TitleId`
4. Uses the agent ID (`T_{titleId}.{botId}.gpt.default`) in WebSocket chat requests
5. Caches the agent ID in `~/.config/opencode-m365/agent-id.json`

### Conversation reuse

Each agent session reuses the same M365 conversation (same `sessionId` + `conversationId`). The WebSocket reconnects per turn but M365 maintains server-side context. This saves quota — the 600 message limit applies per-conversation.

## Packages

```
@m365-copilot/core          — Shared: auth, WebSocket client, tool formatting, proxy server, agent management, session
├── @m365-copilot/proxy     — Standalone HTTP proxy binary
└── @m365-copilot/openclaw-plugin  — OpenClaw config generator + setup CLI + skill
```

## Windows

### Quick start (recommended)

The normal Windows workflow is exactly these three repository-root commands:

```powershell
.\proxy-up.ps1
.\claude-m365.ps1
.\proxy-down.ps1
```

`proxy-up.ps1` installs locked dependencies only when missing, rebuilds stale
output, creates a strong private local bearer key, uses the legitimate Microsoft
browser login on first live use, starts a bounded-restart watchdog, and verifies
`/health` plus `/v1/models`. It is idempotent. For offline validation use
`.\proxy-up.ps1 -Fake`; force a refresh with `-Fresh`.

Select and validate a model against the live local catalog before launching the
real installed Claude Code binary:

```powershell
.\claude-m365.ps1 -Model gpt-5.5-think-deeper
```

Each launch gets a new `x-m365-session-id` unless `-SessionId` is supplied. The
Anthropic environment and bearer key are process-scoped, `ANTHROPIC_API_KEY` is
removed for the child to avoid ambiguous authentication, and normal Claude Code
permission prompts remain enabled. `-Unsafe` is the only way the launcher adds
`--dangerously-skip-permissions`. Existing `run.ps1`, login, TUI, and direct-Claude
escape hatches remain available for advanced use. Logs are under
`%USERPROFILE%\.local\state\m365-copilot-proxy`; health is
`http://127.0.0.1:4141/health`.

### Model selection and dynamic enterprise aliasing

The gateway exposes a centralized, strictly truthful model catalog:
- `gpt-5.5-think-deeper` / `gpt-5.5`: M365 GPT-5.5 Reasoning (`Gpt_5_5_Reasoning`).
- `gpt-5.6-think-deeper` / `gpt-5.6`: Frontier M365 GPT-5.6 Reasoning (`Gpt_5_6_Reasoning`).
- `claude-opus` / `claude-opus-5`: Microsoft 365 Copilot Opus tone (`Claude_Opus`).
- `claude-sonnet`: Microsoft 365 Copilot Sonnet tone (`Claude_Sonnet`).

**Strict Model Truthfulness:** Built-in models never silently demote or redirect to an unrequested family (e.g. requesting `claude-opus` will never silently become GPT).

#### Enterprise Policy Spoofing & Custom Aliases
If your corporate network or Claude Code configuration enforces specific allowed Anthropic model names (e.g. `claude-opus-4.6`, `eu.anthropic.*`), you can configure dynamic custom aliases **without editing any code or rebuilding**:

1. **Via `model-aliases.json` (Recommended):**
   Copy `model-aliases.example.json` to `%USERPROFILE%\.config\m365-copilot-proxy\model-aliases.json`:
   ```json
   {
     "claude-opus-4.6": "gpt-5.5-think-deeper",
     "eu.anthropic.claude-opus-4.6": "gpt-5.5-think-deeper",
     "my-custom-model": "gpt-5.6-think-deeper"
   }
   ```
2. **Via `proxy.env` / Environment Variable:**
   In your `proxy.env` (or shell):
   ```ini
   M365_MODEL_ALIASES='{"claude-opus-4.6":"gpt-5.5-think-deeper"}'
   ```
   Or set a custom file path:
   ```ini
   M365_MODEL_ALIASES_FILE=~/.config/m365-copilot-proxy/model-aliases.json
   ```

Custom aliases take priority over built-in names, allowing seamless compliance with organizational client-side policies while routing to your chosen M365 backend.

### Compatibility boundary

- Native-equivalent interface behavior: Messages request/response shapes,
  `tool_use`/`tool_result`, SSE ordering, stop reasons, session routing, and MCP
  tool forwarding back to Claude Code.
- Adapter-emulated compatibility: M365 fenced tool intent, JSON-Schema validation
  and conservative argument repair, ToolSearch retrieval, structured-output
  checks, display-safe M365 reasoning summaries, and token estimates.
- Not reproducible: Anthropic's inference runtime, native tool-constrained
  decoding, KV prompt cache, exact tokenizer, hidden system prompt, or internal
  infrastructure behavior.

The proxy never executes Claude Code's client tools. Claude Code performs the real
filesystem/shell/MCP action after receiving a validated `tool_use` block.

Everything is cross-platform; use PowerShell instead of the bash launchers.
`run.ps1` is a one-stop bootstrap — it installs Node LTS (winget) if missing,
provisions pnpm, installs project dependencies, builds, fetches the system-prompt
corpus, installs Claude Code if no binary is found, starts the proxy, waits for
health, and can connect + run Claude Code against it:

```powershell
.\run.ps1                          # deps -> build -> serve (auto live/FAKE mode)
.\run.ps1 -Claude                  # ...connect + RUN Claude Code through the proxy
.\run.ps1 -Fake -Claude            # offline scripted backend + Claude Code (zero quota)
.\run.ps1 -Model claude-sonnet -Claude
.\run.ps1 -Model claude-sonnet `
          -SystemPrompt "name:Anthropic/claude-code/claude-code-sonnet-4.6" -Claude
.\run.ps1 -StopProxy               # stop the watchdog + proxy
.\run.ps1 -Tui                     # interactive TUI instead
.\run.ps1 -Fresh                   # force reinstall + rebuild

pnpm test:e2e:sandbox              # cross-platform Node E2E (no quota)
```

A **watchdog** (armed automatically) respawns the proxy within ~5 s if it dies,
so long Claude Code sessions survive background-process crashes. The proxy also
stays up after Claude exits by default — manage it explicitly:

```powershell
.\run.ps1                 # terminal A: serve (self-healing)
.\run.ps1 -Claude         # terminal B: Claude Code attached to that proxy
.\run.ps1 -StopProxy      # shut everything down
```

Connection is session-scoped (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` env) —
nothing global is written. Credentials for live M365 live at
`%USERPROFILE%\.config\opencode-m365\secrets.json`.

## One-click Linux setup
### Requirements

- 64-bit Linux with Bash
- `npm`, `curl`, and Git (Git is unnecessary when using a downloaded archive)
- An eligible Microsoft 365 work or university account with Copilot Chat access
- A Chromium-based browser for the recommended interactive sign-in
- Claude Code, only if you want to use the Claude terminal interface

The installer downloads a private Node.js 24 runtime into this repository's `.runtime/`
directory. It does not replace the system Node.js and it installs locked dependency
versions from `pnpm-lock.yaml`.

### Fast path

Clone the repository, then run:

```bash
git clone https://github.com/m365-copilot-proxy/m365-copilot-proxy.git
cd m365-copilot-proxy

./bin/m365-copilot login
./bin/m365-copilot start
./bin/m365-copilot connect-claude
claude
```

Every action is available through the unified CLI:

```bash
m365-copilot help
m365-copilot login
m365-copilot login-device
m365-copilot start
m365-copilot status
m365-copilot models
m365-copilot logs
m365-copilot connect-claude
m365-copilot disconnect-claude
m365-copilot stop
```

### Sign in safely

`m365-copilot login` opens a visible Microsoft browser. Enter the address, password, and MFA only
on Microsoft's page. The proxy captures a short-lived OAuth authorization code and stores
an MSAL refresh cache at `~/.config/opencode-m365/msal-cache.json`; it never requests or
stores the password or MFA seed.

If interactive login is unavailable, `m365-copilot login-device` prints Microsoft's URL and a
short-lived code. Do not paste that code into chat or store it in a file. Error `53003`
means the Conditional Access policy rejected that device, platform, or auth
flow. The launcher cannot bypass it; use the interactive browser flow or ask the tenant
administrator.

### Start and manage the proxy

The proxy runs in the background on `http://127.0.0.1:4141`:

```bash
m365-copilot start
m365-copilot status
m365-copilot models
m365-copilot logs --follow
m365-copilot stop
```

The manager records an exact PID and refuses to kill an unrelated process. Runtime files:

- private API key: `~/.config/m365-copilot-proxy/proxy.env` (mode `0600`)
- proxy PID and log: `~/.local/state/m365-copilot-proxy/`
- Microsoft token cache: `~/.config/opencode-m365/msal-cache.json`

The read-only model catalog can be opened at `http://127.0.0.1:4141/v1/models`.
All model-consuming endpoints require the generated local bearer key.

### Connect and disconnect Claude Code

Connection is reversible. `connect-claude.sh` preserves the currently resolved Claude
executable and installs a small wrapper at `~/.local/bin/claude`. It does not overwrite
Claude's subscription credentials. It also installs `claude-direct`, which bypasses M365
without disconnecting:

```bash
m365-copilot connect-claude
m365-copilot start

claude                         # M365-backed Claude Code interface
MODEL=quick claude             # faster M365 model
MODEL=gpt-5.5-think-deeper claude
claude-direct                  # original Anthropic provider

m365-copilot disconnect-claude # restore normal `claude`
```

Claude's `/model` picker contains Anthropic product names rather than the M365 catalog.
Unsupported choices are mapped to `gpt-5.5-think-deeper`; selecting “Opus” does not grant
an Anthropic Opus model. Use `MODEL=<id> claude` for an explicit M365 model.

The wrapper intentionally exposes only `Bash`, `Read`, `Edit`, `Write`, `Glob`, and
`Grep`. Larger tool schemas frequently trigger M365's content filter. Treat every command
as untrusted: keep Claude permissions enabled, inspect diffs, and run tests before commits.

### Other clients

Pi in a selected bubblewrap workspace:

```bash
bash scripts/pi-sandbox.sh /absolute/path/to/project
```

OpenClaw:

```bash
m365-openclaw-setup
```

Any OpenAI-compatible client can use `http://127.0.0.1:4141/v1` with the bearer key in
`~/.config/m365-copilot-proxy/proxy.env`. Anthropic Messages-compatible clients can use
`http://127.0.0.1:4141/v1/messages`.

### Troubleshooting

Run `m365-copilot doctor` first. Common cases:

- **`EADDRINUSE :4141`** — another proxy/process owns the port. Stop its terminal or run
  the existing instance; the manager will not kill an unrecognized process.
- **Connection error in Claude** — run `m365-copilot status`, then
  `m365-copilot start`.
- **Empty response / `Disengaged`** — do not retry rapidly. Large prompts, large tool
  payloads, or account-level throttling can cause empty replies. Wait, then continue one
  conversation rather than opening many new ones.
- **`Both ANTHROPIC_AUTH_TOKEN and apiKeyHelper set`** — reconnect once with
  `m365-copilot connect-claude`; it safely removes legacy localhost proxy fields while
  backing up the prior Claude settings.
- **Return to paid/normal Claude immediately** — run `claude-direct`, or permanently run
  `m365-copilot disconnect-claude`.

### Uninstall

```bash
./uninstall.sh
./uninstall.sh --purge
```

The default removes the command wrappers and restores Claude while keeping configuration,
logs, and Microsoft login state. `--purge` additionally removes this proxy's configuration
and logs, but intentionally preserves the Microsoft token cache. The downloaded repository
and `.runtime/` remain until you delete that exact folder yourself.

## Available models

| Model ID | M365 Tone | Description |
|---|---|---|
| `gpt-5.5-think-deeper` | Gpt_5_5_Reasoning | **Recommended default for agents/tool-calling** — robust tool compliance |
| `gpt-5.5` / `gpt-5.5-quick` | Gpt_5_5_Chat | GPT-5.5 fast |
| `m365-copilot` / `auto` | magic | Auto-routing — high-variance at tool-calling (confabulates; see below) |
| `quick` | Gpt_Quick | Fast responses |
| `think-deeper` | Gpt_Reasoning | Slower, more thorough |
| `claude` / `claude-sonnet` | Claude_Sonnet | Real Anthropic Claude (agent-less path) |
| `claude-sonnet-think-deeper` | Claude_Sonnet_Reasoning | Claude reasoning |
| `gpt-5.4` / `gpt-5.4-quick` | Gpt_5_4_* | GPT-5.4 |
| `gpt-5.3` / `gpt-5.3-think-deeper` | Gpt_5_3_* | GPT-5.3 |
| `gpt-5.2` / `gpt-5.2-think-deeper` | Gpt_5_2_* | GPT-5.2 |
| `gpt-5.6-reasoning` / `sol` / `terra` / `luna` / `gpt-5.6-sol|terra|luna` | **Gpt_5_6_Reasoning** | GPT-5.6 reasoning tone — a REAL distinct backend model ([F17.11](docs/hypotheses.md)); sol/terra/luna differ only by effort preset |

> ✅ **For tool calling, use `gpt-5.5-think-deeper` (the default when no model is sent).**
> The current agent + fenced/shell-routing path makes this reasoning tone robust —
> 100% compliance and solve across prompt/toolset sizes on the bench (docs/hypotheses.md
> §12.10/§12.11). The **default `m365-copilot` (magic) tone is *not* reliable** for
> tools — it confabulates ("I no longer have access to the filesystem tools") and solves
> ~0% of real tasks (§12.11); a proxy request with no `model` field already defaults to
> `gpt-5.5-think-deeper` for this reason.
>
> ⚠️ The **older** reasoning tones (`gpt-5.2`/`gpt-5.3`/`gpt-5.4` `*-think-deeper`, bare
> `think-deeper`) route through M365's `DeepLeo` pipeline, which meta-analyzes the
> injected prompt and can disengage from tools. Prefer `gpt-5.5-think-deeper`.
> See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) §5/§10.

## Claude Code, TUI, parallel agents & system prompts

### Interactive TUI

```sh
pnpm tui
```

Arrow-key launcher: run **Claude Code through this proxy** or the **original**
Anthropic backend side by side, pick any registered model from the live registry,
route a system prompt, spawn parallel agents, and live-validate models.

### System prompt routing (corpus)

```sh
pnpm prompts:fetch        # clone/update github.com/asgeirtj/system_prompts_leaks -> vendor/
```

425+ real leaked system prompts get indexed (including the full Claude Code
prompts: `Anthropic/claude-code/claude-code-sonnet-4.6`, opus variants, subagents…).
Browse via `GET /v1/system-prompts`, fetch one via
`GET /v1/system-prompts/<url-encoded-name>`, and route per request:

```sh
curl -X POST localhost:4141/v1/messages \
  -H 'Authorization: Bearer m365' -H 'x-m365-system-prompt: name:Anthropic/claude-code/claude-code-sonnet-4.6' …
```

Spec forms: `name:<corpus-name>` · `path:<file>` · bare literal text. A global
default can be set with `M365_SYSTEM_PROMPT`; the TUI routes it via Claude Code's
`ANTHROPIC_CUSTOM_HEADERS`. Injection is **opt-in** — big injected prompts raise
Disengaged risk, so nothing is added unless you ask. The `pnpm tui` picker wires
this for you; MCP servers/skills/plugins are Claude Code *client* features and
work unchanged once `ANTHROPIC_BASE_URL` points at the proxy.

### Parallel agents

```sh
pnpm agents -- --agents 3 --task "fix the failing tests" --model gpt-5.5-think-deeper
```

N isolated headless Claude Code runs (`--worktree` for git worktrees). Safe for
M365: every turn passes through the server-side **TurnGate** — bounded inflight
turns (`M365_MAX_CONCURRENT_TURNS`, default 2) plus staggered NEW-conversation
starts (`M365_CONVERSATION_START_GAP_MS`, default 5000) so N clients never
stampede the thread-rate throttle. Long single-agent loops are never gap-delayed.
Live stats: `GET /health`.

### Offline E2E / sandbox validation (no quota)

```sh
pnpm test:e2e:sandbox                 # boots built Nitro in M365_FAKE_MODE=1 and drives
RUN_CLAUDE_E2E=1 pnpm test:e2e:sandbox # …optionally incl. a headless `claude -p` loop
```

`M365_FAKE_MODE=1` swaps the M365 WebSocket backend for a scripted FakeTransport —
the FULL stack (fenced tool formatting → parsing → OpenAI/Anthropic translation)
runs against deterministic responses. Also used by the offline vitest suite
(`packages/proxy-lib/src/e2e.offline.test.ts`): tool loop round-trip, incremental
SSE shape, system-prompt injection, gate semantics.

### Live model validation

```sh
pnpm validate:models -- --yes          # sequential one-turn probe per canonical model
```

Strictly sequential with cooldowns (quota-aware); writes a JSON scorecard to
`scripts/validate-models-out/`.

## Image generation

M365 Copilot generates images through a built-in server-side tool, and the core
package exposes it as one call. The picture comes back on a `GraphicArt` frame as
a URL (never as chat text), and the bytes sit behind a separate auth boundary —
`generateImage()` handles both, returning the image with bytes attached:

```ts
import { generateImage } from "@m365-copilot/core";

const [img] = await generateImage("A minimalist flat-design logo of a lighthouse, teal and white.");
// img.data      -> Buffer (real PNG, verified end-to-end)
// img.base64    -> same bytes, ready for an OpenAI-style b64_json response
// img.contentType, img.size, img.orientation
```

Everything the M365 web client can do is reachable — the proxy sends the same image
optionsSets it does. Steer type and aspect with options (they nudge the prompt the
way the GUI's meta-prompting does; the model still makes the final call):

```ts
await generateImage("a lighthouse on a cliff", { orientation: "portrait" });   // landscape | portrait | square
await generateImage("a lighthouse", { style: "icon" });                        // natural | icon | story | designer
```

**You don't have to call `generateImage` at all.** Just like the web client, a plain
chat turn draws when asked — send `"draw me an image of a green teapot"` to
`/v1/chat/completions` (or `ModelSession.run`) with no tools and the image comes back
embedded in the reply as a markdown data-URI. (Image gen is enabled on the agent-less
path only, so it never competes with tool calling; set `M365_NO_IMAGE_GEN=1` to force
pure text.)

Runs its own agent-less session. Uses the same login as chat; the artifact fetch uses
a `designerappservice` token acquired silently from the existing cache. Protocol
write-up: [docs/hypotheses.md §14](docs/hypotheses.md).

> **Separate, scarcer budget.** Image generation draws on its own daily quota, distinct
> from the ~600-message conversation limit and not metered by the chat throttle — treat
> image calls as the expensive ones. When it's exhausted, `generateImage()` throws
> `ImageGenerationError` with `reason: "quota_exceeded"` (map it to HTTP 429); a plain
> chat turn instead returns M365's "can't generate any more images today" message as text.

An OpenAI-compatible `POST /v1/images/generations` endpoint on top of this is the
next step — the core API it needs is already in place.

## Authentication

The auth flow uses Azure MSAL with PKCE:

1. **Silent refresh** — Uses cached tokens from `~/.config/opencode-m365/msal-cache.json`
2. **Interactive login** — Opens a visible browser; the user completes Microsoft's
   sign-in and MFA directly, with no password or MFA secret stored by the proxy
3. **Device-code login** — Displays a short-lived Microsoft device code for completion
   on another trusted browser/device; useful for CLI and broker-oriented accounts
4. **Legacy automated login** — Available only when an operator deliberately supplies
   the older `secrets.json`; it is not used by the local launcher

Three token scopes are acquired:
- `substrate.office.com/sydney/*` — For M365 Copilot chat
- `api.powerplatform.com/.default` — For Copilot Studio agent management
- `api.bap.microsoft.com/.default` — For environment discovery

## Sub-agents (Task)

The proxy synthesizes a **`Task(prompt)`** tool: the model can delegate self-contained
research/exploration jobs to a sub-agent that runs in its OWN M365 conversation with
restricted read-only workspace tools (`read_file` / `glob_files` / `grep_files`,
executed in-process by the proxy, workspace-jailed). The sub-agent's report is fed back
into the main conversation; the client only sees ordinary turns. Mutations stay with the
main loop. Knobs: `M365_NO_SUBAGENTS=1` (disable), `M365_SUBAGENT_TURNS` (default 6),
`M365_WORKSPACE_ROOT` (sandbox root, default cwd).

> Note: adoption is tone-dependent today — gpt-5.5's shell-first framing may ignore Task
> ([F17.8](docs/hypotheses.md)); a delegating framing variant is the planned fix.

## DeepSeek Harness (dsh) as a frontend

The proxy is a standard OpenAI-compatible endpoint, so [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`npm i -g @deepseek-ai/dsh`) works as a full Web-UI agent on M365 models:

```powershell
m365-dsh          # starts proxy if needed, opens the dsh Web UI
```

Config lives in `~/.dsh-m365/settings.yaml` (provider `m365` → `http://127.0.0.1:4141/v1`,
models gpt-5.5 / claude-opus-5 / claude-sonnet-5 / sol; default route set via the
`agent-default-model:` section). Headless mode: `dsh --profile headless "task"` with
`DSH_HOME=%USERPROFILE%\.dsh-m365`. dsh ships native sub-agents, workflows, and a
plan tool — all driving your M365 models through this proxy.

## Status dashboard

While the proxy runs, open **http://127.0.0.1:4141/** — a local-only page showing tone-health
circuit breakers, recent upstream turn latencies (total + TTFT per turn), and pool/gate state.
Raw JSON: `/internal/stats`. Keep the proxy bound to 127.0.0.1.

## TTFT / perceived latency

Tool-mode responses now **stream their prose live**: the moment M365 emits preamble text
("Let me check the files…") it flows to the client — only the tool-call fence itself is held
back until the turn completes and is parsed into `tool_calls`. Fence bytes never leak as
content (guarded forwarder with holdback window; see [hypotheses §17](docs/hypotheses.md)).
Remaining latency after that is M365 server think-time (measured: gpt-5.5 ≈5s/turn healthy;
Claude tones vary 5–50s under load). Tune retry pacing with `M365_EMPTY_RETRY_DELAY_MS` /
`M365_MAX_EMPTY_RETRIES`, conversation-start stagger with `M365_CONVERSATION_START_GAP_MS`.

## Generic OpenAI-upstream mode

Set `OPENAI_UPSTREAM_BASE_URL` (+ `OPENAI_UPSTREAM_API_KEY`) **before starting the proxy** to
bypass M365 entirely and point Claude Code / any Anthropic client at any OpenAI-compatible
backend — the same job as LiteLLM-based bridges (`claude-code-proxy` et al.), no Python needed:

```powershell
$env:OPENAI_UPSTREAM_BASE_URL = "https://api.openai.com"   # or OpenRouter / vLLM / LM Studio
$env:OPENAI_UPSTREAM_API_KEY  = "sk-..."
$env:UPSTREAM_BIG_MODEL       = "gpt-4.1"                  # sonnet/opus requests map here
$env:UPSTREAM_SMALL_MODEL     = "gpt-4.1-mini"             # haiku requests map here
.\start-proxy.ps1
```

`POST /v1/chat/completions` becomes a near-verbatim reverse proxy (model remapped);
`POST /v1/messages` gets full Anthropic⇄OpenAI translation incl. streaming tool_use.
Unset the variable and the proxy returns to M365 mode. M365-specific features (tone
failover, ToolSearch deferred catalog, breaker dashboard data) apply to M365 mode only.

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` (truncated payloads) |
| `M365_TRACE` | Set to `1` for full, untruncated debug logging (every WS frame/prompt/response) — implies `M365_DEBUG`. For reverse engineering. |
| `M365_LOG_STDOUT` | Set to `1` to mirror debug lines to the proxy's stdout as well as the log file, so you can watch a run without tailing it in a second terminal. Needs `M365_DEBUG` or `M365_TRACE` — on its own it logs nothing. |
| `M365_DUMP_FRAMES` | Set to `1` to write every WebSocket frame (both directions) to `~/.config/opencode-m365/frames/<requestId>.ndjson`. For offline diffing of new M365 fields. |
| `M365_NO_MULTI_TOOL` | Batched tool calls are now **ON by default** (models naturally emit several gather-checks in one turn — e.g. `/doctor`-style sweeps; one-call-per-turn made those parse-fail). Set to `1` to restore the old truncate-to-first behavior. The fenced parser also accepts CommonMark-style LONG fences (`````bash … `````) so bodies containing ` ``` ` sequences — or models wrapping nested markdown — parse correctly instead of leaking as text ([F17.7](docs/hypotheses.md)). |
| `M365_ALLOWED_TOOLS` / `M365_MAX_TOOLS` | Lean-toolset control (M365 ignores tool framing on large payloads — [F16.4](docs/hypotheses.md)). `M365_ALLOWED_TOOLS="Bash,Read,Edit,Write,Glob,Grep"` keeps only those names; `M365_MAX_TOOLS="6"` caps the advertised count (original order wins). Tools dropped by either become a **deferred catalog**: still executable by the client, hidden from M365 behind a synthetic `ToolSearch` meta-tool the model can call to pull matching definitions into the conversation. The daemon launcher defaults to the 6 core tools; set `M365_ALLOWED_TOOLS=""` to disable filtering. |
| `M365_NO_TONE_FAILOVER` | Set to `1` to disable automatic tone failover. By default, when the requested Claude tone is in an upstream outage (`turnState:"Failed"` empties — the F16.3 signature) or its circuit breaker is open after `M365_BREAKER_THRESHOLD` consecutive failures (default 3, cooldown `M365_BREAKER_COOLDOWN_MS`, default 10 min), the proxy transparently retries/reroutes on a healthy fallback (sonnet↔opus↔gpt-5.5) on a **new** conversation. Throttle-class empties never fail over — degradation backoff owns those. |
| `M365_INJECT_REPLY_TOOL` | Set to `1` to inject a synthetic `reply(text)` tool. Forces every turn to be a tool call, including pure-prose answers. Cleaner contract for the model, +1 tool to the prompt (watch the Disengaged threshold). Confirmed 5/5 compliance on June 9 2026 ([hypotheses §1.1](docs/hypotheses.md)). |
| `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES` | M365's chat model sometimes produces prose instead of a tool call when it should act — either confabulating an inability ("I can't access the files, please paste them") **or** claiming a completion it never did ("I've replaced the README", with no tool call). On a first-turn refusal, the proxy now returns a safe read-only `bash` orientation call directly (when available), avoiding an extra M365 message; other detected cases are re-prompted forcefully **in the same conversation** (`M365_CONFAB_RETRIES`, default `1`). Set `M365_NO_CONFAB_RETRY=1` to disable recovery. |
| `M365_NO_BACKOFF` (alias `M365_NO_AUTO_REAUTH`) | Set to `1` to disable degradation backoff. By default, when empty/throttled responses span several **distinct conversations** in a short window (the thread-rate-throttle signature, [F13](docs/hypotheses.md)), the proxy **paces subsequent turns** (a jittered delay before starting new backend conversations) to let the account self-heal. This replaced the old auto-reauth: a fresh login does **not** clear this throttle (it's `oid`-keyed — [§11 H-R1](docs/hypotheses.md)) and raised our detection profile. A single long pi thread never trips the trigger. |
| `M365_BACKOFF_THRESHOLD` / `M365_BACKOFF_WINDOW_MS` / `M365_BACKOFF_BASE_MS` / `M365_BACKOFF_MAX_MS` | Tune backoff: distinct-conversation empties to trigger (default `3`), the window they must fall in (default `120000`), the initial pacing window (default `90000`), and its escalation cap (default `600000`). |
| `M365_BROWSER_PROFILE` / `M365_LOGIN_UA` | Override the persistent browser-profile dir and the login User-Agent used for the (rare) automated interactive login. The persistent profile keeps AAD SSO/device cookies so repeat logins are silent and look like a familiar device ([§11 H-R3](docs/hypotheses.md)). |
| `M365_CACHE_FILE` | Override MSAL token cache location |
| `M365_SECRETS_FILE` | Override credentials file location |
| `M365_INTERACTIVE_LOGIN` | Set to `1` to use visible browser sign-in when silent refresh is unavailable |
| `M365_PROXY_API_KEY` | Bearer key required by `/v1/*`; generated by `scripts/setup-local.sh` |
| `M365_REQUIRE_API_KEY` | Fail startup when the bearer key is absent; enabled by the local launcher |
| `M365_LOCAL_ENV` | Override the private local environment file used by the launch scripts |
| `CHROMIUM_PATH` | Path to Chromium binary for automated login |

### Usage / context-window % in responses

The OpenAI `usage` block in every chat completion response now includes M365
extension fields with the **per-conversation message quota** — the closest
proxy we have to "context-window utilisation" since M365 hides token counts:

```json
"usage": {
  "prompt_tokens": 0,
  "completion_tokens": 0,
  "total_tokens": 0,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_message_type": null,
  "x_m365_turn_count": 3,
  "x_m365_classifier_scores": {
    "BotOffense": 1.27e-7,
    "dea_violation": 2.81e-6
  },
  "x_m365_dea_score": 2.81e-6,
  "x_m365_offense_score": 1.27e-7
}
```

`x_m365_dea_score` is M365's own "disengaged-eligible answer" classifier
score — the closest signal to "am I about to get Disengaged?". Empirically:
clean tool calls sit at ~1 × 10⁻⁸, prose at ~1 × 10⁻⁶, jailbreak-shaped
prompts at ~1 × 10⁻³. Disengaged itself fires at some threshold > 2 × 10⁻³
that we haven't yet pinpointed. Clients can monitor this to back off before
tripping the filter.

Clients that ignore unknown extension fields keep working; curious users can
read them. See [docs/hypotheses.md §0](docs/hypotheses.md) for the full
findings dump and [§2](docs/hypotheses.md) for what we tried and didn't find.

## Config files

Authentication state is stored in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `msal-cache.json` | MSAL token cache (auto-managed) |
| `agent-id.json` | Cached Copilot Studio agent ID |
| `debug.log` | Debug log (when `M365_DEBUG=1`) |

The local proxy key is stored separately at
`~/.config/m365-copilot-proxy/proxy.env` (`0600`). Pi state is stored under
`~/.local/state/m365-copilot-proxy/pi-home/`. Neither location contains the Microsoft
password or an MFA seed.

## Development

```sh
bash scripts/local.sh install
bash scripts/local.sh build            # Build all packages
bash scripts/local.sh proxy:local       # Start localhost-only proxy on :4141
bash scripts/local.sh test:unit         # Run vitest unit tests (no auth/network)
bash scripts/local.sh test:live         # Run live integration tests against M365
```

## Known limitations

- **M365 "disengages" on large tool payloads** — heavy agent harnesses (e.g. opencode's ~15-tool prompt) get empty `Disengaged` responses. Keep the toolset lean (this is why [pi](https://pi.dev/) works well). See [docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter).
- Tool calling is emulated (prompt injection + a Copilot Studio agent), not native function calling — robust with the agent, unreliable without it
- The `think-deeper` / `*_Reasoning` models take 10-30s per response
- Hard quota of ~600 messages **per conversation** (mitigated by session reuse + delta sends)
- Streaming: **tool-less** responses stream incrementally (deltas forwarded as they arrive). **Tool-calling** turns are still buffered server-side — the raw text has to be parsed for tool-call fences before it can be emitted — so those arrive as a single chunk at the end (with an immediate HTTP 200 + heartbeats so the client never times out waiting)

## License

[MIT](LICENSE). Use at your own risk — this speaks to Microsoft's API with your own
credentials, on your own account, and that's between you and your tenant's
acceptable-use policy.
