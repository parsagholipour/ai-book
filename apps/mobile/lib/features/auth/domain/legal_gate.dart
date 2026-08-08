import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Whether the reader chose "Not now" on the updated-terms gate this session.
///
/// The server keeps everything readable while re-acceptance is outstanding and
/// refuses only writes (HTTP 428), so the app mirrors that instead of trapping
/// the whole session on the gate: a dismissal lets the reader back into their
/// library, and the first refused write clears it, which snaps the router back
/// to the gate. In-memory on purpose — the gate returns on the next launch.
final legalGateDismissedProvider = NotifierProvider<LegalGateDismissal, bool>(
  LegalGateDismissal.new,
);

class LegalGateDismissal extends Notifier<bool> {
  @override
  bool build() => false;

  void dismiss() => state = true;

  void reset() => state = false;
}
