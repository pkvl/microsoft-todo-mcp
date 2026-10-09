import { describe, expect, it, vi } from "vitest";
import { withIdempotency, type ToolContext } from "../src/tools/_shared";

describe("create tool identity", () => {
  function context(account: string) {
    let currentAccount = "anonymous";
    const operations = { run: vi.fn(async (_key, _fingerprint, _ttl, run) => ({ value: await run(), reused: false })) };
    const auth = {
      getAccessToken: async () => { currentAccount = account; return "synthetic-token"; },
      accountId: () => currentAccount,
    };
    return { ctx: { auth, operations } as unknown as ToolContext, operations };
  }

  it("scopes operations to the authenticated account, not anonymous", async () => {
    const first = context("account-one");
    const second = context("account-two");
    for (const { ctx } of [first, second]) {
      await withIdempotency(ctx, "create_task", { operationId: "request-one", title: "x" }, async () => ({ id: "task" }));
    }
    expect(first.operations.run.mock.calls[0]![0]).not.toBe(second.operations.run.mock.calls[0]![0]);
  });

  it("separates request identity from the payload fingerprint", async () => {
    const { ctx, operations } = context("account");
    await withIdempotency(ctx, "create_task", { operationId: "same-request", title: "first" }, async () => ({}));
    await withIdempotency(ctx, "create_task", { operationId: "same-request", title: "second" }, async () => ({}));
    const [first, second] = operations.run.mock.calls;
    expect(first![0]).toBe(second![0]);
    expect(first![1]).not.toBe(second![1]);
    expect(first![2]).toBe(86_400_000);
  });
});
