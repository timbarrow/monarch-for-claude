import crypto from "node:crypto";
import { PREVIEW_TTL_MS } from "../config.js";
import {
  previewChangeSchema,
  type PreviewChange,
  type PreviewChangeInput,
} from "./schema.js";

export interface StoredPreview {
  preview_id: string;
  change: PreviewChange;
  state_fingerprint: string;
  historical_match_count: number;
  created_at: number;
  used: boolean;
}
export class PreviewStore {
  private readonly values = new Map<string, StoredPreview>();
  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = PREVIEW_TTL_MS,
  ) {}
  create(
    change: PreviewChangeInput,
    stateFingerprint: string,
    historicalMatchCount = 0,
  ): StoredPreview {
    this.sweep();
    const preview: StoredPreview = {
      preview_id: crypto.randomUUID(),
      change: previewChangeSchema.parse(change),
      state_fingerprint: stateFingerprint,
      historical_match_count: historicalMatchCount,
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
