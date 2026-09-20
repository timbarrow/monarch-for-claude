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
import { authenticationLog, diagnostic } from "../logging.js";
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
  result?: {
    cookies?: CdpCookie[];
    body?: string;
    base64Encoded?: boolean;
  };
}
export interface CdpCookie {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
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

export function isMonarchGraphqlUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.monarch.com" &&
      (url.pathname === "/graphql" || url.pathname === "/graphql/")
    );
  } catch {
    return false;
  }
}

export function isMonarchLoginUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "api.monarch.com" &&
      (url.pathname === "/auth/login" || url.pathname === "/auth/login/")
    );
  } catch {
    return false;
  }
}

export function tokenFromLoginResponse(
  body: string,
  base64Encoded = false,
): string | undefined {
  try {
    const text = base64Encoded
      ? Buffer.from(body, "base64").toString("utf8")
      : body;
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const token = (parsed as { token?: unknown }).token;
    return typeof token === "string" &&
      token.length > 0 &&
      token.length <= 10_000
      ? token
      : undefined;
  } catch {
    return undefined;
  }
}

export function cookieHeaderForMonarchApi(
  cookies: CdpCookie[],
): string | undefined {
  const apiHost = "api.monarch.com";
  const apiPath = "/graphql";
  const applicable = cookies
    .filter((cookie) => {
      const domain = cookie.domain?.replace(/^\./, "").toLowerCase();
      const cookiePath = cookie.path ?? "/";
      return (
        !!cookie.name &&
        cookie.value !== undefined &&
        !!domain &&
        (apiHost === domain || apiHost.endsWith(`.${domain}`)) &&
        apiPath.startsWith(cookiePath) &&
        /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name) &&
        !/[;\r\n]/.test(cookie.value)
      );
    })
    .sort((a, b) => (b.path?.length ?? 1) - (a.path?.length ?? 1));
  return applicable.length
    ? applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ")
    : undefined;
}

function cookieValue(header: string, name: string): string | undefined {
  const prefix = `${name}=`;
  const pair = header
    .split("; ")
    .find((candidate) => candidate.startsWith(prefix));
  return pair?.slice(prefix.length);
}

