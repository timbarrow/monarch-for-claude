import { spawn } from "node:child_process";

const encryptScript =
  "$d=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($d);$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";
const decryptScript =
  "$d=[Console]::In.ReadToEnd();$b=[Convert]::FromBase64String($d);$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($p))";

function run(script: string, input: Buffer): Promise<Buffer> {
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
    child.on("error", () => reject(new Error("DPAPI_UNAVAILABLE")));
    child.on("close", (code) => {
      if (code !== 0 || !/^[A-Za-z0-9+/=\r\n]+$/.test(stdout))
        reject(new Error("DPAPI_FAILED"));
      else resolve(Buffer.from(stdout.trim(), "base64"));
    });
    child.stdin.end(input.toString("base64"));
  });
}

export const dpapi = {
  encrypt: (plaintext: Buffer): Promise<Buffer> =>
    run(encryptScript, plaintext),
  decrypt: (ciphertext: Buffer): Promise<Buffer> =>
    run(decryptScript, ciphertext),
};
