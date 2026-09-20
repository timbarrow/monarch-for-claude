import { describe, expect, it } from "vitest";
import { searchTransactionsInput } from "../../src/tools/contracts.js";
import { redact } from "../../src/logging.js";
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
  it("forces historical application off at the network boundary", () => {
    expect(
      toGraphqlSafeRule({
        criteria: { merchant: { operator: "equals", value: "Synthetic" } },
        actions: { add_tag_ids: ["tag_1"] },
      }),
    ).toMatchObject({ applyToExistingTransactions: false });
  });
  it("redacts common secret-bearing diagnostics", () => {
    const output = redact(
      "authorization=Bearer synthetic-secret cookie=session-token csrf=abc",
    );
    expect(output).not.toContain("synthetic-secret");
    expect(output).not.toContain("session-token");
  });
});
