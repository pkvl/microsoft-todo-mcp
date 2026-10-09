import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } from "@azure/msal-node-extensions";
import { TokenCacheContext } from "@azure/msal-node";
import { AppError } from "../graph/errors";

async function persistence(path: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  return PersistenceCreator.createPersistence({
    cachePath: resolve(path),
    dataProtectionScope: DataProtectionScope.CurrentUser,
    serviceName: "microsoft-todo-mcp",
    accountName: createHash("sha256").update(resolve(path)).digest("hex"),
    usePlaintextFileOnLinux: false,
    loggerOptions: { loggerCallback: () => {}, piiLoggingEnabled: false },
  });
}

/** OS-encrypted persistence with MSAL's cross-process cache lock; never fall back to plaintext. */
export async function encryptedCachePlugin(path: string): Promise<PersistenceCachePlugin> {
  try {
    return new PersistenceCachePlugin(await persistence(path));
  } catch {
    throw new AppError("config_error", "Encrypted token storage is unavailable. Enable the OS credential store; plaintext storage is disabled.");
  }
}

export async function clearCache(path: string): Promise<void> {
  // Use the same lock as MSAL instead of unlinking a cache while another client writes it.
  const plugin = await encryptedCachePlugin(path);
  const cache = { deserialize: () => {}, serialize: () => "" };
  await plugin.beforeCacheAccess(new TokenCacheContext(cache, true));
  try {
    await plugin.persistence.delete();
  } finally {
    await plugin.afterCacheAccess(new TokenCacheContext(cache, false));
  }
}
