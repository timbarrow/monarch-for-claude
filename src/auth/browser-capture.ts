import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import {
  AUTH_CAPTURE_TTL_MS,
  MONARCH_GRAPHQL_URL,
  MONARCH_ORIGIN,
} from "../config.js";
import { diagnostic } from "../logging.js";
import { locateBrowser } from "./browser-locator.js";
import type { MonarchSession } from "./types.js";

export interface DevToolsTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}
interface CdpEvent {
  id?: number;
  method?: string;
  params?: {
    requestId?: string;
    request?: { url?: string; headers?: Record<string, string> };
    headers?: Record<string, string>;
    response?: { url?: string; status?: number };
  };
  result?: { body?: string; base64Encoded?: boolean };
}

function randomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === "string")
        reject(new Error("BROWSER_CAPTURE_FAILED"));
      else resolve(address.port);
    });
  });
}

export async function fetchTargets(port: number): Promise<DevToolsTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error("BROWSER_CAPTURE_FAILED");
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("BROWSER_CAPTURE_FAILED");
  return body as DevToolsTarget[];
}

/** Never attach to /json/version: its browser websocket does not observe page Network events. */
export function selectMonarchPageTarget(
  targets: DevToolsTarget[],
): DevToolsTarget | undefined {
  return targets.find(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      target.url.startsWith(MONARCH_ORIGIN) &&
      typeof target.webSocketDebuggerUrl === "string",
  );
}

export function isSuccessfulGraphqlResponse(
  body: string,
  base64Encoded = false,
): boolean {
  try {
    const text = base64Encoded
      ? Buffer.from(body, "base64").toString("utf8")
      : body;
    const parsed: unknown = JSON.parse(text);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      !(
        "errors" in parsed &&
        Array.isArray((parsed as { errors?: unknown }).errors) &&
        (parsed as { errors: unknown[] }).errors.length > 0
      ) &&
      "data" in parsed &&
      (parsed as { data?: unknown }).data !== null
    );
  } catch {
    return false;
  }
}

export function sessionFromHeaders(
  headers: Record<string, string>,
): MonarchSession | undefined {
  const values = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const cookie = values.cookie;
  const authorization = values.authorization;
  const csrfToken = values["x-csrf-token"];
  if (!cookie && !authorization) return undefined;
  return {
    cookie,
    authorization,
    csrfToken,
    clientPlatform: values["client-platform"],
    deviceUuid: values["device-uuid"],
    cioClientPlatform: values["x-cio-client-platform"],
    capturedAt: new Date().toISOString(),
  };
}

/** Captures only auth headers from a temporary, dedicated Monarch page target. */
export class BrowserCapture {
  private active = false;
  constructor(
    private readonly findBrowser = locateBrowser,
    private readonly launch: typeof spawn = spawn,
    private readonly getTargets = fetchTargets,
    private readonly ttlMs = AUTH_CAPTURE_TTL_MS,
  ) {}

