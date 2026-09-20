export class MonarchError extends Error {
  constructor(
    readonly code:
      | "AUTH_REQUIRED"
      | "RATE_LIMITED"
      | "NETWORK_ERROR"
      | "API_ERROR"
      | "INVALID_RESPONSE",
    readonly status?: number,
  ) {
    super(code);
  }
}
