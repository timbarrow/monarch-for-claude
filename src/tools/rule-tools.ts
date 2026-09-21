import crypto from "node:crypto";
import type { ReadService } from "./read-tools.js";
import type { MonarchClient } from "../monarch/client.js";
import type { Transaction } from "../monarch/types.js";
import { historicalImpact } from "../rules/impact-preview.js";
import { normalizeExistingRule } from "../rules/normalize.js";
import { PreviewStore } from "../rules/preview-store.js";
import {
  previewChangeSchema,
  safeRuleSchema,
  toGraphqlSafeRule,
  type SafeRule,
} from "../rules/schema.js";
import type { Confirmation } from "../rules/confirmation.js";

function fingerprint(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
function safeRuleFromExisting(rule: {
  criteria: unknown;
  actions: unknown;
}): SafeRule {
  const result = safeRuleSchema.safeParse({
    criteria: rule.criteria,
    actions: rule.actions,
  });
  if (!result.success) throw new Error("RULE_NOT_EDITABLE");
  return result.data;
}
function comparableRule(rule: SafeRule): unknown {
  const criteria = { ...rule.criteria };
  if (criteria.merchant && !Array.isArray(criteria.merchant))
    criteria.merchant = [criteria.merchant];
  if (
    criteria.original_statement &&
    !Array.isArray(criteria.original_statement)
  )
    criteria.original_statement = [criteria.original_statement];
  const actions = { ...rule.actions };
  // Monarch's read shape does not distinguish an absent hide action from an
  // explicit false value. Treat false as the canonical absence for read-back.
  if (actions.hide_from_reports === false) delete actions.hide_from_reports;
  return { criteria, actions };
}
export function assertPayloadSuccess(result: unknown, field: string): void {
  const payload =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)[field]
      : undefined;
  if (!payload || typeof payload !== "object")
    throw new Error("MUTATION_RESPONSE_INVALID");
  const errors = (payload as Record<string, unknown>).errors;
  if (errors && (!Array.isArray(errors) || errors.length > 0))
    throw new Error("RULE_MUTATION_REJECTED");
}

