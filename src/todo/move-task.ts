import type { GraphClient } from "../graph/client";
import { AppError } from "../graph/errors";
import { collectPages, type Page } from "../graph/pagination";
import type { OperationCheckpoint } from "../lib/create-operations";
import { IdempotencyCache } from "../lib/idempotency";
import { ChecklistItemSchema, TaskListSchema, TaskSchema, type Task } from "./types";

export interface MoveTaskInput {
  sourceListId: string;
  taskId: string;
  destinationListId: string;
}

const TASK_FIELDS = ["title", "body", "status", "importance", "categories", "isReminderOn", "dueDateTime", "reminderDateTime", "completedDateTime", "startDateTime"];
const LINK_FIELDS = ["applicationName", "displayName", "externalId", "webUrl"];
type RecordValue = Record<string, unknown>;

function pick(value: RecordValue, fields: string[]): RecordValue {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

function taskFields(task: Task): RecordValue {
  const fields = pick(task, TASK_FIELDS);
  if (task.body) fields.body = pick(task.body, ["content", "contentType"]);
  if (task.categories) fields.categories = [...task.categories].sort();
  return fields;
}

function hash(value: unknown): string {
  return IdempotencyCache.key({ tool: "move-snapshot", args: value, accountId: "" });
}

function ordered(values: RecordValue[]): RecordValue[] {
  return [...values].sort((a, b) => hash(a).localeCompare(hash(b)));
}

/** Conservative copy/verify/delete: Graph To Do has no native move action. */
export async function moveTask(graph: GraphClient, input: MoveTaskInput, checkpoint: OperationCheckpoint, traceId?: string) {
  const { sourceListId, taskId, destinationListId } = input;
  if (sourceListId === destinationListId) throw new AppError("validation_error", "Source and destination lists must differ.");
  const listPath = (id: string) => `/me/todo/lists/${encodeURIComponent(id)}`;
  const sourcePath = `${listPath(sourceListId)}/tasks/${encodeURIComponent(taskId)}`;
  for (const id of [sourceListId, destinationListId]) {
    const list = TaskListSchema.parse(await graph.request("GET", listPath(id), { traceId }));
    if (list.wellknownListName === "flaggedEmails") throw new AppError("validation_error", "Moves involving Flagged Emails are unsupported; their mail relationship must be preserved.");
  }

  async function collection(path: string): Promise<RecordValue[]> {
    const result = await collectPages<RecordValue>(
      () => graph.request<Page<RecordValue>>("GET", path, { traceId }),
      (url) => graph.request<Page<RecordValue>>("GET", url, { traceId }),
      Number.POSITIVE_INFINITY,
    );
    return result.items;
  }

  async function snapshot(path: string) {
    const task = TaskSchema.parse(await graph.request("GET", path, { traceId, query: { "$expand": "extensions" } }));
    if (task.recurrence || task.hasAttachments) throw new AppError("validation_error", "Move cannot preserve recurring rules or attachments. The original task has not been deleted.");
    const attachments = await collection(`${path}/attachments`);
    // To Do returns 404 for GET /extensions and can omit the requested expansion.
    // Extensions that Graph does not expose cannot be discovered or preserved.
    const extensions = task.extensions ?? [];
    if (!Array.isArray(extensions)) throw new AppError("graph_error", "Microsoft Graph returned an invalid extensions value. Move stopped before deleting the original.");
    if (attachments.length || extensions.length) throw new AppError("validation_error", "Move cannot preserve attachments or custom extensions. The original task has not been deleted.");
    const checklist = (await collection(`${path}/checklistItems`)).map((item) => {
      const parsed = ChecklistItemSchema.parse(item);
      return { displayName: parsed.displayName, isChecked: parsed.isChecked ?? false };
    });
    const links = (await collection(`${path}/linkedResources`)).map((item) => pick(item, LINK_FIELDS));
    return { task, fields: taskFields(task), checklist: ordered(checklist), links: ordered(links) };
  }

  const source = await snapshot(sourcePath);
  const state: { destinationTaskId?: string } = {};
  const progress = (phase: string) => checkpoint({ kind: "move_task", ...input, ...state, phase });
  await progress("creating_destination");
  const response = await graph.request<RecordValue>("POST", `${listPath(destinationListId)}/tasks`, { body: source.fields, traceId });
  if (typeof response?.id === "string") state.destinationTaskId = response.id;
  await progress("copying_related_items");
  const copied = TaskSchema.parse(response);
  const destinationPath = `${listPath(destinationListId)}/tasks/${encodeURIComponent(copied.id)}`;
  for (const item of source.checklist) await graph.request("POST", `${destinationPath}/checklistItems`, { body: item, traceId });
  for (const item of source.links) await graph.request("POST", `${destinationPath}/linkedResources`, { body: item, traceId });

  await progress("verifying_destination");
  const destination = await snapshot(destinationPath);
  const destinationFields = pick(destination.fields, Object.keys(source.fields));
  if (hash([source.fields, source.checklist, source.links]) !== hash([destinationFields, destination.checklist, destination.links])) {
    throw new AppError("conflict", "Destination verification failed. Both tasks are retained.");
  }
  const current = await snapshot(sourcePath);
  if (hash(source) !== hash(current)) throw new AppError("conflict", "Source changed while copying. Both tasks are retained.");

  await progress("deleting_source");
  try {
    await graph.request("DELETE", sourcePath, { traceId, ifMatch: typeof source.task["@odata.etag"] === "string" ? source.task["@odata.etag"] : undefined });
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== "not_found") throw err;
  }
  return { moved: true, sourceListId, sourceTaskId: taskId, destinationListId, destinationTaskId: copied.id, task: destination.task, method: "copy_verify_delete" };
}
