import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../../src/auth/session-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
describe("SessionStore", () => {
  it("stores only encrypted bytes through its cipher boundary", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "monarch-test-"));
    directories.push(directory);
    const cipher = {
      encrypt: async (value: Buffer) =>
        Buffer.from(`cipher:${value.toString("base64")}`),
      decrypt: async (value: Buffer) =>
        Buffer.from(value.toString().slice(7), "base64"),
    };
    const store = new SessionStore(cipher, directory);
    await store.save({
      cookie: "synthetic-secret",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await fs.readFile(store.file, "utf8")).not.toContain(
      "synthetic-secret",
    );
    expect(await store.load()).toEqual({
      cookie: "synthetic-secret",
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
