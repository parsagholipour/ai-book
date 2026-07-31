import { describe, expect, it } from "vitest";
import { projectPath } from "./routing.js";

describe("project routing helpers", () => {
  it("builds project detail paths", () => {
    expect(projectPath("book-123")).toBe("/projects/book-123");
  });

  it("escapes ids so a path never breaks on one", () => {
    expect(projectPath("book 123")).toBe("/projects/book%20123");
    expect(projectPath("a/b")).toBe("/projects/a%2Fb");
  });
});
