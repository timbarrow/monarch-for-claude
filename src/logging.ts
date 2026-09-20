import fs from "node:fs/promises";
import path from "node:path";
import { localDataDirectory, SERVER_VERSION } from "./config.js";

const SECRET_PATTERN =
  /(?:authorization|cookie|set-cookie|token|password|session|csrf)[=:]\s*(?:Bearer\s+)?[^\s,;]+/gi;

export function redact(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(
    SECRET_PATTERN,
    (match) => `${match.split(/[=:]/, 1)[0]}=[REDACTED]`,
  );
}

export function diagnostic(code: string, detail?: unknown): void {
  const suffix = detail === undefined ? "" : ` ${redact(detail)}`;
  process.stderr.write(`[monarch-for-claude] ${code}${suffix}\n`);
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof Error && /^[A-Z0-9_]+$/.test(error.message))
    return error.message;
  return "UNEXPECTED_ERROR";
}

const AUTH_LOG_MAX_BYTES = 1024 * 1024;
const AUTH_TRACE_MAX_ENTRIES = 150;
let authLogWriteFailureReported = false;
const SAFE_EVENT = /^[A-Z0-9_]+$/;
const FORBIDDEN_FIELD =
  /authorization(?!_present)|cookie(?!_present|_names)|token(?!_present)|password|secret|csrf(?!_present)|session/i;
let authLogQueue = Promise.resolve();
export interface AuthenticationTraceEntry {
  timestamp: string;
  event: string;
  [key: string]: string | number | boolean | null;
}
const authenticationTraceEntries: AuthenticationTraceEntry[] = [];

export function sanitizeAuthenticationFields(
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const safeFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(key)) continue;
    safeFields[key] =
      typeof value === "string"
        ? value.replace(/[\r\n]/g, " ").slice(0, 400)
        : value;
  }
  return safeFields;
}

export function authenticationLog(
  event: string,
  fields: Record<string, string | number | boolean | null> = {},
): void {
  if (!SAFE_EVENT.test(event)) return;
  const safeFields = sanitizeAuthenticationFields(fields);
  const entry: AuthenticationTraceEntry = {
    timestamp: new Date().toISOString(),
    event,
    ...safeFields,
  };
  authenticationTraceEntries.push(entry);
  if (authenticationTraceEntries.length > AUTH_TRACE_MAX_ENTRIES)
    authenticationTraceEntries.splice(
      0,
      authenticationTraceEntries.length - AUTH_TRACE_MAX_ENTRIES,
    );
  authLogQueue = authLogQueue
    .then(async () => {
      const directory = path.join(localDataDirectory(), "logs");
      const file = path.join(directory, "authentication.log");
      await fs.mkdir(directory, { recursive: true });
      try {
        const stat = await fs.stat(file);
        if (stat.size >= AUTH_LOG_MAX_BYTES)
          await fs.rename(file, `${file}.1`).catch(async () => {
            await fs.rm(`${file}.1`, { force: true });
            await fs.rename(file, `${file}.1`);
          });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const fileEntry = { version: SERVER_VERSION, ...entry };
      await fs.appendFile(file, `${JSON.stringify(fileEntry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    })
    .catch((error: unknown) => {
      // Never let logging break authentication, but do not fail silently
      // either: surface the (safe) reason once in the in-memory trace, which
      // get_monarch_connection_status returns, so a missing file is explained.
      if (authLogWriteFailureReported) return;
      authLogWriteFailureReported = true;
      const errno = (error as NodeJS.ErrnoException | undefined)?.code;
      const message = error instanceof Error ? error.message : undefined;
      const candidate = errno ?? message;
      const code =
        typeof candidate === "string" && SAFE_EVENT.test(candidate)
          ? candidate
          : "UNKNOWN";
      authenticationTraceEntries.push({
        timestamp: new Date().toISOString(),
        event: "AUTH_LOG_FILE_WRITE_FAILED",
        code,
      });
      diagnostic("AUTH_LOG_FILE_WRITE_FAILED", { code });
    });
}

export function authenticationLogFile(): string | undefined {
  try {
    return path.join(localDataDirectory(), "logs", "authentication.log");
  } catch {
    return undefined;
  }
}

export function authenticationTrace(): AuthenticationTraceEntry[] {
  return authenticationTraceEntries.map((entry) => ({ ...entry }));
}
