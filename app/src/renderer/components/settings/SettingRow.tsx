import type { ReactNode } from 'react';

interface SettingRowProps {
  label: string;
  description?: string;
  /** put the control under the text instead of beside it (sliders, card groups) */
  stack?: boolean;
  children: ReactNode;
}

export function SettingRow({ label, description, stack, children }: SettingRowProps) {
  return (
    <div className="set-row" data-stack={stack}>
      <div>
        <div className="set-label">{label}</div>
        {description ? <div className="set-desc">{description}</div> : null}
      </div>
      <div className={stack ? 'set-control set-control-stack' : 'set-control'}>{children}</div>
    </div>
  );
}
