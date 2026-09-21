import { safeRuleSchema, type SafeRule } from "./schema.js";

export interface NormalizedRule {
  id: string;
  order: number;
  criteria: unknown;
  actions: unknown;
  last_applied_at: string | null;
  editable: boolean;
  unsupported_actions: string[];
}

export function normalizeExistingRule(input: {
  id: string;
  order: number;
  criteria: unknown;
  actions: unknown;
  last_applied_at: string | null;
}): NormalizedRule {
  const parsed = safeRuleSchema.safeParse({
    criteria: input.criteria,
    actions: input.actions,
  });
  return {
    ...input,
    editable: parsed.success,
    unsupported_actions: parsed.success
      ? []
      : unsupportedActionLabels(input.actions),
  };
}

function unsupportedActionLabels(actions: unknown): string[] {
  if (!actions || typeof actions !== "object" || Array.isArray(actions))
    return ["unrecognized_action_shape"];
  const allowed = new Set([
    "set_category_id",
    "add_tag_ids",
    "set_merchant_name",
    "hide_from_reports",
    "review_status",
  ]);
  const keys = Object.keys(actions as Record<string, unknown>);
  const labels = keys.filter((key) => !allowed.has(key));
  return labels.length ? labels : ["criteria_or_action_not_supported"];
}

export function normalizedSafeRule(rule: SafeRule): SafeRule {
  return safeRuleSchema.parse(rule);
}