export class RuleService {
  private applying = false;
  constructor(
    private readonly read: ReadService,
    private readonly client: MonarchClient,
    private readonly previews: PreviewStore,
    private readonly confirmation: Confirmation,
  ) {}
  async list() {
    return this.read.rules();
  }
  async preview(raw: unknown) {
    const change = previewChangeSchema.parse(raw);
    const rules = await this.read.rawRules();
    const normalized = rules.map(normalizeExistingRule);
    const target =
      "target_rule_id" in change
        ? normalized.find((rule) => rule.id === change.target_rule_id)
        : undefined;
    if ("target_rule_id" in change && !target)
      throw new Error("RULE_NOT_FOUND");
    if (change.kind === "update" && !target?.editable)
      throw new Error("RULE_NOT_EDITABLE");
    if (change.kind === "create" || change.kind === "update")
      await this.validateRuleReferences(change.rule);
    const before = target ?? null;
    const after =
      change.kind === "create" || change.kind === "update"
        ? change.rule
        : change.kind === "delete"
          ? null
          : { ...target, order: change.new_position };
    let impact = {
      historical_match_count: 0,
      representative_matches: [] as unknown[],
      scope: "not_applicable",
    };
    if (change.kind === "create" || change.kind === "update") {
      const transactions: Transaction[] = [];
      let cursor: string | undefined;
      let startDate: string | undefined = change.apply_to_existing_transactions
        ? "1900-01-01"
        : undefined;
      let endDate: string | undefined;
      do {
        const page = await this.read.search({
          page_size: 200,
          cursor,
          start_date: startDate,
          end_date: endDate,
        });
        startDate = page.applied_date_range.start_date;
        endDate = page.applied_date_range.end_date;
        transactions.push(...page.transactions);
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
      const computed = historicalImpact(transactions, change.rule);
      impact = {
        historical_match_count: computed.count,
        representative_matches: computed.representatives,
        scope: change.apply_to_existing_transactions
          ? `full available history ${startDate} through ${endDate}; selected for historical application`
          : `current default ${startDate} through ${endDate}; preview only`,
      };
    }
    const stored = this.previews.create(
      change,
      fingerprint(rules),
      impact.historical_match_count,
    );
    return {
      preview_id: stored.preview_id,
      expires_in_seconds: 600,
      before,
      after,
      validation_warnings:
        change.kind === "reorder"
          ? ["Rule order affects execution order."]
          : (change.kind === "create" || change.kind === "update") &&
              change.apply_to_existing_transactions
            ? [
                "Applying this rule will immediately change every existing Monarch transaction that matches it.",
              ]
            : [],
      ...impact,
      historical_transactions_modified: 0,
      historical_transactions_to_modify:
        (change.kind === "create" || change.kind === "update") &&
        change.apply_to_existing_transactions
          ? impact.historical_match_count
          : 0,
      ordering_impact:
        change.kind === "reorder"
          ? `Rule will move to zero-based position ${change.new_position}.`
          : null,
    };
  }
  async apply(previewId: string) {
    if (this.applying) throw new Error("RULE_CHANGE_IN_PROGRESS");
    this.applying = true;
    try {
      const preview = this.previews.consume(previewId);
      const current = await this.read.rawRules();
      if (fingerprint(current) !== preview.state_fingerprint)
        throw new Error("PREVIEW_STALE");
      const change = previewChangeSchema.parse(preview.change);
      if (change.kind === "update" || change.kind === "create")
        safeRuleSchema.parse(change.rule);
      const confirmed = await this.confirmation.confirm(change);
      if (!confirmed) throw new Error("USER_CONFIRMATION_CANCELLED");
      // Re-fetch after the human confirmation so an intervening UI edit cannot
      // turn a previously safe preview into a stale mutation.
      const immediatelyBeforeMutation = await this.read.rawRules();
      if (fingerprint(immediatelyBeforeMutation) !== preview.state_fingerprint)
        throw new Error("PREVIEW_STALE");
      if (change.kind === "create" || change.kind === "update")
        await this.validateRuleReferences(change.rule);
      let mutationResult: unknown;
      if (change.kind === "create") {
        mutationResult = await this.client.mutate(
          "Common_CreateTransactionRuleMutationV2",
          {
            input: toGraphqlSafeRule(
              change.rule,
              undefined,
              change.apply_to_existing_transactions,
            ),
          },
        );
        assertPayloadSuccess(mutationResult, "createTransactionRuleV2");
      } else if (change.kind === "update") {
        const target = immediatelyBeforeMutation.find(
          (rule) => rule.id === change.target_rule_id,
        );
        if (!target) throw new Error("PREVIEW_STALE");
        safeRuleFromExisting(target);
        mutationResult = await this.client.mutate(
          "Common_UpdateTransactionRuleMutationV2",
          {
            input: toGraphqlSafeRule(
              change.rule,
              change.target_rule_id,
              change.apply_to_existing_transactions,
            ),
          },
        );
        assertPayloadSuccess(mutationResult, "updateTransactionRuleV2");
      } else if (change.kind === "delete") {
        mutationResult = await this.client.mutate(
          "Common_DeleteTransactionRule",
          {
            id: change.target_rule_id,
          },
        );
        assertPayloadSuccess(mutationResult, "deleteTransactionRule");
      } else {
        mutationResult = await this.client.mutate(
          "Web_UpdateRuleOrderMutation",
          {
            id: change.target_rule_id,
            order: change.new_position,
          },
        );
        assertPayloadSuccess(mutationResult, "updateTransactionRuleOrderV2");
      }
      const finalRules = await this.read.rules();
      if (
        change.kind === "delete" &&
        finalRules.some((rule) => rule.id === change.target_rule_id)
      )
        throw new Error("READ_BACK_VERIFICATION_FAILED");
      if (
        change.kind === "reorder" &&
        finalRules.find((rule) => rule.id === change.target_rule_id)?.order !==
          change.new_position
      )
        throw new Error("READ_BACK_VERIFICATION_FAILED");
      if (change.kind === "update") {
        const observed = finalRules.find(
          (rule) => rule.id === change.target_rule_id,
        );
        if (
          !observed ||
          JSON.stringify(comparableRule(safeRuleFromExisting(observed))) !==
            JSON.stringify(comparableRule(change.rule))
        )
          throw new Error("READ_BACK_VERIFICATION_FAILED");
      }
      if (
        change.kind === "create" &&
        !finalRules.some((rule) => {
          try {
            return (
              JSON.stringify(comparableRule(safeRuleFromExisting(rule))) ===
              JSON.stringify(comparableRule(change.rule))
            );
          } catch {
            return false;
          }
        })
      )
        throw new Error("READ_BACK_VERIFICATION_FAILED");
      return {
        applied: true,
        historical_application_requested:
          (change.kind === "create" || change.kind === "update") &&
          change.apply_to_existing_transactions,
        previewed_historical_match_count: preview.historical_match_count,
        final_rules: finalRules,
      };
    } finally {
      this.applying = false;
    }
  }

  private async validateRuleReferences(rule: SafeRule): Promise<void> {
    const [accounts, categories, tags] = await Promise.all([
      this.read.accounts(true, true),
      this.read.categories(),
      this.read.tags(),
    ]);
    const accountIds = new Set(accounts.map((account) => account.id));
    const categoryIds = new Set(categories.map((category) => category.id));
    const tagIds = new Set(tags.map((tag) => tag.id));
    for (const id of rule.criteria.account_ids ?? [])
      if (!accountIds.has(id)) throw new Error("UNKNOWN_ACCOUNT_ID");
    for (const id of [
      ...(rule.criteria.category_ids ?? []),
      ...(rule.actions.set_category_id ? [rule.actions.set_category_id] : []),
    ])
      if (!categoryIds.has(id)) throw new Error("UNKNOWN_CATEGORY_ID");
    for (const id of rule.actions.add_tag_ids ?? [])
      if (!tagIds.has(id)) throw new Error("UNKNOWN_TAG_ID");
  }
}
