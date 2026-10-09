# Security

Report security vulnerabilities through GitHub's private security advisory flow for this fork; do not include tokens or private task contents in public issues.

## Credentials and requests

- Delegated Microsoft Graph scopes are `Tasks.ReadWrite`, or `Tasks.Read` with `--scope-readonly`. The default public-client identity is Microsoft Graph Command Line Tools; there is no client secret.
- Refresh-token persistence uses MSAL Node Extensions and the OS credential store, with encryption required. Windows DPAPI is scoped to the current user. Separate MCP clients share a cross-process persistence lock.
- Every Graph request is limited to the configured HTTPS origin and supported To Do routes. Redirects are disabled. Cursors and next links cannot select another destination.
- Graph base and Microsoft authority overrides are trusted local configuration. Do not set them to untrusted endpoints.
- Logging uses stderr. Native persistence diagnostics are suppressed. Task bodies and bearer tokens are not intentionally logged.

## Local data and limits

The create-operation journal contains task results and notes in plaintext, but no tokens. Store it in a private user directory. Replay expiry does not delete files. Pending records and stale locks require inspection before recovery, so the server does not duplicate an uncertain create.

Encryption protects credentials at rest; a process running as the same OS user may still access them. Logout clears persistence, but already-running clients can retain an access token until expiry; stop them to complete a local sign-out.

The old plaintext cache is not migrated automatically. Sign in with the new encrypted cache, then remove any old cache yourself. See `docs/HARDENING.md`.

`--readonly` and `--no-destructive` control exposed tools; `--scope-readonly` controls requested Microsoft scopes and uses a separate default cache. Use separate paths when overriding read-only and read/write token caches.

Runtime and build dependencies are locked in `package-lock.json`. This private fork is not published under the upstream npm package name. Use a reviewed local build.
