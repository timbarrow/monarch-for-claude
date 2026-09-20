import type { BrowserCapture } from "../auth/browser-capture.js";
import type { SessionStore } from "../auth/session-store.js";
import type { ConnectionStatus, MonarchSession } from "../auth/types.js";
import type { MonarchClient } from "../monarch/client.js";

export class AuthService {
  private lastVerifiedAt: string | null = null;
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
          diagnostic_code: "NOT_CONNECTED",
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
    const status = await this.capture.begin(async (session) =>
      this.verifyAndSave(session),
    );
    return { status };
  }
  private async verifyAndSave(session: MonarchSession): Promise<void> {
    await this.store.save(session);
    try {
      await this.client.read("GetAccounts");
      this.lastVerifiedAt = new Date().toISOString();
    } catch {
      await this.store.clear();
      throw new Error("AUTH_VERIFICATION_FAILED");
    }
  }
}
