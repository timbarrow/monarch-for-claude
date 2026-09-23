import crypto from "node:crypto";
import http from "node:http";
import { spawn } from "node:child_process";
import { CONFIRMATION_TTL_MS } from "../config.js";

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] ?? c,
  );
export interface Confirmation {
  confirm(change: unknown): Promise<boolean>;
}
export class LoopbackConfirmation implements Confirmation {
  constructor(private readonly ttlMs = CONFIRMATION_TTL_MS) {}
  confirm(change: unknown): Promise<boolean> {
    return new Promise((resolve) => {
      const nonce = crypto.randomBytes(24).toString("hex");
      const server = http.createServer((request, response) => {
        const host = request.headers.host;
        const address = server.address();
        const expectedHost =
          typeof address === "object" && address
            ? `127.0.0.1:${address.port}`
            : "";
        if (host !== expectedHost || request.url !== `/${nonce}`) {
          response.writeHead(403);
          response.end("Forbidden");
          return;
        }
        if (request.method === "GET") {
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(
            `<!doctype html><title>Confirm Monarch change</title><h1>Confirm Monarch change</h1><pre>${escapeHtml(JSON.stringify(change, null, 2))}</pre><form method="post"><button type="submit">Confirm</button></form><p>Closing this page cancels the change.</p>`,
          );
          return;
        }
        const expectedOrigin = `http://${expectedHost}`;
        if (
          request.method === "POST" &&
          request.headers.origin === expectedOrigin
        ) {
          response.writeHead(200);
          response.end("Confirmed. You may return to Claude.");
          finish(true);
          return;
        }
        response.writeHead(403);
        response.end("Forbidden");
      });
      let settled = false;
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        resolve(confirmed);
      };
      const timer = setTimeout(() => finish(false), this.ttlMs);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") return finish(false);
        const url = `http://127.0.0.1:${address.port}/${nonce}`;
        const browser = spawn("cmd.exe", ["/d", "/s", "/c", "start", "", url], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        browser.unref();
      });
      server.on("error", () => finish(false));
    });
  }
}
