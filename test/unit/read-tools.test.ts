import { describe, expect, it, vi } from "vitest";
import { MonarchClient, type FetchLike } from "../../src/monarch/client.js";
import {
  normalizeAccount,
  normalizeCategory,
} from "../../src/monarch/normalize.js";
import { ReadService } from "../../src/tools/read-tools.js";

describe("current Monarch read shapes", () => {
  it("maps accepted filters into current API variables and applies amount bounds", async () => {
    const fetchMock = vi.fn<FetchLike>(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              allTransactions: {
                totalCount: 2,
                results: [
                  {
                    id: "a",
                    amount: -10,
                    date: "2026-01-01",
                    pending: true,
                    isRecurring: true,
                    needsReview: false,
                    hideFromReports: true,
                    merchant: { id: "m", name: "M" },
                    tags: [],
                    splits: [],
                  },
                  {
                    id: "b",
                    amount: -100,
                    date: "2026-01-02",
                    pending: true,
                    isRecurring: true,
                    needsReview: false,
                    hideFromReports: true,
                    merchant: { id: "m", name: "M" },
                    tags: [],
                    splits: [],
                  },
                ],
              },
            },
          }),
          { status: 200 },
        ),
    );
    const client = new MonarchClient(
      {
        load: async () => ({
          cookie: "synthetic",
          capturedAt: "2026-01-01T00:00:00Z",
        }),
        clear: async () => undefined,
      },
      fetchMock,
    );
    const result = await new ReadService(client).search({
      pending: true,
      recurring: true,
      reviewed: true,
      hidden: true,
      minimum_amount: -50,
      page_size: 2,
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(body.operationName).toBe("GetTransactionsList");
    expect(body.variables.filters).toMatchObject({
      isPending: true,
      isRecurring: true,
      needsReview: false,
      hideFromReports: true,
      transactionVisibility: "all_transactions",
    });
    expect(result.transactions.map((transaction) => transaction.id)).toEqual([
      "a",
    ]);
    expect(result.transactions[0]?.recurring).toBe(true);
  });
  it("normalizes nested current account and category fields", () => {
    expect(
      normalizeAccount({
        id: "a",
        displayName: "A",
        deactivatedAt: "2026-01-01",
        isHidden: true,
        includeInNetWorth: true,
        institution: { name: "Bank" },
        type: { name: "depository" },
        subtype: { name: "checking" },
      }),
    ).toMatchObject({
      closed: true,
      hidden: true,
      include_in_net_worth: true,
      institution: "Bank",
    });
    expect(
      normalizeCategory({
        id: "c",
        name: "Food",
        group: { id: "g", name: "Living" },
      }).group,
    ).toBe("Living");
  });
});
