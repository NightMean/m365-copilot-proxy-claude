# Upstream Provenance and Lineage Analysis

This document records the provenance, commit history, licensing, and architectural divergence across the four upstream Microsoft 365 Copilot repositories evaluated for this gateway.

## Upstream Repositories

| Repository | Branch | Exact HEAD SHA | Commit Date | License | Primary Role |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`mahmoudsallem/m365-copilot-proxy-claude`** | `main` | `6377d04ba04d10a617c1214c3b9b83fd24dcd247` | 2026-08-26 | MIT | **PRIMARY BASE** (Anthropic Messages API, TurnGate concurrency serialization, offline e2e tests, launcher scripts, profile isolation). |
| **`cramt/m365-copilot-proxy`** | `main` | `d7c6d8080bf2bb769c1949c2dfbe60bb7ca929c3` | 2026-08-17 | MIT | **UPSTREAM REFERENCE** (SignalR protocol, fenced tool calling, shell routing, GPT-5.6 tone validation, Copilot Studio agent caching, Windows shell routing). |
| **`Theprosonce/m365-copilot-proxy`** | `main` | `8eddc3e7bf772eb350da3d2bedc2656f79230b2c` | 2026-07-27 | Apache 2.0 | **FEATURE REFERENCE** (Image vision upload via `UploadFile`, SQLite session persistence with LRU/TTL, `disableMemory=1` temporary chat, `agent=web/work` grounding). |
| **`iv0rish/m365-copilot-proxy`** | `main` | `4a86427f3dc80c01e5e79a48106c8bdcfe263608` | 2026-07-08 | *None* | **DESIGN REFERENCE ONLY** (Browser calibration pattern: observing first-party web request shape via dedicated browser session to detect protocol changes). Reimplemented independently without copying source. |

---

## Divergence: `mahmoudsallem` vs `cramt`

- **Common Merge Base**: `9e880b7377652ebdba54f9fc77feeae501d10ce9`
- `mahmoudsallem` is **27 commits ahead** and **9 commits behind** `cramt/main`.

### Upstream Commits on `cramt` Missing from `mahmoudsallem`
These 9 commits represent critical upstream fixes incorporated into our codebase:

1. `d7c6d80` — `fix(agent): derive the Power Platform host from both DNS labels`
   - Fixes Copilot Studio agent resolution across environment domains.
2. `3ea3983` — `Merge pull request #11 from chrischall/docs/opencode-harness-findings`
3. `673911b` — `fix(fenced): route Windows shell fences, and tell the model which OS it is on`
   - Unconditionally routes Windows fences (`powershell`, `pwsh`, `cmd`, `bat`) and injects `hostPlatformNote()` so the model does not emit Linux `cat <<'EOF'` or `sed -i` on Windows hosts.
4. `6346b75` — `docs: how to trim opencode under the Disengaged threshold, and where it has to happen`
5. `805c1b7` — `fix(auth): clear the login race timer, and verify interactive sign-in live`
   - Clears timeout race timer when interactive login succeeds.
6. `bf687ae` — `feat(auth): user-driven interactive sign-in for tenants with no TOTP seed`
7. `34cb916` — `fix(tools): anchor remote-artifact detection, document three-state tone validation`
   - Anchors remote-artifact detection (Teams asyncgw diff links and citation markers) and GPT-5.6 `/mnt/data` hallucinated sandbox completion patterns.
8. `8a64f9c` — `Merge PR #5: GPT-5.6 tone + remote-artifact guard`
9. `3dbb35f` — `feat: add GPT-5.6 and guard remote artifacts`

### Commits Added by `mahmoudsallem` Ahead of `cramt`
Key contributions retained and verified:
- Anthropic Messages API implementation (`POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`).
- `TurnGate` FIFO queuing and sequential turn serialization to prevent concurrent SignalR request collisions.
- Offline end-to-end integration tests (`packages/proxy-lib/src/e2e.offline.test.ts`).
- Profile isolation (`x-m365-profile` header) and launcher scripts (`connect-claude`, `disconnect-claude`, `claude-m365.ps1`).

