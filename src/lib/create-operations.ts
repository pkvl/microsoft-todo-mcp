import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError } from "../graph/errors";

const Entry = z.object({
  version: z.literal(1),
  fingerprint: z.string(),
  outcome: z.enum(["pending", "completed"]),
  expiresAt: z.number(),
  result: z.unknown().optional(),
  progress: z.unknown().optional(),
});

export type OperationCheckpoint = (progress: unknown) => Promise<void>;

/** A pending record is written BEFORE sending a create, and survives a process crash. */
export class CreateOperations {
  private readonly active = new Map<string, { fingerprint: string; promise: Promise<{ value: unknown; reused: boolean }> }>();

  constructor(private readonly directory: string, private readonly now: () => number = Date.now) {}

  run(key: string, fingerprint: string, ttlMs: number, create: (checkpoint: OperationCheckpoint) => Promise<unknown>): Promise<{ value: unknown; reused: boolean }> {
    if (!/^[a-f0-9]{64}$/.test(key)) return Promise.reject(new AppError("validation_error", "Invalid operation key."));
    const active = this.active.get(key);
    if (active) {
      if (active.fingerprint !== fingerprint) return Promise.reject(new AppError("conflict", "operationId was already used with different arguments."));
      return active.promise.then((result) => ({ ...result, reused: true }));
    }
    const promise = this.execute(key, fingerprint, ttlMs, create).finally(() => this.active.delete(key));
    this.active.set(key, { fingerprint, promise });
    return promise;
  }

  private async execute(key: string, fingerprint: string, ttlMs: number, create: (checkpoint: OperationCheckpoint) => Promise<unknown>) {
    const path = join(this.directory, `${key}.json`);
    const previous = await this.locked(key, async () => {
      let entry: z.infer<typeof Entry> | undefined;
      try {
        entry = Entry.parse(JSON.parse(await readFile(path, "utf8")));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw new AppError("operation_uncertain", "The create journal is unreadable. Inspect the list before issuing a new operationId.");
        }
      }
      if (entry && (entry.outcome === "pending" || entry.expiresAt > this.now())) {
        if (entry.fingerprint !== fingerprint) throw new AppError("conflict", "operationId was already used with different arguments.");
        if (entry.outcome === "pending") throw new AppError("operation_uncertain", "This operation is running or its outcome is unknown. Inspect the source and destination before retrying.", { details: entry.progress });
        return { value: entry.result, reused: true };
      }
      await this.write(path, { version: 1, fingerprint, outcome: "pending", expiresAt: 0 });
      return undefined;
    });
    if (previous) return previous;
    let progress: unknown;
    const checkpoint: OperationCheckpoint = async (next) => {
      progress = next;
      await this.locked(key, () => this.write(path, { version: 1, fingerprint, outcome: "pending", expiresAt: 0, progress }));
    };
    let value: unknown;
    try {
      value = await create(checkpoint);
    } catch (err) {
      // Auth, permission, validation and other definite rejections may be retried.
      // Unknown failures and ambiguous POST outcomes retain the pending marker.
      if (progress === undefined && err instanceof AppError && err.code !== "operation_uncertain") {
        await this.locked(key, () => unlink(path));
        throw err;
      }
      if (progress !== undefined) {
        throw new AppError("operation_uncertain", "The move stopped after a write may have occurred. Inspect both lists before retrying; the journal retains the known destination and phase.", { details: progress });
      }
      if (err instanceof AppError) throw err;
      throw new AppError("operation_uncertain", "The create may have succeeded. Inspect the list before issuing a new operationId.");
    }
    try {
      await this.locked(key, () => this.write(path, { version: 1, fingerprint, outcome: "completed", expiresAt: this.now() + ttlMs, result: value }));
    } catch {
      throw new AppError("operation_uncertain", "The operation succeeded, but its result could not be recorded. Inspect the lists before retrying.", { details: progress });
    }
    return { value, reused: false };
  }

  private async locked<T>(key: string, action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.directory, `${key}.lock`);
    let lock;
    for (let attempt = 0; ; attempt++) {
      try {
        lock = await open(lockPath, "wx", 0o600);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        if (attempt >= 40) throw new AppError("operation_uncertain", "The create journal is locked. Retry later; inspect the list before removing a stale lock.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    try {
      return await action();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  private async write(path: string, entry: z.infer<typeof Entry>): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(entry));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; });
    }
  }
}
