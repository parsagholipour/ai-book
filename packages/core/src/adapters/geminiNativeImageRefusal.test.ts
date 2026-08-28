import { BlockedReason, HarmCategory, HarmProbability } from "@google/genai";
import { describe, expect, it } from "vitest";
import { isImageContentRefusalError } from "./imageRefusal.js";
import { imageRefusalCategory } from "./imageRefusalVerdict.js";
import { missingNativeImageError } from "./geminiNativeImageRefusal.js";

/**
 * The reading `missingNativeImageError` does over a picture-less native turn,
 * one step below the adapter that calls it.
 *
 * Both partitions here are the point, and each is checked against the SDK's own
 * enum rather than a list copied out of it. `BlockedReason` has grown twice
 * already (`MODEL_ARMOR` and `JAILBREAK` are not in the six the API documents),
 * and a member nobody here has weighed has to land on the retryable side by
 * itself. Adding one to the allowlist should break this test — deliberately, on
 * its way to being a permanent verdict. `HarmCategory` is the same rule about
 * the other enum: a category the SDK adds next must keep the copyright rewrite
 * reachable unless its own name is a harm word.
 */

const blockedTurn = (blockReason: string, text?: string) =>
  missingNativeImageError(
    "gemini-2.5-flash-image",
    { promptFeedback: { blockReason } },
    { finishReason: "STOP", content: { parts: [] } },
    text ? [{ text }] : []
  );

/** A picture-less turn that also carries the safety table Gemini rates every answer with. */
const ratedTurn = (turn: {
  blockReason?: string;
  finishReason?: string;
  text?: string;
  candidateRatings?: unknown[];
  promptRatings?: unknown[];
}) =>
  missingNativeImageError(
    "gemini-2.5-flash-image",
    {
      promptFeedback: {
        ...(turn.blockReason ? { blockReason: turn.blockReason } : {}),
        ...(turn.promptRatings ? { safetyRatings: turn.promptRatings } : {})
      }
    },
    {
      finishReason: turn.finishReason ?? "STOP",
      content: { parts: [] },
      ...(turn.candidateRatings ? { safetyRatings: turn.candidateRatings } : {})
    },
    turn.text ? [{ text: turn.text }] : []
  );

/** The textbook copyright refusal: a bland decline that names a franchise and nothing else. */
const FRANCHISE_DECLINE = "I can't create an image of Spider-Man, a copyrighted character.";

const NAMES_AN_OBJECTION = new Set(["BLOCKLIST", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "SAFETY"]);

/**
 * The harm categories whose own names are never-rewritable vocabulary.
 *
 * `NEVER_REWRITABLE_CODE` is `/child|minor|csam|sexual|nudity|nude|nsfw|porn|explicit/i`
 * and a `HarmCategory` member is machine vocabulary, so the veto reads these two
 * and no others. The set is small because the enum is: Gemini publishes no
 * `HARM_CATEGORY_CHILD_SAFETY`, and a child-safety block arrives as a sexual
 * category, as `PROHIBITED_CONTENT`, or in the model's own sentence.
 */
const VETOES_THE_REWRITE = new Set([
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT"
]);

