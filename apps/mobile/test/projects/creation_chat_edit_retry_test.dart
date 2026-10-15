import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/data/billing_repository.dart';
import 'package:tomeza/features/projects/data/creation_repository.dart';
import 'package:tomeza/features/projects/presentation/creation_chat_controller.dart';

import '../audiobook/audiobook_fakes.dart' as audio;
import 'creation_chat_fakes.dart';

ProviderContainer _container(ScriptedCreationRepository repository) {
  final container = ProviderContainer(
    overrides: [
      creationRepositoryProvider.overrideWithValue(repository),
      billingProvider.overrideWith((ref) async => audio.affordableBilling()),
    ],
  );
  final subscription = container.listen(
    creationChatControllerProvider,
    (_, _) {},
  );
  addTearDown(() {
    subscription.close();
    container.dispose();
  });
  return container;
}

void main() {
  for (final failedRetries in [0, 2]) {
    testWidgets(
      'failed creation edit still forks after $failedRetries failed retries',
      (tester) async {
        final repository = ScriptedCreationRepository();
        final container = _container(repository);
        final controller = container.read(
          creationChatControllerProvider.notifier,
        );
        await controller.init(fresh: true);
        await controller.sendMessage('Old idea');

        repository.sendError = Exception('Network disconnected before send');
        await expectLater(
          controller.sendMessage('Changed idea', editMessageId: 'user-current'),
          throwsException,
        );
        final failed = container
            .read(creationChatControllerProvider)
            .messages
            .singleWhere((message) => message.isFailedSend);
        for (var attempt = 0; attempt < failedRetries; attempt++) {
          await expectLater(
            controller.retryFailedMessage(failed.localId!),
            throwsException,
          );
          expect(
            container
                .read(creationChatControllerProvider)
                .messages
                .singleWhere((message) => message.isFailedSend)
                .localId,
            failed.localId,
          );
        }

        repository.sendError = null;
        await controller.retryFailedMessage(failed.localId!);

        expect(repository.editRequests, ['user-current']);
        final edited = container
            .read(creationChatControllerProvider)
            .messages
            .singleWhere((message) => message.isUser);
        expect(edited.content, 'Changed idea');
        expect(edited.branch?.canGoPrevious, isTrue);
        await controller.switchBranch(
          messageId: edited.id!,
          direction: 'previous',
        );
        expect(
          container
              .read(creationChatControllerProvider)
              .messages
              .singleWhere((message) => message.isUser)
              .content,
          'Old idea',
        );
      },
    );
  }

  testWidgets('retrying an ordinary creation message does not fork', (
    tester,
  ) async {
    final repository = ScriptedCreationRepository();
    final container = _container(repository);
    final controller = container.read(creationChatControllerProvider.notifier);
    await controller.init(fresh: true);
    await controller.sendMessage('Old idea');

    repository.sendError = Exception('Network disconnected before send');
    await expectLater(controller.sendMessage('More detail'), throwsException);
    final failed = container
        .read(creationChatControllerProvider)
        .messages
        .singleWhere((message) => message.isFailedSend);

    repository.sendError = null;
    await controller.retryFailedMessage(failed.localId!);

    expect(repository.editRequests, isEmpty);
    expect(repository.sentMessages, ['Old idea', 'More detail']);
    expect(
      container
          .read(creationChatControllerProvider)
          .messages
          .any((message) => message.isFailedSend),
      isFalse,
    );
  });
}
