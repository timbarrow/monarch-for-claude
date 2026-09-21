import { describe, expect, it } from "vitest";
import { searchTransactionsInput } from "../../src/tools/contracts.js";
import {
  authenticationLog,
  authenticationTrace,
  redact,
  sanitizeAuthenticationFields,
} from "../../src/logging.js";
import { toGraphqlSafeRule } from "../../src/rules/schema.js";

describe("security boundary", () => {
  it("bounds pagination, identifiers, and input fields", () => {
    expect(() => searchTransactionsInput.parse({ page_size: 201 })).toThrow();
    expect(() =>
      searchTransactionsInput.parse({
        account_ids: Array.from({ length: 101 }, () => "acct_1"),
      }),
    ).toThrow();
    expect(() =>
      searchTransactionsInput.parse({
        page_size: 1,
        endpoint: "https://evil.example",
      }),
    ).toThrow();
  });
  it("defaults historical application off and permits only an explicit boolean", () => {
    expect(
      toGraphqlSafeRule({
        criteria: { merchant: { operator: "equals", value: "Synthetic" } },
        actions: { add_tag_ids: ["tag_1"] },
      }),
    ).toMatchObject({ applyToExistingTransactions: false });
    expect(
      toGraphqlSafeRule(
        {
          criteria: { merchant: { operator: "equals", value: "Synthetic" } },
          actions: { set_category_id: "cat_1" },
        },
        undefined,
        true,
      ),
    ).toMatchObject({ applyToExistingTransactions: true });
  });
  it("redacts common secret-bearing diagnostics", () => {
    const output = redact(
      "authorization=Bearer synthetic-secret cookie=session-token csrf=abc",
    );
    expect(output).not.toContain("synthetic-secret");
    expect(output).not.toContain("session-token");
    expect(
      sanitizeAuthenticationFields({
        authorization: "Token secret",
        cookie: "session=secret",
        csrfToken: "secret",
        authorization_present: true,
        cookie_names: "csrftoken,sessionid",
        code: "AUTH_REQUIRED",
      }),
    ).toEqual({
      authorization_present: true,
      cookie_names: "csrftoken,sessionid",
      code: "AUTH_REQUIRED",
    });
    authenticationLog("TEST_SAFE_TRACE", {
      authorization: "Token secret",
      cookie: "session=secret",
      authorization_present: true,
      code: "AUTH_REQUIRED",
    });
    expect(authenticationTrace().at(-1)).toMatchObject({
      event: "TEST_SAFE_TRACE",
      authorization_present: true,
      code: "AUTH_REQUIRED",
    });
    expect(JSON.stringify(authenticationTrace().at(-1))).not.toContain(
      "secret",
    );
  });
});
