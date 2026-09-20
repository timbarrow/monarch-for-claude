import crypto from "node:crypto";
import { PREVIEW_TTL_MS } from "../config.js";
import type { PreviewChange } from "./schema.js";

export interface StoredPreview {
  preview_id: string;
  change: PreviewChange;
  state_fingerprint: string;
  created_at: number;
  used: boolean;
}
export class PreviewStore {
  private readonly values = new Map<string, StoredPreview>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PREVIEW_TTL_MS,
  ) {}
  create(change: PreviewChange, stateFingerprint: string): StoredPreview {
    this.sweep();
    const preview: StoredPreview = {
      preview_id: crypto.randomUUID(),
      change,
      state_fingerprint: stateFingerprint,
      created_at: this.now(),
      used: false,
    };
    this.values.set(preview.preview_id, preview);
    return preview;
  }
  consume(id: string): StoredPreview {
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
