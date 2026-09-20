import { safeErrorCode } from "../logging.js";
export function response(data: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
export function failure(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: safeErrorCode(error) }) },
    ],
    isError: true,
  };
}
