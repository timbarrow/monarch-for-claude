import crypto from "node:crypto";
import { PREVIEW_TTL_MS } from "../config.js";
import type { Transaction } from "../monarch/types.js";
import type { z } from "zod";
import type { previewTransactionUpdateInput } from "../tools/contracts.js";

export type TransactionUpdate = z.infer<typeof previewTransactionUpdateInput>;

export interface StoredTransactionPreview {
  preview_id: string;
  update: TransactionUpdate;
  before_fingerprint: string;
  before: Transaction;
  after: Transaction;
  created_at: number;
  used: boolean;
}

export class TransactionPreviewStore {
  private readonly values = new Map<string, StoredTransactionPreview>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PREVIEW_TTL_MS,
  ) {}
  create(
    update: TransactionUpdate,
    beforeFingerprint: string,
    before: Transaction,
    after: Transaction,
  ): StoredTransactionPreview {
    this.sweep();
    const preview = {
      preview_id: crypto.randomUUID(),
      update,
      before_fingerprint: beforeFingerprint,
      before,
      after,
      created_at: this.now(),
      used: false,
    };
    this.values.set(preview.preview_id, preview);
    return preview;
  }
  consume(id: string): StoredTransactionPreview {
    const item = this.values.get(id);
    if (!item || item.used || this.now() - item.created_at > this.ttlMs) {
      this.values.delete(id);
      throw new Error("PREVIEW_INVALID_OR_EXPIRED");
    }
    item.used = true;
    return item;
  }
  private sweep(): void {
    for (const [id, value] of this.values)
      if (value.used || this.now() - value.created_at > this.ttlMs)
        this.values.delete(id);
  }
}
