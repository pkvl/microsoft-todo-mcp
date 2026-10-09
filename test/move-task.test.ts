import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GraphClient } from "../src/graph/client";
import { AppError } from "../src/graph/errors";
import { CreateOperations } from "../src/lib/create-operations";
import { withIdempotency, type ToolContext } from "../src/tools/_shared";
import { taskTools } from "../src/tools/task-tools";
import { moveTask } from "../src/todo/move-task";

const input = { sourceListId: "source", taskId: "old", destinationListId: "destination" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function fixture(options: { recurrence?: boolean; attachments?: boolean; extensions?: boolean; flagged?: boolean; mismatch?: boolean; edited?: boolean; failure?: string; failureCode?: "permission_denied"; deleteAbsent?: boolean; paged?: boolean } = {}) {
  const source = {
    id: "old", title: "Rich task", body: { content: "<p>Keep <b>HTML</b></p>", contentType: "html" },
    status: "completed", categories: ["Work", "Personal"], importance: "high", isReminderOn: false,
    dueDateTime: null, reminderDateTime: null,
    completedDateTime: { dateTime: "2026-10-01T12:00:00", timeZone: "UTC" },
    startDateTime: { dateTime: "2026-09-30T12:00:00", timeZone: "UTC" },
    createdDateTime: "original-created", lastModifiedDateTime: "original-updated", "@odata.etag": 'W/"source-version"',
    recurrence: options.recurrence ? { pattern: { type: "daily" } } : null,
    hasAttachments: options.attachments ?? false,
  };
  let copied: Record<string, unknown>;
  let sourceReads = 0;
  const copiedChecklist: unknown[] = [];
  const copiedLinks: unknown[] = [];
  const request = vi.fn(async (method: string, path: string, opts?: { body?: Record<string, unknown> }) => {
    if (options.failure === `${method} ${path}`) throw new AppError(options.failureCode ?? "operation_uncertain", "test failure");
    if (method === "POST" && path.endsWith("/tasks")) { copied = { ...opts!.body, id: "new", createdDateTime: "new-created" }; return copied; }
    if (method === "POST" && path.endsWith("/checklistItems")) { copiedChecklist.push(opts!.body); return { ...opts!.body, id: "new-check" }; }
    if (method === "POST" && path.endsWith("/linkedResources")) { copiedLinks.push(opts!.body); return { ...opts!.body, id: "new-link" }; }
    if (method === "DELETE") { if (options.deleteAbsent) throw new AppError("not_found", "already deleted"); return undefined; }
    if (path === "/me/todo/lists/source") return { id: "source", displayName: "Source", wellknownListName: options.flagged ? "flaggedEmails" : "none" };
    if (path === "/me/todo/lists/destination") return { id: "destination", displayName: "Destination" };
    if (path.endsWith("/tasks/old")) { sourceReads++; return options.edited && sourceReads > 1 ? { ...source, title: "Changed concurrently" } : source; }
    if (path.endsWith("/tasks/new")) return options.mismatch ? { ...copied, title: "Wrong title" } : copied;
    if (path.endsWith("/attachments")) return { value: [] };
    if (path.endsWith("/extensions")) return { value: options.extensions ? [{ id: "custom-extension" }] : [] };
    if (path.endsWith("/old/checklistItems")) return { value: [{ id: "check", displayName: "Step", isChecked: true }], ...(options.paged ? { "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/todo/lists/source/tasks/old/checklistItems?$skiptoken=second" } : {}) };
    if (path.includes("$skiptoken=second")) return { value: [{ id: "check2", displayName: "Step two", isChecked: false }] };
    if (path.endsWith("/new/checklistItems")) return { value: copiedChecklist.map((item) => ({ ...(item as object), id: "new-check" })) };
    if (path.endsWith("/old/linkedResources")) return { value: [{ id: "link", applicationName: "App", displayName: "Source link", externalId: "external", webUrl: "https://example.com/task" }] };
    if (path.endsWith("/new/linkedResources")) return { value: copiedLinks };
    throw new Error(`Unhandled test request: ${method} ${path}`);
  });
  return { graph: { request } as unknown as GraphClient, request };
}

describe("copy/verify/delete task moves", () => {
  it("preserves rich body, completed date, null dates, categories and all related pages before deleting", async () => {
    const { graph, request } = fixture({ paged: true });
    const checkpoint = vi.fn(async () => {});
    const result = await moveTask(graph, input, checkpoint);
    expect(result).toMatchObject({ moved: true, destinationTaskId: "new", sourceTaskId: "old" });
    const create = request.mock.calls.find(([method, path]) => method === "POST" && path.endsWith("/tasks"));
    expect(create![2]!.body).toMatchObject({ body: { contentType: "html", content: "<p>Keep <b>HTML</b></p>" }, completedDateTime: { dateTime: "2026-10-01T12:00:00" }, dueDateTime: null });
    expect(create![2]!.body).not.toHaveProperty("id");
    expect(create![2]!.body).not.toHaveProperty("createdDateTime");
    expect(request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/checklistItems"))).toHaveLength(2);
    expect(request.mock.calls.at(-1)).toEqual(["DELETE", "/me/todo/lists/source/tasks/old", { traceId: undefined, ifMatch: 'W/"source-version"' }]);
    expect(checkpoint.mock.calls.length).toBe(4);
  });

  it.each(["recurrence", "attachments", "extensions", "flagged"] as const)("rejects %s before any writes", async (feature) => {
    const { graph, request } = fixture({ [feature]: true });
    await expect(moveTask(graph, input, async () => {})).rejects.toMatchObject({ code: "validation_error" });
    expect(request.mock.calls.every(([method]) => method === "GET")).toBe(true);
  });

  it("rejects a same-list move without contacting Graph", async () => {
    const { graph, request } = fixture();
    await expect(moveTask(graph, { ...input, destinationListId: input.sourceListId }, async () => {})).rejects.toMatchObject({ code: "validation_error" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["mismatch", "edited"] as const)("retains the original when %s is detected", async (feature) => {
    const { graph, request } = fixture({ [feature]: true });
    await expect(moveTask(graph, input, async () => {})).rejects.toMatchObject({ code: "conflict" });
    expect(request.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
  });

  it("treats an already-absent source at the final deletion as success", async () => {
    const { graph } = fixture({ deleteAbsent: true });
    expect(await moveTask(graph, input, async () => {})).toMatchObject({ moved: true });
  });

  it.each(["POST /me/todo/lists/destination/tasks/new/checklistItems", "DELETE /me/todo/lists/source/tasks/old"])("retains known progress after %s and blocks retries across a restart", async (failure) => {
    const directory = await mkdtemp(join(tmpdir(), "todo-move-test-"));
    directories.push(directory);
    const { graph, request } = fixture({ failure });
    const ctx = { auth: { getAccessToken: async () => "synthetic", accountId: () => "account" }, operations: new CreateOperations(directory) } as unknown as ToolContext;
    const run = () => withIdempotency(ctx, "move_task", input, (checkpoint) => moveTask(graph, input, checkpoint), { sourceListId: input.sourceListId, taskId: input.taskId });
    await expect(run()).rejects.toMatchObject({ code: "operation_uncertain", details: { destinationTaskId: "new" } });
    const count = request.mock.calls.length;
    ctx.operations = new CreateOperations(directory);
    await expect(run()).rejects.toMatchObject({ code: "operation_uncertain", details: { destinationTaskId: "new" } });
    expect(request.mock.calls.length).toBe(count);
  });

  it("keeps deletion idempotent when a task is already absent", async () => {
    const remove = vi.fn(async () => { throw new AppError("not_found", "absent"); });
    const ctx = { tasks: { remove }, ids: { uuid: () => "trace" } } as unknown as ToolContext;
    const tool = taskTools.find((item) => item.name === "delete_task")!;
    expect(await tool.handler({ listId: "list", taskId: "task" }, ctx)).toMatchObject({ deleted: true, alreadyAbsent: true });
  });

  it("replays a completed move after restart without another Graph request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-move-test-"));
    directories.push(directory);
    const { graph, request } = fixture();
    const ctx = { auth: { getAccessToken: async () => "synthetic", accountId: () => "account" }, operations: new CreateOperations(directory) } as unknown as ToolContext;
    const identity = { sourceListId: input.sourceListId, taskId: input.taskId };
    const run = (args = input) => withIdempotency(ctx, "move_task", args, (checkpoint) => moveTask(graph, args, checkpoint), identity);
    await run();
    const count = request.mock.calls.length;
    ctx.operations = new CreateOperations(directory);
    expect(await run()).toMatchObject({ moved: true, _idempotent: true });
    await expect(run({ ...input, destinationListId: "other" })).rejects.toMatchObject({ code: "conflict" });
    expect(request.mock.calls.length).toBe(count);
  });

  it.each([
    { failure: "POST /me/todo/lists/destination/tasks", phase: "creating_destination" },
    { failure: "POST /me/todo/lists/destination/tasks/new/linkedResources", phase: "copying_related_items", failureCode: "permission_denied" as const },
  ])("retains a reservation after $failure", async ({ failure, phase, ...options }) => {
    const directory = await mkdtemp(join(tmpdir(), "todo-move-test-"));
    directories.push(directory);
    const { graph, request } = fixture({ failure, ...options });
    const operations = new CreateOperations(directory);
    await expect(operations.run("a".repeat(64), "payload", 1000, (checkpoint) => moveTask(graph, input, checkpoint))).rejects.toMatchObject({ code: "operation_uncertain", details: { phase } });
    expect(request.mock.calls.some(([method]) => method === "DELETE")).toBe(false);
    await expect(new CreateOperations(directory).run("a".repeat(64), "payload", 1000, vi.fn())).rejects.toMatchObject({ code: "operation_uncertain", details: { phase } });
  });
});
