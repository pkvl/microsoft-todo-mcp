# Windows setup

Use Node.js 22.12 or newer. In this fork's checkout:

```powershell
npm ci
npm run build
node dist/index.js login
node dist/index.js whoami
```

Complete the device-code login on Microsoft's page with your personal account. For the MCP client, launch `node` with the absolute path to this checkout's `dist/index.js` and `--no-destructive`. No global npm install or client secret is required.

Tokens use Windows DPAPI for the current user. Multiple clients share the encrypted cache and operation journal. Do not use the upstream npm package for this fork's fixes.

See [HARDENING.md](HARDENING.md) for the client configuration example, optional app identity, cache migration, and create-retry behavior.
