/**
 * A procedural blob mascot: a flat coloured body and two dark capsule eyes.
 * Nothing else — no mouth, no shading, no highlights. Every expression is made
 * from how each eye is sized and turned and where the face is looking, which is
 * exactly why it reads so clearly at any size.
 *
 * Returns plain primitives, like `companionTree`, so the desktop (<svg>), the
 * mobile app (react-native-svg) and any plain web page (`mascotSvg`) draw the
 * same character from one source. No dependencies on purpose: this file is
 * meant to be copied into other projects as-is.
 *
 * Coordinate space: 100 × 100 viewBox, body centred around (50, 52).
 *
 * The eyes live on an imagined sphere. Each one is a capsule laid on that
 * surface, and the whole face turns with the head, so looking away slides the
 * eyes towards the edge and slants and narrows them on their own — the
 * perspective comes out of the projection instead of being faked per pose.
 */

export type MascotPrimitive =
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; fill: string }
  | { kind: "path"; d: string; fill: string }
  | { kind: "stroke"; d: string; stroke: string; width: number };

export type MascotShape = "round" | "capsule" | "lemon" | "cube" | "cloud";

export type MascotCharacter = {
  shape: MascotShape;
  color: string;
  eyeColor: string;
  /** Wider than tall above 1. */
  aspect: number;
  /** Resting lean of the body, in degrees. */
  lean: number;
  /** Eye size multiplier; 1 is the default. */
  eyeSize: number;
  /** Eye spacing multiplier; 1 is the default. */
  eyeSpread: number;
};

/**
 * One eye, in the face's own terms. `x`/`y` are angles on the sphere (radians,
 * 0 is straight ahead) measured from where that eye normally sits; `length` and
 * `width` scale the default capsule; `angle` turns it (degrees, 0 is upright,
 * positive leans the top outwards, away from the other eye).
 */
export type EyeSpec = { x: number; y: number; length: number; width: number; angle: number };

/**
 * Every field is numeric or a colour so two expressions can be blended into
 * each other (`blendExpressions`) rather than snapping.
 */
export type MascotExpression = {
  left: EyeSpec;
  right: EyeSpec;
  /** Where the head is turned, −1 … 1. */
  lookX: number;
  lookY: number;
  /** Extra body lean, degrees. */
  tilt: number;
  /** Hop height, viewBox units. */
  bounce: number;
  /** How much the idle gaze wanders, 0 … 1. */
  wander: number;
  /** Replaces the body colour — anger goes red. Empty keeps the character's. */
  tint: string;
  /** 0 … 1, how much of `tint` shows. */
  tintAmount: number;
  /** 0 … 1: rising Zs. */
  zzz: number;
  /** Pill eyes blink; closed or squinting ones would look odd doing it. */
  blinks: boolean;
};

export type MascotPose = {
  expression: MascotExpression;
  /** Gaze added on top of the expression's own, −1 … 1. */
  lookX: number;
  lookY: number;
  /** 0 open … 1 shut. */
  blink: number;
  /** Vertical squash from breathing or landing, ~ −0.1 … 0.1. */
  squash: number;
  /** Upward offset from bouncing. */
  lift: number;
  /** Seconds, for things that drift on their own (the Zs). */
  time: number;
};

export const DEFAULT_CHARACTER: MascotCharacter = {
  shape: "round",
  color: "#6d7fe0",
  eyeColor: "#111216",
  aspect: 1,
  lean: 0,
  eyeSize: 1,
  eyeSpread: 1,
};

const EYE: EyeSpec = { x: 0, y: 0, length: 1, width: 1, angle: 0 };
const eye = (spec: Partial<EyeSpec>): EyeSpec => ({ ...EYE, ...spec });
/** The same eye on both sides; angles mirror through `angle`'s definition. */
const both = (spec: Partial<EyeSpec>) => ({ left: eye(spec), right: eye(spec) });

const NEUTRAL: MascotExpression = {
  ...both({}),
  lookX: 0,
  lookY: 0,
  tilt: 0,
  bounce: 0,
  wander: 1,
  tint: "",
  tintAmount: 0,
  zzz: 0,
  blinks: true,
};

