import { z } from "zod";

export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,200}$/)
  .max(200);
const ids = z.array(idSchema).min(1).max(100);
const match = z
  .object({
    operator: z.enum(["equals", "contains"]),
    value: z.string().trim().min(1).max(200),
  })
  .strict();
const amount = z
  .object({
    operator: z.enum(["equals", "greater_than", "less_than", "between"]),
    direction: z.enum(["income", "expense"]),
    value: z.number().finite().nonnegative().optional(),
    minimum: z.number().finite().nonnegative().optional(),
    maximum: z.number().finite().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.operator === "between" &&
      (value.minimum === undefined ||
        value.maximum === undefined ||
        value.minimum > value.maximum)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "between requires ordered minimum and maximum",
      });
    if (value.operator !== "between" && value.value === undefined)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "amount operator requires value",
      });
  });

export const safeRuleSchema = z
  .object({
    criteria: z
      .object({
        merchant: match.optional(),
        original_statement: match.optional(),
        account_ids: ids.optional(),
        category_ids: ids.optional(),
        amount: amount.optional(),
      })
      .strict()
      .refine(
        (value) => Object.keys(value).length > 0,
        "at least one criterion is required",
      ),
    actions: z
      .object({
        set_category_id: idSchema.optional(),
        add_tag_ids: ids.optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.set_category_id !== undefined ||
          value.add_tag_ids !== undefined,
        "at least one safe action is required",
      ),
  })
  .strict();
export type SafeRule = z.infer<typeof safeRuleSchema>;

export const previewChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), rule: safeRuleSchema }).strict(),
  z
    .object({
      kind: z.literal("update"),
      target_rule_id: idSchema,
      rule: safeRuleSchema,
    })
    .strict(),
  z.object({ kind: z.literal("delete"), target_rule_id: idSchema }).strict(),
  z
    .object({
      kind: z.literal("reorder"),
      target_rule_id: idSchema,
      new_position: z.number().int().min(0).max(10_000),
    })
    .strict(),
]);
export type PreviewChange = z.infer<typeof previewChangeSchema>;

export function toGraphqlSafeRule(
  rule: SafeRule,
  id?: string,
): Record<string, unknown> {
  const criterion = (value: {
    operator: "equals" | "contains";
    value: string;
  }) => ({
    operator: value.operator === "equals" ? "eq" : "contains",
    value: value.value,
  });
  const amount = rule.criteria.amount
    ? {
        operator: (
          {
            equals: "eq",
            greater_than: "gt",
            less_than: "lt",
            between: "between",
          } as const
        )[rule.criteria.amount.operator],
        isExpense: rule.criteria.amount.direction === "expense",
        ...(rule.criteria.amount.operator === "between"
          ? {
              valueRange: {
                lower: rule.criteria.amount.minimum,
                upper: rule.criteria.amount.maximum,
              },
            }
          : { value: rule.criteria.amount.value }),
      }
    : undefined;
  return {
    ...(id ? { id } : {}),
    ...(rule.criteria.merchant
      ? { merchantNameCriteria: [criterion(rule.criteria.merchant)] }
      : {}),
    ...(rule.criteria.original_statement
      ? {
          originalStatementCriteria: [
            criterion(rule.criteria.original_statement),
          ],
        }
      : {}),
    ...(rule.criteria.account_ids
      ? { accountIds: rule.criteria.account_ids }
      : {}),
    ...(rule.criteria.category_ids
      ? { categoryIds: rule.criteria.category_ids }
      : {}),
    ...(amount ? { amountCriteria: amount } : {}),
    ...(rule.actions.set_category_id
      ? { setCategoryAction: rule.actions.set_category_id }
      : {}),
    ...(rule.actions.add_tag_ids
      ? { addTagsAction: rule.actions.add_tag_ids }
      : {}),
    applyToExistingTransactions: false,
  };
}
