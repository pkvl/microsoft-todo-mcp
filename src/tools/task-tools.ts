import { z } from "zod";
import { DateTimeInput, Importance, TaskStatus } from "../lib/schema";
import { defineTool, OperationId, withIdempotency } from "./_shared";
import { AppError } from "../graph/errors";

export const taskTools = [
  defineTool({
    name: "list_tasks",
    description: "List tasks in a To Do list. Optionally filter by status and expand checklist items / linked resources inline.",
    risk: "read",
    input: {
      listId: z.string(),
      status: z.enum(["all", "notStarted", "inProgress", "completed"]).optional().describe("Filter by status; default 'all'"),
      includeChecklist: z.boolean().optional(),
      includeLinkedResources: z.boolean().optional(),
      cursor: z.string().optional(),
      maxResults: z.number().int().min(1).max(1000).optional(),
    },
    handler: (args, ctx) =>
      ctx.tasks.list(args.listId, {
        status: args.status,
        includeChecklist: args.includeChecklist,
        includeLinkedResources: args.includeLinkedResources,
        cursor: args.cursor,
        maxResults: args.maxResults,
        traceId: ctx.ids.uuid(),
      }),
  }),

  defineTool({
    name: "get_task",
    description: "Get a single To Do task by id.",
    risk: "read",
    input: {
      listId: z.string(),
      taskId: z.string(),
      includeChecklist: z.boolean().optional(),
      includeLinkedResources: z.boolean().optional(),
    },
    handler: (args, ctx) =>
      ctx.tasks.get(args.listId, args.taskId, {
        includeChecklist: args.includeChecklist,
        includeLinkedResources: args.includeLinkedResources,
        traceId: ctx.ids.uuid(),
      }),
  }),

  defineTool({
    name: "create_task",
    description: "Create a new task in a To Do list.",
    risk: "write",
    input: {
      listId: z.string(),
      title: z.string().min(1),
      operationId: OperationId,
      body: z.string().optional().describe("Plain-text note/body"),
      dueDateTime: DateTimeInput.optional().describe("Due date-time: ISO-8601 string (host timezone) or { dateTime, timeZone }"),
      reminderDateTime: DateTimeInput.optional(),
      importance: Importance.optional(),
      status: TaskStatus.optional(),
      categories: z.array(z.string()).optional(),
    },
    handler: (args, ctx) =>
      withIdempotency(ctx, "create_task", args, () =>
        ctx.tasks.create(
          {
            listId: args.listId,
            title: args.title,
            body: args.body,
            dueDateTime: args.dueDateTime,
            reminderDateTime: args.reminderDateTime,
            importance: args.importance,
            status: args.status,
            categories: args.categories,
          },
          ctx.ids.uuid(),
        ),
      ),
  }),

  defineTool({
    name: "update_task",
    description:
      "Update fields of an existing task. Pass null for dueDateTime/reminderDateTime to clear them. Set status to 'completed' to complete the task.",
    risk: "write",
    input: {
      listId: z.string(),
      taskId: z.string(),
      title: z.string().min(1).optional(),
      body: z.string().optional(),
      dueDateTime: DateTimeInput.nullable().optional(),
      reminderDateTime: DateTimeInput.nullable().optional(),
      importance: Importance.optional(),
      status: TaskStatus.optional(),
      categories: z.array(z.string()).optional(),
    },
    handler: (args, ctx) =>
      ctx.tasks.update(
        args.listId,
        args.taskId,
        {
          title: args.title,
          body: args.body,
          dueDateTime: args.dueDateTime,
          reminderDateTime: args.reminderDateTime,
          importance: args.importance,
          status: args.status,
          categories: args.categories,
        },
        ctx.ids.uuid(),
      ),
  }),

  defineTool({
    name: "complete_task",
    description: "Mark a task as completed (convenience for update_task with status='completed').",
    risk: "write",
    input: { listId: z.string(), taskId: z.string() },
    handler: (args, ctx) => ctx.tasks.complete(args.listId, args.taskId, ctx.ids.uuid()),
  }),

  defineTool({
    name: "move_task",
    description: "Move a task to another list by copying and verifying it, then deleting the source. IDs and creation timestamps change. Preserves supported fields, checklist and linked resources; rejects recurring tasks, attachments, extensions and Flagged Emails lists. A partial failure retains known destination IDs in the journal; inspect both lists before retrying. Deleting the source cannot be undone.",
    risk: "destructive",
    input: {
      sourceListId: z.string().min(1),
      taskId: z.string().min(1),
      destinationListId: z.string().min(1),
    },
    handler: (args, ctx) => withIdempotency(ctx, "move_task", args,
      (checkpoint) => ctx.tasks.move(args, checkpoint, ctx.ids.uuid()),
      { sourceListId: args.sourceListId, taskId: args.taskId }),
  }),

  defineTool({
    name: "delete_task",
    description: "Permanently delete a task. This cannot be undone.",
    risk: "destructive",
    input: { listId: z.string(), taskId: z.string() },
    handler: async (args, ctx) => {
      try {
        await ctx.tasks.remove(args.listId, args.taskId, ctx.ids.uuid());
      } catch (err) {
        if (!(err instanceof AppError) || err.code !== "not_found") throw err;
        return { deleted: true, taskId: args.taskId, alreadyAbsent: true };
      }
      return { deleted: true, taskId: args.taskId };
    },
  }),
];
