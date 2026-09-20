import type { BrowserCapture } from "../auth/browser-capture.js";
import type { SessionStore } from "../auth/session-store.js";
import type { ConnectionStatus, MonarchSession } from "../auth/types.js";
import type { MonarchClient } from "../monarch/client.js";
import { MonarchError } from "../monarch/errors.js";
import { SERVER_VERSION } from "../config.js";
import {
  authenticationLog,
  authenticationTrace,
  safeErrorCode,
} from "../logging.js";

export class AuthService {
  private lastVerifiedAt: string | null = null;
  private lastDiagnostic: string | null = null;
  constructor(
    private readonly store: SessionStore,
    private readonly capture: BrowserCapture,
    private readonly client: MonarchClient,
  ) {}
  async status(): Promise<ConnectionStatus> {
    try {
      const session = await this.store.load();
      if (!session)
        return {
          server_version: SERVER_VERSION,
          connected: false,
          auth_mode: "none",
          last_verified_at: null,
          reauthentication_required: true,
          diagnostic_code: this.lastDiagnostic ?? "NOT_CONNECTED",
          diagnostic_trace: authenticationTrace(),
        };
      return {
        server_version: SERVER_VERSION,
        connected: true,
        auth_mode: "browser_session",
        last_verified_at: this.lastVerifiedAt ?? session.capturedAt,
        reauthentication_required: false,
        diagnostic_code: "SESSION_STORED",
        diagnostic_trace: authenticationTrace(),
      };
    } catch (error) {
      authenticationLog("SESSION_UNREADABLE", { code: safeErrorCode(error) });
      return {
        server_version: SERVER_VERSION,
        connected: false,
        auth_mode: "none",
        last_verified_at: null,
        reauthentication_required: true,
        diagnostic_code: "SESSION_UNREADABLE",
        diagnostic_trace: authenticationTrace(),
      };
    }
  }
  async connect(): Promise<{ status: string }> {
    this.lastDiagnostic = "AUTHENTICATION_IN_PROGRESS";
    try {
      const status = await this.capture.begin(
        async (session) => this.verifyAndSave(session),
        (code) => {
          this.lastDiagnostic = code;
        },
        (code) => {
          this.lastDiagnostic = code;
        },
      );
      if (status !== "BROWSER_OPENED_SIGN_IN_DIRECTLY")
        this.lastDiagnostic = status;
      return { status };
    } catch (error) {
      this.lastDiagnostic =
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "BROWSER_CAPTURE_FAILED";
      throw error;
    }
  }
  private async verifyAndSave(session: MonarchSession): Promise<void> {
    authenticationLog("AUTH_VERIFICATION_STARTED", {
      authorization_present: !!session.authorization,
      cookie_present: !!session.cookie,
      csrf_present: !!session.csrfToken,
      device_uuid_present: !!session.deviceUuid,
    });
    try {
      await this.store.save(session);
      authenticationLog("SESSION_SAVED");
    } catch (error) {
      const code = safeErrorCode(error);
      authenticationLog("SESSION_SAVE_FAILED", { code });
      throw new Error(code);
    }
    try {
      await this.client.read("GetAccounts");
      this.lastVerifiedAt = new Date().toISOString();
      this.lastDiagnostic = null;
      authenticationLog("AUTH_VERIFICATION_SUCCEEDED", {
        operation: "GetAccounts",
        http_status: 200,
      });
    } catch (error) {
      await this.store.clear();
      if (error instanceof MonarchError) {
        authenticationLog("AUTH_VERIFICATION_FAILED", {
          code: error.code,
          http_status: error.status ?? null,
        });
        throw new Error(`AUTH_VERIFICATION_${error.code}`);
      }
      authenticationLog("AUTH_VERIFICATION_FAILED", { code: "UNKNOWN" });
      throw new Error("AUTH_VERIFICATION_FAILED");
    }
  }
}
