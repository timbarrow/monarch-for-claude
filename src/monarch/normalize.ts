import type {
  Account,
  Category,
  ClassificationRule,
  Tag,
  Transaction,
} from "./types.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}
export function normalizeAccount(value: unknown): Account {
  const r = record(value);
  const institution = record(r.institution);
  const type = record(r.type);
  const subtype = record(r.subtype);
  return {
    id: text(r.id) ?? "",
    display_name: text(r.displayName) ?? "",
    institution: text(r.institutionName) ?? text(institution.name),
    type: text(r.type) ?? text(type.name),
    subtype: text(r.subtype) ?? text(subtype.name),
    currency: text(r.currency),
    current_balance: number(r.currentBalance),
    closed: bool(r.isClosed) ?? (text(r.deactivatedAt) ? true : false),
    hidden: bool(r.isHidden),
    include_in_net_worth: bool(r.includeInNetWorth),
  };
}
export function normalizeCategory(value: unknown): Category {
  const r = record(value);
  const group = record(r.group);
  return {
    id: text(r.id) ?? "",
    name: text(r.name) ?? "",
    group: text(r.groupName) ?? text(group.name),
    active: bool(r.isActive),
    archived: bool(r.isArchived),
  };
}
export function normalizeTag(value: unknown): Tag {
  const r = record(value);
  return {
    id: text(r.id) ?? "",
    name: text(r.name) ?? "",
    color: text(r.color),
  };
}
export function normalizeTransaction(
  value: unknown,
  includeNotes = false,
): Transaction {
  const r = record(value);
  const account = record(r.account);
  const category = record(r.category);
  const merchant = record(r.merchant);
  const tags = Array.isArray(r.tags) ? r.tags.map(normalizeTag) : [];
  const rawSplits = Array.isArray(r.splits)
    ? r.splits
    : Array.isArray(r.splitTransactions)
      ? r.splitTransactions
      : [];
  const splits = rawSplits
    ? rawSplits.map((s) => {
        const p = record(s);
        return { id: text(p.id) ?? "", amount: number(p.amount) ?? 0 };
      })
    : [];
  const output: Transaction = {
    id: text(r.id) ?? "",
    date: text(r.date) ?? "",
    amount: number(r.amount) ?? 0,
    merchant: text(r.merchantName) ?? text(merchant.name),
    original_statement: text(r.originalStatement) ?? text(r.plaidName),
    account: account.id
      ? {
          id: text(account.id) ?? "",
          display_name: text(account.displayName) ?? "",
        }
      : null,
    category: category.id
      ? { id: text(category.id) ?? "", name: text(category.name) ?? "" }
      : null,
    tags,
    pending: bool(r.pending),
    recurring: bool(r.isRecurring) ?? bool(r.recurring),
    reviewed:
      bool(r.reviewed) ??
      (bool(r.needsReview) === null ? null : !bool(r.needsReview)),
    hidden: bool(r.hidden) ?? bool(r.hideFromReports),
    splits,
  };
  if (includeNotes) output.notes = text(r.notes);
  return output;
}
export function normalizeRule(
  value: unknown,
  order: number,
): ClassificationRule {
  const r = record(value);
  const merchantCriteria = Array.isArray(r.merchantNameCriteria)
    ? r.merchantNameCriteria
    : [];
  const statementCriteria = Array.isArray(r.originalStatementCriteria)
    ? r.originalStatementCriteria
    : [];
  const amount = record(r.amountCriteria);
  const range = record(amount.valueRange);
  const mapCriterion = (items: unknown[]) => {
    const first = record(items[0]);
    return items.length === 1 && first.value
      ? {
          operator: first.operator === "eq" ? "equals" : "contains",
          value: text(first.value) ?? "",
        }
      : undefined;
  };
  const merchant = mapCriterion(merchantCriteria);
  const statement = mapCriterion(statementCriteria);
  const mappedAmountOperator = (
    {
      eq: "equals",
      gt: "greater_than",
      lt: "less_than",
      between: "between",
    } as Record<string, string>
  )[String(amount.operator)];
  const criteria = {
    ...(merchant ? { merchant } : {}),
    ...(statement ? { original_statement: statement } : {}),
    ...(Array.isArray(r.accountIds) && r.accountIds.length
      ? { account_ids: r.accountIds }
      : {}),
    ...(Array.isArray(r.categoryIds) && r.categoryIds.length
      ? { category_ids: r.categoryIds }
      : {}),
    ...(mappedAmountOperator
      ? {
          amount: {
            operator: mappedAmountOperator,
            direction: amount.isExpense === true ? "expense" : "income",
            ...(amount.operator === "between"
              ? { minimum: number(range.lower), maximum: number(range.upper) }
              : { value: number(amount.value) }),
          },
        }
      : {}),
  };
  const category = record(r.setCategoryAction);
  const tags = Array.isArray(r.addTagsAction)
    ? r.addTagsAction
        .map((tag) => text(record(tag).id))
        .filter((id): id is string => !!id)
    : [];
  const actions = {
    ...(text(category.id) ? { set_category_id: text(category.id) } : {}),
    ...(tags.length ? { add_tag_ids: tags } : {}),
    // Preserve unsupported action markers so normalizeExistingRule marks this
    // rule non-editable instead of silently dropping a broader existing action.
    ...(r.setMerchantAction !== null && r.setMerchantAction !== undefined
      ? { set_merchant_action: true }
      : {}),
    ...(r.linkGoalAction !== null && r.linkGoalAction !== undefined
      ? { link_goal_action: true }
      : {}),
    ...(r.linkSavingsGoalAction !== null &&
    r.linkSavingsGoalAction !== undefined
      ? { link_savings_goal_action: true }
      : {}),
    ...(r.setHideFromReportsAction !== null &&
    r.setHideFromReportsAction !== undefined
      ? { set_hide_from_reports_action: true }
      : {}),
    ...(r.reviewStatusAction !== null && r.reviewStatusAction !== undefined
      ? { review_status_action: true }
      : {}),
    ...(r.sendNotificationAction !== null &&
    r.sendNotificationAction !== undefined
      ? { send_notification_action: true }
      : {}),
    ...(r.splitTransactionsAction !== null &&
    r.splitTransactionsAction !== undefined
      ? { split_transactions_action: true }
      : {}),
  };
  return {
    id: text(r.id) ?? "",
    order,
    criteria: r.criteria ?? criteria,
    actions: r.actions ?? actions,
    last_applied_at: text(r.lastAppliedAt),
  };
}
