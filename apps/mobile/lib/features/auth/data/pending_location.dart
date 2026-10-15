import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../sharing/data/pending_remix.dart';
import '../../sharing/presentation/remix_location.dart';
import '../presentation/verify_email_location.dart';

/// The in-app location a cold start was opened on, held through the detour
/// the router makes before it can show it.
///
/// Every launch begins on the splash while the session is restored, and a
/// reader with no session goes on to sign in (and a reader owing the terms to
/// the terms screen). Each of those is a redirect away from the location the
/// app was opened on, and the landing after them used to be home: a link to
/// `/books` or `/projects/<id>` opened the app and then lost itself. Only a
/// remix link was remembered ([PendingRemix], which also survives the process
/// being killed under a password reset); this is the same idea for every
/// other screen, kept in memory because a cold start's detour happens within
/// one run.
///
/// A plain object for the same reason as [PendingRemix]: the router's
/// `redirect` reads and records it synchronously. The redirect only ever
/// peeks; the location is let go by [settle], which the router calls once a
/// page past the gates has actually been shown with a session — after the
/// navigation committed, so a second run of the same redirect still reaches
/// the same answer.
class PendingLocation {
  String? _location;
  bool _settled = false;

  /// Where the reader was going, or null.
  String? get location => _location;

  /// Records [uri] if it is a screen worth returning to and the run has not
  /// reached the app yet.
  ///
  /// Once it has, a detour is a sign-out, a lost session or terms that
  /// changed under the reader, and those keep landing at home as before:
  /// returning someone who just logged out to the screen they left would put
  /// the next account on it.
  void remember(Uri uri) {
    if (_settled || !isReturnLocation(uri)) return;
    _location = uri.toString();
  }

  /// The reader has reached the app: what was pending has been shown, or
  /// something with priority (a remix link) was shown instead. Either way the
  /// detour is over, and nothing later in this run is remembered.
  void settle() {
    _settled = true;
    _location = null;
  }
}

/// Whether [uri] is an in-app screen a reader can be returned to after the
/// detour: anything but the gates themselves, home (where the detour lands
/// anyway), and a remix link (which [PendingRemix] keeps).
bool isReturnLocation(Uri uri) {
  if (uri.hasScheme || uri.hasAuthority) return false;
  final path = uri.path;
  if (!path.startsWith('/') || path == '/' || path == '/home') return false;
  if (isDetourPath(path)) return false;
  return remixSlugFromPath(path) == null;
}

/// The screens a launch passes through on the way in: the splash, signing
/// in, the terms, the update wall, the signed-out sample and the email code
/// a new account opens on. Arriving at one of them does not end a detour.
bool isDetourPath(String path) {
  return path == '/splash' ||
      path == '/auth' ||
      path.startsWith('/auth/') ||
      path == '/legal/acceptance' ||
      path == '/update-required' ||
      path == '/sample-book' ||
      path == verifyEmailPath;
}

/// Where a reader goes once nothing stands in the way: the remix link they
/// came in on, else the screen the app was opened on, else home. The router's
/// landing and every gate screen that walks on by itself (the terms, the
/// email code) ask this, so none of them drops what the other kept.
String landingLocation(PendingRemix remix, PendingLocation location) {
  final slug = remix.slug;
  if (slug != null) return remixLocation(slug);
  return location.location ?? '/home';
}

final pendingLocationProvider = Provider<PendingLocation>((ref) {
  return PendingLocation();
});
