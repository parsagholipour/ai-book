import 'dart:convert';
import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

/// Which accounts on this phone have been shown the first-book offer.
///
/// Device-local on purpose: the offer is a one-time nudge, not a record, and a
/// reader who reinstalls seeing it once more costs nothing. Keyed by account so
/// a second account on the same phone still gets its own.
abstract interface class FirstBookOfferStore {
  /// True when [account] has seen the offer — and also when this phone cannot
  /// say: an offer that cannot remember being dismissed must not come back on
  /// every finished book.
  Future<bool> wasShown(String account);

  Future<void> markShown(String account);
}

/// A JSON file in the app documents directory, the same shape as the creation
/// chat's preference store.
class FileFirstBookOfferStore implements FirstBookOfferStore {
  FileFirstBookOfferStore({Directory? root}) : _override = root;

  final Directory? _override;
  Directory? _resolved;

  static const directoryName = 'tomeza_offers';
  static const _filename = 'first_book_offer.json';

  @override
  Future<bool> wasShown(String account) async {
    try {
      final file = await _file();
      if (!await file.exists()) return false;
      return (await _accounts(file)).contains(account);
    } catch (_) {
      return true;
    }
  }

  @override
  Future<void> markShown(String account) async {
    try {
      final file = await _file();
      final accounts = await file.exists() ? await _accounts(file) : <String>{};
      accounts.add(account);
      await file.writeAsString(jsonEncode({'shown': accounts.toList()}));
    } catch (_) {
      // Forgetting costs one more showing; it must never cost the book page.
    }
  }

  Future<Set<String>> _accounts(File file) async {
    final json = jsonDecode(await file.readAsString());
    final shown = json is Map ? json['shown'] : null;
    return shown is List ? shown.whereType<String>().toSet() : <String>{};
  }

  Future<File> _file() async {
    final root =
        _override ?? (_resolved ??= await getApplicationDocumentsDirectory());
    final directory = Directory('${root.path}/$directoryName');
    if (!await directory.exists()) {
      await directory.create(recursive: true);
    }
    return File('${directory.path}/$_filename');
  }
}

class MemoryFirstBookOfferStore implements FirstBookOfferStore {
  MemoryFirstBookOfferStore([Iterable<String> shown = const []])
    : _shown = {...shown};

  final Set<String> _shown;

  @override
  Future<bool> wasShown(String account) async => _shown.contains(account);

  @override
  Future<void> markShown(String account) async => _shown.add(account);
}

final firstBookOfferStoreProvider = Provider<FirstBookOfferStore>(
  (ref) => FileFirstBookOfferStore(),
);
