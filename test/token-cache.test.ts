import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenCacheContext } from "@azure/msal-node";
import { afterEach, describe, expect, it } from "vitest";
import { clearCache, encryptedCachePlugin } from "../src/auth/token-cache";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe.skipIf(process.platform !== "win32")("Windows encrypted cache", () => {
  async function cachePath() {
    const directory = await mkdtemp(join(tmpdir(), "todo-dpapi-test-"));
    directories.push(directory);
    return join(directory, "cache.enc");
  }

  it("encrypts a synthetic token at rest and reads it back", async () => {
    const path = await cachePath();
    const plugin = await encryptedCachePlugin(path);
    const fakeToken = "synthetic-refresh-token-for-test-only";
    await plugin.persistence.save(fakeToken);
    expect(await plugin.persistence.load()).toBe(fakeToken);
    expect((await readFile(path)).includes(Buffer.from(fakeToken))).toBe(false);
  });

  it("serializes writers from separate plugin instances", async () => {
    const path = await cachePath();
    const first = await encryptedCachePlugin(path);
    const second = await encryptedCachePlugin(path);
    let restored = "";
    const firstContext = new TokenCacheContext({ serialize: () => "first-cache", deserialize: () => {} }, true);
    const secondContext = new TokenCacheContext({ serialize: () => "second-cache", deserialize: (data) => { restored = data; } }, true);
    await first.beforeCacheAccess(firstContext);
    let entered = false;
    const waiting = second.beforeCacheAccess(secondContext).then(() => { entered = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(entered).toBe(false);
    await first.afterCacheAccess(firstContext);
    await waiting;
    expect(restored).toBe("first-cache");
    await second.afterCacheAccess(secondContext);
    expect(await second.persistence.load()).toBe("second-cache");
  });

  it("clears persisted credentials and releases the lock", async () => {
    const path = await cachePath();
    const plugin = await encryptedCachePlugin(path);
    await plugin.persistence.save("synthetic-cache");
    await clearCache(path);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const fresh = await encryptedCachePlugin(path);
    const context = new TokenCacheContext({ serialize: () => "new-cache", deserialize: () => {} }, true);
    await fresh.beforeCacheAccess(context);
    await fresh.afterCacheAccess(context);
    expect(await fresh.persistence.load()).toBe("new-cache");
  });
});
