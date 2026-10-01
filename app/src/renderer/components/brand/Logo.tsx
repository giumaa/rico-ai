import { useId } from 'react';
import { GLYPH_H, GLYPH_PATH, GLYPH_W } from './logoPaths';

interface LogoProps {
  size?: number;
  className?: string;
  /** 'tile' = rounded ink-black app icon · 'glyph' = bare gradient letter */
  variant?: 'tile' | 'glyph';
  title?: string;
}

/**
 * The Rico mark: the Arabic letter «ك» (kaf) in Aref Ruqaa Bold, saffron → ember on ink black.
 * Outlines are baked (see logoPaths.ts), so it renders identically offline.
 */
export function Logo({ size = 32, className, variant = 'tile', title }: LogoProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const inkId = `ink${uid}`;
  const tileId = `tile${uid}`;
  const rimId = `rim${uid}`;
  const labelled = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true as const };

  if (variant === 'glyph') {
    return (
      <svg
        viewBox={`0 0 ${GLYPH_W} ${GLYPH_H}`}
        width={size * (GLYPH_W / GLYPH_H)}
        height={size}
        className={className}
        {...labelled}
      >
        <defs>
          <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={GLYPH_H}>
            <stop offset="0" stopColor="#FFD66E" />
            <stop offset="0.5" stopColor="#F2B33D" />
            <stop offset="1" stopColor="#E8742C" />
          </linearGradient>
        </defs>
        <path d={GLYPH_PATH} fill={`url(#${inkId})`} />
      </svg>
    );
  }

  const scale = 600 / GLYPH_H; // glyph ≈ 59% of the tile height
  const ox = (1024 - GLYPH_W * scale) / 2;
  const oy = (1024 - GLYPH_H * scale) / 2;
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} {...labelled}>
      <defs>
        <linearGradient id={tileId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#221C17" />
          <stop offset="1" stopColor="#0F0D0B" />
        </linearGradient>
        <linearGradient id={rimId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F2B33D" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#F2B33D" stopOpacity="0.08" />
          <stop offset="1" stopColor="#E8742C" stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id={inkId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2={GLYPH_H}>
          <stop offset="0" stopColor="#FFD66E" />
          <stop offset="0.5" stopColor="#F2B33D" />
          <stop offset="1" stopColor="#E8742C" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="1024" height="1024" rx="236" fill={`url(#${tileId})`} />
      <rect x="6" y="6" width="1012" height="1012" rx="230" fill="none" stroke={`url(#${rimId})`} strokeWidth="10" />
      <g transform={`translate(${ox} ${oy}) scale(${scale})`}>
        <path d={GLYPH_PATH} fill={`url(#${inkId})`} />
      </g>
    </svg>
  );
}
