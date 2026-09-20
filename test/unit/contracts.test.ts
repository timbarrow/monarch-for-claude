import { describe, expect, it } from "vitest";
import {
  searchTransactionsValidation,
  summarizeTransactionsValidation,
} from "../../src/tools/contracts.js";

describe("tool contract dates", () => {
  it("accepts leap days and rejects impossible calendar dates", () => {
    expect(
      summarizeTransactionsValidation.safeParse({
        start_date: "2024-02-29",
        end_date: "2024-02-29",
        group_by: "month",
      }).success,
    ).toBe(true);
    expect(
      summarizeTransactionsValidation.safeParse({
        start_date: "2026-02-31",
        end_date: "2026-03-01",
        group_by: "month",
      }).success,
    ).toBe(false);
    expect(
      searchTransactionsValidation.safeParse({
        start_date: "2026-99-99",
      }).success,
    ).toBe(false);
  });
});
