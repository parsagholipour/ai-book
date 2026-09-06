import { describe, expect, it } from 'vitest';
import { editManuscriptDevelopment, type DevelopmentEditPlan } from './developmentalEdit.js';
import {
  developmentInput,
  originalDevelopmentPlan,
  scriptedDevelopmentModel,
} from './testing/bookDevelopmentFixtures.js';

type EditGroup = DevelopmentEditPlan['groups'][number];
type EditChange = EditGroup['changes'][number];

const claimOpening = 'Keep this exact opening.';
const claimRepeated = 'A repeated explanation belongs later.';
const claimClosing = 'Keep this exact closing.';
const appealOpening = 'The appeal opens here.';
const appealEvidence = 'Existing evidence remains in place.';
const appealMarkdown = `${appealOpening}\n\n${appealEvidence}`;
const insertedText = 'The appeal reopens this disputed factual question.';

const chapters = [
  { index: 1, title: 'Claim', markdown: `${claimOpening}\n\n${claimRepeated}\n\n${claimClosing}` },
  { index: 2, title: 'Appeal', markdown: appealMarkdown },
];
const wordBudget = { min: 15, target: 30, max: 50 };

function deletion(id: string, chapterIndex: number, startParagraph: number): EditChange {
  return {
    id,
    chapterIndex,
    startParagraph,
    deleteCount: 1,
    targetWords: 0,
    instruction: `Delete paragraph ${startParagraph} of chapter ${chapterIndex}.`,
  };
}

const cutGroup: EditGroup = {
  id: 'cut',
  reason: 'The repeated explanation adds nothing to the claim.',
  changes: [deletion('remove', 1, 2)],
};

const moveGroup: EditGroup = {
  id: 'move',
  reason: 'The repeated explanation belongs in the appeal.',
  changes: [
    deletion('move-remove', 1, 2),
    {
      id: 'insert',
      chapterIndex: 2,
      startParagraph: 2,
      deleteCount: 0,
      targetWords: 6,
      instruction: 'Reintroduce the disputed question before the existing evidence.',
    },
  ],
};

const moveResponse = {
  replacements: [
    { id: 'move-remove', text: '' },
    { id: 'insert', text: insertedText },
  ],
};

async function runEdit(editPlan: DevelopmentEditPlan, responses: unknown[] = []) {
  const { model, calls } = scriptedDevelopmentModel([editPlan, ...responses]);
  const result = await editManuscriptDevelopment({
    input: developmentInput,
    plan: originalDevelopmentPlan(),
    chapters,
    wordBudget,
    textModel: model,
  });
  return { result, calls };
}

function markdownOf(
  edited: ReadonlyArray<{ index: number; markdown: string }>,
  index: number,
): string {
  const chapter = edited.find((candidate) => candidate.index === index);
  if (!chapter) throw new Error(`Chapter ${index} missing from edited manuscript`);
  return chapter.markdown;
}

describe('editManuscriptDevelopment group isolation', () => {
  it('rejects a group with overlapping deletions and still applies the later valid cut', async () => {
    const badOverlap: EditGroup = {
      id: 'bad-overlap',
      reason: 'Two deletions collide on the opening paragraph.',
      changes: [deletion('overlap-a', 1, 1), deletion('overlap-b', 1, 1)],
    };

    const { result, calls } = await runEdit({ groups: [badOverlap, cutGroup] });

    expect(result.appliedGroups).toEqual(['cut']);
    const rejected = result.rejectedGroups.find((group) => group.id === 'bad-overlap');
    expect(rejected?.reason).toContain('overlapping range');
    const claim = markdownOf(result.chapters, 1);
    expect(claim).toContain(claimOpening);
    expect(claim).toContain(claimClosing);
    expect(claim).not.toContain(claimRepeated);
    expect(calls.map((call) => call.purpose)).toEqual(['plan-developmental-edit']);
  });

  it('applies a pure deletion with only the planner call and leaves other chapters untouched', async () => {
    const { result, calls } = await runEdit({ groups: [cutGroup] });

    expect(result.appliedGroups).toEqual(['cut']);
    expect(calls).toHaveLength(1);
    expect(calls.map((call) => call.purpose)).toEqual(['plan-developmental-edit']);
    expect(markdownOf(result.chapters, 2)).toBe(appealMarkdown);
  });

  it('drops an out-of-range group without breaking the linked move that follows it', async () => {
    const badRange: EditGroup = {
      id: 'bad-range',
      reason: 'Targets a paragraph that does not exist.',
      changes: [deletion('range-remove', 1, 999)],
    };

    const { result, calls } = await runEdit({ groups: [badRange, moveGroup] }, [moveResponse]);

    expect(result.appliedGroups).toEqual(['move']);
    expect(result.rejectedGroups.map((group) => group.id)).toContain('bad-range');
    const claim = markdownOf(result.chapters, 1);
    expect(claim).toContain(claimOpening);
    expect(claim).toContain(claimClosing);
    expect(claim).not.toContain(claimRepeated);
    const appeal = markdownOf(result.chapters, 2);
    expect(appeal).toContain(appealOpening);
    expect(appeal).toContain(insertedText);
    expect(appeal).toContain(appealEvidence);
    expect(calls.map((call) => call.purpose)).toEqual([
      'plan-developmental-edit',
      'rewrite-developmental-sections',
    ]);
  });

  it('reserves ranges only for accepted groups so the first deletion wins a collision', async () => {
    const first: EditGroup = {
      id: 'first',
      reason: 'Remove the repeated explanation.',
      changes: [deletion('first-remove', 1, 2)],
    };
    const collision: EditGroup = {
      id: 'collision',
      reason: 'Also remove the repeated explanation.',
      changes: [deletion('collision-remove', 1, 2)],
    };

    const { result, calls } = await runEdit({ groups: [first, collision] });

    expect(result.appliedGroups).toEqual(['first']);
    const rejected = result.rejectedGroups.find((group) => group.id === 'collision');
    expect(rejected?.reason).toContain('overlapping range');
    const claim = markdownOf(result.chapters, 1);
    expect(claim).toContain(claimOpening);
    expect(claim).toContain(claimClosing);
    expect(claim).not.toContain(claimRepeated);
    expect(calls).toHaveLength(1);
    expect(calls.map((call) => call.purpose)).toEqual(['plan-developmental-edit']);
  });
});