describe("missingNativeImageError", () => {
  it("settles only the block reasons that name an objection", () => {
    const settled: string[] = [];
    const retryable: string[] = [];
    for (const blockReason of Object.values(BlockedReason)) {
      (isImageContentRefusalError(blockedTurn(blockReason)) ? settled : retryable).push(blockReason);
    }

    expect(new Set(settled)).toEqual(NAMES_AN_OBJECTION);
    // Everything else — the proto zero value, the SDK's `OTHER` catch-all, and
    // the two Vertex-only reasons this API-key client cannot receive — stays a
    // render that did not happen. Being wrong here costs a few retries and a
    // fallback render; being wrong the other way costs a character its
    // reference sheet for the life of the plan version.
    expect(retryable).toContain("BLOCKED_REASON_UNSPECIFIED");
    expect(retryable).toContain("OTHER");
  });

  it("keeps a rejected block reason as a qualifier once prose settles the turn", () => {
    const error = blockedTurn("OTHER", "I can't draw a copyrighted character.");

    expect(isImageContentRefusalError(error)).toBe(true);
    // The prose is what established it, so the label says so — and the word
    // the provider sent still travels, the way DashScope's `InvalidParameter`
    // does, because a run log is where anyone would go to see it.
    expect(error).toMatchObject({ reason: "NO_IMAGE: OTHER" });
  });

  it("keeps the finish-reason allowlist reading second, under the block reason", () => {
    expect(blockedTurn("IMAGE_SAFETY")).toMatchObject({ reason: "IMAGE_SAFETY" });
    const finishOnly = missingNativeImageError(
      "gemini-2.5-flash-image",
      {},
      { finishReason: "IMAGE_RECITATION", content: { parts: [] } },
      []
    );
    expect(finishOnly).toMatchObject({ reason: "IMAGE_RECITATION" });
  });

  it("leaves a turn no field and no sentence settled a retryable failure", () => {
    const error = missingNativeImageError(
      "gemini-2.5-flash-image",
      {},
      { finishReason: "STOP", content: { parts: [] } },
      [{ text: "Here you go!" }]
    );

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });

  it("partitions the SDK's harm categories by whether a block on one may still be rewritten", () => {
    const vetoed: string[] = [];
    const rewritable: string[] = [];
    for (const category of Object.values(HarmCategory)) {
      // `IMAGE_RECITATION` is copyright evidence in the codes half, so the
      // rewrite is on the table for every category and only the veto takes it
      // away. That is what makes this a partition rather than four "other"s.
      const error = ratedTurn({ finishReason: "IMAGE_RECITATION", candidateRatings: [{ category, blocked: true }] });
      (imageRefusalCategory(error) === "copyright" ? rewritable : vetoed).push(category);
    }

    expect(new Set(vetoed)).toEqual(VETOES_THE_REWRITE);
    // A category the SDK grows next lands here by itself, and the two the enum
    // documents as unusable land here too: being wrong on this side costs one
    // rewritten prompt a child-safety filter refuses identically, being wrong
    // on the other costs a picture nobody may ask for again.
    expect(rewritable).toContain("HARM_CATEGORY_HARASSMENT");
    expect(rewritable).toContain("HARM_CATEGORY_UNSPECIFIED");
  });

  it("lets a blocked rating veto the rewrite the same turn's prose would have bought", () => {
    const error = ratedTurn({
      blockReason: "IMAGE_SAFETY",
      text: FRANCHISE_DECLINE,
      candidateRatings: [
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, probability: HarmProbability.HIGH, blocked: true }
      ]
    });

    expect(isImageContentRefusalError(error)).toBe(true);
    // The structured door: the veto reads the category out of `reason`, where
    // the filter put it, rather than out of a sentence about Spider-Man.
    expect(error).toMatchObject({ reason: "IMAGE_SAFETY: HARM_CATEGORY_SEXUALLY_EXPLICIT" });
    expect(imageRefusalCategory(error)).toBe("other");
  });

  it("keeps a merely-scored category out of the verdict, so a copyright block keeps its rewrite", () => {
    const error = ratedTurn({
      finishReason: "IMAGE_RECITATION",
      candidateRatings: [
        // Scored at the top of the range and blocked by nothing — the Imagen
        // mistake exactly, in the one shape that says so per row.
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, probability: HarmProbability.HIGH, blocked: false },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, probability: HarmProbability.MEDIUM }
      ]
    });

    expect(error).toMatchObject({ reason: "IMAGE_RECITATION" });
    expect(imageRefusalCategory(error)).toBe("copyright");
  });

  it("records every rating as diagnostics, blocked or not, and asserts with none of them", () => {
    const error = ratedTurn({
      blockReason: "SAFETY",
      candidateRatings: [
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, probability: HarmProbability.NEGLIGIBLE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, probability: HarmProbability.HIGH, blocked: true }
      ],
      promptRatings: [{ category: HarmCategory.HARM_CATEGORY_HARASSMENT, probability: HarmProbability.LOW }]
    });

    expect(error).toMatchObject({
      reason: "SAFETY: HARM_CATEGORY_SEXUALLY_EXPLICIT",
      diagnostics:
        "HARM_CATEGORY_HATE_SPEECH=NEGLIGIBLE, HARM_CATEGORY_SEXUALLY_EXPLICIT=HIGH blocked, " +
        "PROMPT HARM_CATEGORY_HARASSMENT=LOW"
    });
  });

  it("treats an ambiguous `blocked` as no assertion at all", () => {
    const error = ratedTurn({
      blockReason: "SAFETY",
      // Anything but the boolean `true` is the classifier scoring rather than
      // the filter blocking, and the cheap side is where an unreadable answer
      // belongs.
      candidateRatings: [
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, probability: HarmProbability.HIGH, blocked: "true" },
        { category: HarmCategory.HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT, blocked: 1 }
      ]
    });

    expect(error).toMatchObject({ reason: "SAFETY" });
  });

  it("leaves a rating unable to settle a turn no field and no sentence settled", () => {
    const error = ratedTurn({
      // A rating refines a refusal somebody else established; it never
      // establishes one. A picture that never arrived is not a picture that was
      // refused, and only the second is permanent.
      candidateRatings: [{ category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, blocked: true }]
    });

    expect(isImageContentRefusalError(error)).toBe(false);
    expect((error as Error).message).toContain("did not return image bytes");
  });
});
