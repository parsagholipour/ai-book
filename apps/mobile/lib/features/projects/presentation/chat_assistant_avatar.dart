import 'package:flutter/material.dart';

import '../../../shared/ui/tomeza_brand.dart';

/// The assistant's face in a transcript. A brand mark rather than a photo: it
/// says who is talking without pretending to be a person.
///
/// Decorative — the bubble beside it carries the words — so it is kept out of
/// the semantics tree.
class ChatAssistantAvatar extends StatelessWidget {
  const ChatAssistantAvatar({super.key});

  static const size = 28.0;

  /// What the avatar and its gap take out of a row, for anything that has to
  /// line up under the bubble it sits beside.
  static const slot = size + 8;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ExcludeSemantics(
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: colors.primaryContainer,
          shape: BoxShape.circle,
        ),
        child: SizedBox.square(
          dimension: size,
          child: Center(
            child: TomezaBrandMark(size: 16, color: colors.onPrimaryContainer),
          ),
        ),
      ),
    );
  }
}
