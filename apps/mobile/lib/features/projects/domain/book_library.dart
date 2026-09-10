import 'project_models.dart';

enum BookLibraryFilter {
  all('All books'),
  ready('Ready to read'),
  inProgress('In progress'),
  needsAttention('Needs attention');

  const BookLibraryFilter(this.label);
  final String label;

  static BookLibraryFilter forBook(MobileProjectSummary book) {
    if (book.status.toLowerCase() == 'failed') return needsAttention;
    if (book.isLive) return inProgress;
    if (book.status.toLowerCase() == 'complete' || book.hasReadyExport) {
      return ready;
    }
    return inProgress;
  }
}

enum BookLibrarySort {
  updated('Recently updated'),
  newest('Newest first'),
  title('Title A–Z');

  const BookLibrarySort(this.label);
  final String label;

  int compare(MobileProjectSummary a, MobileProjectSummary b) {
    final result = switch (this) {
      updated => b.updatedAt.compareTo(a.updatedAt),
      newest => b.createdAt.compareTo(a.createdAt),
      title => a.title.toLowerCase().compareTo(b.title.toLowerCase()),
    };
    return result == 0 ? a.id.compareTo(b.id) : result;
  }
}

/// Ideas and plans stay in chat until writing has produced manuscript pages.
/// The drawer and the full library use the same definition of a book.
List<MobileProjectSummary> libraryBooks(List<MobileProjectSummary> projects) =>
    projects.where((project) => project.pageCount > 0).toList()
      ..sort(BookLibrarySort.updated.compare);

List<MobileProjectSummary> searchLibraryBooks(
  List<MobileProjectSummary> books, {
  String query = '',
  BookLibraryFilter filter = BookLibraryFilter.all,
  BookLibrarySort sort = BookLibrarySort.updated,
}) {
  final words = query.trim().toLowerCase().split(RegExp(r'\s+'));
  return books.where((book) {
    if (filter != BookLibraryFilter.all &&
        BookLibraryFilter.forBook(book) != filter) {
      return false;
    }
    final searchable = [
      book.title,
      book.subtitle ?? '',
      book.authorName ?? '',
      book.promptPreview,
      book.bookTypeLabel,
    ].join(' ').toLowerCase();
    return words.every(searchable.contains);
  }).toList()..sort(sort.compare);
}