export function sessionFromHeaders(
  headers: Record<string, string>,
): MonarchSession | undefined {
  const values = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const cookie = values.cookie;
  const authorization = values.authorization;
  const csrfToken = values["x-csrftoken"] ?? values["x-csrf-token"];
  if (!cookie && !authorization) return undefined;
  return {
    cookie,
    authorization,
    csrfToken,
    clientPlatform: values["client-platform"],
    deviceUuid: values["device-uuid"],
    cioClientPlatform: values["x-cio-client-platform"],
    monarchClient: values["monarch-client"],
    monarchClientVersion: values["monarch-client-version"],
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
    onProgress?: (code: string) => void,
  ): Promise<string> {
    if (this.active) return "AUTHENTICATION_ALREADY_IN_PROGRESS";
    const browser = this.findBrowser();
    if (!browser) return "BROWSER_NOT_FOUND";
    this.active = true;
    authenticationLog("AUTH_CAPTURE_STARTED");
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
      void this.capture(port, child, profile, onSession, onFailure, onProgress);
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
    onProgress?: (code: string) => void,
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
      onProgress?.("BROWSER_TARGET_ATTACHED");
      authenticationLog("BROWSER_TARGET_ATTACHED");
      await new Promise<void>((resolve, reject) => {
        const requestUrls = new Map<string, string>();
        const requestHeaders = new Map<string, Record<string, string>>();
        const successfulResponses = new Set<string>();
        const cookieRequests = new Map<number, string>();
        const pendingCookieRequests = new Set<string>();
        const successfulLoginResponses = new Set<string>();
        const loginBodyRequests = new Map<number, string>();
        const lastSessionAttempts = new Map<string, number>();
        let nextCommandId = 2;
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
        const verifySession = async (session: MonarchSession) => {
          if (captured) return;
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
                session.monarchClient,
                session.monarchClientVersion,
              ]),
            )
            .digest("hex");
          const lastAttempt = lastSessionAttempts.get(sessionFingerprint);
          if (lastAttempt !== undefined && Date.now() - lastAttempt < 5_000)
            return;
          lastSessionAttempts.set(sessionFingerprint, Date.now());
          onProgress?.("SESSION_CANDIDATE_SEEN");
          authenticationLog("SESSION_CANDIDATE_SEEN", {
            authorization_present: !!session.authorization,
            cookie_present: !!session.cookie,
            csrf_present: !!session.csrfToken,
            device_uuid_present: !!session.deviceUuid,
            monarch_client_present: !!session.monarchClient,
          });
          try {
            await onSession(session);
            captured = true;
            clearTimeout(timer);
            authenticationLog("AUTH_CAPTURE_VERIFIED");
            resolve();
          } catch (error) {
            // Login and MFA can produce successful public GraphQL traffic
            // before the final authenticated cookie/token is installed. Keep
            // watching for a changed session instead of closing the browser.
            lastVerificationFailure =
              error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
                ? error.message
                : "AUTH_VERIFICATION_FAILED";
            onProgress?.("AUTH_VERIFICATION_RETRYING");
            authenticationLog("AUTH_VERIFICATION_RETRYING", {
              code: lastVerificationFailure,
            });
          }
        };
        const completeIfVerified = async (requestId: string) => {
          if (
            captured ||
            !successfulResponses.has(requestId) ||
            !isMonarchGraphqlUrl(requestUrls.get(requestId))
          )
            return;
          const headers = requestHeaders.get(requestId);
          if (!headers) return;
          const session = sessionFromHeaders(headers);
          if (session) await verifySession(session);
        };
        const requestApplicableCookies = (requestId: string) => {
          if (captured || pendingCookieRequests.has(requestId)) return;
          const commandId = nextCommandId++;
          pendingCookieRequests.add(requestId);
          cookieRequests.set(commandId, requestId);
          socket?.send(
            JSON.stringify({
              id: commandId,
              method: "Network.getCookies",
              params: { urls: [MONARCH_GRAPHQL_URL, MONARCH_ORIGIN] },
            }),
          );
        };
        socket?.once("close", () => {
          reject(
            new Error(lastVerificationFailure ?? "BROWSER_CAPTURE_CLOSED"),
          );
        });
        socket?.on("message", async (data) => {
          const event = JSON.parse(data.toString()) as CdpEvent;
          const cookieRequestId =
            event.id === undefined ? undefined : cookieRequests.get(event.id);
          if (cookieRequestId) {
            cookieRequests.delete(event.id as number);
            pendingCookieRequests.delete(cookieRequestId);
            const cookie = cookieHeaderForMonarchApi(
              event.result?.cookies ?? [],
            );
            if (cookie) {
              const csrfToken = cookieValue(cookie, "csrftoken");
              const deviceUuid = cookieValue(cookie, "monarchDeviceUUID");
              requestHeaders.set(cookieRequestId, {
                ...requestHeaders.get(cookieRequestId),
                cookie,
                ...(csrfToken ? { "x-csrftoken": csrfToken } : {}),
                ...(deviceUuid ? { "device-uuid": deviceUuid } : {}),
              });
              onProgress?.("MONARCH_COOKIES_READ");
              authenticationLog("MONARCH_COOKIES_READ", {
                cookie_names: (event.result?.cookies ?? [])
                  .map((item) => item.name)
                  .filter((name): name is string => !!name)
                  .sort()
                  .join(","),
              });
              await completeIfVerified(cookieRequestId);
            } else {
              onProgress?.("MONARCH_COOKIES_EMPTY");
              authenticationLog("MONARCH_COOKIES_EMPTY");
            }
          }
          const loginRequestId =
            event.id === undefined
              ? undefined
              : loginBodyRequests.get(event.id);
          if (loginRequestId && event.result?.body !== undefined) {
            loginBodyRequests.delete(event.id as number);
            const token = tokenFromLoginResponse(
              event.result.body,
              event.result.base64Encoded === true,
            );
            if (token) {
              onProgress?.("MONARCH_LOGIN_TOKEN_SEEN");
              authenticationLog("MONARCH_LOGIN_TOKEN_SEEN");
              const headers = requestHeaders.get(loginRequestId) ?? {};
              const session = sessionFromHeaders({
                ...headers,
                authorization: `Token ${token}`,
              });
              if (session) await verifySession(session);
            } else {
              authenticationLog("MONARCH_LOGIN_TOKEN_MISSING");
            }
          }
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
            await completeIfVerified(requestId);
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
          )
            await completeIfVerified(requestId);
          if (
            event.method === "Network.responseReceived" &&
            requestId &&
            isMonarchGraphqlUrl(params?.response?.url) &&
            params?.response?.status === 200
          ) {
            successfulResponses.add(requestId);
            onProgress?.("MONARCH_GRAPHQL_SEEN");
            authenticationLog("MONARCH_GRAPHQL_SEEN", { http_status: 200 });
            await completeIfVerified(requestId);
            requestApplicableCookies(requestId);
          }
          if (
            event.method === "Network.responseReceived" &&
            requestId &&
            isMonarchLoginUrl(params?.response?.url) &&
            params?.response?.status === 200
          ) {
            successfulLoginResponses.add(requestId);
            authenticationLog("MONARCH_LOGIN_RESPONSE_SEEN", {
              http_status: 200,
            });
          }
          if (
            event.method === "Network.loadingFinished" &&
            requestId &&
            successfulLoginResponses.has(requestId)
          ) {
            const commandId = nextCommandId++;
            loginBodyRequests.set(commandId, requestId);
            socket?.send(
              JSON.stringify({
                id: commandId,
                method: "Network.getResponseBody",
                params: { requestId },
              }),
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
      authenticationLog("AUTH_CAPTURE_FAILED", { code });
      onFailure?.(code);
    } finally {
      await cleanup();
    }
  }
}
