import { expect, it } from "vitest";
import { FakeTextModelAdapter } from "../adapters/fake.js";
import { proseArithmeticFindings } from "./proseArithmetic.js";

it("retains a code-checked disagreement for review when the intent verifier votes false", async () => {
  const markdown = 'Count letters and take the remainder after division by 10. “Send six pumps” might produce 5; “Send twelve pumps” might produce 7. Use 2 messages.';
  const textModel = new FakeTextModelAdapter();
  textModel.generateJson = async (options) => {
    const data = options.schema.parse(options.messages[1]!.content.includes('"passage"')
      ? { states: false }
      : { errors: [{ quote: '“Send six pumps” might produce 5', expression: '12 - 10', stated: 5 }] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  expect(await proseArithmeticFindings({ markdown, textModel })).toEqual([{
    quote: '“Send six pumps” might produce 5',
    reason: expect.stringContaining("12 - 10 = 2, not 5"),
    reviewOnly: true
  }]);
});

it.each(["Error", "StopRequestedError"])("retains an unavailable intent check but propagates cancellation: %s", async name => {
  const markdown = "After rent of $1,200 and electricity of $110 from $800, only $290 remains.";
  const error = Object.assign(new Error("fixture failure"), { name });
  const textModel = new FakeTextModelAdapter();
  textModel.generateJson = async options => {
    if (options.messages[1]!.content.includes('"passage"')) throw error;
    const data = options.schema.parse({ errors: [{ quote: "only $290 remains", expression: "800 - 1200 - 110", stated: 290 }] });
    return { data, text: JSON.stringify(data), provider: "fixture", model: "fixture" };
  };
  const result = proseArithmeticFindings({ markdown, textModel });
  if (name === "StopRequestedError") await expect(result).rejects.toBe(error);
  else expect(await result).toEqual([expect.objectContaining({ quote: "only $290 remains", reviewOnly: true })]);
});
