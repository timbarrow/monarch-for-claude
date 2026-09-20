import { describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import { MONARCH_GRAPHQL_URL } from "../../src/config.js";
import {
  BrowserCapture,
  isSuccessfulGraphqlResponse,
  selectMonarchPageTarget,
  sessionFromHeaders,
} from "../../src/auth/browser-capture.js";

describe("browser capture guards", () => {
  it("attaches to the Monarch page target, not the browser-level websocket", () => {
    const page = selectMonarchPageTarget([
      {
        type: "browser",
        url: "",
        webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/browser/a",
      },
      {
        type: "page",
        url: "https://app.monarch.com/",
        webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/page/b",
      },
    ]);
    expect(page?.webSocketDebuggerUrl).toContain("/page/");
  });
  it("uses the API GraphQL host and only accepts successful GraphQL response bodies", () => {
    expect(MONARCH_GRAPHQL_URL).toBe("https://api.monarch.com/graphql");
    expect(isSuccessfulGraphqlResponse('{"data":{"accounts":[]}}')).toBe(true);
    expect(isSuccessfulGraphqlResponse('{"errors":[{"message":"no"}]}')).toBe(
      false,
    );
    expect(isSuccessfulGraphqlResponse("not json")).toBe(false);
  });
  it("supports cookie or token sessions and captures only approved replay headers", () => {
    expect(sessionFromHeaders({ Cookie: "session=synthetic" })).toMatchObject({
      cookie: "session=synthetic",
    });
    expect(sessionFromHeaders({ "Client-Platform": "web" })).toBeUndefined();
    expect(
      sessionFromHeaders({
        Authorization: "Token synthetic",
        Cookie: "session=synthetic",
        "Client-Platform": "web",
        "Device-Uuid": "device_1",
        "X-Cio-Client-Platform": "web",
        "X-Unapproved-Secret": "do-not-store",
      }),
    ).toMatchObject({
      authorization: "Token synthetic",
      cookie: "session=synthetic",
      clientPlatform: "web",
      deviceUuid: "device_1",
      cioClientPlatform: "web",
    });
    expect(
      JSON.stringify(
        sessionFromHeaders({
          Authorization: "Token synthetic",
          "X-Unapproved-Secret": "do-not-store",
        }),
      ),
    ).not.toContain("do-not-store");
  });
  it("clears the in-progress guard when browser launch setup fails", async () => {
    const launch = vi.fn(() => {
      throw new Error("synthetic launch failure");
    }) as unknown as typeof spawn;
    const capture = new BrowserCapture(() => "synthetic-browser.exe", launch);
    await expect(capture.begin(async () => undefined)).rejects.toThrow(
      "BROWSER_CAPTURE_FAILED",
    );
    await expect(capture.begin(async () => undefined)).rejects.toThrow(
      "BROWSER_CAPTURE_FAILED",
    );
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
