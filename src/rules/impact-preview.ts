import type { Transaction } from "../monarch/types.js";
import type { SafeRule } from "./schema.js";

function includes(
  haystack: string | null,
  needle: string,
  operator: "equals" | "contains",
): boolean {
  if (!haystack) return false;
  return operator === "equals"
    ? haystack === needle
    : haystack.toLowerCase().includes(needle.toLowerCase());
}
function matchesAny(
  haystack: string | null,
  criteria:
    | { operator: "equals" | "contains"; value: string }
    | { operator: "equals" | "contains"; value: string }[],
): boolean {
  const values = Array.isArray(criteria) ? criteria : [criteria];
  return values.some((item) => includes(haystack, item.value, item.operator));
}
export function transactionMatchesRule(
  transaction: Transaction,
  rule: SafeRule,
): boolean {
  const c = rule.criteria;
  if (c.merchant && !matchesAny(transaction.merchant, c.merchant)) return false;
  if (
    c.original_statement &&
    !matchesAny(transaction.original_statement, c.original_statement)
  )
    return false;
  if (
    c.account_ids &&
    (!transaction.account || !c.account_ids.includes(transaction.account.id))
  )
    return false;
  if (
    c.category_ids &&
    (!transaction.category || !c.category_ids.includes(transaction.category.id))
  )
    return false;
  if (c.amount) {
    const value = Math.abs(transaction.amount);
    const signedOk =
      c.amount.direction === "income"
        ? transaction.amount > 0
        : transaction.amount < 0;
    if (!signedOk) return false;
    if (c.amount.operator === "equals" && value !== c.amount.value)
      return false;
    if (
      c.amount.operator === "greater_than" &&
      !(value > (c.amount.value ?? 0))
    )
      return false;
    if (c.amount.operator === "less_than" && !(value < (c.amount.value ?? 0)))
      return false;
    if (
      c.amount.operator === "between" &&
      !(
        value >= (c.amount.minimum ?? Infinity) &&
        value <= (c.amount.maximum ?? -Infinity)
      )
    )
      return false;
  }
  return true;
}
export function historicalImpact(
  transactions: Transaction[],
  rule: SafeRule,
): { count: number; representatives: Transaction[] } {
  const matched = transactions.filter((transaction) =>
    transactionMatchesRule(transaction, rule),
  );
  return { count: matched.length, representatives: matched.slice(0, 10) };
}
