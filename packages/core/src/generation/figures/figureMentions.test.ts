import { describe, expect, it } from "vitest";
import { mentionsFigure } from "./figureMentions.js";

describe("mentionsFigure", () => {
  it("fires on a request that names the chart or diagram, in several languages", () => {
    for (const request of [
      "drop the chart",
      "Make the diagram simpler",
      "turn the diagram into a flowchart",
      "redraw the figure as a pie",
      "update Figure 2 with the 1950 numbers",
      "fix the numbers in the bar chart",
      "add a scatter plot of the two series",
      "the plot of the data is wrong",
      "put the years on the x-axis",
      "give the infographic a caption",
      "نمودار را حذف کن",
      "شکل ۲ را ساده‌تر کن",
      "把图表改成饼图",
      "図2を修正して",
      "グラフを削除して",
      "차트를 삭제해 주세요",
      "Mach das Diagramm kleiner",
      "cambia el gráfico por uno de barras",
      "graphique",
      "le graphique",
      "исправь график 2",
      "построй линейный график вместо столбчатого",
      "убери диаграмму",
      "change the legend labels",
      "Move the legend to the bottom",
      "put the legend on the right",
      "make the graphic smaller",
      "the graphic should show 1950 too",
      "delete the figure.",
      "delete this figure",
      "the figure on page 3 needs a caption",
      "move the figure into section 2",
      "label the y-axis in percent",
      "the axis labels are unreadable",
      "the tick labels overlap",
      "add a second data series for France",
      "draw a histogram instead",
      "این شکل را حذف کن",
      "محور عمودی را درصدی کن",
      "beschrifte die y-Achse",
      "cambia el eje vertical",
      "corrige l'axe des ordonnées",
      "подпиши ось y",
      "把图例放到下面",
      "凡例を消して",
      "범례를 지워 주세요"
    ]) {
      expect(mentionsFigure(request), request).toBe(true);
    }
  });

  it("counts a request that quotes the page's own figure title, and nothing else about its data", () => {
    const figures = [
      { kind: "bar" as const, title: "Share of the workforce in farming", categories: ["1900", "1950"], series: [{ name: "United States", values: [41, 12] }], source: "Census" }
    ];
    expect(mentionsFigure("shorten Share of the Workforce in Farming to one line", figures)).toBe(true);
    expect(mentionsFigure("widen GDP", [{ ...figures[0]!, title: "GDP" }])).toBe(true);
    expect(mentionsFigure("regrowth", [{ ...figures[0]!, title: "Growth" }])).toBe(false);
    expect(mentionsFigure("tighten the paragraph on farming", figures)).toBe(false);
    // Categories and series names are the years and names the prose is about.
    expect(mentionsFigure("describe 1950 more vividly", figures)).toBe(false);
    expect(mentionsFigure("mention the United States by name", figures)).toBe(false);
    // A short title still has to appear as a whole phrase: "Farm" is not "farming".
    expect(mentionsFigure("make farming the theme", [{ ...figures[0]!, title: "Farm" }])).toBe(false);
    expect(mentionsFigure("shorten Share of the workforce in farming", [])).toBe(false);
  });

  it("stays silent on prose that merely uses the words plot, figure, shape or picture", () => {
    for (const request of [
      "make it more vivid",
      "strengthen the plot twist",
      "fix the plot hole on page 3",
      "the plot of the novel drags here",
      "make him a more sympathetic historical figure",
      "figure out why she left and say so",
      "the figure of Napoleon looms over the chapter",
      "he cut a fine figure at the ball",
      "a father figure for the boy",
      "the figure standing in the doorway should be menacing",
      "check the sales figures against the ledger",
      "she is a public figure now",
      "به این شکل بنویس",
      "جدول زمانی را اصلاح کن",
      "把地图放大一点",
      "地図を追加して",
      "図を直して",
      "измени график работы на странице 3",
      "у неё плотный график",
      "change this figure skating passage",
      "the figure eight she skated should be described",
      "this figure, a man in grey, should be older",
      "the figure with the cane is her uncle",
      "the figure in the doorway should be menacing",
      "that figure was the last thing he saw",
      "the graphic detail is too much here",
      "the graphic novel he loved deserves a mention",
      "photographique",
      "expand the legend of the lost city",
      "rewrite the graph-theory proof",
      "the graph of G is bipartite",
      "turn the graph into an adjacency list",
      "the Axis advance across the desert",
      "the axis of her argument is fairness",
      "the story series should get a mention",
      "a local legend says the well is bottomless",
      "محور اصلی داستان را روشن‌تر کن",
      "die Achsenmächte rückten vor",
      "la leyenda del rey Arturo",
      "la légende dit qu'il revint",
      "легенда о городе живёт до сих пор"
    ]) {
      expect(mentionsFigure(request), request).toBe(false);
    }
  });
});
