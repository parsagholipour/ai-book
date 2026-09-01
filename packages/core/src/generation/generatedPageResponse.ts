export const MODEL_PAGE_ARRAY_KEYS = [
  "pages",
  "pageBeats",
  "page_beats",
  "pagebeats",
  "beats",
  "pagePlans",
  "page_plans"
] as const;
export const MODEL_PAGE_INDEX_KEYS = ["pageIndex", "pageNumber", "page", "index", "globalPageIndex"] as const;
export const MODEL_CHAPTER_INDEX_KEYS = ["chapterIndex", "chapterNumber", "chapter"] as const;
export const MODEL_PAGE_PURPOSE_KEYS = ["purpose", "pagePurpose", "goal", "objective", "function"] as const;
export const MODEL_PAGE_BEAT_KEYS = [
  "beat",
  "pageBeat",
  "action",
  "event",
  "scene",
  "description",
  "summary",
  "content"
] as const;
export const MODEL_PAGE_CONTINUITY_KEYS = ["requiredContinuity", "continuity", "continuityNotes"] as const;
export const MODEL_PAGE_ENDING_PRESSURE_KEYS = [
  "endingPressure",
  "nextPagePressure",
  "hook",
  "transition",
  "endingHook",
  "pageTurn"
] as const;
export const MODEL_PAGE_IMAGE_MOMENT_KEYS = [
  "imageMoment",
  "visualMoment",
  "imagePrompt",
  "illustrationMoment"
] as const;
/** How a model spells a page's one bounded claim (the evidence ledger, `evidenceLedger.ts`). */
export const MODEL_PAGE_CLAIM_KEYS = ["claim", "thesis", "centralClaim", "pageClaim"] as const;
/** How a model spells the cases a page argues from. */
export const MODEL_PAGE_EVIDENCE_ANCHOR_KEYS = ["evidenceAnchors", "anchors", "evidence"] as const;
