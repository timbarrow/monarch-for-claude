import { DEFAULT_DATE_WINDOW_DAYS, DEFAULT_PAGE_SIZE } from "../config.js";
import {
  normalizeAccount,
  normalizeCategory,
  normalizeRule,
  normalizeTag,
  normalizeTransaction,
} from "../monarch/normalize.js";
import type { MonarchClient } from "../monarch/client.js";
import type { ClassificationRule, Transaction } from "../monarch/types.js";
import {
  normalizeExistingRule,
  type NormalizedRule,
} from "../rules/normalize.js";
import {
  searchTransactionsValidation,
  summarizeTransactionsValidation,
} from "./contracts.js";

type Data = Record<string, unknown>;
function value(data: Data, key: string): unknown {
  return data[key];
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface SearchArgs {
  start_date?: string;
  end_date?: string;
  account_ids?: string[];
  category_ids?: string[];
  tag_ids?: string[];
  search?: string;
  minimum_amount?: number;
  maximum_amount?: number;
  pending?: boolean;
  recurring?: boolean;
  reviewed?: boolean;
  hidden?: boolean;
  cursor?: string;
  page_size?: number;
  include_notes?: boolean;
}
export class ReadService {
  constructor(private readonly client: MonarchClient) {}
  async accounts(includeClosed: boolean, includeHidden: boolean) {
    const data = await this.client.read<Data>("GetAccounts");
    return array(value(data, "accounts"))
      .map(normalizeAccount)
      .filter(
        (a) => (includeClosed || !a.closed) && (includeHidden || !a.hidden),
      );
  }
  async search(args: SearchArgs) {
    searchTransactionsValidation.parse(args);
    const start_date = args.start_date ?? isoDaysAgo(DEFAULT_DATE_WINDOW_DAYS);
    const end_date = args.end_date ?? new Date().toISOString().slice(0, 10);
    const offset = args.cursor
      ? Number(Buffer.from(args.cursor, "base64url").toString("utf8"))
      : 0;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("INVALID_CURSOR");
    const filters = {
      ...(args.search ? { search: args.search } : {}),
      ...(args.account_ids ? { accounts: args.account_ids } : {}),
      ...(args.category_ids ? { categories: args.category_ids } : {}),
      ...(args.tag_ids ? { tags: args.tag_ids } : {}),
      startDate: start_date,
      endDate: end_date,
      ...(args.pending !== undefined ? { isPending: args.pending } : {}),
      ...(args.recurring !== undefined ? { isRecurring: args.recurring } : {}),
      ...(args.reviewed !== undefined ? { needsReview: !args.reviewed } : {}),
      ...(args.hidden !== undefined
        ? {
            hideFromReports: args.hidden,
            transactionVisibility: "all_transactions",
          }
        : {}),
    };
    const limit = args.page_size ?? DEFAULT_PAGE_SIZE;
    const data = await this.client.read<Data>("GetTransactionsList", {
      offset,
      limit,
      filters,
      orderBy: "date",
    });
    const container = object(value(data, "allTransactions"));
    const total =
      typeof container.totalCount === "number" ? container.totalCount : 0;
    const nextOffset = offset + array(container.results).length;
    return {
      transactions: array(container.results)
        .map((item) => normalizeTransaction(item, args.include_notes))
        .filter(
          (transaction) =>
            (args.minimum_amount === undefined ||
              transaction.amount >= args.minimum_amount) &&
            (args.maximum_amount === undefined ||
              transaction.amount <= args.maximum_amount),
        ),
      next_cursor:
        nextOffset < total
          ? Buffer.from(String(nextOffset)).toString("base64url")
          : null,
      has_more: nextOffset < total,
      applied_date_range: { start_date, end_date },
    };
  }
  async transaction(id: string, includeNotes: boolean) {
    const data = await this.client.read<Data>("GetTransactionDrawer", {
      id,
      redirectPosted: true,
    });
    const raw = value(data, "getTransaction");
    if (!raw) throw new Error("TRANSACTION_NOT_FOUND");
    return normalizeTransaction(raw, includeNotes);
  }
  async categories() {
    const data = await this.client.read<Data>("GetCategories");
    return array(value(data, "categories")).map(normalizeCategory);
  }
  async tags() {
    const data = await this.client.read<Data>("GetHouseholdTransactionTags");
    return array(value(data, "householdTransactionTags")).map(normalizeTag);
  }
  async rawRules(): Promise<ClassificationRule[]> {
    const data = await this.client.read<Data>("GetTransactionRules");
    return array(value(data, "transactionRules")).map((rule, index) =>
      normalizeRule(rule, index),
    );
  }
  async rules(): Promise<NormalizedRule[]> {
    return (await this.rawRules()).map(normalizeExistingRule);
  }
  async summary(
    startDate: string,
    endDate: string,
    groupBy: "month" | "account" | "category" | "merchant",
  ) {
    summarizeTransactionsValidation.parse({
      start_date: startDate,
      end_date: endDate,
      group_by: groupBy,
    });
    let cursor: string | undefined;
    const transactions: Transaction[] = [];
    do {
      const page = await this.search({
        start_date: startDate,
        end_date: endDate,
        cursor,
        page_size: 200,
      });
      transactions.push(...page.transactions);
      cursor = page.next_cursor ?? undefined;
      if (transactions.length > 5_000) throw new Error("SUMMARY_RESULT_LIMIT");
    } while (cursor);
    const groups = new Map<string, { count: number; total: number }>();
    for (const t of transactions) {
      const key =
        groupBy === "month"
          ? t.date.slice(0, 7)
          : groupBy === "account"
            ? (t.account?.display_name ?? "Unassigned")
            : groupBy === "category"
              ? (t.category?.name ?? "Uncategorized")
              : (t.merchant ?? "Unknown merchant");
      const current = groups.get(key) ?? { count: 0, total: 0 };
      current.count += 1;
      current.total += t.amount;
      groups.set(key, current);
    }
    return {
      start_date: startDate,
      end_date: endDate,
      group_by: groupBy,
      transaction_count: transactions.length,
      total: transactions.reduce((sum, item) => sum + item.amount, 0),
      groups: [...groups.entries()]
        .map(([key, totals]) => ({ key, ...totals }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    };
  }
}
