# Architecture

This fork keeps the upstream dependency direction:

- `tools/`: MCP input schemas, risk classes and handlers.
- `todo/`: task, list and checklist operations independent of MCP.
- `graph/`: authenticated HTTP, destination validation, errors and pagination.
- `auth/`: MSAL device-code sign-in, refresh and encrypted persistence.
- `lib/`: logging, IDs, clocks, key derivation and durable create operations.

## Authentication

`createPca` asynchronously creates OS-encrypted persistence via MSAL Node Extensions. DPAPI is scoped to the current Windows user. Linux plaintext fallback is disabled. MSAL's persistence plugin handles cross-process cache locking. `clearCache` deletes persisted credentials under the same lock. The default read-only cache is separate from the read/write cache.

The auth manager supports cached silent refresh and a device-code flow started by `sign_in` or a tool that needs a token. Tokens are never returned to MCP clients. Read `HARDENING.md` for cache migration and logout limitations.

## Graph boundary

`graphDestination` validates every URL before the HTTP layer acquires a token. Absolute cursor URLs and server-supplied next links are treated as untrusted. Requests must use HTTPS, the configured origin and supported v1.0 To Do routes. Encoded traversal and separators, credentials in URLs and fragments are rejected. Fetch uses `redirect: error`.

GET and idempotent update/delete requests have bounded retries. POSTs retry only throttling (429); transport failures, invalid successful responses and server errors are reported as `operation_uncertain` rather than blindly replayed.

## Create journal

The MCP create wrapper acquires an account first, derives an account-scoped key and payload fingerprint, then delegates to `CreateOperations`. The journal writes a pending record before sending a request. Short exclusive file locks serialize journal state changes across processes; the lock is released before network I/O. Records are atomically replaced after file sync.

Concurrent calls within a process join the same promise. Other processes fail closed on a pending record. Successful results replay for 24 hours with an explicit `operationId`, or 60 seconds with the argument-derived fallback key. Ambiguous or interrupted operations retain their pending record indefinitely. Known rejections remove the pending record so they can be retried.

The journal is local plaintext task data, not a token cache. It is not an analytics event store, and does not provide Microsoft's server-side exactly-once execution. Inspection and a new operation ID are required to recover from an uncertain result. See `HARDENING.md` for stale locks and retention.

## Verification

Tests cover forged cursors, malicious next links, normal continuation queries, throttled and ambiguous POSTs, duplicate/concurrent/restarted creates, corrupt records, and actual Windows DPAPI persistence and locks with synthetic credentials. CI builds on Windows and Linux on Node 22/24. Live Microsoft-account tests are separate.
