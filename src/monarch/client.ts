import { MONARCH_GRAPHQL_URL, REQUEST_TIMEOUT_MS } from "../config.js";
import type { MonarchSession } from "../auth/types.js";
import { MonarchError } from "./errors.js";
import {
  ALLOWED_MUTATIONS,
  GRAPHQL_OPERATIONS,
  READ_OPERATIONS,
  type OperationName,
} from "./operations.js";

export interface SessionProvider {
  load(): Promise<MonarchSession | undefined>;
  clear(): Promise<void>;
}
export interface FetchLike {
  (input: string, init: RequestInit): Promise<Response>;
}

export class MonarchClient {
  constructor(
    private readonly sessions: SessionProvider,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}
  async read<T>(
    name: OperationName,
    variables: Record<string, unknown> = {},
  ): Promise<T> {
    if (!READ_OPERATIONS.has(name)) throw new MonarchError("API_ERROR");
    return this.execute<T>(name, variables, true);
  }
  async mutate<T>(
    name: OperationName,
    variables: Record<string, unknown>,
  ): Promise<T> {
    if (!ALLOWED_MUTATIONS.has(name)) throw new MonarchError("API_ERROR");
    return this.execute<T>(name, variables, false);
  }
  private async execute<T>(
    name: OperationName,
    variables: Record<string, unknown>,
    mayRetry: boolean,
  ): Promise<T> {
    const session = await this.sessions.load();
    if (!session) throw new MonarchError("AUTH_REQUIRED");
    const attempt = async (): Promise<T> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = {
          "content-type": "application/json",
          "client-platform": session.clientPlatform ?? "web",
          origin: "https://app.monarch.com",
        };
        if (session.cookie) headers.cookie = session.cookie;
        if (session.authorization)
          headers.authorization = session.authorization;
        if (session.csrfToken) headers["x-csrf-token"] = session.csrfToken;
        if (session.deviceUuid) headers["device-uuid"] = session.deviceUuid;
        if (session.cioClientPlatform)
          headers["x-cio-client-platform"] = session.cioClientPlatform;
        const response = await this.fetchImpl(MONARCH_GRAPHQL_URL, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            operationName: name,
            query: GRAPHQL_OPERATIONS[name],
            variables,
          }),
        });
        if (response.status === 401 || response.status === 403) {
          await this.sessions.clear();
          throw new MonarchError("AUTH_REQUIRED", response.status);
        }
        if (response.status === 429)
          throw new MonarchError("RATE_LIMITED", 429);
        if (!response.ok)
          throw new MonarchError("NETWORK_ERROR", response.status);
        const body: unknown = await response.json().catch(() => {
          throw new MonarchError("INVALID_RESPONSE");
        });
        if (!body || typeof body !== "object")
          throw new MonarchError("INVALID_RESPONSE");
        const parsed = body as { data?: T; errors?: unknown[] };
        if (parsed.errors?.length || parsed.data === undefined)
          throw new MonarchError("API_ERROR");
        return parsed.data;
      } catch (error) {
        if (error instanceof MonarchError) throw error;
        throw new MonarchError("NETWORK_ERROR");
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      return await attempt();
    } catch (error) {
      if (
        mayRetry &&
        error instanceof MonarchError &&
        error.code === "NETWORK_ERROR"
      )
        return attempt();
      throw error;
    }
  }
}
