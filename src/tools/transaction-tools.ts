import crypto from "node:crypto";
import type { MonarchClient } from "../monarch/client.js";
import type { Transaction } from "../monarch/types.js";
import type { Confirmation } from "../rules/confirmation.js";
import { TransactionPreviewStore } from "../transactions/preview-store.js";
import { previewTransactionUpdateInput } from "./contracts.js";
import type { ReadService } from "./read-tools.js";

function fingerprint(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function assertMutationSuccess(result: unknown, field: string): void {
  const payload =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)[field]
      : undefined;
  if (!payload || typeof payload !== "object")
    throw new Error("MUTATION_RESPONSE_INVALID");
  const errors = (payload as Record<string, unknown>).errors;
  if (errors && (!Array.isArray(errors) || errors.length > 0))
    throw new Error("TRANSACTION_MUTATION_REJECTED");
}

function ids(values: { id: string }[]): string[] {
  return values.map((value) => value.id).sort();
}

export class TransactionService {
  private applying = false;
  constructor(
    private readonly read: ReadService,
    private readonly client: MonarchClient,
    private readonly previews: TransactionPreviewStore,
    private readonly confirmation: Confirmation,
  ) {}

  async preview(raw: unknown) {
    const parsed = previewTransactionUpdateInput.parse(raw);
    const before = await this.read.transaction(parsed.transaction_id, true);
    const update = { ...parsed, transaction_id: before.id };
    const after: Transaction = structuredClone(before);
    if (update.merchant_name !== undefined)
      after.merchant = update.merchant_name;
    if (update.notes !== undefined) after.notes = update.notes;
    if (update.reviewed !== undefined) after.reviewed = update.reviewed;
    if (update.hidden !== undefined) after.hidden = update.hidden;
    if (update.category_id !== undefined) {
      const category = (await this.read.categories()).find(
        (item) => item.id === update.category_id,
      );
      if (!category) throw new Error("UNKNOWN_CATEGORY_ID");
      after.category = { id: category.id, name: category.name };
    }
    if (update.tag_ids !== undefined) {
      const available = await this.read.tags();
      const byId = new Map(available.map((tag) => [tag.id, tag]));
      after.tags = update.tag_ids.map((id) => {
        const tag = byId.get(id);
        if (!tag) throw new Error("UNKNOWN_TAG_ID");
        return tag;
      });
    }
    const stored = this.previews.create(
      update,
      fingerprint(before),
      before,
      after,
    );
    return {
      preview_id: stored.preview_id,
      expires_in_seconds: 600,
      before,
      after,
      transaction_deleted: false,
    };
  }

  async apply(previewId: string) {
    if (this.applying) throw new Error("TRANSACTION_UPDATE_IN_PROGRESS");
    this.applying = true;
    try {
      const preview = this.previews.consume(previewId);
      const current = await this.read.transaction(
        preview.update.transaction_id,
        true,
      );
      if (fingerprint(current) !== preview.before_fingerprint)
        throw new Error("PREVIEW_STALE");
      const confirmed = await this.confirmation.confirm({
        kind: "update_transaction",
        before: preview.before,
        after: preview.after,
      });
      if (!confirmed) throw new Error("USER_CONFIRMATION_CANCELLED");
      const immediatelyBeforeMutation = await this.read.transaction(
        preview.update.transaction_id,
        true,
      );
      if (fingerprint(immediatelyBeforeMutation) !== preview.before_fingerprint)
        throw new Error("PREVIEW_STALE");

      const update = preview.update;
      if (update.tag_ids !== undefined) {
        const result = await this.client.mutate("Web_SetTransactionTags", {
          input: {
            transactionId: update.transaction_id,
            tagIds: update.tag_ids,
          },
        });
        assertMutationSuccess(result, "setTransactionTags");
      } else {
        const result = await this.client.mutate(
          "Web_TransactionDrawerUpdateTransaction",
          {
            input: {
              id: update.transaction_id,
              ...(update.merchant_name !== undefined
                ? { name: update.merchant_name }
                : {}),
              ...(update.category_id !== undefined
                ? { category: update.category_id }
                : {}),
              ...(update.notes !== undefined ? { notes: update.notes } : {}),
              ...(update.reviewed !== undefined
                ? { needsReview: !update.reviewed }
                : {}),
              ...(update.hidden !== undefined
                ? { hideFromReports: update.hidden }
                : {}),
            },
          },
        );
        assertMutationSuccess(result, "updateTransaction");
      }

      const observed = await this.read.transaction(update.transaction_id, true);
      if (
        (update.merchant_name !== undefined &&
          observed.merchant !== update.merchant_name) ||
        (update.category_id !== undefined &&
          observed.category?.id !== update.category_id) ||
        (update.notes !== undefined && observed.notes !== update.notes) ||
        (update.reviewed !== undefined &&
          observed.reviewed !== update.reviewed) ||
        (update.hidden !== undefined && observed.hidden !== update.hidden) ||
        (update.tag_ids !== undefined &&
          JSON.stringify(ids(observed.tags)) !==
            JSON.stringify([...update.tag_ids].sort()))
      )
        throw new Error("READ_BACK_VERIFICATION_FAILED");
      return { applied: true, transaction: observed };
    } finally {
      this.applying = false;
    }
  }
}
