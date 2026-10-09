import { describe, expect, it, vi } from "vitest";
import { TasksApi } from "../src/todo/tasks";
import { encodeCursor } from "../src/graph/pagination";
import { GraphClient } from "../src/graph/client";
import { createLogger } from "../src/lib/logger";
import type { AppConfig } from "../src/config";

const config = { graphBase: "https://graph.microsoft.com/v1.0" } as AppConfig;
const silent = createLogger("silent");
const tokens = { getAccessToken: async () => "tok", accountId: () => "acct" };
const ids = { uuid: () => "00000000-0000-0000-0000-000000000000" };
const noSleep = async () => {};

/** A fetch that never resolves on its own — it only settles when the AbortSignal fires. */
function hangingFetch(onCall?: () => void): typeof fetch {
  return ((_url: string, opts?: { signal?: AbortSignal }) => {
    onCall?.();
    return new Promise<Response>((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new DOMException("The operation timed out.", "TimeoutError")));
    });
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("GraphClient", () => {
  it("times out a hung request instead of hanging forever", async () => {
    const client = new GraphClient({ config, tokens, logger: silent, ids, requestTimeoutMs: 20, fetchImpl: hangingFetch(), sleep: noSleep });
    await expect(client.request("GET", "/me/todo/lists")).rejects.toMatchObject({ code: "graph_unavailable" });
  });

  it("does not auto-retry a POST that may have landed", async () => {
    let calls = 0;
    const client = new GraphClient({ config, tokens, logger: silent, ids, requestTimeoutMs: 20, fetchImpl: hangingFetch(() => { calls += 1; }), sleep: noSleep });
    await expect(client.request("POST", "/me/todo/lists/x/tasks", { body: { title: "t" } })).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(calls).toBe(1);
  });

  it("retries a GET on a 503, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return calls < 2 ? jsonResponse(503, { error: { code: "serviceUnavailable" } }) : jsonResponse(200, { value: [] });
    }) as unknown as typeof fetch;
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    const res = await client.request<{ value: unknown[] }>("GET", "/me/todo/lists");
    expect(res.value).toEqual([]);
    expect(calls).toBe(2);
  });

  it("maps a 404 to not_found and carries the request id", async () => {
    const fetchImpl = (async () => jsonResponse(404, { error: { code: "ItemNotFound", message: "not found" } }, { "request-id": "req-abc-123" })) as unknown as typeof fetch;
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    await expect(client.request("GET", "/me/todo/lists/nope")).rejects.toMatchObject({ code: "not_found", requestId: "req-abc-123" });
  });

  it("returns undefined for a 204 (no body)", async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    expect(await client.request("DELETE", "/me/todo/lists/x/tasks/y")).toBeUndefined();
  });

  it.each([
    "https://attacker.example/v1.0/me/todo/lists",
    "http://graph.microsoft.com/v1.0/me/todo/lists",
    "https://graph.microsoft.com:444/v1.0/me/todo/lists",
    "https://user@graph.microsoft.com/v1.0/me/todo/lists",
    "https://graph.microsoft.com/v1.0/me/messages",
    "https://graph.microsoft.com/v1.0/me/todo/lists/x/tasks/y/../../../../messages",
    "https://graph.microsoft.com/v1.0/me/todo/lists/x%2f..%2f..%2fmessages",
    "https://graph.microsoft.com/v1.0/me/todo/lists/x%252f..",
    "https://graph.microsoft.com/v1.0/me/todo/lists#secret",
  ])("rejects forged cursor %s before acquiring a token", async (url) => {
    const getAccessToken = vi.fn(tokens.getAccessToken);
    const fetchImpl = vi.fn();
    const client = new GraphClient({ config, tokens: { ...tokens, getAccessToken }, logger: silent, ids, fetchImpl });
    const tasks = new TasksApi(client, 200);
    await expect(tasks.list("x", { cursor: encodeCursor(url) })).rejects.toMatchObject({ code: "validation_error" });
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an untrusted server-supplied nextLink without sending a second token", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { value: [], "@odata.nextLink": "https://attacker.example/" }));
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    await expect(new TasksApi(client, 200).list("x")).rejects.toMatchObject({ code: "validation_error" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves real continuation queries and refuses redirects", async () => {
    const url = "https://graph.microsoft.com/v1.0/me/todo/lists/x/tasks?$skiptoken=abc%2Fdef%3D";
    const fetchImpl = vi.fn(async () => jsonResponse(200, { value: [] }));
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl });
    await new TasksApi(client, 200).list("x", { cursor: encodeCursor(url) });
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error" }));
  });

  it("supports a configured sovereign Graph origin", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { value: [] }));
    const client = new GraphClient({ config: { ...config, graphBase: "https://graph.microsoft.us/v1.0" }, tokens, logger: silent, ids, fetchImpl });
    await client.request("GET", "/me/todo/lists");
    expect(fetchImpl).toHaveBeenCalledWith("https://graph.microsoft.us/v1.0/me/todo/lists", expect.anything());
  });

  it.each([500, 503, 504])("does not retry a POST on HTTP %s", async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, {}));
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    await expect(client.request("POST", "/me/todo/lists/x/tasks", { body: { title: "x" } })).rejects.toMatchObject({ code: "operation_uncertain" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a throttled create, which was rejected before processing", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(429, {}, { "retry-after": "0" })).mockResolvedValueOnce(jsonResponse(201, { id: "new-task" }));
    const client = new GraphClient({ config, tokens, logger: silent, ids, fetchImpl, sleep: noSleep });
    expect(await client.request("POST", "/me/todo/lists/x/tasks")).toEqual({ id: "new-task" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
