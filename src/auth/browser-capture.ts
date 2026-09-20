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
import { authenticationLog, diagnostic, safeErrorCode } from "../logging.js";
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
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
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

const SAFE_TOKEN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~:/]+$/;

/** URL host and path only; query strings and fragments can carry secrets. */
export function safeUrlParts(value: string | undefined): {
  host: string;
  path: string;
} {
  if (!value) return { host: "unknown", path: "unknown" };
  try {
    const url = new URL(value);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return { host: "unparseable", path: "unparseable" };
  }
}

/** Header names only, lowercased and sorted; values are never read. */
export function headerNamesOf(
  headers: Record<string, string> | undefined,
): string {
  return Object.keys(headers ?? {})
    .map((name) => name.toLowerCase())
    .filter((name) => SAFE_TOKEN.test(name))
    .sort()
    .join(",");
}

/** Cookie name, scope and flags only; the value is never copied. */
export function cookieMetadata(
  cookies: CdpCookie[],
): Array<Record<string, string | boolean>> {
  return cookies.map((cookie) => ({
    name: cookie.name && SAFE_TOKEN.test(cookie.name) ? cookie.name : "invalid",
    domain:
      cookie.domain && SAFE_TOKEN.test(cookie.domain)
        ? cookie.domain
        : "invalid",
    path: cookie.path && SAFE_TOKEN.test(cookie.path) ? cookie.path : "invalid",
    secure: cookie.secure === true,
    http_only: cookie.httpOnly === true,
    same_site:
      cookie.sameSite && SAFE_TOKEN.test(cookie.sameSite)
        ? cookie.sameSite
        : "unset",
    sent_to_api: cookieHeaderForMonarchApi([cookie]) !== undefined,
  }));
}

