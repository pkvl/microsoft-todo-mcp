# Personal-account fork

This fork is maintained at https://github.com/pkvl/microsoft-todo-mcp. The upstream npm package does not include these changes. Use a local build or a reviewed commit from this fork.

## Local setup

```powershell
npm ci
npm run build
node dist/index.js login
node dist/index.js serve --no-destructive
```

Login requires your interaction with Microsoft's device-code page. No client secret is required. `MS_TODO_CLIENT_ID` is an optional override for a public-client registration supporting personal Microsoft accounts.

Configure your MCP client to run `node` with the absolute path to this checkout's `dist/index.js` and `--no-destructive`. A JSON client configuration example:

```json
{
  "mcpServers": {
    "microsoft-todo": {
      "command": "node",
      "args": [
        "C:/Development/to-do-enhancer/microsoft-todo-mcp/dist/index.js",
        "--no-destructive"
      ]
    }
  }
}
```

Adjust the path for another machine. All clients under the same OS user share the default cache and create-operation journal.

## Request destinations

Every request is checked before a token is acquired. Only HTTPS requests to the configured Graph origin and supported `/v1.0/me/todo/lists` routes are permitted. User-info URLs, unrelated Graph APIs, encoded traversal/separators and URL fragments are rejected. Redirects are disabled. Continuation query strings are preserved.

`MS_TODO_GRAPH_BASE` is trusted administrator configuration, not a tool argument. It must be an HTTPS origin with `/v1.0`, e.g. `https://graph.microsoft.com/v1.0` or a sovereign Graph endpoint. Never point it at an untrusted service.

## Encrypted credentials

MSAL Node Extensions provides DPAPI encryption for the current Windows user, Keychain on macOS, and Secret Service on Linux. Plaintext fallback is disabled. The persistence plugin coordinates cache access across processes. Debug output from the persistence library is suppressed.

The default path is `~/.config/microsoft-todo-mcp/token-cache.enc`. A separate `token-cache-read.enc` is used with `--scope-readonly`. If you override `MS_TODO_TOKEN_CACHE`, use separate paths for read-only and read/write clients.

The old plaintext `token-cache.json` is not imported or overwritten. Sign in again with the new cache, then remove the old file yourself if it exists. Custom paths pointing at a legacy plaintext file must also be changed. `logout` clears persisted credentials under the cache lock. Already-running clients can retain an access token until it expires; stop them to finish signing out locally.

OS encryption protects data at rest; other processes running as the same Windows user can still access it. Native credential stores must be available on Linux/macOS. Encryption failures stop authentication rather than writing plaintext.

On Debian/Ubuntu, install the runtime library with `sudo apt-get install libsecret-1-0` before starting the MCP. An unlocked Secret Service session is also required for sign-in. CI installs the library for module loading; Linux tests do not exercise a desktop credential store.

## Creates and retries

`create_task`, `create_task_list`, and `add_checklist_item` accept optional `operationId`. Reuse a stable ID on retries; use a new ID for a separate intended item. Reusing it for different arguments returns `conflict`. Successful calls with an explicit ID replay for 24 hours. Without an ID, identical arguments are deduplicated for 60 seconds.

A pending record is written before a create is sent. Concurrent calls in one process join the same operation. Another process either replays a completed result or receives `operation_uncertain` while it is pending. The journal survives restarts. POSTs are not automatically retried after transport failures or HTTP 5xx; HTTP 429 can retry.

Uncertain outcomes never expire automatically. Inspect the list first. If the item exists, use it; if you establish it was not created, issue a new `operationId`. This is conservative duplicate prevention, not an exactly-once guarantee from Microsoft Graph.

The journal is at `~/.config/microsoft-todo-mcp/operations` (override: `MS_TODO_OPERATIONS_DIR`). It stores task results in plaintext, including notes, but no tokens. Keep it in a private directory; do not sync or commit it. Expiry governs replay, not file deletion; records remain on disk. A process crash during a short file lock can leave a `.lock`. Stop clients and inspect the list before removing a stale lock. Corrupt records fail closed.

## Verification

Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`. On Windows, `npm run smoke` also connects to the built CLI over stdio and checks tool modes and signed-out status in an isolated cache. Windows tests exercise actual DPAPI encryption, locking and clearing with synthetic credentials. Other tests use fake Graph responses and temporary directories. No real account is accessed.

Live personal-account sign-in and task creation require a separate smoke test in a temporary To Do list.
