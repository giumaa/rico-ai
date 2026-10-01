import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
}

/** Accessible radio-group styled as a segmented control (arrow keys move + select). */
export function Segmented<T extends string>({ value, options, onChange, label }: SegmentedProps<T>) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;
    e.preventDefault();
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const forward = e.key === 'ArrowDown' || (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight'));
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + (forward ? 1 : -1) + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    });
  };

  return (
    <div ref={ref} className="seg" role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          className="seg-item"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}
