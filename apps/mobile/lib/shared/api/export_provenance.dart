import 'api_client.dart';

/// Which compile of a book a downloaded file came from, as the response said.
///
/// Every compile is published over the same URL, so the response — not the
/// descriptor that started the request — is the authority on the bytes that
/// arrived. Both direct export downloads and the in-app PDF reader consume this
/// contract.
enum ExportProvenanceState {
  /// The server named the compile these exact bytes came from.
  exact,

  /// A current server explicitly could not tie these bytes to a compile — a
  /// file published before provenance records existed.
  ///
  /// The file is an ordinary readable book, and for some books this state is
  /// permanent: the server only writes a missing record back for a project in
  /// a publishable status whose revision it can prove a compile completed for.
  /// So the descriptor stands in exactly as it did before provenance existed,
  /// guarded by the size it reported — refusing instead would refuse those
  /// books forever. A publication landing under the read reports [mismatch],
  /// not this, so trusting the descriptor here does not reopen that race.
  unknown,

  /// An older server sent no provenance contract at all. The descriptor stands
  /// in, exactly as [unknown].
  unreported,

  /// A record exists and describes other bytes. The file was being replaced
  /// while it was read, so no revision may be guessed.
  mismatch,
}

class ExportProvenance {
  const ExportProvenance({required this.state, this.revision, this.digest});

  final ExportProvenanceState state;

  /// The compile these bytes belong to. Non-null only for an exact response.
  final int? revision;

  final String? digest;

  /// What a server that reports nothing amounts to.
  static const absent = ExportProvenance(
    state: ExportProvenanceState.unreported,
  );

  static const _stateHeader = 'x-export-provenance';
  static const _revisionHeader = 'x-export-content-revision';
  static const _digestHeader = 'x-export-content-digest';

  /// Resolves the downloaded bytes against this provenance and the descriptor
  /// that started the request.
  ///
  /// One rule for both download surfaces — the save/share path in
  /// `ProjectsRepository` and the reader's `ExportCache` — so the two can never
  /// disagree about the same bytes. The surfaces map the resolution
  /// differently (the share sheet refuses what the reader merely declines to
  /// file), but what the bytes *are* is decided here.
  ///
  /// The length the response declared is checked first: a truncated transfer
  /// is not the compile any header describes. Past that, the response's own
  /// account of the bytes wins over the descriptor that asked for them — and a
  /// *newer* exact revision is [ExportDownloadResolution.identified], not
  /// stale: the retry after an `EXPORT_NOT_READY` is routinely answered by the
  /// compile that just published, and nothing newer is being offered. Where
  /// the response has no account ([ExportProvenanceState.unknown] and
  /// [ExportProvenanceState.unreported]), the descriptor stands in exactly as
  /// it did before provenance existed, guarded by the size it reported.
  ResolvedExportDownload resolveDownload({
    required int byteSize,
    required int? declaredContentLength,
    required int descriptorRevision,
    required int? descriptorByteSize,
  }) {
    if (declaredContentLength != null && declaredContentLength != byteSize) {
      return const ResolvedExportDownload._(
        ExportDownloadResolution.incomplete,
      );
    }
    switch (state) {
      case ExportProvenanceState.exact:
        final exactRevision = revision!;
        return ResolvedExportDownload._(
          exactRevision < descriptorRevision
              ? ExportDownloadResolution.identifiedStale
              : ExportDownloadResolution.identified,
          revision: exactRevision,
          revisionIsExact: true,
        );
      case ExportProvenanceState.mismatch:
        return const ResolvedExportDownload._(
          ExportDownloadResolution.replacedUnderRead,
        );
      case ExportProvenanceState.unknown:
      case ExportProvenanceState.unreported:
        if (descriptorByteSize != null && descriptorByteSize != byteSize) {
          return const ResolvedExportDownload._(
            ExportDownloadResolution.unidentified,
          );
        }
        return ResolvedExportDownload._(
          ExportDownloadResolution.identified,
          revision: descriptorRevision,
        );
    }
  }

  factory ExportProvenance.fromDownload(DownloadedFile download) {
    final digest = download.header(_digestHeader);
    final revision = int.tryParse(download.header(_revisionHeader) ?? '');
    switch (download.header(_stateHeader)) {
      case 'exact':
        return revision == null
            ? ExportProvenance(
                state: ExportProvenanceState.mismatch,
                digest: digest,
              )
            : ExportProvenance(
                state: ExportProvenanceState.exact,
                revision: revision,
                digest: digest,
              );
      case 'mismatch':
        return ExportProvenance(
          state: ExportProvenanceState.mismatch,
          digest: digest,
        );
      case 'unknown':
        return ExportProvenance(
          state: ExportProvenanceState.unknown,
          digest: digest,
        );
      default:
        return absent;
    }
  }
}

/// What downloaded export bytes turned out to be. See
/// [ExportProvenance.resolveDownload].
enum ExportDownloadResolution {
  /// The bytes belong to [ResolvedExportDownload.revision] — the response's
  /// own account, or the descriptor standing in for a server that has none.
  identified,

  /// Identified, but as a compile *older* than the descriptor promised: the
  /// file has not yet been republished for the revision the status named.
  identifiedStale,

  /// The transfer did not deliver the length the response declared.
  incomplete,

  /// The file was being replaced under the read. The bytes are a whole
  /// readable book, but no revision may be claimed for them.
  replacedUnderRead,

  /// Nothing ties the bytes to a compile: the response had no account of them
  /// and the descriptor's size guard failed.
  unidentified,
}

class ResolvedExportDownload {
  const ResolvedExportDownload._(
    this.resolution, {
    this.revision,
    this.revisionIsExact = false,
  });

  final ExportDownloadResolution resolution;

  /// The compile to file the bytes under. Non-null exactly for
  /// [ExportDownloadResolution.identified] and
  /// [ExportDownloadResolution.identifiedStale].
  final int? revision;

  /// Whether [revision] is the server's own account of the bytes rather than
  /// the descriptor standing in. Only an exact revision may re-anchor markup.
  final bool revisionIsExact;
}
