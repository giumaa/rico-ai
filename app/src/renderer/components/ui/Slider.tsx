import { useEffect, useRef, useState, type CSSProperties } from 'react';

interface SliderProps {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  /** fires continuously while dragging (live preview) */
  onInput?: (value: number) => void;
  /** fires once when the user is done (pointer up / key up / blur) */
  onCommit: (value: number) => void;
}

export function Slider({ value, min, max, step, label, onInput, onCommit }: SliderProps) {
  const [local, setLocal] = useState(value);
  const dirty = useRef(false);
  useEffect(() => setLocal(value), [value]);

  const pct = ((local - min) / (max - min)) * 100;
  const commit = () => {
    if (!dirty.current) return;
    dirty.current = false;
    onCommit(local);
  };

  return (
    <input
      className="slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={local}
      aria-label={label}
      style={{ '--pct': `${pct}%` } as CSSProperties}
      onChange={(e) => {
        const v = Number(e.target.value);
        dirty.current = true;
        setLocal(v);
        onInput?.(v);
      }}
      onPointerUp={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  );
}
