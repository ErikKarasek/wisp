/**
 * The mascot for plain web pages: an SVG string, and a tiny animated mount that
 * needs nothing but a DOM. This is the half other projects (the portfolio, the
 * job tracker) use; the React apps render the primitives themselves.
 */
import {
  blendExpressions,
  EXPRESSIONS,
  mascotFrame,
  mascotPose,
  stillPose,
  type ExpressionName,
  type MascotCharacter,
  type MascotExpression,
  type MascotGeometry,
  type MascotPrimitive,
} from "./mascot";

function primitiveSvg(p: MascotPrimitive): string {
  if (p.kind === "ellipse") {
    return `<ellipse cx="${p.cx}" cy="${p.cy}" rx="${p.rx}" ry="${p.ry}" fill="${p.fill}"/>`;
  }
  if (p.kind === "path") return `<path d="${p.d}" fill="${p.fill}"/>`;
  return `<path d="${p.d}" fill="none" stroke="${p.stroke}" stroke-width="${p.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** The inside of the <svg>: the whole mascot leaning about its base. */
export function geometryInnerSvg(g: MascotGeometry): string {
  return `<g transform="rotate(${g.tilt} ${g.pivot.x} ${g.pivot.y})">${g.primitives.map(primitiveSvg).join("")}</g>`;
}

/** A complete, static SVG of one expression. */
export function mascotSvg(
  character: Partial<MascotCharacter> = {},
  expression: MascotExpression | ExpressionName = "neutral",
  size = 120,
): string {
  const ex = typeof expression === "string" ? EXPRESSIONS[expression] : expression;
  const g = mascotFrame(character, stillPose(ex));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${g.width} ${g.height}" role="img">` +
    geometryInnerSvg(g) +
    `</svg>`
  );
}

export type MountedMascot = {
  setExpression(next: MascotExpression | ExpressionName): void;
  setCharacter(next: Partial<MascotCharacter>): void;
  destroy(): void;
};

/**
 * Put a living mascot inside `el`. It breathes, blinks and looks around, eases
 * between expressions, and holds still for people who asked for reduced motion.
 */
export function mountMascot(
  el: HTMLElement,
  options: {
    character?: Partial<MascotCharacter>;
    expression?: MascotExpression | ExpressionName;
    seed?: number;
    /** Milliseconds to ease from one expression to the next. */
    transition?: number;
  } = {},
): MountedMascot {
  const resolve = (e: MascotExpression | ExpressionName) =>
    typeof e === "string" ? EXPRESSIONS[e] : e;
  let character = options.character ?? {};
  let from = resolve(options.expression ?? "neutral");
  let to = from;
  let changedAt = 0;
  const transition = options.transition ?? 360;
  const seed = options.seed ?? Math.random() * 100;
  const still =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");
  svg.setAttribute("role", "img");
  el.appendChild(svg);

  let frame = 0;
  const draw = (now: number) => {
    const k = transition > 0 ? (now - changedAt) / transition : 1;
    const ex = k >= 1 ? to : blendExpressions(from, to, k);
    const pose = still ? stillPose(ex) : mascotPose(ex, now, seed);
    svg.innerHTML = geometryInnerSvg(mascotFrame(character, pose));
    if (!still) frame = requestAnimationFrame(draw);
  };
  frame = requestAnimationFrame(draw);

  return {
    setExpression(next) {
      const now = performance.now();
      const k = transition > 0 ? (now - changedAt) / transition : 1;
      // Start from wherever the face is right now, not from the last target.
      from = k >= 1 ? to : blendExpressions(from, to, k);
      to = resolve(next);
      changedAt = now;
      if (still) draw(now);
    },
    setCharacter(next) {
      character = { ...character, ...next };
      if (still) draw(performance.now());
    },
    destroy() {
      cancelAnimationFrame(frame);
      svg.remove();
    },
  };
}
