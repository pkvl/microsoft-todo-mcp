import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercises the built CLI with synthetic, isolated cache paths. No Microsoft sign-in.
const directory = await mkdtemp(join(tmpdir(), "todo-mcp-smoke-"));
try {
  for (const mode of ["--no-destructive", "--readonly"]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("dist/index.js"), mode],
      env: {
        ...process.env,
        MS_TODO_CLIENT_ID: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
        MS_TODO_AUTHORITY: "https://login.microsoftonline.com/common",
        MS_TODO_TOKEN_CACHE: join(directory, "credentials.enc"),
        MS_TODO_OPERATIONS_DIR: join(directory, "operations"),
        MS_TODO_READONLY: "0",
        MS_TODO_NO_DESTRUCTIVE: "0",
        MS_TODO_SCOPE_READONLY: "0",
        LOG_LEVEL: "silent",
      },
    });
    const client = new Client({ name: "local-smoke", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, mode === "--readonly" ? 6 : 13);
      assert.ok(tools.every((tool) => !tool.name.startsWith("delete_")));
      if (mode === "--readonly") assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint));
      else assert.ok(tools.some((tool) => tool.name === "create_task"));
      const status = await client.callTool({ name: "auth_status", arguments: {} });
      assert.ok(!status.isError);
      const block = status.content.find((item) => item.type === "text");
      assert.equal(JSON.parse(block.text).state, "uninitialized");
      process.stdout.write(`${mode}: tools and signed-out status verified\n`);
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