export const EXPRESSIONS = {
  neutral: NEUTRAL,
  // Soft, a little squashed and looking up: contentment rather than a grin.
  happy: {
    ...NEUTRAL,
    ...both({ length: 0.62, width: 1.05, angle: -14, y: -0.02 }),
    lookY: -0.35,
    tilt: -4,
    wander: 0.6,
  },
  // Round, bigger, bouncing.
  thriving: {
    ...NEUTRAL,
    ...both({ length: 0.15, width: 1.35 }),
    lookY: -0.4,
    bounce: 5,
    wander: 0.4,
  },
  // Tops lean together and the face drops.
  sad: {
    ...NEUTRAL,
    ...both({ length: 0.85, angle: -26 }),
    lookY: 0.65,
    lookX: -0.2,
    tilt: 5,
    wander: 0.2,
  },
  // Flat dashes.
  sleepy: {
    ...NEUTRAL,
    ...both({ length: 0.9, width: 0.6, angle: 90, y: 0.05 }),
    lookY: 0.35,
    wander: 0,
    zzz: 1,
    blinks: false,
  },
  surprised: {
    ...NEUTRAL,
    ...both({ length: 0.2, width: 1.5 }),
    lookY: -0.15,
    wander: 0.15,
  },
  // A V: tops apart, bottoms together, and the body flushes red.
  angry: {
    ...NEUTRAL,
    ...both({ length: 0.95, width: 1.1, angle: 30 }),
    lookY: 0.1,
    wander: 0.25,
    tint: "#c0453e",
    tintAmount: 1,
  },
  // One eye bigger than the other, head turned.
  curious: {
    ...NEUTRAL,
    left: eye({ length: 0.7, width: 0.85 }),
    right: eye({ length: 1.25, width: 1.2 }),
    lookX: 0.55,
    lookY: -0.2,
    tilt: 7,
    wander: 0.2,
  },
  // Chin up, eyes leaning back.
  proud: {
    ...NEUTRAL,
    left: eye({ angle: -34, length: 1.05 }),
    right: eye({ angle: -12, length: 0.95 }),
    lookX: -0.45,
    lookY: 0.35,
    tilt: -5,
    wander: 0.2,
  },
  // Two dots, far off to the side.
  shy: {
    ...NEUTRAL,
    ...both({ length: 0.1, width: 0.8 }),
    lookX: -0.8,
    lookY: 0.45,
    tilt: -6,
    wander: 0.15,
  },
} satisfies Record<string, MascotExpression>;

export type ExpressionName = keyof typeof EXPRESSIONS;

/**
 * The companion's mood, as the domain computes it, mapped to a face. Kept here
 * so every renderer agrees on it — the same kind of list the stage names were
 * before they drifted apart across four copies.
 */
export const MOOD_EXPRESSION: Record<string, ExpressionName> = {
  dormant: "sleepy",
  wilting: "sad",
  okay: "neutral",
  happy: "happy",
  thriving: "thriving",
};

export function expressionForMood(mood: string): MascotExpression {
  return EXPRESSIONS[MOOD_EXPRESSION[mood] ?? "neutral"];
}

// "worklet" marks the functions the mobile app runs on Reanimated's UI thread,
// every frame, so the mascot keeps moving while JavaScript is busy. Anywhere
// else the directive is an inert string, so desktop and web are unaffected.

function clamp(v: number, lo: number, hi: number) {
  "worklet";
  return Math.max(lo, Math.min(hi, v));
}
function mix(a: number, b: number, t: number) {
  "worklet";
  return a + (b - a) * t;
}
function r2(v: number) {
  "worklet";
  return Math.round(v * 100) / 100;
}

