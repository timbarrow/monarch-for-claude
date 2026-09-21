import { describe, expect, it, vi } from "vitest";
import {
  historicalImpact,
  transactionMatchesRule,
} from "../../src/rules/impact-preview.js";
import { PreviewStore } from "../../src/rules/preview-store.js";
import { previewChangeSchema, safeRuleSchema } from "../../src/rules/schema.js";
import { normalizeTransaction } from "../../src/monarch/normalize.js";
import { normalizeRule } from "../../src/monarch/normalize.js";
import { normalizeExistingRule } from "../../src/rules/normalize.js";
import {
  assertPayloadSuccess,
  RuleService,
} from "../../src/tools/rule-tools.js";
import type { ReadService } from "../../src/tools/read-tools.js";
import type { MonarchClient } from "../../src/monarch/client.js";
import type { Confirmation } from "../../src/rules/confirmation.js";
import { failure } from "../../src/tools/shared.js";

const safeRule = {
  criteria: { merchant: { operator: "contains" as const, value: "Coffee" } },
  actions: { set_category_id: "cat_food" },
};
describe("safe rule boundary", () => {
  it("accepts the supported rule-only actions", () => {
    expect(safeRuleSchema.parse(safeRule)).toEqual(safeRule);
    expect(() =>
      safeRuleSchema.parse({ ...safeRule, applyToExistingTransactions: true }),
    ).toThrow();
    expect(
      safeRuleSchema.parse({
        ...safeRule,
        actions: {
          set_merchant_name: "Amazon",
          hide_from_reports: true,
          review_status: "reviewed",
        },
      }),
    ).toMatchObject({ actions: { set_merchant_name: "Amazon" } });
    expect(() =>
      safeRuleSchema.parse({
        ...safeRule,
        criteria: { Merchant: { operator: "contains", value: "Coffee" } },
      }),
    ).toThrow();
  });
  it("rejects GraphQL-like and unknown preview fields", () => {
    expect(() =>
      previewChangeSchema.parse({
        kind: "create",
        rule: safeRule,
        query: "mutation DeleteTransaction",
      }),
    ).toThrow();
    expect(
      previewChangeSchema.parse({
        kind: "update",
        target_rule_id: "rule_1",
        rule: safeRule,
        apply_to_existing_transactions: true,
      }),
    ).toMatchObject({ apply_to_existing_transactions: true });
    expect(() =>
      previewChangeSchema.parse({
        kind: "delete",
        target_rule_id: "rule_1",
        apply_to_existing_transactions: true,
      }),
    ).toThrow();
  });
  it("normalizes documented and compatibility historical flags", () => {
    for (const candidate of [
      {
        kind: "create",
        rule: { ...safeRule, apply_to_existing_transactions: true },
      },
      {
        kind: "create",
        rule: { ...safeRule, apply_to_historical: true },
      },
      {
        kind: "create",
        rule: { ...safeRule, applyToExistingTransactions: true },
      },
      {
        kind: "create",
        rule: safeRule,
        apply_to_historical: true,
      },
      {
        kind: "create",
        rule: safeRule,
        applyToExistingTransactions: true,
      },
    ])
      expect(previewChangeSchema.parse(candidate)).toMatchObject({
        apply_to_existing_transactions: true,
        rule: safeRule,
      });
    expect(() =>
      previewChangeSchema.parse({
        kind: "create",
        rule: { ...safeRule, apply_to_historical: false },
        apply_to_existing_transactions: true,
      }),
    ).toThrow("HISTORICAL_APPLICATION_FLAG_CONFLICT");
  });
  it("returns actionable validation details instead of an opaque error", () => {
    try {
      previewChangeSchema.parse({
        kind: "create",
        rule: { criteria: {}, actions: {} },
      });
      throw new Error("EXPECTED_VALIDATION_FAILURE");
    } catch (error) {
      expect(failure(error)).toMatchObject({
        isError: true,
        content: [
          {
            text: expect.stringContaining('"error":"INVALID_INPUT"'),
          },
        ],
      });
    }
  });
  it("computes historical matches as inert read-only data", () => {
    const transaction = normalizeTransaction({
      id: "txn_1",
      date: "2026-09-01",
      amount: -12.5,
      merchantName: "Synthetic Coffee",
      originalStatement: "SYNTHETIC COFFEE",
      account: { id: "acct_1", displayName: "Synthetic Checking" },
      category: { id: "cat_food", name: "Food" },
      tags: [],
      pending: false,
      recurring: false,
      reviewed: true,
      hidden: false,
      splits: [],
    });
    expect(transactionMatchesRule(transaction, safeRule)).toBe(true);
    expect(historicalImpact([transaction], safeRule)).toMatchObject({
      count: 1,
      representatives: [{ id: "txn_1" }],
    });
  });
  it("matches any merchant value within one criterion", () => {
    const transaction = normalizeTransaction({
      id: "txn_1",
      date: "2026-09-01",
      amount: -25,
      merchantName: "Amazon Marketplace",
    });
    expect(
      transactionMatchesRule(transaction, {
        criteria: {
          merchant: [
            { operator: "contains", value: "Target" },
            { operator: "contains", value: "Amazon" },
          ],
        },
        actions: { set_category_id: "cat_shopping" },
      }),
    ).toBe(true);
  });
  it("pages through the full preview window before reporting match count", async () => {
    const matchingTransaction = normalizeTransaction({
      id: "txn_1",
      date: "2026-09-01",
      amount: -12.5,
      merchantName: "Synthetic Coffee",
    });
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        transactions: [],
        next_cursor: "cursor_2",
        applied_date_range: {
          start_date: "2026-08-21",
          end_date: "2026-09-20",
        },
      })
      .mockResolvedValueOnce({
        transactions: [matchingTransaction],
        next_cursor: null,
        applied_date_range: {
          start_date: "2026-08-21",
          end_date: "2026-09-20",
        },
      });
    const read = {
      rawRules: async () => [],
      search,
      accounts: async () => [],
      categories: async () => [{ id: "cat_food" }],
      tags: async () => [],
    } as unknown as ReadService;
    const service = new RuleService(
      read,
      {} as MonarchClient,
      new PreviewStore(),
      {} as Confirmation,
    );
    await expect(
      service.preview({ kind: "create", rule: safeRule }),
    ).resolves.toMatchObject({ historical_match_count: 1 });
    expect(search).toHaveBeenNthCalledWith(2, {
      page_size: 200,
      cursor: "cursor_2",
      start_date: "2026-08-21",
      end_date: "2026-09-20",
    });
  });
  it("previews all available history before enabling retroactive application", async () => {
    const transaction = normalizeTransaction({
      id: "txn_1",
      date: "2020-01-01",
      amount: -12.5,
      merchantName: "Synthetic Coffee",
    });
    const search = vi.fn().mockResolvedValue({
      transactions: [transaction],
      next_cursor: null,
      applied_date_range: {
        start_date: "1900-01-01",
        end_date: "2026-09-21",
      },
    });
    const read = {
      rawRules: async () => [],
      search,
      accounts: async () => [],
      categories: async () => [{ id: "cat_food" }],
      tags: async () => [],
    } as unknown as ReadService;
    const service = new RuleService(
      read,
      {} as MonarchClient,
      new PreviewStore(),
      {} as Confirmation,
    );
    await expect(
      service.preview({
        kind: "create",
        rule: safeRule,
        apply_to_existing_transactions: true,
      }),
    ).resolves.toMatchObject({
      historical_match_count: 1,
      historical_transactions_to_modify: 1,
    });
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ start_date: "1900-01-01" }),
    );
  });
  it("sends historical application only after preview and confirmation", async () => {
    const mutate = vi.fn().mockResolvedValue({
      createTransactionRuleV2: { errors: null },
    });
    const read = {
      rawRules: async () => [],
      search: async () => ({
        transactions: [],
        next_cursor: null,
        applied_date_range: {
          start_date: "1900-01-01",
          end_date: "2026-09-21",
        },
      }),
      accounts: async () => [],
      categories: async () => [{ id: "cat_food" }],
      tags: async () => [],
      rules: async () => [
        {
          id: "rule_created",
          order: 0,
          criteria: safeRule.criteria,
          actions: safeRule.actions,
          last_applied_at: null,
          editable: true,
          unsupported_actions: [],
        },
      ],
    } as unknown as ReadService;
    const confirmation = {
      confirm: vi.fn().mockResolvedValue(true),
    } as unknown as Confirmation;
    const service = new RuleService(
      read,
      { mutate } as unknown as MonarchClient,
      new PreviewStore(),
      confirmation,
    );
    const preview = await service.preview({
      kind: "create",
      rule: safeRule,
      apply_to_existing_transactions: true,
    });
    await expect(service.apply(preview.preview_id)).resolves.toMatchObject({
      applied: true,
      historical_application_requested: true,
    });
    expect(confirmation.confirm).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith(
      "Common_CreateTransactionRuleMutationV2",
      expect.objectContaining({
        input: expect.objectContaining({
          applyToExistingTransactions: true,
        }),
      }),
    );
  });
  it("expires and consumes previews", () => {
    let now = 0;
    const store = new PreviewStore(() => now, 100);
    const preview = store.create({ kind: "create", rule: safeRule }, "state");
    expect(store.consume(preview.preview_id).used).toBe(true);
    expect(() => store.consume(preview.preview_id)).toThrow(
      "PREVIEW_INVALID_OR_EXPIRED",
    );
    const expired = store.create({ kind: "create", rule: safeRule }, "state");
    now = 101;
    expect(() => store.consume(expired.preview_id)).toThrow(
      "PREVIEW_INVALID_OR_EXPIRED",
    );
  });
  it("does not make existing broad-action rules editable", () => {
    const rule = normalizeRule(
      {
        id: "rule_unsafe",
        merchantNameCriteria: [{ operator: "contains", value: "Synthetic" }],
        setCategoryAction: { id: "cat_food" },
        linkGoalAction: { id: "goal_1" },
      },
      0,
    );
    expect(normalizeExistingRule(rule)).toMatchObject({
      editable: false,
      unsupported_actions: ["link_goal_action"],
    });
  });
  it("rejects HTTP-200 mutation payload errors", () => {
    expect(() =>
      assertPayloadSuccess(
        { createTransactionRuleV2: { errors: [{ message: "rejected" }] } },
        "createTransactionRuleV2",
      ),
    ).toThrow("RULE_MUTATION_REJECTED");
    expect(() =>
      assertPayloadSuccess(
        { createTransactionRuleV2: { errors: null } },
        "createTransactionRuleV2",
      ),
    ).not.toThrow();
  });
});
