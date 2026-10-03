import 'package:flutter_test/flutter_test.dart';
import 'package:tomeza/features/billing/domain/billing_models.dart';

void main() {
  test('groups thousands, and keeps the sign outside the groups', () {
    expect(formatCredits(0), '0');
    expect(formatCredits(999), '999');
    expect(formatCredits(1000), '1,000');
    expect(formatCredits(16912), '16,912');
    expect(formatCredits(1234567), '1,234,567');
    expect(formatCredits(-500), '-500');
    expect(formatCredits(-16912), '-16,912');
  });
}
