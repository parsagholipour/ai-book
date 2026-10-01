import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/plan_revision_suggestions.dart';
import 'package:tomeza/features/projects/domain/project_models.dart';

MobilePlan _plan({
  String title = 'A Book',
  String? subtitle,
  String premise = '',
  String audience = '',
}) => MobilePlan(
  id: 'plan-1',
  projectId: 'project-1',
  version: 1,
  status: 'DRAFT',
  title: title,
  subtitle: subtitle,
  premise: premise,
  audience: audience,
  questions: const [],
  chapters: const [],
  createdAt: DateTime.utc(2026, 10, 1),
  updatedAt: DateTime.utc(2026, 10, 1),
);

void main() {
  test('a bedtime story is offered story ideas for young readers', () {
    // The chips used to offer "Add more examples" to a six-year-old's story.
    final ideas = planRevisionSuggestionsFor(
      bookType: 'short_story',
      plan: _plan(
        title: 'Tiko and the Quiet Sea',
        premise: 'Shy little Tiko longs to see the sea.',
        audience: 'Children around age six, as a calm read-aloud at bedtime.',
      ),
    );

    expect(ideas, contains('Make it gentler'));
    expect(ideas, isNot(contains('Add more examples')));
  });

  test('an adult story is offered story ideas', () {
    final ideas = planRevisionSuggestionsFor(
      bookType: 'short_story',
      plan: _plan(
        premise: 'A detective returns to the town that ruined her career.',
        audience: 'Adult readers of literary crime.',
      ),
    );

    expect(ideas, containsAll(['Raise the stakes', 'Change the ending']));
    expect(ideas, isNot(contains('Make it gentler')));
  });

  test('an Auto book whose plan tells a story is treated as one', () {
    final ideas = planRevisionSuggestionsFor(
      bookType: 'custom',
      plan: _plan(
        premise: 'A gentle bedtime story about a fox who cannot sleep.',
        audience: '5-year-olds',
      ),
    );

    expect(ideas, contains('Use simpler words'));
  });

  test(
    'a guide keeps the non-fiction ideas, and a workbook gets exercises',
    () {
      final guide = _plan(
        premise: 'A practical guide to balcony vegetable gardening.',
        audience: 'Renters with no gardening experience.',
      );

      expect(
        planRevisionSuggestionsFor(bookType: 'custom', plan: guide),
        planRevisionSuggestions,
      );
      expect(
        planRevisionSuggestionsFor(bookType: 'workbook', plan: guide),
        contains('Add more exercises'),
      );
    },
  );

  test('an Auto book filed as literary fiction is treated as a story', () {
    // "The Light Between Tides" (2026-10-01): an Auto adult story whose plan
    // said "A short story" and "literary fiction" got "Add more examples".
    final ideas = planRevisionSuggestionsFor(
      bookType: 'custom',
      plan: _plan(
        title: 'The Light Between Tides',
        subtitle: 'A short story',
        premise: "An elderly lighthouse keeper's solitude is interrupted by a letter.",
        audience: 'Adult readers of quiet literary fiction',
      ),
    );
    expect(ideas, contains('Change the ending'));

    final noSubtitle = planRevisionSuggestionsFor(
      bookType: 'custom',
      plan: _plan(title: 'Tides', premise: 'A keeper reads a letter.', audience: 'Readers of literary fiction'),
    );
    expect(noSubtitle, contains('Change the ending'));
  });

  test('non-fiction is not mistaken for fiction', () {
    final ideas = planRevisionSuggestionsFor(
      bookType: 'custom',
      plan: _plan(title: 'Dinner Week', premise: 'A plan for weeknight meals.', audience: 'Busy parents who read non-fiction'),
    );
    expect(ideas, contains('Add more examples'));
  });

  test('an Auto story written in Persian is offered story ideas', () {
    // Nothing in this plan is an English word the cue could match; the
    // server filed it as a story, and that is what decides.
    final plan = _plan(
      title: 'نانِ پشتِ در',
      subtitle: 'داستانی از یک صبح در کاشان',
      audience: 'خوانندگان داستان‌های کوتاه فارسی‌زبان',
    );
    expect(
      planRevisionSuggestionsFor(bookType: 'custom', plan: plan),
      contains('Add more examples'),
    );
    final ideas = planRevisionSuggestionsFor(
      bookType: 'custom',
      bookShape: 'story',
      plan: plan,
    );
    expect(ideas, contains('Raise the stakes'));
    expect(ideas, isNot(contains('Add more examples')));
    expect(
      planRevisionSuggestionsFor(
        bookType: 'custom',
        bookShape: 'children_story',
        plan: plan,
      ),
      contains('Make it gentler'),
    );
  });
}
