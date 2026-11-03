# Project instructions

## Documentation and private planning

- Store agent plans, research, notes, and test artifacts only under `.agent/`.
- Never commit anything under `.agent/`. Preserve its `.gitignore` rule and the local `.git/info/exclude` protection.
- Do not create documentation outside `.agent/` unless the user explicitly requests it. This root `AGENTS.md` was explicitly requested.
- Keep the implementation plan in `.agent/plan.md` current as work progresses.
- Do not create a README or other public documentation as part of packaging without explicit permission.

## Implementation workflow

- Work in small, independently verifiable, commit-sized steps following `.agent/plan.md`.
- Read relevant installed Pi documentation and examples before implementing integration changes.
- Prefer supported extension, SDK, and TUI APIs. Do not create a second terminal renderer inside the extension.
- Verify a true side-by-side layout first. An overlay that obscures main chat is not an equivalent substitute.
- The user approved a guarded, Pi 1.5.0-pinned private adapter. Confine private API access to `src/pi-1.5-adapter.ts` and fail closed on incompatible versions/shapes. Discuss any broader private API dependence or Pi core changes before proceeding.
- Do not silently drop custom tools, MCP tools, tool policies, or context during forking. Report integration limitations explicitly.
- TypeScript checks are allowed; do not add unit tests.

## End-to-end testing

- Run extension tests in `agent-workspace-linux` in headless mode, using the available MCP tools to launch and interact with real Pi in a terminal.
- Test the complete application through user-visible keyboard interaction, focus changes, resizing, and rendered output; do not substitute direct component calls for E2E coverage.
- Use isolated temporary projects and Pi configuration for tests. Do not modify user credentials or normal sessions.
- A local deterministic model endpoint may provide repeatable responses and capture model requests, but sessions, tools, and terminal rendering must remain real.
- Verify context isolation by inspecting outgoing model requests, not just assistant claims.
- Keep screenshots, terminal captures, logs, and other agent test artifacts under `.agent/` and out of commits. Do not store secrets in artifacts.
- Cover shared file effects, custom/MCP tools, cancellation, reopening, reload, session replacement, errors, and process cleanup.
- Run a real-provider smoke test when credentials and access are available; report unavailable coverage honestly.
- Cancellation cannot undo completed file changes or guarantee cancellation of external operations.
