import { spawn } from "node:child_process";
import { authenticationLog } from "../logging.js";

const prelude =
  "$ErrorActionPreference='Stop';Add-Type -AssemblyName System.Security;";
const encryptScript =
  prelude +
  "$d=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($d);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
const decryptScript =
  prelude +
  "$d=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($d);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";

/**
 * Reduce PowerShell stderr to a fixed vocabulary. The raw text is never
 * logged because it can echo input that we treat as secret.
 */
export function classifyPowerShellError(stderr: string): string {
  if (!stderr.trim()) return "NO_STDERR";
  if (/unable to find type|cannot find type/i.test(stderr))
    return "TYPE_NOT_FOUND";
  if (/could not load file or assembly|assembly/i.test(stderr))
    return "ASSEMBLY_LOAD_FAILED";
  if (/constrained ?language|not permitted in this language mode/i.test(stderr))
    return "CONSTRAINED_LANGUAGE_MODE";
  if (/execution policy|is blocked|disabled by/i.test(stderr))
    return "POLICY_BLOCKED";
  if (/not a valid base-?64|invalid length for a base-?64/i.test(stderr))
    return "BASE64_INVALID";
  if (
    /key not valid|cannot be decrypted|parameter is incorrect|cryptographic/i.test(
      stderr,
    )
  )
    return "DPAPI_CRYPTO_ERROR";
  if (/access is denied|unauthorized/i.test(stderr)) return "ACCESS_DENIED";
  return "UNCLASSIFIED";
}

function run(
  script: string,
  input: Buffer,
  operation: "encrypt" | "decrypt",
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on(
      "data",
      (chunk: Buffer) => (stdout += chunk.toString("utf8")),
    );
    child.stderr.on(
      "data",
      (chunk: Buffer) => (stderr += chunk.toString("utf8")),
    );
    child.on("error", (error) => {
      authenticationLog("DPAPI_PROCESS_UNAVAILABLE", {
        operation,
        code: (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
      });
      reject(new Error("DPAPI_UNAVAILABLE"));
    });
    child.on("close", (code, signal) => {
      const stdoutValid = /^[A-Za-z0-9+/=\r\n]+$/.test(stdout);
      if (code !== 0 || !stdoutValid) {
        authenticationLog("DPAPI_PROCESS_FAILED", {
          operation,
          exit_code: code,
          signal: signal ?? null,
          stdout_valid: stdoutValid,
          stdout_bytes: stdout.length,
          stderr_bytes: stderr.length,
          stderr_class: classifyPowerShellError(stderr),
        });
        reject(new Error("DPAPI_FAILED"));
      } else resolve(Buffer.from(stdout.trim(), "base64"));
    });
    child.stdin.end(input.toString("base64"));
  });
}

export const dpapi = {
  encrypt: (plaintext: Buffer): Promise<Buffer> =>
    run(encryptScript, plaintext, "encrypt"),
  decrypt: (ciphertext: Buffer): Promise<Buffer> =>
    run(decryptScript, ciphertext, "decrypt"),
};
