import type { BrowserCapture } from "../auth/browser-capture.js";
import type { SessionStore } from "../auth/session-store.js";
import type { ConnectionStatus, MonarchSession } from "../auth/types.js";
import type { MonarchClient } from "../monarch/client.js";

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
          connected: false,
          auth_mode: "none",
          last_verified_at: null,
          reauthentication_required: true,
          diagnostic_code: this.lastDiagnostic ?? "NOT_CONNECTED",
        };
      return {
        connected: true,
        auth_mode: "browser_session",
        last_verified_at: this.lastVerifiedAt ?? session.capturedAt,
        reauthentication_required: false,
        diagnostic_code: "SESSION_STORED",
      };
    } catch {
      return {
        connected: false,
        auth_mode: "none",
        last_verified_at: null,
        reauthentication_required: true,
        diagnostic_code: "SESSION_UNREADABLE",
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
    await this.store.save(session);
    try {
      await this.client.read("GetAccounts");
      this.lastVerifiedAt = new Date().toISOString();
      this.lastDiagnostic = null;
    } catch {
      await this.store.clear();
      throw new Error("AUTH_VERIFICATION_FAILED");
    }
  }
}
