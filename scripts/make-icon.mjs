// Draws the app icon: the mascot on a dark squircle, rendered to
// src-tauri/icons/source.png for `tauri icon`. macOS doesn't mask icons, so the
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

const g = mascotFrame({ color: "#8b9cff" }, { ...stillPose(EXPRESSIONS.happy), lookX: 0, lookY: -0.2 });
const shapes = g.primitives
  .map((p) =>
    p.kind === "ellipse"
      ? `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="${p.fill}"/>`
      : p.kind === "path"
        ? `<path d="${p.d}" fill="${p.fill}"/>`
        : `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="round"/>`,
  )
  .join("");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.4" y2="1">
      <stop offset="0" stop-color="#2d3350"/>
      <stop offset="1" stop-color="#171a26"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)"/>
  <svg x="192" y="200" width="640" height="640" viewBox="0 0 ${g.width} ${g.height}">
    <g transform="rotate(${g.tilt} ${g.pivot.x} ${g.pivot.y})">${shapes}</g>
  </svg>
</svg>`;

const svgPath = join(dir, "icon.svg");
writeFileSync(svgPath, svg);
execFileSync("rsvg-convert", ["-w", "1024", "-h", "1024", svgPath, "-o", join(root, "src-tauri/icons/source.png")]);
console.log("src-tauri/icons/source.png");