function parseHex(hex: string): [number, number, number] {
  "worklet";
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h.slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixHex(a: string, b: string, t: number): string {
  "worklet";
  if (t <= 0) return a;
  if (t >= 1) return b;
  const pa = parseHex(a);
  const pb = parseHex(b);
  return `#${pa
    .map((v, i) =>
      Math.round(mix(v, pb[i], t))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Relative luminance, 0 black … 1 white. */
function luminance(hex: string): number {
  "worklet";
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mixEye(a: EyeSpec, b: EyeSpec, t: number): EyeSpec {
  "worklet";
  return {
    x: mix(a.x, b.x, t),
    y: mix(a.y, b.y, t),
    length: mix(a.length, b.length, t),
    width: mix(a.width, b.width, t),
    angle: mix(a.angle, b.angle, t),
  };
}

/**
 * Blend two expressions. Everything interpolates — the eyes turn and stretch
 * into their new shape, which is most of the charm — except the flags, which
 * switch halfway.
 */
export function blendExpressions(
  from: MascotExpression,
  to: MascotExpression,
  t: number,
): MascotExpression {
  "worklet";
  const k = clamp(t, 0, 1);
  if (k === 0) return from;
  if (k === 1) return to;
  // A tint fading in or out blends from/to "no tint" at the same strength.
  const tint = to.tint || from.tint;
  const fromAmount = from.tint ? from.tintAmount : 0;
  const toAmount = to.tint ? to.tintAmount : 0;
  return {
    left: mixEye(from.left, to.left, k),
    right: mixEye(from.right, to.right, k),
    lookX: mix(from.lookX, to.lookX, k),
    lookY: mix(from.lookY, to.lookY, k),
    tilt: mix(from.tilt, to.tilt, k),
    bounce: mix(from.bounce, to.bounce, k),
    wander: mix(from.wander, to.wander, k),
    tint,
    tintAmount: mix(fromAmount, toAmount, k),
    zzz: mix(from.zzz, to.zzz, k),
    blinks: (k >= 0.5 ? to : from).blinks,
  };
}

/** A cheap deterministic hash in 0 … 1, so blink timing is stable per seed. */
function hash01(n: number): number {
  "worklet";
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Where the idle animation is at `timeMs`. Pure: the same time and seed always
 * give the same pose, so renderers only need a clock, and two mascots with
 * different seeds do not blink in unison.
 */
export function mascotPose(expression: MascotExpression, timeMs: number, seed = 0): MascotPose {
  "worklet";
  const s = timeMs / 1000;
  const sleeping = expression.zzz > 0.5;

  // Breathing: slower and deeper while asleep.
  const breathPeriod = sleeping ? 4.2 : 3.4;
  const breath = Math.sin((s / breathPeriod) * Math.PI * 2);

  // Blinks fall into 3.6 s slots, once per slot at a hashed moment, now and
  // then doubled.
  let blink = 0;
  if (expression.blinks) {
    const slotLen = 3.6;
    const slot = Math.floor(s / slotLen);
    const at = slot * slotLen + hash01(slot + seed * 91) * (slotLen - 0.5);
    const d = s - at;
    if (d >= 0 && d < 0.18) blink = Math.sin((d / 0.18) * Math.PI);
    const d2 = d - 0.28;
    if (hash01(slot * 7 + seed) > 0.8 && d2 >= 0 && d2 < 0.18) {
      blink = Math.sin((d2 / 0.18) * Math.PI);
    }
  }

  // The head drifts on a sum of sines, which never visibly repeats, and holds
  // each glance a moment instead of sliding constantly.
  const w = expression.wander;
  const drift = (f: number, p: number) => {
    const v = Math.sin(s * f + p);
    return Math.sign(v) * Math.pow(Math.abs(v), 0.6);
  };
  const lookX = w * (0.38 * drift(0.41, seed) + 0.14 * Math.sin(s * 1.13 + seed * 2));
  const lookY = w * 0.22 * drift(0.29, seed * 3 + 1);

  // Bouncing: a hop with a squash on landing.
  let lift = 0;
  let land = 0;
  if (expression.bounce > 0) {
    const phase = (s * 1.6) % 1;
    lift = expression.bounce * Math.sin(phase * Math.PI);
    land = phase > 0.9 || phase < 0.06 ? 0.06 : 0;
  }

  return {
    expression,
    lookX,
    lookY,
    blink,
    squash: breath * (sleeping ? 0.025 : 0.014) + land,
    lift,
    time: s,
  };
}

/** Half-width of the body at a given height, as a fraction of its radius. */
function widthAt(shape: MascotShape, v: number): number {
  "worklet";
  // v: −1 at the top … 1 at the bottom.
  if (shape === "lemon") return 0.8 + 0.2 * v;
  return 1;
}

function bodyPath(shape: MascotShape, cx: number, cy: number, rx: number, ry: number): string {
  "worklet";
  // Superellipse exponent: higher is boxier.
  const n = shape === "cube" ? 5 : shape === "capsule" ? 3 : 2;
  const steps = 64;
  const pts: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const ex = Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const ey = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push(`${r2(cx + rx * ex * widthAt(shape, ey))} ${r2(cy + ry * ey)}`);
  }
  return `M${pts.join(" L")} Z`;
}

/** A cloud: overlapping puffs of the body colour around a solid middle. */
function cloudPuffs(cx: number, cy: number, rx: number, ry: number, fill: string) {
  "worklet";
  const puffs: Array<[number, number, number]> = [
    [0, 0.18, 0.78],
    [-0.52, 0.28, 0.5],
    [0.52, 0.28, 0.5],
    [-0.3, -0.3, 0.52],
    [0.28, -0.36, 0.56],
    [0, 0.5, 0.5],
  ];
  return puffs.map(
    ([x, y, r]): MascotPrimitive => ({
      kind: "ellipse",
      cx: r2(cx + x * rx),
      cy: r2(cy + y * ry),
      rx: r2(r * rx),
      ry: r2(r * ry),
      fill,
    }),
  );
}

export type MascotGeometry = {
  width: number;
  height: number;
  primitives: MascotPrimitive[];
  /** Lean, applied by the renderer as a rotation about `pivot`. */
  tilt: number;
  pivot: { x: number; y: number };
};

/**
 * One frame of the mascot. Pass a `MascotPose` from `mascotPose` for motion,
 * or `stillPose(expression)` for a static picture.
 */
export function mascotFrame(character: Partial<MascotCharacter>, pose: MascotPose): MascotGeometry {
  "worklet";
  const ch = { ...DEFAULT_CHARACTER, ...character };
  const ex = pose.expression;
  const groundY = 92;

  const baseR = 38;
  const cloud = ch.shape === "cloud";
  const rx = baseR * Math.sqrt(ch.aspect) * (1 + pose.squash * 0.5) * (cloud ? 0.92 : 1);
  const ry = (baseR / Math.sqrt(ch.aspect)) * (1 - pose.squash) * (cloud ? 0.72 : 1);
  const cx = 50;
  const cy = groundY - ry - pose.lift - (cloud ? 8 : 0);

  const tinted = ex.tint && ex.tintAmount > 0;
  const color = tinted ? mixHex(ch.color, ex.tint, ex.tintAmount) : ch.color;
  // On a tinted body the eyes darken towards that tint rather than staying
  // black, which keeps them part of the same face.
  // Dark eyes vanish on a dark body, so a near-black character gets light ones
  // unless it chose its own.
  const baseEye =
    ch.eyeColor === DEFAULT_CHARACTER.eyeColor && luminance(ch.color) < 0.12
      ? "#f2f2f5"
      : ch.eyeColor;
  const eyeColor = tinted
    ? mixHex(baseEye, mixHex(ex.tint, "#000000", 0.6), ex.tintAmount)
    : baseEye;

  const primitives: MascotPrimitive[] = cloud
    ? cloudPuffs(cx, cy, rx, ry, color)
    : [{ kind: "path", d: bodyPath(ch.shape, cx, cy, rx, ry), fill: color }];

  // ── The head's rotation ─────────────────────────────────────────────────
  const yaw = clamp(ex.lookX + pose.lookX, -1, 1) * 0.62;
  const pitch = clamp(ex.lookY + pose.lookY, -1, 1) * 0.42;
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  /** A point on the face (azimuth, elevation) → screen, with its depth. */
  const project = (az: number, el: number) => {
    // Unit sphere, y down, z towards the viewer.
    let x = Math.cos(el) * Math.sin(az);
    let y = Math.sin(el);
    let z = Math.cos(el) * Math.cos(az);
    // Yaw about the vertical axis, then pitch about the horizontal one.
    [x, z] = [x * cosY + z * sinY, -x * sinY + z * cosY];
    [y, z] = [y * cosP + z * sinP, -y * sinP + z * cosP];
    const v = clamp(y, -1, 1);
    return { x: cx + x * rx * 0.94 * widthAt(ch.shape, v), y: cy + y * ry * 0.94, z };
  };

  const spread = 0.25 * ch.eyeSpread;
  const halfLen = 0.13 * ch.eyeSize;
  const thickness = 9.2 * ch.eyeSize;

  for (const side of [-1, 1] as const) {
    const spec = side < 0 ? ex.left : ex.right;
    const az = side * spread + side * spec.x;
    const el = -0.06 + spec.y;
    // Positive angle leans the top outwards, so it mirrors between the eyes.
    const a = (spec.angle * Math.PI) / 180;
    const h = halfLen * spec.length;
    const dAz = side * Math.sin(a) * h;
    const dEl = Math.cos(a) * h;
    const top = project(az + dAz, el - dEl);
    const bottom = project(az - dAz, el + dEl);
    const mid = project(az, el);
    // Turned past the silhouette: hidden behind the head.
    if (mid.z < 0.15) continue;

    // Foreshortening thins the stroke as the eye turns away.
    let width = thickness * spec.width * (0.45 + 0.55 * mid.z);
    let x1 = top.x;
    let y1 = top.y;
    let x2 = bottom.x;
    let y2 = bottom.y;

    // Blink: flatten vertically about the middle and widen into a dash, so an
    // upright capsule closes into a line instead of shrinking to a dot.
    if (pose.blink > 0) {
      const b = pose.blink;
      y1 = mid.y + (y1 - mid.y) * (1 - b);
      y2 = mid.y + (y2 - mid.y) * (1 - b);
      const spreadX = b * Math.min(width * 0.3, 3);
      const leftFirst = x1 <= x2;
      x1 += leftFirst ? -spreadX : spreadX;
      x2 += leftFirst ? spreadX : -spreadX;
      width *= 1 - b * 0.45;
    }

    primitives.push({
      kind: "stroke",
      d: `M${r2(x1)} ${r2(y1)} L${r2(x2)} ${r2(y2)}`,
      stroke: eyeColor,
      width: r2(width),
    });
  }

  // Zs rise and fade from the top right, one after another.
  if (ex.zzz > 0.01) {
    for (let i = 0; i < 3; i += 1) {
      const p = (pose.time * 0.32 + i / 3) % 1;
      const size = 3.5 + p * 4;
      const zx = cx + rx * 0.72 + p * 12;
      const zy = cy - ry * 0.75 - p * 20;
      const alpha = Math.round(Math.sin(p * Math.PI) * 170 * clamp(ex.zzz, 0, 1))
        .toString(16)
        .padStart(2, "0");
      primitives.push({
        kind: "stroke",
        d:
          `M${r2(zx - size / 2)} ${r2(zy - size / 2)} L${r2(zx + size / 2)} ${r2(zy - size / 2)} ` +
          `L${r2(zx - size / 2)} ${r2(zy + size / 2)} L${r2(zx + size / 2)} ${r2(zy + size / 2)}`,
        stroke: `${eyeColor}${alpha}`,
        width: r2(1.2 + size * 0.14),
      });
    }
  }

  return {
    width: 100,
    height: 100,
    primitives,
    tilt: ch.lean + ex.tilt,
    pivot: { x: cx, y: groundY },
  };
}

/** A pose with no motion, for a static picture of an expression. */
export function stillPose(expression: MascotExpression): MascotPose {
  "worklet";
  return { expression, lookX: 0, lookY: 0, blink: 0, squash: 0, lift: 0, time: 0 };
}
