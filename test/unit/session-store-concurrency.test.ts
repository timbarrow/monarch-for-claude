import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/auth/session-store.js";

describe("SessionStore concurrency", () => {
  it("never exposes a half-written file to concurrent readers", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "monarch-race-"));
    // A slow cipher widens the window in which a torn read used to happen.
    const cipher = {
      encrypt: async (value: Buffer) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return Buffer.from(`c:${value.toString("base64")}`);
      },
      decrypt: async (value: Buffer) => {
        const text = value.toString();
        if (!text.startsWith("c:") || text.length < 10)
          throw new Error("DPAPI_FAILED");
        return Buffer.from(text.slice(2), "base64");
      },
    };
    const store = new SessionStore(cipher, directory);
    await store.save({
      cookie: "synthetic-0",
      capturedAt: "2026-01-01T00:00:00Z",
    });
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, index) =>
        store.save({
          cookie: `synthetic-${index}`,
          capturedAt: "2026-01-01T00:00:00Z",
        }),
      ),
      ...Array.from({ length: 10 }, () => store.load()),
    ]);
    expect(
      results.filter((value) => value !== undefined).length,
    ).toBeGreaterThan(0);
    expect(await store.load()).toMatchObject({ cookie: expect.any(String) });
    await fs.rm(directory, { recursive: true, force: true });
  });
});
