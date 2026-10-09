import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercises the built CLI with synthetic, isolated cache paths. No Microsoft sign-in.
const directory = await mkdtemp(join(tmpdir(), "todo-mcp-smoke-"));
try {
  const modes = [
    { name: "default", args: [], count: 14, move: true, deletion: false },
    { name: "allow-delete", args: ["--allow-delete"], count: 17, move: true, deletion: true },
    { name: "allow-delete-env", args: [], allowDeleteEnv: "true", count: 17, move: true, deletion: true },
    { name: "no-destructive", args: ["--no-destructive", "--allow-delete"], count: 13, move: false, deletion: false },
    { name: "readonly", args: ["--readonly", "--allow-delete"], count: 6, move: false, deletion: false },
  ];
  for (const mode of modes) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js"), ...mode.args],
      env: {
        ...process.env,
        MS_TODO_CLIENT_ID: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
        MS_TODO_AUTHORITY: "https://login.microsoftonline.com/common",
        MS_TODO_TOKEN_CACHE: join(directory, "credentials.enc"),
        MS_TODO_OPERATIONS_DIR: join(directory, "operations"),
        MS_TODO_READONLY: "0",
        MS_TODO_NO_DESTRUCTIVE: "0",
        MS_TODO_ALLOW_DELETE: mode.allowDeleteEnv ?? "0",
        MS_TODO_SCOPE_READONLY: "0",
        LOG_LEVEL: "silent",
      },
    });
    const client = new Client({ name: "local-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, mode.count);
      for (const name of ["delete_task", "delete_task_list", "delete_checklist_item"]) {
        assert.equal(tools.some((tool) => tool.name === name), mode.deletion);
        if (!mode.deletion) {
          // Exercise tools/call, not just discovery: unregistered tools cannot reach Graph.
          const result = await client.callTool({ name, arguments: { listId: "synthetic", taskId: "synthetic", checklistItemId: "synthetic" } });
          assert.equal(result.isError, true);
          assert.match(result.content.find((item) => item.type === "text").text, /not found/i);
        }
      }
      assert.equal(tools.some((tool) => tool.name === "move_task"), mode.move);
      if (mode.name === "readonly") assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint));
      else assert.ok(tools.some((tool) => tool.name === "create_task"));
      const status = await client.callTool({ name: "auth_status", arguments: {} });
      assert.ok(!status.isError);
      const block = status.content.find((item) => item.type === "text");
      assert.equal(JSON.parse(block.text).state, "uninitialized");
      process.stdout.write(`${mode.name}: tool availability, deletion guard, and signed-out status verified\n`);
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
