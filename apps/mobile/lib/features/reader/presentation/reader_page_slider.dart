import 'package:flutter/material.dart';

/// The scrubber under the page, showing and setting the current page.
class ReaderPageSlider extends StatelessWidget {
  const ReaderPageSlider({
    required this.currentPage,
    required this.pageCount,
    required this.onChanged,
    super.key,
  });

  final int currentPage;
  final int pageCount;
  final void Function(int page) onChanged;

  /// Height of the bar, excluding safe-area padding.
  ///
  /// Fixed on purpose. `RenderSlider` is `sizedByParent` and takes the full
  /// height whenever it is given a bounded one, so an unconstrained slider in
  /// a `Scaffold.bottomNavigationBar` grows to the whole screen and leaves the
  /// body with zero height — which reads as "the book will not render".
  static const barHeight = 56.0;

  @override
  Widget build(BuildContext context) {
    if (pageCount < 2) {
      return const SizedBox.shrink();
    }
    final page = currentPage.clamp(1, pageCount);
    return SafeArea(
      child: SizedBox(
        height: barHeight,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Row(
            children: [
              Expanded(
                child: Slider(
                  value: page.toDouble(),
                  min: 1,
                  max: pageCount.toDouble(),
                  divisions: pageCount > 1 ? pageCount - 1 : null,
                  label: '$page',
                  onChanged: (value) => onChanged(value.round()),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '$page / $pageCount',
                style: Theme.of(context).textTheme.labelMedium,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
