# Web Activation Contract (`code-awareness-activation/v1`) & Chrome/Windows Native Bridge

## Overview

Code Awareness connects external web AI chats (`https://chat.deepseek.com` and `https://chat.qwen.ai`) to the local Code Awareness Desktop MCP Skills and read-only navigation surface using:

1. **Native MCP Skills Extension (`io.modelcontextprotocol/skills`, protocol revision `2026-07-28`)** served by Code Awareness Desktop (`server/discover` negotiating `resources.directoryRead: false`, `initialize`, `skills/list` with `catalogRevision`, `skills/get`, `resources/read`, `resources/list`). When no project is bound, `McpLifecycle.ensureGlobalSkillsEndpoint()` lazily serves global Academy skills cleanly (`GLOBAL_ONLY`).
2. **Reusable Native Messaging Port (`chrome.runtime.connectNative`) & Windows Host (`com.ericrocha.codeawareness.web_activation`)** communicating via `UInt32LE` length-prefixed stdio frames (`NativeMessagingProtocol`), reusing a persistent multiplexed `Port` keyed by request `id` with configurable idle TTL (closed only when no operations are pending) and fail-closed disconnect/reconnect handling. The bridge discovers the running Desktop endpoint via `LocalChannelHost` (`web_activation.endpoint`), fails closed with `APP_UNAVAILABLE` if Desktop is stopped, and enforces:
   - strict Chrome extension + allowed web origin checks (`ORIGIN_NOT_ALLOWED`);
   - session binding continuity (`PROJECT` / `bindingId` / `instanceId` -> `SESSION_INVALIDATED`);
   - read-only method/tool allowlists (`METHOD_NOT_ALLOWED`, `TOOL_NOT_ALLOWED`, `skill://` URI confinement);
   - persistent revocable egress consent (`ConsentStore`) keyed by `site + projectId + dataClass` (`METADATA` vs `LITERAL_SOURCE`).
3. **Progressive Emulated Host Activation Contract (`code-awareness-activation/v1`)** in `ActivationSession`:
   - **Progressive Bootstrap**: the first turn sends only the compact `name + description + uri` catalog of authorized skills and the `skills.load` invocation contract (no MCP tool inventory or JSON schemas upfront).
   - **Two Separate Projections**: the extension/host retains full internal manifests (`resources[].digest`, `size`, `ttlMs`, `cacheScope`, `catalogRevision`, and tool `inputSchema`), while the model-facing `code-awareness-result` projection returns only status, canonical skill identity, verified content, compact `availableTools` (`name + description`), and pagination indicators (`truncated`, `totalChars`, `offset`, `nextOffset`), dynamically adjusting Markdown fence lengths and escaping closing sequences against adversarial delimiters.
   - **On-Demand Tool Schemas & Integrity**: `tools.schema` delivers full `inputSchema` only for explicitly requested read-only tools before `tools.call`. `skills.load` / `skills/get` + `resources/read` enforce exact `skill.uri === requestedUri`, authorized namespace, UTF-8 byte length, SHA-256 digest, field-by-field YAML frontmatter equality (`parseSkillFrontmatter` / `deepEqualFrontmatter`), acting-window confinement, content-bound approvals, single-request envelopes (`requests[]` batching rejected with `BATCHING_NOT_SUPPORTED`), and selective `catalogRevision` cache revalidation.

## Packaging & Setup

Build the Chrome MV3 extension (`dist/web-extension/`) and Native Messaging host bundle (`dist/web-activation/native-host.cjs`):

```bash
npm run web-activation:build
```

Load `dist/web-extension/` in `chrome://extensions` (Developer Mode -> Load unpacked), copy the generated Extension ID, and register the Windows Native Messaging Host into a stable (non-worktree) location such as `%LOCALAPPDATA%\CodeAwareness\web-activation\`. Use `installNativeMessagingHost` from `src/main/web-activation/native-host-registration.ts` to write the manifest, launcher `.cmd`, and `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ericrocha.codeawareness.web_activation`.

## Security Guarantees

- Read-only bridge: write tools, script execution, CLI execution, Git writes, file edits, Academy mutations, and Continuum publication are never exposed.
- Consent changes (`SET_CONSENT`) are accepted only from trusted extension UI (`popup.html`), never from web page tabs or content scripts.
- No Skill bodies, MCP tool schemas, cryptographic digests, or source files are eagerly injected into the web prompt during first-turn bootstrap.

## Extension Manager (Build, Reload & Remote Attestation)

For development unpacked installations (`installType === "development"`), the Code Awareness Channel exposes three operational tools (`get_web_extension_status`, `start_web_extension_operation` with `action: BUILD | RELOAD | UPDATE`, and `get_web_extension_operation`). None of these tools are ever exposed over the web activation read-only allowlist.

1. **Managed Installation Enrollment**:
   - Enroll the active machine installation explicitly through the Local Agent Channel:
     ```bash
     node scripts/local-agent/local.cjs web_activation enroll --extension-id <extId> --profile-id <profileId> --unpacked-path <canonicalUnpackedDir> --host-install-dir <stableHostDir> --host-script-path <stableHostScript> --source-repo <canonicalCheckout>
     ```
   - Supports one active managed installation per Desktop profile (`enrollment.json`), requiring canonical non-symlink/junction paths and revocable at any time via `web_activation revoke`.
2. **Isolated Staging & Transactional Promotion**:
   - `BUILD` validates `expectedSourceHead` / clean working tree and compiles isolated staging bundles (`background.js`, `content-script.js`, `popup.js`, `native-host.cjs`) embedding an immutable `buildId`, `sourceHead`, `inputsFingerprint`, and per-file SHA-256 hashes without disturbing the live unpacked directory.
   - `UPDATE` revalidates source drift and promotes staged bundles atomically on the same volume with a minimal rollback journal (`swap-journal.json`) while preserving `allowed_origins` in the Native Messaging host manifest.
3. **MV3 Maintenance, Quiescence & Attestation**:
   - Background SW schedules a low-cost 1-minute `chrome.alarms` check only for enrolled `development` installs (backing off up to 15 min on `APP_UNAVAILABLE` and clearing immediately if unmanaged/revoked).
   - Before calling `chrome.runtime.reload()`, active tool calls, streaming responses, and recent draft typing defer the reload (`WAITING_IDLE`).
   - Post-reload startup sends a fresh `bootId`, compiled `buildId`, `manifestVersion`, `extensionId`, `installationId`, and host `hostBuildId`, then idempotently re-injects `content-script.js` into open authorized tabs via `chrome.scripting.executeScript` (preserving existing composer text) before converging to `VERIFIED` (or `PARTIAL` / `NOT_ATTESTED`).

> **Post-Integration Live Migration**: After merging changes to the canonical `main` checkout, rebuild with `npm run web-activation:build`, copy updated unpacked files into the live unpacked directory, update `%LOCALAPPDATA%\CodeAwareness\web-activation\native-host.bundle.cjs`, reload once in `chrome://extensions`, and run `web_activation enroll`.
