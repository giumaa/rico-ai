// Rico icon generator (one-off tool, not part of the app bundle).
//
//   One-off deps (NOT added to the app's package.json):
//     npm i --no-save @resvg/resvg-js png-to-ico png2icons
//   or point RICO_TOOLS at any folder that has them in its node_modules:
//     RICO_TOOLS=/path/to/tools node app/resources/icons/build-icons.mjs
//
// Inputs : riko-glyph.json  (the Arabic letter «ك» in Aref Ruqaa Bold, baked outlines, SIL OFL)
// Outputs: icon.svg, icon-small.svg, logo-glyph.svg, icon.png (1024), icon-512.png,
//          icon-256.png, icon.ico (16..256), icon.icns, and the in-app glyph
//          ../../src/renderer/components/brand/logoPaths.ts
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const toolsDir = process.env.RICO_TOOLS ? path.resolve(process.env.RICO_TOOLS) : here;
const req = createRequire(path.join(toolsDir, 'noop.js'));
const { Resvg } = req('@resvg/resvg-js');
const pngToIcoMod = req('png-to-ico');
const pngToIco = pngToIcoMod.default ?? pngToIcoMod;
const png2icons = req('png2icons');

const glyph = JSON.parse(fs.readFileSync(path.join(here, 'riko-glyph.json'), 'utf8'));
const GW = glyph.w;
const GH = glyph.h;

// --- palette (SPEC) ---------------------------------------------------------
const INK = '#0F0D0B';
const INK_HI = '#221C17';
const SAFFRON = '#F2B33D';
const SAFFRON_HI = '#FFD66E';
const EMBER = '#E8742C';

/** Translate + scale the baked absolute path (M/L/Q/Z only). */
function placeGlyph(scale, cx, cy) {
  const ox = cx - (GW * scale) / 2;
  const oy = cy - (GH * scale) / 2;
  const r = (n) => Math.round(n * 10) / 10;
  return glyph.d.replace(/([MLQ])([^MLQZ]*)/g, (_, cmd, args) => {
    const n = args.trim().split(/[\s,]+/).map(Number);
    const out = [];
    for (let i = 0; i < n.length; i += 2) out.push(`${r(ox + n[i] * scale)} ${r(oy + n[i + 1] * scale)}`);
    return cmd + out.join(' ');
  });
}

function inkGradient(id, top, bottom) {
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${bottom}">
      <stop offset="0" stop-color="${SAFFRON_HI}"/><stop offset="0.5" stop-color="${SAFFRON}"/><stop offset="1" stop-color="${EMBER}"/>
    </linearGradient>`;
}

// --- full-detail icon (>= 64px) ---------------------------------------------
function fullIcon() {
  const S = 500 / GH; // glyph height 500px inside the 1024 canvas
  const cy = 462;
  const top = cy - (GH * S) / 2;
  const bottom = cy + (GH * S) / 2;
  const d = placeGlyph(S, 512, cy);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Rico">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK_HI}"/><stop offset="1" stop-color="${INK}"/></linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.44" r="0.55">
      <stop offset="0" stop-color="${SAFFRON}" stop-opacity="0.26"/><stop offset="0.55" stop-color="${EMBER}" stop-opacity="0.10"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${SAFFRON}" stop-opacity="0.5"/><stop offset="0.5" stop-color="${SAFFRON}" stop-opacity="0.05"/><stop offset="1" stop-color="${EMBER}" stop-opacity="0.32"/></linearGradient>
    <linearGradient id="dune" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${EMBER}" stop-opacity="0"/><stop offset="0.5" stop-color="${EMBER}"/><stop offset="1" stop-color="${SAFFRON}" stop-opacity="0"/></linearGradient>
    ${inkGradient('ink', top, bottom)}
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="214" fill="url(#tile)"/>
  <rect x="64" y="64" width="896" height="896" rx="214" fill="url(#glow)"/>
  <rect x="66" y="66" width="892" height="892" rx="212" fill="none" stroke="url(#rim)" stroke-width="3"/>
  <path d="${d}" fill="url(#ink)"/>
  <path d="M 330 800 Q 512 740 694 800 Q 512 774 330 800 Z" fill="url(#dune)"/>
</svg>
`;
}

// --- simplified icon (16..48px): flat, bigger glyph, no glow/dune -----------
function smallIcon() {
  const S = 650 / GH;
  const cy = 512;
  const top = cy - (GH * S) / 2;
  const bottom = cy + (GH * S) / 2;
  const d = placeGlyph(S, 512, cy);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024" role="img" aria-label="Rico">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${INK_HI}"/><stop offset="1" stop-color="${INK}"/></linearGradient>
    ${inkGradient('ink', top, bottom)}
  </defs>
  <rect x="24" y="24" width="976" height="976" rx="236" fill="url(#tile)"/>
  <path d="${d}" fill="url(#ink)"/>
</svg>
`;
}

// --- bare glyph (transparent), also used in-app ------------------------------
function glyphOnly() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${GW} ${GH}" width="${GW}" height="${GH}" role="img" aria-label="Rico">
  <defs>${inkGradient('ink', 0, GH)}</defs>
  <path d="${glyph.d}" fill="url(#ink)"/>
</svg>
`;
}

const render = (svg, size) =>
  new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();

const full = fullIcon();
const small = smallIcon();
fs.writeFileSync(path.join(here, 'icon.svg'), full);
fs.writeFileSync(path.join(here, 'icon-small.svg'), small);
fs.writeFileSync(path.join(here, 'logo-glyph.svg'), glyphOnly());

const png1024 = render(full, 1024);
fs.writeFileSync(path.join(here, 'icon.png'), png1024);
fs.writeFileSync(path.join(here, 'icon-512.png'), render(full, 512));
fs.writeFileSync(path.join(here, 'icon-256.png'), render(full, 256));

// ICO: small art for <=48, full art above
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoPngs = icoSizes.map((s) => render(s <= 48 ? small : full, s));
fs.writeFileSync(path.join(here, 'icon.ico'), await pngToIco(icoPngs));

// ICNS from the 1024 master
const icns = png2icons.createICNS(png1024, png2icons.BICUBIC, 0);
if (icns) fs.writeFileSync(path.join(here, 'icon.icns'), icns);
else console.warn('icns generation failed');

// in-app glyph path (strict TS, no runtime deps)
const brandDir = path.resolve(here, '../../src/renderer/components/brand');
fs.mkdirSync(brandDir, { recursive: true });
fs.writeFileSync(
  path.join(brandDir, 'logoPaths.ts'),
  `// GENERATED by app/resources/icons/build-icons.mjs - do not edit.
// The Arabic letter «ك» (kaf) in Aref Ruqaa Bold (SIL OFL 1.1), outlines baked as one SVG path.
export const GLYPH_W = ${GW};
export const GLYPH_H = ${GH};
export const GLYPH_PATH =
  '${glyph.d}';
`,
);
console.log('icons written to', here);
