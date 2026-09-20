import { describe, expect, it, vi } from "vitest";
import { MonarchClient } from "../../src/monarch/client.js";
import { MONARCH_GRAPHQL_URL } from "../../src/config.js";
import type { FetchLike } from "../../src/monarch/client.js";
import { GRAPHQL_OPERATIONS } from "../../src/monarch/operations.js";

describe("MonarchClient", () => {
  it("requests the category name for transaction details", () => {
    expect(GRAPHQL_OPERATIONS.GetTransactionDrawer).toContain(
      "category { id name }",
    );
  });
  it("uses the fixed host and an approved read operation", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response(JSON.stringify({ data: { accounts: [] } }), {
          status: 200,
        }),
    );
    const client = new MonarchClient(
      {
        load: async () => ({
          cookie: "synthetic",
          capturedAt: "2026-01-01T00:00:00.000Z",
        }),
        clear: async () => undefined,
      },
      fetchMock,
    );
    await expect(client.read("GetAccounts")).resolves.toEqual({ accounts: [] });
    expect(fetchMock.mock.calls[0][0]).toBe(MONARCH_GRAPHQL_URL);
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.operationName).toBe("GetAccounts");
  });
  it("clears expired auth and never treats a mutation as retryable", async () => {
    const clear = vi.fn(async () => undefined);
    const client = new MonarchClient(
      {
        load: async () => ({
          authorization: "synthetic",
          capturedAt: "2026-01-01T00:00:00.000Z",
        }),
        clear,
      },
      async () => new Response("", { status: 401 }),
    );
    await expect(
      client.mutate("Common_DeleteTransactionRule", { id: "rule_1" }),
    ).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(clear).toHaveBeenCalledOnce();
  });
});
