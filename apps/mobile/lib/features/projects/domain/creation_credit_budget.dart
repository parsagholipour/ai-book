import 'creation_models.dart';
import 'project_models.dart';

/// Largest affordable count up to [targetPages], including the initial plan
/// and the later book approval. Zero means even a one-page book is unaffordable.
int affordableCreationPages({
  required MobileCreationPresets presets,
  required int targetPages,
  required int availableCredits,
  required Map<String, dynamic> creditCosts,
}) {
  final bookBudget =
      availableCredits -
      estimatePlanGenerationCredits(
        qualityPreset: presets.qualityPreset,
        creditCosts: creditCosts,
      );
  int estimate(int pages) => estimateProjectCredits(
    bookType: presets.bookType,
    bookTypeChoice: presets.bookTypeChoice,
    qualityPreset: presets.qualityPreset,
    coverEnabled: presets.coverEnabled,
    illustrationsEnabled: presets.illustrationsEnabled,
    targetPages: pages,
    creditCosts: creditCosts,
  );

  // Use the complete quote at each count: illustration charges grow in steps,
  // so dividing a balance by the writing rate would overstate affordability.
  var low = 0;
  var high = targetPages;
  while (low < high) {
    final middle = (low + high + 1) ~/ 2;
    if (estimate(middle) <= bookBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}
