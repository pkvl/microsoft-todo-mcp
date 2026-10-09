# Microsoft To Do MCP — personal-account fork

A local MCP server for Microsoft To Do, maintained in [pkvl/microsoft-todo-mcp](https://github.com/pkvl/microsoft-todo-mcp), based on [Fabien Butz's MIT-licensed implementation](https://github.com/fabienbutz/microsoft-todo-mcp).

This fork adds protected Graph destinations, OS-encrypted credential persistence, and a durable create-operation journal. The upstream npm package does not include these changes. Use this checkout's local build.

## Setup

Requires Node.js 22.12 or newer and an available native credential store. Windows uses DPAPI for the current user; macOS uses Keychain; Linux uses Secret Service. Plaintext credential fallback is disabled.

```powershell
npm ci
npm run build
node dist/index.js login
node dist/index.js serve --no-destructive
```

Complete Microsoft's device-code sign-in with your personal account. No client secret is required. The default identity is Microsoft Graph Command Line Tools. To use your own registration, set `MS_TODO_CLIENT_ID` to a public-client app supporting personal Microsoft accounts.

Configure your MCP client to run `node` with the absolute path to `dist/index.js` and `--no-destructive`. See [local client setup and migration](docs/HARDENING.md).

## Tools

- Authentication: `auth_status`, `sign_in`.
- Lists: `list_task_lists`, `create_task_list`, `update_task_list`, `delete_task_list`.
- Tasks: `list_tasks`, `get_task`, `create_task`, `update_task`, `complete_task`, `move_task`, `delete_task`.
- Checklists: `list_checklist_items`, `add_checklist_item`, `update_checklist_item`, `delete_checklist_item`.

Tasks support titles, plain-text notes, due dates, reminders, importance, status and categories. Date-time inputs accept a local ISO string in the host's timezone or an explicit `{ dateTime, timeZone }` object. List tools return `hasMore` and a continuation `cursor`; follow every page when collecting tasks for analytics.

The three create tools accept `operationId`. Reuse the ID on retries; use a new ID for a separate intended item. If a create returns `operation_uncertain`, inspect the list before creating again. See [retry behavior and its limits](docs/HARDENING.md#creates-and-retries).

## Modes

- `--readonly` hides write and delete tools.
- `--no-destructive` hides delete and move tools while allowing creation and updates.
- `--scope-readonly` requests `Tasks.Read` and uses a separate default credential cache. Sign in separately for that mode.

## Configuration

| Variable | Default / purpose |
| --- | --- |
| `MS_TODO_CLIENT_ID` | Microsoft's Graph CLI public-client identity; override for your own app |
| `MS_TODO_AUTHORITY` | `https://login.microsoftonline.com/common` |
| `MS_TODO_TOKEN_CACHE` | `~/.config/microsoft-todo-mcp/token-cache.enc`; read-only mode uses `token-cache-read.enc` |
| `MS_TODO_OPERATIONS_DIR` | `~/.config/microsoft-todo-mcp/operations` |
| `MS_TODO_MAX_RESULTS` | 200, a soft cap per list-tool call |
| `MS_TODO_GRAPH_BASE` | `https://graph.microsoft.com/v1.0`; trusted configuration for sovereign endpoints |
| `MS_TODO_READONLY` / `MS_TODO_NO_DESTRUCTIVE` / `MS_TODO_SCOPE_READONLY` | Environment equivalents of the flags |
| `LOG_LEVEL` | `info`; logs use stderr, never the MCP stdout stream |

Credentials are encrypted; the create journal contains task results in plaintext and must stay in a private directory. Old plaintext token caches are not automatically imported. See [storage notes](docs/HARDENING.md#encrypted-credentials).

CLI commands: `serve` (default), `login`, `logout`, `whoami`, `--version`, `--help`.

`move_task` uses copy/verify/delete because the current Graph To Do API has no native move action. It preserves supported fields, rich notes, checklist items and linked resources. Task/checklist/link IDs and creation timestamps change. Recurrence, attachments, returned custom extensions and Flagged Emails lists are rejected before writing. Graph can omit custom extensions, so unknown extension data is not preserved; use the native app for tasks carrying such data. Source edits or failed verification leave the source intact; partial copies remain available for inspection. See [move limits and recovery](docs/HARDENING.md#moves-and-deletion).

To expose task moves/deletes, run without `--no-destructive` and use client tool filtering to hide `delete_task_list` and `delete_checklist_item` if only task operations are wanted. Read-only mode still hides all writes. Existing `Tasks.ReadWrite` consent is sufficient.

## Development

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

CI covers Windows and Linux on Node 22 and 24. Windows tests use synthetic credentials to verify actual encryption and cache locks. No real account is accessed during tests.

This MCP provides task operations. Background synchronization, task history and the analytics dashboard will be separate enhancer components.

## License

MIT. Original implementation © Fabien Butz; the original license is preserved.
