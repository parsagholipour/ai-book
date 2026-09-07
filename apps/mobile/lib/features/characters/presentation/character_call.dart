import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/api/api_error.dart';
import '../../../shared/ui/feedback/app_snack_bar.dart';
import '../../voice/data/voice_repository.dart';
import '../../voice/domain/voice_models.dart';
import '../../voice/presentation/voice_call_launcher.dart';
import '../domain/character_models.dart';

/// Rings one of the reader's own saved characters.
///
/// The same call a book's cast member gets — the same screen, meter and
/// memory — placed from the character's page instead of a cast sheet. The
/// library cast is re-read on every tap rather than watched: it carries the
/// balance and the price, both of which move between taps, and one small GET
/// is a fair price for a toast that names the right number.
///
/// [onCastLoaded] fires once that read is in, before any gate: it is the end of
/// the only wait a surface should show a spinner for. The disclosure and the
/// call screen after it are the reader's own time.
Future<void> callLibraryCharacter({
  required BuildContext context,
  required WidgetRef ref,
  required LibraryCharacter character,
  VoidCallback? onCastLoaded,
}) async {
  final messenger = ScaffoldMessenger.of(context);
  final VoiceCast cast;
  try {
    cast = await ref.refresh(voiceCastProvider(null).future);
  } catch (error) {
    onCastLoaded?.call();
    messenger.showAppSnackBar(SnackBar(content: Text(userFacingError(error))));
    return;
  }
  onCastLoaded?.call();
  if (!context.mounted) return;
  await launchVoiceCall(
    context: context,
    ref: ref,
    projectId: null,
    character: voiceCharacterFor(character, cast),
    cast: cast,
  );
}

/// The saved character as the call screen takes them.
///
/// The server's entry wins when it is there: it carries the picture the
/// profile shows through an immutable URL. A character the cast has not caught
/// up with yet — saved a moment ago — is built from what the app already
/// holds, so the call goes through either way.
VoiceCharacter voiceCharacterFor(LibraryCharacter character, VoiceCast cast) {
  for (final entry in cast.characters) {
    if (entry.id == character.id) return entry;
  }
  return VoiceCharacter(
    id: character.id,
    name: character.name,
    role: '',
    description: character.description,
    traits: const [],
    status: VoiceCharacterStatus.ready,
    needsPreparation: false,
    libraryCharacterId: character.id,
    libraryPortraitUrl: character.displayImageUrl,
  );
}
