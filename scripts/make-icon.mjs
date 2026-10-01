// Draws the app icon: Wisp, a glowing ghost, on a dark squircle, rendered to
// src-tauri/icons/source.png for `tauri icon` (and full bleed for the iPhone). macOS doesn't mask icons, so the
// squircle (824 px, radius 185, on a 1024 canvas) is baked into the picture.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "dispecink-icon-"));
const js = stripTypeScriptTypes(readFileSync(join(root, "src/mascot/mascot.ts"), "utf8"));
writeFileSync(join(dir, "mascot.mjs"), js);
const { mascotFrame, stillPose, EXPRESSIONS } = await import(join(dir, "mascot.mjs"));

// Wisp: a softly glowing ghost.
const g = mascotFrame(
  { shape: "ghost", color: "#e4dfff", eyeColor: "#1c1638", eyeSize: 1.15 },
  { ...stillPose(EXPRESSIONS.happy), lookX: 0, lookY: -0.15 },
);
const bodyCount = g.body.count;
const prim = (p) =>
  p.kind === "ellipse"
    ? `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="${p.fill}"/>`
    : p.kind === "path"
      ? `<path d="${p.d}" fill="${p.fill}"/>`
      : `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="round"/>`;
const body = g.primitives.slice(0, bodyCount).map(prim).join("");
const eyes = g.primitives.slice(bodyCount).map(prim).join("");
const b = g.body;
const ghost = `<svg x="{X}" y="{Y}" width="{S}" height="{S}" viewBox="0 0 ${g.width} ${g.height}">
    <defs>
      <clipPath id="body">${body.replace(/fill="[^"]*"/g, "")}</clipPath>
      <radialGradient id="gloss" cx="${b.cx - b.rx * 0.38}" cy="${b.cy - b.ry * 0.5}" r="${Math.max(b.rx, b.ry) * 1.55}" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff" stop-opacity=".75"/><stop offset=".4" stop-color="#fff" stop-opacity=".12"/>
        <stop offset=".72" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#3b2d8a" stop-opacity=".35"/>
      </radialGradient>
    </defs>
    <g transform="rotate(${g.tilt} ${g.pivot.x} ${g.pivot.y})">${body}<rect width="100" height="100" fill="url(#gloss)" clip-path="url(#body)"/>${eyes}</g>
  </svg>`;

const art = (bg) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#2a2366"/><stop offset=".55" stop-color="#151236"/><stop offset="1" stop-color="#0a0a1c"/>
    </linearGradient>
    <radialGradient id="halo" cx="512" cy="540" r="330" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#9d8cff" stop-opacity=".75"/><stop offset=".5" stop-color="#6c5bff" stop-opacity=".25"/><stop offset="1" stop-color="#6c5bff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  ${bg}
  <circle cx="512" cy="540" r="330" fill="url(#halo)"/>
  ${ghost.replace("{X}", "212").replace("{Y}", "200").replace(/\{S\}/g, "600")}
</svg>`;

// macOS doesn't mask icons: the squircle is baked in. iOS masks them itself: full bleed.
const out = [
  [art(`<rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>`), "src-tauri/icons/source.png"],
  [art(`<rect width="1024" height="1024" fill="url(#bg)"/>`), "ios/App/Assets.xcassets/AppIcon.appiconset/icon-1024.png"],
];
for (const [svg, target] of out) {
  const svgPath = join(dir, "icon.svg");
  writeFileSync(svgPath, svg);
  execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", svgPath, "-o", join(root, target)]);
  console.log(target);
}
