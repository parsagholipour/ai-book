import 'dart:async';

import 'package:tomeza/features/book_matter/data/book_matter_repository.dart';
import 'package:tomeza/features/book_matter/domain/author_profile.dart';
import 'package:tomeza/features/book_matter/domain/book_matter.dart';
import 'package:tomeza/shared/api/api_error.dart';

/// One call the fake answered, with the body it was sent.
class FakeMatterCall {
  const FakeMatterCall(this.method, {this.projectId, this.body = const {}});

  final String method;
  final String? projectId;
  final Map<String, Object?> body;

  @override
  String toString() => '$method ${projectId ?? ''} $body'.trim();
}

/// An in-memory profile and book-matter server for widget tests. Partial
/// updates merge the way the real routes do — a key present replaces, a
/// null clears — and every call lands in [calls].
class FakeBookMatterRepository implements BookMatterRepository {
  FakeBookMatterRepository({
    this.profile = const AuthorProfile(),
    this.matter = const BookMatter(),
    this.reprint = BookMatterReprint.queued,
    this.cover = BookMatterCover.unchanged,
    this.removalReprint = BookMatterReprint.queued,
  });

  AuthorProfile profile;
  BookMatter matter;
  BookMatterReprint reprint;
  BookMatterCover cover;

  /// What a `remove-credit` call answers with.
  BookMatterReprint removalReprint;
  final List<FakeMatterCall> calls = [];

  Object? profileReadError;
  Object? profileWriteError;
  Object? matterReadError;
  Object? matterWriteError;
  Object? removeCreditError;

  /// Holds every write until the test completes it.
  Completer<void>? writeGate;

  List<FakeMatterCall> get writes => [
    for (final call in calls)
      if (call.method != 'GET profile' && call.method != 'GET matter') call,
  ];

  static ApiException refusal(List<String> fields) => ApiException(
    code: 'CONTENT_RESTRICTED',
    message: 'That can’t be printed in a book.',
    statusCode: 422,
    details: {'code': 'CONTENT_RESTRICTED', 'fields': fields},
  );

  static const busy = ApiException(
    code: 'PROJECT_BUSY',
    message: 'Project is busy.',
    statusCode: 409,
  );

  static const subscriptionRequired = ApiException(
    code: 'SUBSCRIPTION_REQUIRED',
    message: 'Removing the “Made with Tomeza” line comes with any plan.',
    statusCode: 403,
  );

  static const unfinished = ApiException(
    code: 'PROJECT_BUSY',
    message: 'Wait for this book to finish, then try again.',
    statusCode: 409,
  );

  @override
  Future<AuthorProfile> getAuthorProfile() async {
    calls.add(const FakeMatterCall('GET profile'));
    final error = profileReadError;
    if (error != null) throw error;
    return profile;
  }

  @override
  Future<AuthorProfile> updateAuthorProfile(AuthorProfileUpdate update) async {
    final body = update.toJson();
    calls.add(FakeMatterCall('PUT profile', body: body));
    await writeGate?.future;
    final error = profileWriteError;
    if (error != null) throw error;
    profile = AuthorProfile.fromJson({...profile.toJson(), ...body});
    return profile;
  }

  @override
  Future<BookMatter> getBookMatter(String projectId) async {
    calls.add(FakeMatterCall('GET matter', projectId: projectId));
    final error = matterReadError;
    if (error != null) throw error;
    return matter;
  }

  @override
  Future<BookMatterSaved> updateBookMatter(
    String projectId,
    BookMatterUpdate update,
  ) async {
    final body = update.toJson();
    calls.add(FakeMatterCall('PATCH matter', projectId: projectId, body: body));
    await writeGate?.future;
    final error = matterWriteError;
    if (error != null) throw error;
    matter = BookMatter.fromJson({...matter.toJson(), ...body});
    return BookMatterSaved(bookMatter: matter, reprint: reprint, cover: cover);
  }

  @override
  Future<BookMatterCreditRemoval> removeTomezaCredit(String projectId) async {
    calls.add(FakeMatterCall('POST remove-credit', projectId: projectId));
    await writeGate?.future;
    final error = removeCreditError;
    if (error != null) throw error;
    matter = BookMatter.fromJson({...matter.toJson(), 'creditPrinted': false});
    return BookMatterCreditRemoval(bookMatter: matter, reprint: removalReprint);
  }
}
