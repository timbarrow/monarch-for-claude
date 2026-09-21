import { safeErrorCode } from "../logging.js";
import { ZodError } from "zod";
export function response(data: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}
export function failure(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  if (error instanceof ZodError)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "INVALID_INPUT",
            issues: error.issues.slice(0, 10).map((issue) => ({
              path: issue.path.join(".").slice(0, 200),
              message: issue.message.replace(/[\r\n]/g, " ").slice(0, 300),
            })),
          }),
        },
      ],
      isError: true,
    };
  return {
    content: [
      { type: "text", text: JSON.stringify({ error: safeErrorCode(error) }) },
    ],
    isError: true,
  };
}
