import { describe, expect, it } from "vitest";
import type { BrowserCapture } from "../../src/auth/browser-capture.js";
import type { SessionStore } from "../../src/auth/session-store.js";
import type { MonarchClient } from "../../src/monarch/client.js";
import { AuthService } from "../../src/tools/auth-tools.js";

describe("AuthService diagnostics", () => {
  it("reports a safe asynchronous verification failure", async () => {
    const store = {
      load: async () => undefined,
    } as SessionStore;
    const capture = {
      begin: async (
        _onSession: unknown,
        onFailure?: (code: string) => void,
      ) => {
        onFailure?.("AUTH_VERIFICATION_FAILED");
        return "BROWSER_OPENED_SIGN_IN_DIRECTLY";
      },
    } as BrowserCapture;
    const auth = new AuthService(store, capture, {} as MonarchClient);

    await auth.connect();

    await expect(auth.status()).resolves.toMatchObject({
      connected: false,
      diagnostic_code: "AUTH_VERIFICATION_FAILED",
    });
  });
});
