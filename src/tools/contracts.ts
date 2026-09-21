import { z } from "zod";
import {
  MAX_DATE_WINDOW_DAYS,
  MAX_ID_ARRAY_LENGTH,
  MAX_PAGE_SIZE,
} from "../config.js";
import { idSchema } from "../rules/schema.js";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return (
      parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day
    );
  }, "date must be a valid calendar date");
const ids = z.array(idSchema).max(MAX_ID_ARRAY_LENGTH);
export const connectionStatusInput = z.object({}).strict();
export const connectInput = z.object({}).strict();
export const listAccountsInput = z
  .object({
    include_closed: z.boolean().default(false),
    include_hidden: z.boolean().default(false),
  })
  .strict();
export const searchTransactionsInput = z
  .object({
    start_date: date.optional(),
    end_date: date.optional(),
    account_ids: ids.optional(),
    category_ids: ids.optional(),
    tag_ids: ids.optional(),
    search: z.string().trim().min(1).max(200).optional(),
    minimum_amount: z.number().finite().optional(),
    maximum_amount: z.number().finite().optional(),
    pending: z.boolean().optional(),
    recurring: z.boolean().optional(),
    reviewed: z.boolean().optional(),
    hidden: z.boolean().optional(),
    cursor: z.string().max(2_000).optional(),
    page_size: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    include_notes: z.boolean().default(false),
  })
  .strict();
export const searchTransactionsValidation = searchTransactionsInput.superRefine(
  (value, ctx) => {
    if (value.start_date && value.end_date && value.start_date > value.end_date)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "start_date must be before end_date",
      });
    if (
      value.minimum_amount !== undefined &&
      value.maximum_amount !== undefined &&
      value.minimum_amount > value.maximum_amount
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "minimum_amount must not exceed maximum_amount",
      });
  },
);
export const getTransactionInput = z
  .object({
    transaction_id: idSchema,
    include_notes: z.boolean().default(false),
  })
  .strict();
export const summarizeTransactionsInput = z
  .object({
    start_date: date,
    end_date: date,
    group_by: z.enum(["month", "account", "category", "merchant"]),
  })
  .strict();
export const summarizeTransactionsValidation =
  summarizeTransactionsInput.superRefine((value, ctx) => {
    const span =
      (Date.parse(value.end_date) - Date.parse(value.start_date)) / 86_400_000;
    if (span < 0 || span > MAX_DATE_WINDOW_DAYS)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `date range must be 0-${MAX_DATE_WINDOW_DAYS} days`,
      });
  });
export const listCategoriesInput = z.object({}).strict();
export const listTagsInput = z.object({}).strict();
export const listRulesInput = z.object({}).strict();
// RuleService immediately reparses this transport schema using its strict
// discriminated union. `passthrough` preserves malicious extra fields so that
// they are rejected there rather than silently discarded by the SDK parser.
export const previewRuleInput = z
  .object({
    kind: z.enum(["create", "update", "delete", "reorder"]),
    target_rule_id: idSchema.optional(),
    rule: z
      .unknown()
      .optional()
      .describe(
        "Complete rule definition. Historical application may be placed here as apply_to_existing_transactions for compatibility, but it is not a persistent rule property.",
      ),
    new_position: z.number().int().min(0).max(10_000).optional(),
    apply_to_existing_transactions: z
      .boolean()
      .optional()
      .describe(
        "For create/update only: set true to apply the reviewed rule to matching existing transactions. This is a TOP-LEVEL preview argument, alongside kind and rule.",
      ),
    apply_to_historical: z
      .boolean()
      .optional()
      .describe("Compatibility alias for apply_to_existing_transactions."),
    applyToExistingTransactions: z
      .boolean()
      .optional()
      .describe("Compatibility alias for apply_to_existing_transactions."),
  })
  .passthrough();
export const applyRuleInput = z
  .object({ preview_id: z.string().uuid() })
  .strict();

export const APPROVED_TOOL_NAMES = [
  "get_monarch_connection_status",
  "connect_monarch",
  "list_accounts",
  "search_transactions",
  "get_transaction",
  "summarize_transactions",
  "list_categories",
  "list_tags",
  "list_classification_rules",
  "preview_classification_rule_change",
  "apply_classification_rule_change",
] as const;
