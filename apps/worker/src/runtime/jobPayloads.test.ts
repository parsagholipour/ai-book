import { describe, expect, expectTypeOf, it } from "vitest";
import { jobNames, type WorkerJobName } from "@book-maker/core";
import {
  jobPayloadSchemas,
  parseWorkerJobData,
  type EnqueuePayloadForType,
  type WorkerJobPayloadByName
} from "./jobPayloads.js";

const projectFields = {
  projectId: "project-1",
  generationJobId: "generation-job-1",
  attemptId: "attempt-1"
} as const;

const validPayloads = {
  [jobNames.PLAN_BOOK]: { ...projectFields, inputSnapshot: { title: "A book" } },
  [jobNames.REVISE_PLAN]: { ...projectFields, planId: "plan-1", message: "Make it warmer" },
  [jobNames.GENERATE_BOOK]: { ...projectFields, planId: "plan-1" },
  [jobNames.GENERATE_PAGE]: { ...projectFields, planId: "plan-1", pageId: "page-1" },
  [jobNames.GENERATE_IMAGE]: {
    ...projectFields,
    planId: "plan-1",
    pageId: "page-1",
    prompt: "A moonlit harbor"
  },
  [jobNames.COMPILE_EXPORT]: { ...projectFields, planId: "plan-1", contentRevision: 3 },
  [jobNames.APPLY_BOOK_EDIT]: {
    ...projectFields,
    operationId: "operation-1",
    request: "Shorten the opening",
    affectedPageIndexes: [1]
  },
  [jobNames.REPLAN_BOOK]: {
    ...projectFields,
    operationId: "operation-1",
    request: "Rebuild it as a mystery"
  },
  [jobNames.PREPARE_CHARACTER_CANDIDATES]: { ...projectFields, planId: "plan-1" },
  [jobNames.BUILD_CHARACTER_PERSONA]: { ...projectFields, voiceCharacterId: "voice-character-1" },
  [jobNames.IMPORT_BOOK]: { ...projectFields, importId: "import-1", language: null },
  [jobNames.CONTINUE_BOOK]: {
    ...projectFields,
    operationId: "operation-1",
    request: "Add one final chapter",
    chapterCount: 1,
    newPageCount: 5
  },
  [jobNames.GENERATE_AUDIOBOOK]: { ...projectFields, audiobookId: "audiobook-1" },
  [jobNames.GENERATE_CHARACTER_PORTRAIT]: {
    generationJobId: "generation-job-1",
    attemptId: "attempt-1",
    libraryCharacterId: "library-character-1",
    userId: "user-1"
  }
} as const satisfies { [Name in WorkerJobName]: WorkerJobPayloadByName[Name] };

describe("worker job payload schemas", () => {
  it("covers exactly every job name exported by core", () => {
    expect(Object.keys(jobPayloadSchemas).sort()).toEqual(Object.values(jobNames).sort());
  });

  it("accepts and narrows a valid payload for every job name", () => {
    for (const name of Object.values(jobNames)) {
      const payload = parseWorkerJobData(name, validPayloads[name]);
      expect(payload.generationJobId).toBe("generation-job-1");
    }

    const page = parseWorkerJobData(jobNames.GENERATE_PAGE, validPayloads[jobNames.GENERATE_PAGE]);
    expectTypeOf(page.pageId).toEqualTypeOf<string>();
    expect(page.pageId).toBe("page-1");

    const portrait = parseWorkerJobData(
      jobNames.GENERATE_CHARACTER_PORTRAIT,
      validPayloads[jobNames.GENERATE_CHARACTER_PORTRAIT]
    );
    expectTypeOf(portrait.libraryCharacterId).toEqualTypeOf<string>();
    expect(portrait.projectId).toBeUndefined();
  });

  it("rejects a missing durable identifier for every job with a descriptive error", () => {
    for (const name of Object.values(jobNames)) {
      const { generationJobId: _missing, ...malformed } = validPayloads[name];
      expect(() => parseWorkerJobData(name, malformed)).toThrow(
        new RegExp(`Invalid payload for worker job "${name}"[\\s\\S]*generationJobId`)
      );
    }
  });

  it("reports name-specific missing identifiers before a handler can guess them", () => {
    const { pageId: _missing, ...malformed } = validPayloads[jobNames.GENERATE_PAGE];
    expect(() => parseWorkerJobData(jobNames.GENERATE_PAGE, malformed)).toThrow(/pageId/);
  });

  it("preserves legacy fields while validating known fields", () => {
    const payload = parseWorkerJobData(jobNames.GENERATE_BOOK, {
      ...validPayloads[jobNames.GENERATE_BOOK],
      legacyResumeMarker: "kept"
    });
    expect(payload.legacyResumeMarker).toBe("kept");
  });

  it("keeps worker fan-out payloads paired with their durable job type", () => {
    const pageFanout = { planId: "plan-1", pageId: "page-1" } satisfies EnqueuePayloadForType<"GENERATE_PAGE">;
    expect(pageFanout.pageId).toBe("page-1");

    // @ts-expect-error GENERATE_PAGE fan-out cannot omit its page identifier.
    const mismatchedFanout: EnqueuePayloadForType<"GENERATE_PAGE"> = { planId: "plan-1" };
    expect(mismatchedFanout).toBeDefined();
  });

  it("does not require or accept a project id for account-level character portraits", () => {
    expect(() =>
      parseWorkerJobData(
        jobNames.GENERATE_CHARACTER_PORTRAIT,
        validPayloads[jobNames.GENERATE_CHARACTER_PORTRAIT]
      )
    ).not.toThrow();
    expect(() =>
      parseWorkerJobData(jobNames.GENERATE_CHARACTER_PORTRAIT, {
        ...validPayloads[jobNames.GENERATE_CHARACTER_PORTRAIT],
        projectId: "project-1"
      })
    ).toThrow(/projectId/);
  });
});