---

## Feature Traceability Matrix

| Feature | Source Repository | Source Commit | Source Files | Adaptation Strategy | Rationale & Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Anthropic Messages Protocol** | `mahmoudsallem` | `910f7b5`, `c2219fb` | `packages/proxy-lib/src/anthropic.ts`, `routes/v1/messages.post.ts` | Adapted | Essential for Claude Code CLI integration. |
| **Turn Serialization (TurnGate)** | `mahmoudsallem` | `4dc9230`, `c2219fb` | `packages/proxy-lib/src/gate.ts`, `turn-queue.ts` | Adapted | Prevents race conditions and desynchronization in multi-turn chats. |
| **SignalR Protocol & Framing** | `cramt` | `d445ebf`, `3dbb35f` | `packages/core/src/session.ts`, `schemas.ts` | Adapted | Upstream reference transport for M365 Copilot private web protocol. |
| **Windows Shell Fence Routing & OS Note** | `cramt` | `673911b` | `packages/core/src/fenced.ts` | Ported | Prevents model confabulation on Windows by emitting PowerShell fences instead of Linux heredocs. |
| **Remote Artifact Guard** | `cramt` | `34cb916` | `packages/core/src/tools.ts` | Ported | Detects when M365 generates Teams patches instead of executing local edit/write tools. |
| **Copilot Studio Agent Resolution** | `cramt` | `d7c6d80` | `packages/core/src/agent.ts` | Ported | Corrects DNS label resolution for Power Platform tenant environments. |
| **Interactive Sign-in Race Fix** | `cramt` | `805c1b7` | `packages/core/src/auth.ts` | Ported | Prevents premature timeouts during browser MFA authentication. |
| **Image Vision Input (`UploadFile`)** | `Theprosonce` | `3b122f9` | `packages/core/src/vision.ts`, `session.ts` | Reimplemented in TypeScript | Converts Anthropic base64 images to multipart `UploadFile` requests, returns `docId` annotations. |
| **Private Chat (`disableMemory`)** | `Theprosonce` | `3b122f9` | `packages/core/src/session.ts` | Ported to WebSocket URL | Sets `disableMemory=1` to prevent corporate history contamination. |
| **Grounding Controls (`agent=web`)** | `Theprosonce` | `3b122f9` | `packages/core/src/session.ts` | Ported to WebSocket URL | Defaults `agent=web` to isolate coding sessions from internal enterprise documents. |
| **SQLite Session Persistence** | `Theprosonce` | `94c88eb` | `packages/proxy-lib/src/session-store.ts` | Adapted in TypeScript | Extends JSON session store with SQLite backend, TTL, and LRU eviction. |
| **Browser Calibration Probe** | `iv0rish` | `4a86427` | `packages/core/src/calibrate.ts` | Cleanroom Reimplementation | Independent diagnostic tool to observe same-origin M365 requests and sanitize headers. |
| **Centralized Model Registry** | *Current Project* | *N/A* | `packages/core/src/model-registry.ts` | Original | Enforces strict truthfulness for `gpt-5.6-think-deeper` and `claude-opus` (no silent fallbacks). |
| **Deterministic Fake Simulator (12 fixtures)** | *Current Project* | *N/A* | `packages/core/src/fake.ts`, `packages/proxy-lib/src/e2e.offline.test.ts` | Enhanced from core fake | Simulates all required protocol fixtures for complete offline testing. |

---

## Licensing Notes

1. **`mahmoudsallem/m365-copilot-proxy-claude`**: MIT License (Alexandra Østermark & contributors).
2. **`cramt/m365-copilot-proxy`**: MIT License (Alexandra Østermark).
3. **`Theprosonce/m365-copilot-proxy`**: Apache License 2.0 (Theprosonce). Ported vision and session concepts are adapted into TypeScript.
4. **`iv0rish/m365-copilot-proxy`**: No license. In accordance with Section 20 and Phase 0 guidelines, **no code is copied** from iv0rish. The browser observation architecture is implemented independently as a diagnostic tool.
