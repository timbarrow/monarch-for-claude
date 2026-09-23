import { describe, expect, it } from "vitest";
import { APPROVED_TOOL_NAMES } from "../../src/tools/contracts.js";
import {
  ALLOWED_MUTATIONS,
  GRAPHQL_OPERATIONS,
} from "../../src/monarch/operations.js";

describe("public contract", () => {
  it("has the exact approved MCP tool inventory", () => {
    expect(APPROVED_TOOL_NAMES).toMatchInlineSnapshot(`
      [
        "get_monarch_connection_status",
        "connect_monarch",
        "list_accounts",
        "search_transactions",
        "get_transaction",
        "summarize_transactions",
        "list_categories",
        "list_tags",
        "list_classification_rules",
        "preview_classification_rule_change",
        "apply_classification_rule_change",
        "preview_transaction_update",
        "apply_transaction_update",
      ]
    `);
  });
  it("contains only the approved non-delete mutations", () => {
    const mutations = Object.entries(GRAPHQL_OPERATIONS)
      .filter(([, document]) => document.startsWith("mutation"))
      .map(([name]) => name);
    expect(mutations.sort()).toEqual([...ALLOWED_MUTATIONS].sort());
    expect(Object.values(GRAPHQL_OPERATIONS).join("\n")).not.toContain(
      "deleteTransaction(",
    );
  });
});
