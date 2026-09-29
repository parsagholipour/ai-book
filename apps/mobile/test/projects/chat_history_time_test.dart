import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_models.dart';
import 'package:tomeza/features/projects/presentation/chat_history_time.dart';

void main() {
  // A fixed "now" mid-afternoon, so day boundaries are unambiguous.
  final now = DateTime(2026, 9, 29, 15);
  final localizations = DefaultMaterialLocalizations();

  MobileChatSession session(String id, DateTime at) => MobileChatSession(
    draftId: id,
    title: id,
    preview: '',
    messageCount: 1,
    status: 'ACTIVE',
    createdAt: at,
    updatedAt: at,
    lastMessageAt: at,
  );

  String month(DateTime at) => localizations.formatMonthYear(at);

  group('groupChatSessions', () {
    test('names recent windows, then files older chats by month', () {
      final groups = groupChatSessions(
        [
          session('today', DateTime(2026, 9, 29, 9)),
          session('yesterday', DateTime(2026, 9, 28, 23)),
          session('week', DateTime(2026, 9, 24)),
          session('month', DateTime(2026, 9, 5)),
          session('august', DateTime(2026, 8, 12)),
          session('august-early', DateTime(2026, 8, 2)),
          session('last-year', DateTime(2025, 12, 31)),
        ],
        now: now,
        monthLabel: month,
      );

      expect(groups.map((group) => group.label), [
        'Today',
        'Yesterday',
        'Last 7 days',
        'Last 30 days',
        month(DateTime(2026, 8)),
        month(DateTime(2025, 12)),
      ]);
      // Two chats in one month share one heading.
      expect(groups[4].sessions.map((s) => s.draftId), [
        'august',
        'august-early',
      ]);
    });

    test('an empty history has no sections', () {
      expect(groupChatSessions(const [], now: now, monthLabel: month), isEmpty);
    });
  });

  group('relativeChatTime', () {
    String at(DateTime value) =>
        relativeChatTime(value, now: now, localizations: localizations);

    test('counts minutes, then hours, within the day', () {
      expect(at(DateTime(2026, 9, 29, 14, 59, 40)), 'Just now');
      expect(at(DateTime(2026, 9, 29, 14, 25)), '35m ago');
      expect(at(DateTime(2026, 9, 29, 11, 30)), '3h ago');
    });

    test('names yesterday and counts days inside the week', () {
      expect(at(DateTime(2026, 9, 28, 23, 50)), 'Yesterday');
      expect(at(DateTime(2026, 9, 26, 8)), '3d ago');
    });

    test('falls back to the date, with the year only when it differs', () {
      expect(
        at(DateTime(2026, 9, 1)),
        localizations.formatShortMonthDay(DateTime(2026, 9, 1)),
      );
      expect(
        at(DateTime(2025, 3, 4)),
        '${localizations.formatShortMonthDay(DateTime(2025, 3, 4))}, 2025',
      );
    });

    test('a time in the future never reads as negative', () {
      expect(at(DateTime(2026, 9, 29, 15, 5)), 'Just now');
    });
  });
}
