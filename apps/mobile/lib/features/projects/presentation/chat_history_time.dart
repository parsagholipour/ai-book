import 'package:flutter/material.dart' show MaterialLocalizations;

import '../domain/creation_models.dart';

/// One dated section of the chat history.
class ChatDateGroup {
  const ChatDateGroup({required this.label, required this.sessions});

  final String label;
  final List<MobileChatSession> sessions;
}

/// Sections a newest-first list of chats by when the conversation last moved.
///
/// Recent chats get named windows a reader can find by memory — Today,
/// Yesterday, the last week, the last month. Anything older is filed by calendar
/// month, because one "Older" heading over a year of chats is the same wall of
/// rows the sections exist to break up.
///
/// Calendar arithmetic rather than `Duration`, so a daylight-saving change never
/// files a chat under the wrong day.
List<ChatDateGroup> groupChatSessions(
  List<MobileChatSession> sorted, {
  required DateTime now,
  required String Function(DateTime month) monthLabel,
}) {
  final today = DateTime(now.year, now.month, now.day);
  final yesterday = DateTime(now.year, now.month, now.day - 1);
  final weekAgo = DateTime(now.year, now.month, now.day - 7);
  final monthAgo = DateTime(now.year, now.month, now.day - 30);

  final groups = <ChatDateGroup>[];
  String? currentLabel;
  var currentItems = <MobileChatSession>[];

  void add(String label, MobileChatSession session) {
    if (label != currentLabel) {
      if (currentLabel != null) {
        groups.add(ChatDateGroup(label: currentLabel!, sessions: currentItems));
      }
      currentLabel = label;
      currentItems = <MobileChatSession>[];
    }
    currentItems.add(session);
  }

  for (final session in sorted) {
    final at = session.lastMessageAt.toLocal();
    final date = DateTime(at.year, at.month, at.day);
    if (!date.isBefore(today)) {
      add('Today', session);
    } else if (!date.isBefore(yesterday)) {
      add('Yesterday', session);
    } else if (!date.isBefore(weekAgo)) {
      add('Last 7 days', session);
    } else if (!date.isBefore(monthAgo)) {
      add('Last 30 days', session);
    } else {
      add(monthLabel(DateTime(at.year, at.month)), session);
    }
  }
  if (currentLabel != null) {
    groups.add(ChatDateGroup(label: currentLabel!, sessions: currentItems));
  }
  return groups;
}

/// How long ago a chat last moved, in the shortest words that still tell two
/// chats from the same day apart: "Just now", "5m ago", "3h ago", "Yesterday",
/// "4d ago", then the date.
String relativeChatTime(
  DateTime at, {
  required DateTime now,
  required MaterialLocalizations localizations,
}) {
  final local = at.toLocal();
  final elapsed = now.difference(local);
  if (elapsed < const Duration(minutes: 1)) return 'Just now';
  if (elapsed < const Duration(hours: 1)) return '${elapsed.inMinutes}m ago';

  // UTC midnights: two local midnights across a clock change are 23 or 25
  // hours apart, and would round to the wrong number of days.
  final days = DateTime.utc(
    now.year,
    now.month,
    now.day,
  ).difference(DateTime.utc(local.year, local.month, local.day)).inDays;
  if (days <= 0) return '${elapsed.inHours}h ago';
  if (days == 1) return 'Yesterday';
  if (days < 7) return '${days}d ago';
  final shortDate = localizations.formatShortMonthDay(local);
  return local.year == now.year ? shortDate : '$shortDate, ${local.year}';
}
