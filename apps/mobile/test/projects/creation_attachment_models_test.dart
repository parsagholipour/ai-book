import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/creation_message_models.dart';

// This file covers the attachment DTO reload.
void main() {
  test(
    'pending and partial status survives reloading the attachment response',
    () {
      final pending = MobileCreationAttachment.fromJson({
        'id': 's1',
        'processing': {'status': 'summarizing', 'progress': 72},
        'extractionVersion': 2,
      });
      expect(pending.isProcessing, isTrue);
      expect(pending.processingLabel, 'Reading · 72%');
      final partial = MobileCreationAttachment.fromJson({
        'id': 's1',
        'processing': {
          'status': 'partial',
          'acceptedPartial': false,
          'unreadable': ['Page 8'],
        },
      });
      expect(partial.isProcessing, isFalse);
      expect(partial.processingLabel, contains('review required'));
      expect(partial.processing?['unreadable'], ['Page 8']);
    },
  );
}