  async begin(
    onSession: (session: MonarchSession) => Promise<void>,
    onFailure?: (code: string) => void,
  ): Promise<string> {
    if (this.active) return "AUTHENTICATION_ALREADY_IN_PROGRESS";
    const browser = this.findBrowser();
    if (!browser) return "BROWSER_NOT_FOUND";
    this.active = true;
    let profile: string | undefined;
    try {
      const port = await randomPort();
      profile = await fs.mkdtemp(path.join(os.tmpdir(), "monarch-for-claude-"));
      const child = this.launch(
        browser,
        [
          "--remote-debugging-address=127.0.0.1",
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${profile}`,
          "--no-first-run",
          "--no-default-browser-check",
          MONARCH_ORIGIN,
        ],
        { detached: false, stdio: "ignore", windowsHide: false },
      );
      void this.capture(port, child, profile, onSession, onFailure);
      return "BROWSER_OPENED_SIGN_IN_DIRECTLY";
    } catch {
      this.active = false;
      if (profile)
        await fs
          .rm(profile, { recursive: true, force: true })
          .catch(() => undefined);
      throw new Error("BROWSER_CAPTURE_FAILED");
    }
  }

  private async capture(
    port: number,
    child: ChildProcess,
    profile: string,
    onSession: (session: MonarchSession) => Promise<void>,
    onFailure?: (code: string) => void,
  ): Promise<void> {
    let socket: WebSocket | undefined;
    let childFailed = false;
    child.once("error", () => {
      childFailed = true;
    });
    const cleanup = async () => {
      this.active = false;
      socket?.terminate();
      if (!child.killed) child.kill();
      await fs
        .rm(profile, { recursive: true, force: true })
        .catch(() => undefined);
    };
    try {
      const deadline = Date.now() + this.ttlMs;
      let target: DevToolsTarget | undefined;
      while (Date.now() < deadline && !target) {
        if (childFailed) throw new Error("BROWSER_CAPTURE_FAILED");
        try {
          target = selectMonarchPageTarget(await this.getTargets(port));
        } catch {
          // The DevTools endpoint commonly rejects requests while starting.
        }
        if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!target?.webSocketDebuggerUrl)
        throw new Error("BROWSER_CAPTURE_TIMEOUT");
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
      });
      socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
      await new Promise<void>((resolve, reject) => {
        const requestUrls = new Map<string, string>();
        const requestHeaders = new Map<string, Record<string, string>>();
        const successfulResponses = new Set<string>();
        let nextCommandId = 2;
        const responseBodyRequests = new Map<number, string>();
        const responseBodies = new Map<
          string,
          { body: string; base64Encoded: boolean }
        >();
        const lastSessionAttempts = new Map<string, number>();
        let captured = false;
        let lastVerificationFailure: string | undefined;
        const timer = setTimeout(
          () => {
            reject(
              new Error(lastVerificationFailure ?? "BROWSER_CAPTURE_TIMEOUT"),
            );
          },
          Math.max(1, deadline - Date.now()),
        );
        const completeIfVerified = async (
          requestId: string,
          body: string,
          base64Encoded: boolean,
        ) => {
          if (
            captured ||
            !successfulResponses.has(requestId) ||
            requestUrls.get(requestId) !== MONARCH_GRAPHQL_URL
          )
            return;
          const headers = requestHeaders.get(requestId);
          if (!headers || !isSuccessfulGraphqlResponse(body, base64Encoded))
            return;
          const session = sessionFromHeaders(headers);
          if (!session) return;
          const sessionFingerprint = crypto
            .createHash("sha256")
            .update(
              JSON.stringify([
                session.cookie,
                session.authorization,
                session.csrfToken,
                session.clientPlatform,
                session.deviceUuid,
                session.cioClientPlatform,
              ]),
            )
            .digest("hex");
          const lastAttempt = lastSessionAttempts.get(sessionFingerprint);
          if (lastAttempt !== undefined && Date.now() - lastAttempt < 5_000)
            return;
          lastSessionAttempts.set(sessionFingerprint, Date.now());
          responseBodies.delete(requestId);
          try {
            await onSession(session);
            captured = true;
            clearTimeout(timer);
            resolve();
          } catch (error) {
            // Login and MFA can produce successful public GraphQL traffic
            // before the final authenticated cookie/token is installed. Keep
            // watching for a changed session instead of closing the browser.
            lastVerificationFailure =
              error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "AUTH_VERIFICATION_FAILED";
          }
        };
        socket?.once("close", () => {
          reject(
            new Error(lastVerificationFailure ?? "BROWSER_CAPTURE_CLOSED"),
          );
        });
        socket?.on("message", async (data) => {
          const event = JSON.parse(data.toString()) as CdpEvent;
          const params = event.params;
          const requestId = params?.requestId;
          if (event.method === "Network.requestWillBeSent" && requestId) {
            const url = params?.request?.url;
            if (url) requestUrls.set(requestId, url);
            if (params?.request?.headers)
              requestHeaders.set(requestId, {
                ...requestHeaders.get(requestId),
                ...params.request.headers,
              });
            const storedBody = responseBodies.get(requestId);
            if (storedBody)
              await completeIfVerified(
                requestId,
                storedBody.body,
                storedBody.base64Encoded,
              );
          }
          if (
            event.method === "Network.requestWillBeSentExtraInfo" &&
            requestId &&
            params?.headers
          )
            requestHeaders.set(requestId, {
              ...requestHeaders.get(requestId),
              ...params.headers,
            });
          if (
            event.method === "Network.requestWillBeSentExtraInfo" &&
            requestId
          ) {
            const storedBody = responseBodies.get(requestId);
            if (storedBody)
              await completeIfVerified(
                requestId,
                storedBody.body,
                storedBody.base64Encoded,
              );
          }
          if (
            event.method === "Network.responseReceived" &&
            requestId &&
            params?.response?.url === MONARCH_GRAPHQL_URL &&
            params.response.status === 200
          )
            successfulResponses.add(requestId);
          if (
            event.method === "Network.loadingFinished" &&
            requestId &&
            successfulResponses.has(requestId) &&
            requestUrls.get(requestId) === MONARCH_GRAPHQL_URL
          ) {
            const commandId = nextCommandId++;
            responseBodyRequests.set(commandId, requestId);
            socket?.send(
              JSON.stringify({
                id: commandId,
                method: "Network.getResponseBody",
                params: { requestId },
              }),
            );
          }
          const responseBodyRequestId =
            event.id === undefined
              ? undefined
              : responseBodyRequests.get(event.id);
          if (responseBodyRequestId && event.result?.body !== undefined) {
            if (event.id !== undefined) responseBodyRequests.delete(event.id);
            const responseBody = {
              body: event.result.body,
              base64Encoded: event.result.base64Encoded === true,
            };
            responseBodies.set(responseBodyRequestId, responseBody);
            await completeIfVerified(
              responseBodyRequestId,
              responseBody.body,
              responseBody.base64Encoded,
            );
          }
        });
      });
    } catch (error) {
      const code =
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "BROWSER_CAPTURE_FAILED";
      diagnostic(code);
      onFailure?.(code);
    } finally {
      await cleanup();
    }
  }
}
