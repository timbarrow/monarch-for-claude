import { describe, expect, it, vi } from "vitest";
import type { MonarchClient } from "../../src/monarch/client.js";
import type { Transaction } from "../../src/monarch/types.js";
import type { Confirmation } from "../../src/rules/confirmation.js";
import { TransactionPreviewStore } from "../../src/transactions/preview-store.js";
import { previewTransactionUpdateInput } from "../../src/tools/contracts.js";
import type { ReadService } from "../../src/tools/read-tools.js";
import { TransactionService } from "../../src/tools/transaction-tools.js";

function transaction(): Transaction {
  return {
    id: "txn_1",
    date: "2026-09-21",
    amount: -42,
    merchant: "Check",
    original_statement: "CHECK 1001",
    account: { id: "acct_1", display_name: "Checking" },
    category: { id: "cat_old", name: "Uncategorized" },
    tags: [],
    pending: false,
    recurring: false,
    reviewed: false,
    hidden: false,
    notes: null,
    splits: [],
  };
}

describe("individual transaction updates", () => {
  it("previews, confirms, applies, and verifies an ordinary update", async () => {
    let state = transaction();
    const mutate = vi.fn(async (_operation, variables: unknown) => {
      const input = (variables as { input: Record<string, unknown> }).input;
      state = {
        ...state,
        merchant: String(input.name),
        category: { id: String(input.category), name: "Home Maintenance" },
        notes: String(input.notes),
        reviewed: input.needsReview === false,
        hidden: input.hideFromReports === true,
      };
      return { updateTransaction: { errors: null } };
    });
    const read = {
      transaction: async () => structuredClone(state),
      categories: async () => [{ id: "cat_new", name: "Home Maintenance" }],
      tags: async () => [],
    } as unknown as ReadService;
    const confirmation = {
      confirm: vi.fn().mockResolvedValue(true),
    } as unknown as Confirmation;
    const service = new TransactionService(
      read,
      { mutate } as unknown as MonarchClient,
      new TransactionPreviewStore(),
      confirmation,
    );
    const preview = await service.preview({
      transaction_id: "txn_1",
      merchant_name: "Frank Barrow",
      category_id: "cat_new",
      notes: "Check 1001",
      reviewed: true,
      hidden: true,
    });
    expect(preview).toMatchObject({
      before: { merchant: "Check", category: { id: "cat_old" } },
      after: {
        merchant: "Frank Barrow",
        category: { id: "cat_new" },
        reviewed: true,
      },
      transaction_deleted: false,
    });
    await expect(service.apply(preview.preview_id)).resolves.toMatchObject({
      applied: true,
      transaction: { merchant: "Frank Barrow", category: { id: "cat_new" } },
    });
    expect(confirmation.confirm).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith(
      "Web_TransactionDrawerUpdateTransaction",
      {
        input: {
          id: "txn_1",
          name: "Frank Barrow",
          category: "cat_new",
          notes: "Check 1001",
          needsReview: false,
          hideFromReports: true,
        },
      },
    );
  });

  it("replaces tags through its separate fixed mutation", async () => {
    let state = transaction();
    const mutate = vi.fn(async () => {
      state = {
        ...state,
        tags: [{ id: "tag_1", name: "Tax", color: null }],
      };
      return { setTransactionTags: { errors: null } };
    });
    const read = {
      transaction: async () => structuredClone(state),
      categories: async () => [],
      tags: async () => [{ id: "tag_1", name: "Tax", color: null }],
    } as unknown as ReadService;
    const service = new TransactionService(
      read,
      { mutate } as unknown as MonarchClient,
      new TransactionPreviewStore(),
      { confirm: async () => true },
    );
    const preview = await service.preview({
      transaction_id: "txn_1",
      tag_ids: ["tag_1"],
    });
    await service.apply(preview.preview_id);
    expect(mutate).toHaveBeenCalledWith("Web_SetTransactionTags", {
      input: { transactionId: "txn_1", tagIds: ["tag_1"] },
    });
  });

  it("rejects deletes, empty updates, and mixed tag updates", () => {
    expect(() =>
      previewTransactionUpdateInput.parse({
        transaction_id: "txn_1",
        delete: true,
      }),
    ).toThrow();
    expect(() =>
      previewTransactionUpdateInput.parse({ transaction_id: "txn_1" }),
    ).toThrow();
    expect(() =>
      previewTransactionUpdateInput.parse({
        transaction_id: "txn_1",
        merchant_name: "Person",
        tag_ids: [],
      }),
    ).toThrow();
  });
});
