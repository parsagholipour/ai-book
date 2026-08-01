import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../voice/presentation/character_cast_sheet.dart';

/// The ways out of the reader: calling a character, or switching to listening.
///
/// Split from the reading surface for the same reason as [ReaderPlaces] and
/// [ReaderMarkupActions]: `ReaderView` is about rendering a PDF and holding the
/// viewer's parameters still, while these hand the reader off to another
/// surface. Built fresh at each call site from the view's current state.
///
/// Both departures want to know where the reader is in the *book*, not in the
/// PDF, which is why the page index arrives as a resolver rather than a number:
/// working it out means reading text off the rendered page.
class ReaderDepartures {
  const ReaderDepartures({
    required this.context,
    required this.projectId,
    required this.bookPageIndex,
    required this.isMounted,
  });

  final BuildContext context;
  final String projectId;
  final Future<int?> Function() bookPageIndex;
  final bool Function() isMounted;

  /// Opens the cast so the reader can talk to someone from the scene they are
  /// actually on.
  Future<void> callCharacter() async {
    final pageIndex = await bookPageIndex();
    // Working out the page means reading text off the rendered PDF, so the
    // reader may well have closed the book by the time it lands.
    if (!isMounted() || !context.mounted) {
      return;
    }
    await showCharacterCastSheet(
      context: context,
      projectId: projectId,
      pageIndex: pageIndex,
    );
  }

  /// Hands the book over to the audiobook player.
  void listen() {
    context.push('/projects/$projectId/listen');
  }
}
