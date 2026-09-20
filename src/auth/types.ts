export type AuthMode = "none" | "browser_session";

export interface MonarchSession {
  cookie?: string;
  authorization?: string;
  csrfToken?: string;
  clientPlatform?: string;
  deviceUuid?: string;
  cioClientPlatform?: string;
  monarchClient?: string;
  monarchClientVersion?: string;
  capturedAt: string;
}

export interface ConnectionStatus {
  connected: boolean;
  auth_mode: AuthMode;
  last_verified_at: string | null;
  reauthentication_required: boolean;
  diagnostic_code: string;
}
