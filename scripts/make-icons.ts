// Draws the app's icons and writes them to public/icons, and the Mac app's
// icon to app/icon.icns:
//   node scripts/make-icons.ts
// The picture is the saucer over the planet, drawn as an SVG and turned into
// PNGs of each size by a headless browser. Run it again if the art changes;
// the PNGs are committed.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

/** `inset` shrinks the art towards the middle, as "maskable" icons need (safe zone 80%). */
const art = (inset: number): string => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#030a1a"/>
  <g transform="translate(256 256) scale(${1 - inset}) translate(-256 -256)">
    <circle cx="60" cy="90" r="3" fill="#99ccff"/><circle cx="430" cy="70" r="2.5" fill="#99ccff"/>
    <circle cx="470" cy="300" r="2" fill="#99ccff"/><circle cx="90" cy="400" r="2.5" fill="#99ccff"/>
    <circle cx="380" cy="440" r="3" fill="#99ccff"/><circle cx="200" cy="60" r="2" fill="#99ccff"/>
    <circle cx="256" cy="560" r="300" fill="#3355aa"/>
    <ellipse cx="256" cy="330" rx="210" ry="26" fill="none" stroke="#a8a8a8" stroke-width="6"
      stroke-dasharray="14 22" opacity="0.7"/>
    <ellipse cx="256" cy="232" rx="150" ry="44" fill="#1a1a1a" stroke="#0099ff" stroke-width="8"/>
    <path d="M196 214a60 46 0 0 1 120 0z" fill="#00ffff"/>
    <circle cx="130" cy="236" r="8" fill="#ffffff"/><circle cx="382" cy="236" r="8" fill="#ffffff"/>
    <circle cx="256" cy="268" r="8" fill="#ffffff"/>
  </g>
</svg>`;

const ICONS: { file: string; size: number; inset: number }[] = [
  { file: 'icon-192.png', size: 192, inset: 0 },
  { file: 'icon-512.png', size: 512, inset: 0 },
  { file: 'icon-maskable-512.png', size: 512, inset: 0.2 },
  // iOS uses this one for the Home Screen and rounds its corners itself.
  { file: 'apple-touch-icon.png', size: 180, inset: 0.08 },
];

const browser = await chromium.launch();
for (const icon of ICONS) {
  const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${art(icon.inset)}`,
  );
  writeFileSync(`public/icons/${icon.file}`, await page.screenshot({ type: 'png' }));
  await page.close();
}
writeFileSync('public/icons/icon.svg', art(0).trim() + '\n');

// macOS wants one file holding the icon at every size it may show it.
// `iconutil` (part of macOS) builds that from a folder of PNGs. macOS draws
// app icons with a margin, so the art is drawn a little smaller.
if (process.platform === 'darwin') {
  const set = 'app/icon.iconset';
  rmSync(set, { recursive: true, force: true });
  mkdirSync(set, { recursive: true });
  for (const points of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const size = points * scale;
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh;border-radius:22%}</style>${art(0.1)}`,
      );
      const name = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
      writeFileSync(`${set}/${name}`, await page.screenshot({ type: 'png', omitBackground: true }));
      await page.close();
    }
  }
  execFileSync('iconutil', ['--convert', 'icns', '--output', 'app/icon.icns', set]);
  rmSync(set, { recursive: true, force: true });
}
await browser.close();
console.log(`wrote ${ICONS.length} PNGs and icon.svg to public/icons, and app/icon.icns`);
