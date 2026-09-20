import fs from "node:fs/promises";
import path from "node:path";
import { localDataDirectory } from "./config.js";

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
const SAFE_EVENT = /^[A-Z0-9_]+$/;
const FORBIDDEN_FIELD =
  /authorization(?!_present)|cookie(?!_present|_names)|token(?!_present)|password|secret|csrf(?!_present)|session/i;
let authLogQueue = Promise.resolve();

export function sanitizeAuthenticationFields(
  fields: Record<string, string | number | boolean | null>,
): Record<string, string | number | boolean | null> {
  const safeFields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (FORBIDDEN_FIELD.test(key)) continue;
    safeFields[key] =
      typeof value === "string"
        ? value.replace(/[\r\n]/g, " ").slice(0, 200)
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
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...safeFields,
      });
      await fs.appendFile(file, `${entry}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    })
    .catch(() => undefined);
}
