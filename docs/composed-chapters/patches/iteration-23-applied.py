import re
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:80]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)

# 1. composed pages: only the integrity rules may send a typesetting cut back to a per-page rewrite
patch('packages/core/src/generation/pagesLocalQa.ts', [
('''export function reviewRequiredPageQualityChecks(options: ReviewPageOptions): PageQualityReport {''',
 '''/**
 * A composed chapter's page is where the typesetter cut, so the page-shape
 * rules (dash density, openers, progression) have nothing to say about it and
 * a rewrite from them undoes composed prose in isolation — one page per book
 * was being rewritten on the dash rule. Only the two integrity rules may fail
 * such a page.
 */
export function composedPageQualityReport(report: PageQualityReport): PageQualityReport {
  const approved = report.checks.placeholderFree && report.checks.promptLeakFree;
  if (approved === report.approved) {
    return report;
  }
  return {
    ...report,
    approved,
    checks: { ...PASSING_PAGE_CHECKS, placeholderFree: report.checks.placeholderFree, promptLeakFree: report.checks.promptLeakFree },
    issues: approved ? [] : report.issues,
    requiredRevisions: approved ? [] : report.requiredRevisions
  };
}

export function reviewRequiredPageQualityChecks(options: ReviewPageOptions): PageQualityReport {'''),
])
patch('apps/worker/src/generation/wholeBookPageReview.ts', [
('''    let report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality,
      allowModelReview: false,
      reviewOptions: {
        input: options.input,
        plan: options.plan,
        pageIndex: pageDraft.index,
        draft,
        previousPages,
        continuityNotes: [],
        textModel: options.textModel
      }
    });''',
 '''    let report = await reviewPageWithQualityGates({
      strategy: options.strategy,
      quality,
      allowModelReview: false,
      reviewOptions: {
        input: options.input,
        plan: options.plan,
        pageIndex: pageDraft.index,
        draft,
        previousPages,
        continuityNotes: [],
        textModel: options.textModel
      }
    });
    if (strategyComposesChapters(options.strategy)) {
      report = composedPageQualityReport(report);
    }'''),
])
s=open(root+'apps/worker/src/generation/wholeBookPageReview.ts').read()
m=re.search(r'import \{([^}]*)\} from "@book-maker/core";', s)
assert m
add=[n for n in ('composedPageQualityReport','strategyComposesChapters') if n not in m.group(1)]
if add:
    s=s.replace(m.group(0), 'import {'+m.group(1).rstrip()+',\n  '+',\n  '.join(add)+'\n} from "@book-maker/core";',1)
open(root+'apps/worker/src/generation/wholeBookPageReview.ts','w').write(s)

# 2. the previous chapter's tail: 300 words is a landing, 1,200 was a third of a chapter re-sent twice
patch('packages/core/src/generation/composedChapter.ts', [
('''export const PREVIOUS_CHAPTER_TAIL_WORDS = 1200;''',
 '''/** 1,200 words was a third of the previous chapter, sent to both the compose and the edit call; 300 is its landing. */
export const PREVIOUS_CHAPTER_TAIL_WORDS = 300;'''),
# 3. digests carry what each earlier chapter told, and are short
('''export type EarlierChapterDigest = { index: number; title: string; digest: string };''',
 '''export type EarlierChapterDigest = {
  index: number;
  title: string;
  digest: string;
  /** The cases, sources, scenes and people that chapter's sections owned: already told, named only. */
  told?: string[] | undefined;
};'''),
('''earlierChapters are digests of what the reader already knows; a case one of them carried may be named in passing, never re-told, and its dates and figures are not repeated.",''',
 '''earlierChapters are digests of what the reader already knows, each with told: the cases, sources, scenes and people that chapter carried; anything in told may be named in passing and is never re-told, and its dates and figures are not repeated.",'''),
])
patch('apps/worker/src/generation/composedChaptersPass.ts', [
('''      .map((candidate) => ({
        index: candidate.chapter.index,
        title: candidate.chapter.title,
        digest:
          digests.get(candidate.chapter.index) ??
          provisionalDigests.get(candidate.chapter.index) ??
          candidate.chapter.summary
      }));''',
 '''      .map((candidate) => {
        const digest =
          digests.get(candidate.chapter.index) ?? provisionalDigests.get(candidate.chapter.index) ?? candidate.chapter.summary;
        const told = [...new Set(compositionFor(candidate).sections.flatMap((section) => section.owns ?? []))];
        return {
          index: candidate.chapter.index,
          title: candidate.chapter.title,
          // Sixty words: 11k characters of digests rode in every call before.
          digest: digest.split(/\\s+/).slice(0, 60).join(" "),
          ...(told.length > 0 ? { told } : {})
        };
      });'''),
])
# 4. section counts assigned per chapter, cycling through the range: the planner asked to vary them returned 4–5 everywhere
patch('packages/core/src/generation/chapterForms.ts', [
('''                sectionCount: sectionCountForPages(range.endPage - range.startPage + 1)''',
 '''                // Assigned, not requested: told to vary the count the planner returned
                // 4 or 5 everywhere (composed-22); a count is a content assignment.
                sectionCount: assignedSectionCount(range.chapter.index, range.endPage - range.startPage + 1)'''),
('''export function sectionCountForPages(pageCount: number): { min: number; max: number } {''',
 '''/** One count per chapter, walking the range so consecutive chapters differ and the book uses the whole range. */
export function assignedSectionCount(chapterIndex: number, pageCount: number): { min: number; max: number } {
  const { min, max } = sectionCountForPages(pageCount);
  const span = max - min + 1;
  const offsets = [0, 2, 1, 3, 0, 2, 1, 3];
  const count = min + (offsets[(Math.max(1, chapterIndex) - 1) % offsets.length]! % span);
  return { min: count, max: count };
}

export function sectionCountForPages(pageCount: number): { min: number; max: number } {'''),
])
print("iteration 23 applied")
