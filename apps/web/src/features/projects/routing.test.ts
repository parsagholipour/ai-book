import { describe, expect, it } from "vitest";
import { projectIdFromPath } from "./routing.js";

describe("project routing helpers", () => {
  it("reads project ids from project detail paths", () => {
    expect(projectIdFromPath("/projects/book-123")).toBe("book-123");
    expect(projectIdFromPath("/projects/book%20123")).toBe("book 123");
  });

  it("ignores non-project paths", () => {
    expect(projectIdFromPath("/")).toBeNull();
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/projects/book-123/edit")).toBeNull();
  });
});
