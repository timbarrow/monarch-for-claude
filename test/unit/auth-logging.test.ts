import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPowerShellError } from "../../src/auth/dpapi.js";
import {
  cookieMetadata,
  headerNamesOf,
  safeUrlParts,
} from "../../src/auth/browser-capture.js";
import { SERVER_VERSION } from "../../src/config.js";
import { authenticationLog, authenticationTrace } from "../../src/logging.js";

afterEach(() => vi.unstubAllEnvs());

describe("authentication diagnostics", () => {
  it("logs cookie scope and flags but never cookie values", () => {
    const metadata = cookieMetadata([
      {
        name: "session_id",
        value: "synthetic-secret-value",
        domain: ".monarch.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
      { name: "bad name", value: "x", domain: "example.com", path: "/" },
    ]);
    expect(JSON.stringify(metadata)).not.toContain("synthetic-secret-value");
    expect(metadata[0]).toEqual({
      name: "session_id",
      domain: ".monarch.com",
      path: "/",
      secure: true,
      http_only: true,
      same_site: "Lax",
      sent_to_api: true,
    });
    expect(metadata[1]).toMatchObject({ name: "invalid", sent_to_api: false });
  });

  it("logs header names only", () => {
    expect(
      headerNamesOf({
        Authorization: "Token synthetic-secret",
        Cookie: "a=synthetic-secret",
        "X-CSRFToken": "synthetic-secret",
      }),
    ).toBe("authorization,cookie,x-csrftoken");
  });

  it("keeps only host and path from URLs", () => {
    expect(
      safeUrlParts("https://api.monarch.com/graphql?token=synthetic#frag"),
    ).toEqual({ host: "api.monarch.com", path: "/graphql" });
    expect(safeUrlParts("not a url")).toEqual({
      host: "unparseable",
      path: "unparseable",
    });
  });

  it("classifies PowerShell errors without echoing them", () => {
    expect(
      classifyPowerShellError("Unable to find type [Security.Cryptography.X]"),
    ).toBe("TYPE_NOT_FOUND");
    expect(classifyPowerShellError("")).toBe("NO_STDERR");
    expect(classifyPowerShellError("synthetic-secret???")).toBe("UNCLASSIFIED");
  });

  it("writes versioned entries to a rotating file and never the secrets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "monarch-log-"));
    vi.stubEnv("LOCALAPPDATA", root);
    authenticationLog("TEST_FILE_ENTRY", {
      cookie: "synthetic-secret",
      http_status: 200,
    });
    const file = path.join(
      root,
      "MonarchForClaude",
      "logs",
      "authentication.log",
    );
    await vi.waitFor(async () => {
      expect((await fs.stat(file)).size).toBeGreaterThan(0);
    });
    const text = await fs.readFile(file, "utf8");
    expect(text).toContain(`"version":"${SERVER_VERSION}"`);
    expect(text).toContain("TEST_FILE_ENTRY");
    expect(text).not.toContain("synthetic-secret");
    expect(authenticationTrace().at(-1)).toMatchObject({
      event: "TEST_FILE_ENTRY",
    });
    await fs.rm(root, { recursive: true, force: true });
  });
});