function browserKind(executable: string): string {
  const name = executable.split(/[\\/]/).pop()?.toLowerCase();
  if (name === "msedge.exe") return "edge";
  if (name === "chrome.exe") return "chrome";
  return "other";
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
    if (!browser) {
      authenticationLog("BROWSER_NOT_FOUND");
      return "BROWSER_NOT_FOUND";
    }
    this.active = true;
    authenticationLog("AUTH_CAPTURE_STARTED", {
      browser: browserKind(browser),
      ttl_ms: this.ttlMs,
      node_version: process.versions.node,
      platform: process.platform,
    });
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
      authenticationLog("BROWSER_LAUNCHED", { debug_port: port });
      void this.capture(port, child, profile, onSession, onFailure, onProgress);
      return "BROWSER_OPENED_SIGN_IN_DIRECTLY";
    } catch (error) {
      authenticationLog("BROWSER_LAUNCH_FAILED", {
        code: safeErrorCode(error),
      });
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
    let endReason = "SESSION_VERIFIED";
    child.once("error", (error) => {
      childFailed = true;
      authenticationLog("BROWSER_PROCESS_ERROR", {
        code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
      });
    });
    child.once("exit", (code, signal) => {
      authenticationLog("BROWSER_PROCESS_EXITED", {
        exit_code: code,
        signal: signal ?? null,
      });
    });
    const cleanup = async () => {
      this.active = false;
      const browserStillRunning = !child.killed;
      socket?.terminate();
      if (!child.killed) child.kill();
      if (process.platform === "win32" && child.pid !== undefined) {
        // Chromium runs helper processes that keep the profile files locked.
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill",
            ["/PID", String(child.pid), "/T", "/F"],
            { stdio: "ignore", windowsHide: true },
          );
          killer.once("error", () => resolve());
          killer.once("exit", () => resolve());
        });
      }
      let profileRemoved = true;
      // The profile holds Monarch cookies, so removal is retried while the
      // browser releases its file locks.
      await fs
        .rm(profile, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 300,
        })
        .catch(() => {
          profileRemoved = false;
        });
      authenticationLog("AUTH_CAPTURE_CLEANUP", {
        reason: endReason,
        browser_still_running: browserStillRunning,
        temporary_profile_removed: profileRemoved,
      });
    };
    try {
      const deadline = Date.now() + this.ttlMs;
      let target: DevToolsTarget | undefined;
      const waitStarted = Date.now();
      let targetPollErrors = 0;
      while (Date.now() < deadline && !target) {
        if (childFailed) throw new Error("BROWSER_CAPTURE_FAILED");
        try {
          target = selectMonarchPageTarget(await this.getTargets(port));
        } catch {
          // The DevTools endpoint commonly rejects requests while starting.
          targetPollErrors++;
        }
        if (!target) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!target?.webSocketDebuggerUrl) {
        authenticationLog("DEVTOOLS_TARGET_NOT_FOUND", {
          waited_ms: Date.now() - waitStarted,
          poll_errors: targetPollErrors,
        });
        throw new Error("BROWSER_CAPTURE_TIMEOUT");
      }
      authenticationLog("DEVTOOLS_TARGET_FOUND", {
        waited_ms: Date.now() - waitStarted,
        poll_errors: targetPollErrors,
      });
      socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket?.once("open", resolve);
        socket?.once("error", reject);
      });
      authenticationLog("DEVTOOLS_SOCKET_OPEN");
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
        const loggedCookieSignatures = new Set<string>();
        const logCounts = new Map<string, number>();
        /** Bound repetitive per-request events so one capture stays readable. */
        const logLimited = (
          event: string,
          fields: Record<string, string | number | boolean | null>,
          limit = 20,
        ) => {
          const count = (logCounts.get(event) ?? 0) + 1;
          logCounts.set(event, count);
          if (count <= limit) authenticationLog(event, fields);
        };
        let cookieReadCount = 0;
        let lastCookieNames = "";
        let nextCommandId = 2;
        let captured = false;
        let lastVerificationFailure: string | undefined;
        const timer = setTimeout(
          () => {
            authenticationLog("AUTH_CAPTURE_TIMEOUT", {
              ttl_ms: this.ttlMs,
              last_verification_failure: lastVerificationFailure ?? null,
            });
            reject(
              new Error(lastVerificationFailure ?? "BROWSER_CAPTURE_TIMEOUT"),
            );
          },
          Math.max(1, deadline - Date.now()),
        );
        let verifying = false;
        const verifySession = async (session: MonarchSession) => {
          // Verification saves, reads and may clear the stored session, so it
          // must never overlap. A dropped candidate is retried by later traffic.
          if (captured || verifying) return;
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
          verifying = true;
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
          } finally {
            verifying = false;
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
          authenticationLog("DEVTOOLS_SOCKET_CLOSED", {
            last_verification_failure: lastVerificationFailure ?? null,
          });
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
              const observedCookies = event.result?.cookies ?? [];
              const cookieNames = observedCookies
                .map((item) => item.name)
                .filter((name): name is string => !!name)
                .sort()
                .join(",");
              cookieReadCount++;
              if (cookieReadCount <= 2 || cookieNames !== lastCookieNames) {
                lastCookieNames = cookieNames;
                authenticationLog("MONARCH_COOKIES_READ", {
                  cookie_names: cookieNames,
                  cookie_count: observedCookies.length,
                  read_number: cookieReadCount,
                });
              }
              for (const metadata of cookieMetadata(observedCookies)) {
                const signature = JSON.stringify(metadata);
                if (loggedCookieSignatures.has(signature)) continue;
                loggedCookieSignatures.add(signature);
                authenticationLog("MONARCH_COOKIE_OBSERVED", metadata);
              }
              await completeIfVerified(cookieRequestId);
            } else {
              onProgress?.("MONARCH_COOKIES_EMPTY");
              authenticationLog("MONARCH_COOKIES_EMPTY", {
                cookie_count: (event.result?.cookies ?? []).length,
              });
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
            if (isMonarchGraphqlUrl(url) || isMonarchLoginUrl(url))
              logLimited("MONARCH_REQUEST_SEEN", {
                ...safeUrlParts(url),
                header_names: headerNamesOf(params?.request?.headers),
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
          ) {
            const knownUrl = requestUrls.get(requestId);
            if (isMonarchGraphqlUrl(knownUrl) || isMonarchLoginUrl(knownUrl))
              logLimited("MONARCH_REQUEST_EXTRA_INFO_SEEN", {
                ...safeUrlParts(knownUrl),
                header_names: headerNamesOf(params?.headers),
              });
            await completeIfVerified(requestId);
          }
          if (
            event.method === "Network.responseReceived" &&
            requestId &&
            safeUrlParts(params?.response?.url).host === "api.monarch.com"
          )
            logLimited(
              "MONARCH_API_RESPONSE",
              {
                ...safeUrlParts(params?.response?.url),
                http_status: params?.response?.status ?? null,
              },
              40,
            );
          if (
            event.method === "Network.responseReceived" &&
            requestId &&
            isMonarchGraphqlUrl(params?.response?.url) &&
            params?.response?.status === 200
          ) {
            requestUrls.set(requestId, params.response.url as string);
            successfulResponses.add(requestId);
            onProgress?.("MONARCH_GRAPHQL_SEEN");
            logLimited("MONARCH_GRAPHQL_SEEN", {
              ...safeUrlParts(params.response.url),
              http_status: params.response.status ?? null,
            });
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
              ...safeUrlParts(params?.response?.url),
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
      endReason = code;
      diagnostic(code);
      authenticationLog("AUTH_CAPTURE_FAILED", { code });
      onFailure?.(code);
    } finally {
      await cleanup();
    }
  }
}
