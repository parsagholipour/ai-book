import type { ReactNode } from "react";

export type SegmentedControlOption<T extends string | number> = {
  value: T;
  label: ReactNode;
  disabled?: boolean;
};

export function SegmentedControl<T extends string | number>(props: {
  label: string;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={["segmented-control", props.className].filter(Boolean).join(" ")}
      role="radiogroup"
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
    >
      {props.options.map((option) => {
        const selected = option.value === props.value;
        return (
          <button
            key={String(option.value)}
            className={`segmented-control-option${selected ? " is-selected" : ""}`}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={props.disabled || option.disabled}
            onClick={() => props.onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
