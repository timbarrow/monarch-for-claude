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
