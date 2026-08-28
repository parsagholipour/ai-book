import { describe, expect, it } from "vitest";
import { alibabaContentRefusal, alibabaRefusalReason } from "./alibabaImageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";

describe("alibabaRefusalReason", () => {
  it("answers with the code only when the code is the arm that settled it", () => {
    expect(alibabaRefusalReason("DataInspectionFailed", "data inspection failed", "error-body")).toBe(
      "DataInspectionFailed"
    );
    expect(alibabaRefusalReason("data_inspection_failed", undefined, "model-turn", "stop")).toBe(
      "data_inspection_failed"
    );
  });

  it("labels a prose-settled verdict for itself and carries the rejected code as a qualifier", () => {
    // `InvalidParameter` is DashScope's general-purpose error field, not its
    // filter's word, and `isAlibabaRefusalCode` has already refused it. It may
    // not come back as *the* reason — but it may not be dropped either, because
    // `imageRefusalCategory` reads a recorded reason as evidence.
    expect(alibabaRefusalReason("InvalidParameter", "Input contains ip infringement", "error-body")).toBe(
      "NO_IMAGE: InvalidParameter"
    );
    expect(alibabaRefusalReason(undefined, "Input data may contain inappropriate content.", "error-body")).toBe(
      "NO_IMAGE"
    );
    // A model turn keeps the finish reason where it says more than "the turn
    // ended", which is the only extra a turn has to offer over an error body.
    expect(
      alibabaRefusalReason("InvalidParameter", "I can't draw Spider-Man, a copyrighted character.", "model-turn", "length")
    ).toBe("length: InvalidParameter");
  });

  it("reads an error body for its vocabulary alone and a model turn for all four readings", () => {
    // `"unable to generate"` in an error body is a bad model name, not a
    // decline; read as one it would make a bug to fix permanent.
    expect(alibabaRefusalReason(undefined, "Unable to generate an image for this model.", "error-body")).toBeUndefined();
    expect(alibabaRefusalReason(undefined, "Unable to generate an image for this prompt.", "model-turn")).toBe(
      "NO_IMAGE"
    );
    // And a drawn picture narrating its own compliance is not a refusal on
    // either reading.
    expect(
      alibabaRefusalReason(undefined, "The image was generated in accordance with the content policy.", "model-turn")
    ).toBeUndefined();
  });

  it("keeps the outage veto above both arms", () => {
    // DashScope names its outages after the very inspector it names its
    // verdicts after, so this sentence is the filter being broken rather than
    // the filter answering — under either spelling of the code.
    const outage = "InternalError: the data inspection service is temporarily unavailable, please retry.";
    expect(alibabaRefusalReason("DataInspectionFailed", outage, "error-body")).toBeUndefined();
    expect(alibabaRefusalReason("InternalError", outage, "model-turn", "stop")).toBeUndefined();
  });
});

describe("alibabaContentRefusal", () => {
  /**
   * The regression. This path used to call the classifier for its truthiness
   * and then label every verdict `code ?? "DataInspectionFailed"` — so a 400
   * settled by prose was recorded under the very code the filter test had just
   * refused, or under a code DashScope never sent at all. That label is what
   * `imageRefusalReason` writes into the run log and onto
   * `PlanVersion.characterReferenceRefusals`, where the durable record of why a
   * character has no reference sheet then names the wrong cause for the life of
   * the plan version, because the set is never re-rendered.
   */
  it("never records a cause the provider did not give", () => {
    const misnamed = alibabaContentRefusal("qwen-image-2.0", 400, "InvalidParameter", "Input contains ip infringement");
    expect(misnamed?.reason).toBe("NO_IMAGE: InvalidParameter");
    expect(misnamed?.reason).not.toBe("InvalidParameter");
    // The evidence still reaches the copyright rewrite, which is why the
    // rejected code travels rather than being dropped.
    expect(imageRefusalCategory(misnamed)).toBe("copyright");

    const invented = alibabaContentRefusal("qwen-image-2.0", 400, undefined, "Input data may contain sensitive content.");
    expect(invented?.reason).toBe("NO_IMAGE");
    expect(invented?.reason).not.toBe("DataInspectionFailed");

    // The code arm is unchanged: DashScope's own word for a filtered render is
    // the reason, and it is the only thing that may be.
    expect(alibabaContentRefusal("qwen-image-2.0", 400, "DataInspectionFailed", "data inspection failed")?.reason).toBe(
      "DataInspectionFailed"
    );
  });

  it("reaches the same answer from the async poll, which has no status to assert", () => {
    // A filtered picture is reported as a FAILED task over an HTTP 200, so that
    // caller passes `undefined` and the status test stands down. Same body,
    // same label — a status nobody sent may not change what the record says.
    const asyncFailure = alibabaContentRefusal("qwen-image", undefined, "InvalidParameter", "Input contains ip infringement");
    expect(asyncFailure?.reason).toBe("NO_IMAGE: InvalidParameter");
    expect(asyncFailure?.provider).toBe("alibaba");
    expect(asyncFailure?.model).toBe("qwen-image");
  });

  it("declines a status that is not the filter's, and an error body that names an outage", () => {
    expect(alibabaContentRefusal("qwen-image-2.0", 503, "DataInspectionFailed", "data inspection failed")).toBeUndefined();
    expect(
      alibabaContentRefusal(
        "qwen-image-2.0",
        400,
        "DataInspectionFailed",
        "InternalError: the data inspection service is temporarily unavailable, please retry."
      )
    ).toBeUndefined();
  });
});
