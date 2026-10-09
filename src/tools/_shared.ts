import { z } from "zod";
import { AppError, toAppError } from "../graph/errors";
import { IdempotencyCache } from "../lib/idempotency";
import type { CreateOperations, OperationCheckpoint } from "../lib/create-operations";
import type { IdGenerator } from "../lib/ids";
import type { Logger } from "../lib/logger";
import type { AuthManager } from "../auth/auth-state";
import type { TaskListsApi } from "../todo/lists";
import type { TasksApi } from "../todo/tasks";

export type RiskClass = "read" | "write" | "destructive";

/** Everything a tool handler needs. Constructed once in `server.ts`. */
export interface ToolContext {
  logger: Logger;
  ids: IdGenerator;
  auth: AuthManager;
  lists: TaskListsApi;
  tasks: TasksApi;
  operations: CreateOperations;
}

/** Erased tool definition used by the registry / server. */
export interface ToolDef {
  name: string;
  description: string;
  risk: RiskClass;
  /** Zod raw shape — passed straight to `server.registerTool()`. */
  inputShape: z.ZodRawShape;
  handler: (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;
}

/** Define a tool with the handler type-checked against its input schema, then erase. */
export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  description: string;
  risk: RiskClass;
  input: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}): ToolDef {
  return {
    name: def.name,
    description: def.description,
    risk: def.risk,
    inputShape: def.input,
    handler: def.handler as ToolDef["handler"],
  };
}

const TEXT = "text" as const;

export function okResult(data: unknown) {
  return { content: [{ type: TEXT, text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown) {
  const appError = err instanceof AppError ? err : toAppError(err);
  return { content: [{ type: TEXT, text: JSON.stringify({ error: appError.toJSON() }, null, 2) }], isError: true as const };
}

/**
 * Authenticate first so a create is scoped to the actual account, then reserve it on disk.
 */
export async function withIdempotency<T>(ctx: ToolContext, tool: string, args: unknown, run: (checkpoint: OperationCheckpoint) => Promise<T>, resourceIdentity?: unknown): Promise<unknown> {
  await ctx.auth.getAccessToken();
  const { operationId, ...payload } = args as Record<string, unknown>;
  const accountId = ctx.auth.accountId();
  const fingerprint = IdempotencyCache.key({ tool, args: payload, accountId });
  const key = resourceIdentity !== undefined
    ? IdempotencyCache.key({ tool, args: resourceIdentity, accountId })
    : operationId ? IdempotencyCache.key({ tool, args: { operationId }, accountId }) : fingerprint;
  const result = await ctx.operations.run(key, fingerprint, operationId || resourceIdentity !== undefined ? 86_400_000 : 60_000, run);
  return result.reused && result.value && typeof result.value === "object" && !Array.isArray(result.value)
    ? { ...(result.value as object), _idempotent: true }
    : result.value;
}

export const OperationId = z.string().min(1).max(128).optional().describe("Stable ID for one intended create. Reuse on retries; use a new ID for a separate item. Completed results can be replayed for 24 hours.");
