import path from "node:path";

export const SERVER_VERSION = "0.1.11";

/** The interactive browser app is separate from the private GraphQL API host. */
export const MONARCH_ORIGIN = "https://app.monarch.com";
export const MONARCH_API_ORIGIN = "https://api.monarch.com";
export const MONARCH_GRAPHQL_URL = `${MONARCH_API_ORIGIN}/graphql`;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_DATE_WINDOW_DAYS = 30;
export const MAX_DATE_WINDOW_DAYS = 366;
export const MAX_ID_ARRAY_LENGTH = 100;
export const REQUEST_TIMEOUT_MS = 20_000;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
export const AUTH_CAPTURE_TTL_MS = 10 * 60 * 1000;

export function localDataDirectory(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const root = env.LOCALAPPDATA;
  if (!root) throw new Error("LOCALAPPDATA_UNAVAILABLE");
  return path.join(root, "MonarchForClaude");
}
