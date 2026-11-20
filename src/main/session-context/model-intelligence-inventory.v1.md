# Model Intelligence Operational Field Inventory (`model-intelligence-inventory-v1`)

Versioned disposition registry for authorized operational metadata across Entire (`0.12.2`, `0.13.4`) and native Codex / Antigravity sources. Runtime contract: [model-intelligence-inventory.ts](./model-intelligence-inventory.ts).

## Dispositions

- `PERSISTED`: Extracted and stored structurally in `SessionStore`.
- `REFERENCED`: Stored via locator, byte range, or SHA-256 digest without duplicating source bodies.
- `DERIVABLE`: Deterministically derived from persisted or referenced facts.
- `UNAVAILABLE`: Not emitted by the source version/schema or gated by absent grant.
- `UNSUPPORTED`: Internal/ephemeral CLI runtime artifact outside stable public read contracts.
- `EXCLUDED_PRIVACY`: Free-text prompts, reasoning text, raw tool payloads, PII, or secrets never stored in intelligence tables.

## Summary by Surface

| Surface | Versions | Granularity | Key Fields | Disposition |
| --- | --- | --- | --- | --- |
| `entire_session_list` | `0.12.2`, `0.13.4` | `session` | `session_id`, `agent`, `status` | `PERSISTED` |
| `entire_session_list` | `0.12.2`, `0.13.4` | `session` | `worktree_path` | `REFERENCED` |
| `entire_session_info` | `0.12.2`, `0.13.4` | `session`, `turn` | `started_at`, `ended_at`, `model`, `turns`, `pending_turns` | `PERSISTED` |
| `entire_session_info` | `0.12.2`, `0.13.4` | `session` | `effort`, `reasoning_effort` | `UNAVAILABLE` |
| `entire_session_tokens` | `0.13.4` | `session` | `tokens.{input,output,cache_read,cache_write,total,api_calls}` | `PERSISTED` |
| `entire_session_tokens` | `0.13.4` | `session` | `signals`, `recommendations` | `DERIVABLE` |
| `entire_checkpoint_top_metadata` | `0.12.2`, `0.13.4` | `checkpoint` | `token_usage` | `PERSISTED` |
| `entire_checkpoint_session_metadata` | `0.12.2`, `0.13.4` | `checkpoint` | `model`, `token_usage` | `PERSISTED` |
| `entire_checkpoint_session_metadata` | `0.12.2`, `0.13.4` | `checkpoint` | `intent` | `EXCLUDED_PRIVACY` |
| `entire_transcript_*` | `0.12.2`, `0.13.4` | `call` | `fields[]` (byte range + sha256) | `REFERENCED` |
| `entire_transcript_*` | `0.12.2`, `0.13.4` | `call` | `files[]` | `PERSISTED` |
| `entire_transcript_*` | `0.12.2`, `0.13.4` | `call` | `payload.{message,arguments,input,output}`, `content`, `reasoning` | `EXCLUDED_PRIVACY` |
| `entire_state` | `0.12.2`, `0.13.4` | `session` | `.git/entire-sessions/*.json` | `UNSUPPORTED` |
| `codex_native_jsonl` | `0.169.0-alpha.11.1` | `turn` | `turn_context.payload.{model,effort,approval_policy,sandbox_policy,collaboration_mode}` | `PERSISTED` |
| `codex_native_jsonl` | `0.169.0-alpha.11.1` | `turn` | `turn_context.payload.{user_instructions,developer_instructions}` | `EXCLUDED_PRIVACY` |
| `codex_native_jsonl` | `0.169.0-alpha.11.1` | `session`, `call` | `event_msg(token_count).payload.info.{total_token_usage,last_token_usage,model_context_window}` | `PERSISTED` |
| `codex_native_jsonl` | `0.169.0-alpha.11.1` | `task`, `subagent` | `task_started/complete.turn_id`, `session_meta.payload.source.subagent` | `PERSISTED` |
| `codex_native_jsonl` | `0.169.0-alpha.11.1` | `session` | `session_meta.payload.{creator_user_id,creator_account_id}` | `EXCLUDED_PRIVACY` (hashed to `providerAccountHash`) |
| `codex_native_app_server` | `app-server-v1` | `session` | `thread.{id,modelProvider,archived,createdAt,updatedAt}` | `PERSISTED` |
| `antigravity_native_step_jsonl` | `antigravity-step-jsonl-v1` | `call` | `step_index`, `type`, `source`, `created_at`, `status`, `error_code`, `tool_calls[].name` | `PERSISTED` |
| `antigravity_native_step_jsonl` | `antigravity-step-jsonl-v1` | `call` | `model`, `effort`, `token_usage` | `UNAVAILABLE` |
| `antigravity_native_vscdb` | `vscdb-v1` | `session` | `conversation_id`, `workspace_uris`, `last_modified_time` | `REFERENCED` |
| `native_hook_envelope` | `hook-v1` | `session` | `provider`, `hookEvent`, `sessionId`, `worktreePath`, `occurredAt` | `PERSISTED` |
