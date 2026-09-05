import { describe, expect, it } from "vitest";
import { figureComposeRules } from "./figurePrompt.js";
import { chartFigureSchema, type FigureKind } from "./figureSpec.js";

function composition(kind: FigureKind) {
  return {
    sections: [
      {
        form: "comparison",
        subject: "farming",
        owns: [],
        figure: { kind, shows: "the share over time", source: "the census" }
      }
    ]
  };
}

describe("figureComposeRules", () => {
  it("shows a line plan a line example, not the bar one", () => {
    const text = figureComposeRules(composition("line")).join("\n");
    expect(text).toContain('"kind":"line"');
    expect(text).not.toContain('"kind":"bar"');
    expect(text).toContain("Share of the workforce in farming");
    expect(text).toContain('"1900"');
    expect(text).toContain("The farm share falls across the century.");
    expect(text).toContain("kind (line)");
    expect(text).toContain('scale: "log"');
    expect(text).not.toContain("kind (bar");
    expect(text).not.toContain("orientation");
    expect(text).not.toContain("line or pie");
  });

  it("shows a pie plan a pie example, not the bar one", () => {
    const text = figureComposeRules(composition("pie")).join("\n");
    expect(text).toContain('"kind":"pie"');
    expect(text).not.toContain('"kind":"bar"');
    expect(text).not.toContain('"1900"');
    expect(text).not.toContain("Share of the workforce in farming");
    expect(text).toContain("United States employment by sector");
    expect(text).toContain('"Services"');
    expect(text).toContain('"Goods-producing"');
    expect(text).toContain('"Farming"');
    expect(text).not.toContain('"1950"');
    expect(text).not.toContain('"2000"');
    const fence = text.match(/```figure\n(\{.*\})\n```/);
    const spec = chartFigureSchema.parse(JSON.parse(fence?.[1] ?? "null"));
    expect(spec.kind).toBe("pie");
    expect(spec.series).toHaveLength(1);
    expect(spec.categories.every((category) => !/^\d{4}$/.test(category))).toBe(true);
    expect(spec.series[0]!.values.reduce((sum, value) => sum + value, 0)).toBe(100);
    expect(text).toContain("kind (pie)");
    expect(text).not.toContain("kind (bar");
    expect(text).not.toContain("line or pie");
    expect(text).not.toContain("orientation");
    expect(text).not.toContain("scale");
  });

  it("keeps the farming bar example for a bar plan", () => {
    const text = figureComposeRules(composition("bar")).join("\n");
    expect(text).toContain('"kind":"bar"');
    expect(text).toContain("Share of the workforce in farming");
    expect(text).toContain('"1900"');
    expect(text).not.toContain('"kind":"line"');
    expect(text).not.toContain('"kind":"pie"');
    expect(text).toContain("kind (bar)");
    expect(text).toContain("orientation");
    expect(text).toContain("scale");
    expect(text).not.toContain("line or pie");
  });
});
