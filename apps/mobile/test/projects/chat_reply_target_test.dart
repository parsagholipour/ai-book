import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/projects/domain/chat_reply_target.dart';

void main() {
  test(
    'a user **note** excerpt keeps the asterisks; an assistant one is note',
    () {
      expect(
        ChatReplyTarget.from(
          messageId: 'u1',
          role: 'user',
          content: '**note**',
        )!.excerpt,
        contains('**note**'),
      );
      expect(
        ChatReplyTarget.from(
          messageId: 'a1',
          role: 'assistant',
          content: '**note**',
        )!.excerpt,
        'note',
      );
      expect(
        ChatReplyTarget.fromJson({
          'messageId': 'u1',
          'role': 'user',
          'excerpt': '**note**',
        })!.excerpt,
        contains('**note**'),
      );
    },
  );

  test('fromJson keeps a stored **note** even when role is omitted', () {
    final target = ChatReplyTarget.fromJson({
      'messageId': 'u1',
      'excerpt': '**note**',
    });
    expect(target!.excerpt, '**note**');
    expect(target.role, 'assistant');
  });

  test('fromJson returns an assistant excerpt as stored, not re-parsed', () {
    expect(
      ChatReplyTarget.fromJson({
        'messageId': 'a1',
        'role': 'assistant',
        'excerpt': 'note',
      })!.excerpt,
      'note',
    );
    expect(
      ChatReplyTarget.fromJson({
        'messageId': 'a2',
        'role': 'assistant',
        'excerpt': '1. item',
      })!.excerpt,
      '1. item',
    );
  });
}
