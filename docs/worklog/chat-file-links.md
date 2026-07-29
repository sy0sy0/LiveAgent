# Chat file links

## Goal

Provide one safe, cross-platform chat file-link path for desktop and Gateway Web. Historical and streaming assistant Markdown must recognize local paths without weakening URL sanitization, and user clicks must resolve/open the path on the conversation's owning host.

## Baseline

- Branch: `fix/chat-file-links`
- Base: `upstream/main` at `410eef1d`; fetched and verified on 2026-07-29.
- Existing unrelated worktree changes are present and must be preserved, notably `Cargo.lock` and local/untracked project files.
- Pre-existing draft files for `chatFileLinks.ts` and GUI `Markdown.tsx` were found. Audit identified duplicate plugin declarations, sanitize/harden bypass, external-link regression, unsafe scheme classification, and missing click plumbing. Treat the draft as unverified input, not completed work.
- `.trellis/` is absent, so `trellis-before-dev` could not load package specs. Repository CodeGraph was synced and used for discovery.

## Execution plan

1. Add failing parser and Markdown rewrite tests for the reported Windows path and the complete path/security matrix.
2. Implement byte-identical GUI/Web parser and safe pre-sanitize rewrite using only `liveagent-file:`.
3. Add accessible file-link rendering while preserving Streamdown external-link confirmation and dangerous-protocol blocking.
4. Carry conversation id/workdir and the click callback through Transcript → AssistantRow → AssistantBubble → RoundContent → Markdown.
5. Add a Tauri command that resolves relative paths against the conversation workdir, canonicalizes, classifies, and returns a safe action. Never execute scripts/executables.
6. Extend the Gateway protobuf relay and Web shim so requests are sent only to the selected/owning agent, with offline/mismatch/timeout errors.
7. Reuse/extend workspace editor and preview requests for in-app text/preview handling and line/column location.
8. Run targeted tests, Rust/Go checks, GUI/Web build+lint+tests, mirror check, diff check, and responsive UI verification.

## Recovery checkpoint

Implementation is complete across the parser, Markdown pipeline, explicit GUI/Web prop chains,
workspace editor location handling, controlled Rust open policy, and Gateway protobuf relay.

Key invariants now enforced:

- `raw → rewriteChatFileLinks → sanitize → harden`; only `liveagent-file:` is added.
- Internal payloads require an AST marker created before sanitize plus a canonical codec round trip.
- The target agent reloads `conversation_id` from its own history database and uses the stored
  `cwd`; the request-supplied workdir is never the relative-path base.
- Paths are canonicalized after click. Missing targets fail before any system process is spawned.
- Scripts open in the editor; executable/active-content files and bundles are revealed, never run.
- Workspace directories use the file tree first, then a validated directory-only file-manager
  fallback. Workspace-external previewable files reuse existing editor/preview readers.

Completed checks:

- GUI parser/Markdown/security tests: 20 passed.
- Gateway parser/adapter/prop-chain tests: 11 passed; complete Web suite: 483 passed.
- Go `internal/protocol/pbws`: passed. Full `go test ./...` passed every other package but is
  blocked on Windows by the pre-existing `agenttoken` permission assertion (0666 vs 0600).
- Rust `chat_file_links` tests: 5 passed using temporary `libclang` tooling;
  `cargo check --tests` passed with five unrelated existing warnings.
- GUI and Gateway Web production builds and `tsc` passed.
- Full GUI frontend suite ran 1,353 tests: 1,348 passed and five unrelated static-source/preset
  sync tests failed (`mention-composer-selection`, `mention-refetch`, provider usage preset sync).
- Full GUI/Web Biome checks were attempted and are blocked by hundreds of existing repository
  diagnostics/CRLF formatting differences. Task-core targeted Biome lint passed; large touched
  host files reported only existing warnings and no diagnostics on the new handlers.
- Mirror check passed for all 116 mirrored files; `git diff --check` passed.
- Playwright narrow-width check: 390px and 412px had no horizontal overflow; mouse, Enter,
  and Space each generated one click; tooltip and focus outline were present.

## Hardening follow-up — 2026-07-29

The follow-up closes the remaining review findings without changing the public file-link contract:

- Escaped Markdown links remain literal, including candidates whose label contains escaped punctuation
- Linked editor locations apply once per request and tab, so typing no longer resets the caret
- Directories are classified before file extensions; macOS active directory packages fail closed
- Unknown binary and active targets never reach the host opener
- Gateway file-open work runs outside the serial envelope loop, with a 25-second timeout and a four-request concurrency limit
- Detached Gateway responses stay bound to the outbound connection that received the request

Verification for the follow-up snapshot:

- GUI targeted chat/Markdown tests: 23 passed
- Gateway targeted chat-file-link tests: 5 passed
- Rust `chat_file_links` tests: 5 passed; `cargo check --tests` passed with five unrelated existing warnings
- GUI and Gateway Web `pnpm build`: passed
- Focused Biome checks for the changed Markdown/editor logic: passed with only existing editor accessibility warnings
- Full package Biome checks remain unusable on this Windows checkout because untouched files produce hundreds of existing CRLF-format and lint diagnostics; no broad formatting rewrite was applied
- `cargo fmt --check`, mirror check for 116 files, and `git diff --check`: passed
- `Cargo.lock`, `Cargo.toml`, generated build output, and unrelated local files are excluded from the follow-up

The hardening implementation and local verification are complete. Commit, push, PR creation, and remote CI follow this checkpoint.

## Maintainer safety follow-up — 2026-07-29

Host file-manager fallbacks now reveal or select directory targets instead of opening the targets
through platform file associations. This keeps unrecognized macOS bundles such as `.prefPane`,
`.saver`, `.bundle`, and `.plugin` directories from being launched after a chat-file-link click.
Platform command construction and the directory-package plan are covered by focused Rust regression
tests.
