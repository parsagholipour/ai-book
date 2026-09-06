import shutil
root='/run/media/parsa/projects/ravanix-book/ai-book-maker/'
sp='/tmp/claude-1000/-run-media-parsa-projects-ravanix-book-ai-book-maker/859a4ec3-36f9-4ef2-a446-a70e8c31d6a6/scratchpad/'
shutil.copy(sp+'chapterIntegrity.ts', root+'packages/core/src/generation/chapterIntegrity.ts')
shutil.copy(sp+'chapterIntegrity.test.ts', root+'packages/core/src/generation/chapterIntegrity.test.ts')
def patch(path, pairs):
    s=open(root+path).read()
    for old,new in pairs:
        assert old in s, (path, old[:70]); s=s.replace(old,new,1)
    open(root+path,'w').write(s)
patch('packages/core/src/index.ts', [
('export * from "./generation/chapterJudge.js";', 'export * from "./generation/chapterJudge.js";\nexport * from "./generation/chapterIntegrity.js";'),
])
patch('apps/worker/src/generation/composedChaptersPass.ts', [
('''  type EditedChapterText,
  cutChapter
} from "@book-maker/core";''', '''  type EditedChapterText,
  chapterDegeneracy,
  cutChapter
} from "@book-maker/core";'''),
('''      : [await composeChapter(composeOptions)];
    let draft = candidates[0]!;''', '''      : [await composeChapter(composeOptions)];
    let draft = candidates[0]!;
    // A draft that is not prose — a verb-chain loop, a runaway, a script the
    // book is not in — is composed once more and, if it comes back the same,
    // fails the job rather than being edited, paginated and published
    // (composed-13-fast, chapter 5, shipped at 2.8/10).
    const budgetForGuard = chapterWordBudget(input, setup.endPage - setup.startPage + 1);
    const guard = (markdown: string) => chapterDegeneracy(markdown, { maxWords: budgetForGuard.max, language: input.language });
    let degeneracy = guard(draft.markdown);
    if (degeneracy.degenerate) {
      console.warn("Composed chapter degenerate; recomposing", {
        event: "generation.composed_chapters.degenerate_draft",
        projectId,
        chapterIndex: setup.chapter.index,
        reasons: degeneracy.reasons
      });
      draft = await composeChapter({ ...composeOptions, variant: "second" });
      degeneracy = guard(draft.markdown);
      if (degeneracy.degenerate) {
        throw new Error(
          `Chapter ${setup.chapter.index} came back degenerate twice (${degeneracy.reasons.join("; ")}); the book is not published with it.`
        );
      }
    }'''),
('''      markdown = edited.markdown;
      editorChanged = edited.changed;
      shapePassApplied = shapeNotes.length > 0;''', '''      const editedDegeneracy = chapterDegeneracy(edited.markdown, { maxWords: budget.max, language: input.language });
      if (editedDegeneracy.degenerate) {
        console.warn("Edited chapter degenerate; keeping the draft", {
          event: "generation.composed_chapters.degenerate_edit",
          projectId,
          chapterIndex: setup.chapter.index,
          reasons: editedDegeneracy.reasons
        });
      } else {
        markdown = edited.markdown;
        editorChanged = edited.changed;
      }
      shapePassApplied = shapeNotes.length > 0;'''),
])
print("integrity guard applied")
