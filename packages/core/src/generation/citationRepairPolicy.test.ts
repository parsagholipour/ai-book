import { describe, expect, it } from "vitest";
import { shouldSkipUnsatisfiableCitationRepair } from "./citationRepairPolicy.js";

const report = (...issues: string[]) => ({ approved: false, issues });

describe("shouldSkipUnsatisfiableCitationRepair", () => {
  it.each([
    [
      "the affected legacy requirement wording",
      "Despite the page brief explicitly requiring a named testimony or archive, the page provides no specific dispatch date."
    ],
    ["a missing dispatch and archive", "No specific dispatch date or archive is identified."],
    ["a missing civilian account", "The documented civilian account is not named."]
  ])("recognizes %s as source-identity-only", (_name, issue) => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(issue), [])).toBe(true);
  });

  it("requires every issue to be source-identity-only", () => {
    expect(
      shouldSkipUnsatisfiableCitationRepair(
        report(
          "No specific dispatch date or archive is identified.",
          "The page repeats the explanation from page 1."
        ),
        []
      )
    ).toBe(false);
  });

  it.each([
    "No specific dispatch date is identified, and the account contradicts the supplied record.",
    "No archive is named, but the chronology is incorrect.",
    "The page invents a diary and fabricates its contents."
  ])("keeps a mixed or substantive single issue repairable: %s", (issue) => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(issue), [])).toBe(false);
  });

  it("keeps the same legacy issue repairable when citeable research exists", () => {
    expect(
      shouldSkipUnsatisfiableCitationRepair(
        report("No specific dispatch date or archive is identified."),
        ["Boundary papers: Commission records."]
      )
    ).toBe(false);
  });

  it("does not classify an empty or unreadable report", () => {
    expect(shouldSkipUnsatisfiableCitationRepair(report(), [])).toBe(false);
    expect(shouldSkipUnsatisfiableCitationRepair(null, [])).toBe(false);
  });
});
