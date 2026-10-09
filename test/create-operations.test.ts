import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateOperations } from "../src/lib/create-operations";
import { AppError } from "../src/graph/errors";

const key = "a".repeat(64);
let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "todo-operations-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("durable create operations", () => {
  it("coalesces concurrent calls to a single create", async () => {
    const store = new CreateOperations(directory);
    const create = vi.fn(async () => ({ id: "task-1" }));
    const results = await Promise.all([store.run(key, "same", 60_000, create), store.run(key, "same", 60_000, create)]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(results[1]).toEqual({ value: { id: "task-1" }, reused: true });
  });

  it("replays the result in another instance after a restart", async () => {
    await new CreateOperations(directory).run(key, "same", 60_000, async () => ({ id: "task-1" }));
    const create = vi.fn();
    expect(await new CreateOperations(directory).run(key, "same", 60_000, create)).toEqual({ value: { id: "task-1" }, reused: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("blocks another client while the first create is running", async () => {
    let release!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => { started = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const first = new CreateOperations(directory).run(key, "same", 60_000, async () => { started(); await finish; return { id: "task-1" }; });
    await Promise.race([start, first.then(() => { throw new Error("Create finished before starting"); })]);
    const create = vi.fn();
    await expect(new CreateOperations(directory).run(key, "same", 60_000, create)).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(create).not.toHaveBeenCalled();
    release();
    await first;
  });

  it("keeps an ambiguous outcome across restarts rather than duplicating a task", async () => {
    await expect(new CreateOperations(directory).run(key, "same", 60_000, async () => { throw new AppError("operation_uncertain", "timeout"); })).rejects.toMatchObject({ code: "operation_uncertain" });
    const create = vi.fn();
    await expect(new CreateOperations(directory).run(key, "same", 60_000, create)).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(create).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, `${key}.json`), "utf8")).outcome).toBe("pending");
  });

  it("allows retry after a definite rejection", async () => {
    const store = new CreateOperations(directory);
    await expect(store.run(key, "same", 60_000, async () => { throw new AppError("permission_denied", "denied"); })).rejects.toMatchObject({ code: "permission_denied" });
    expect(await store.run(key, "same", 60_000, async () => ({ id: "task-1" }))).toMatchObject({ reused: false });
  });

  it("rejects reuse of an operationId for a different payload", async () => {
    const store = new CreateOperations(directory);
    await store.run(key, "first", 60_000, async () => ({ id: "task-1" }));
    await expect(store.run(key, "second", 60_000, vi.fn())).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires successful deduplication", async () => {
    let now = 0;
    const store = new CreateOperations(directory, () => now);
    const create = vi.fn(async () => ({ id: "task-1" }));
    await store.run(key, "same", 1000, create);
    now = 1001;
    await store.run(key, "same", 1000, create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("does not expire an uncertain outcome when the replay window has passed", async () => {
    let now = 0;
    const store = new CreateOperations(directory, () => now);
    await expect(store.run(key, "same", 1000, async () => { throw new AppError("operation_uncertain", "timeout"); })).rejects.toMatchObject({ code: "operation_uncertain" });
    now = 86_400_000;
    const create = vi.fn();
    await expect(store.run(key, "same", 1000, create)).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when a journal record is corrupt", async () => {
    await writeFile(join(directory, `${key}.json`), "broken");
    const create = vi.fn();
    await expect(new CreateOperations(directory).run(key, "same", 60_000, create)).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(create).not.toHaveBeenCalled();
  });
});
