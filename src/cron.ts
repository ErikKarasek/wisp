// Just enough cron to say when something runs next and how often: five fields,
// with *, */n, a-b, a,b and plain numbers. Cloudflare evaluates crons in UTC.

type Field = (n: number) => boolean;

function field(src: string, min: number, max: number): Field | null {
  const parts = src.split(",").map((part) => {
    const [range, stepText] = part.split("/");
    const step = stepText ? Number(stepText) : 1;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map(Number);
      lo = a;
      hi = b ?? (stepText ? max : a);
    }
    if ([lo, hi, step].some((n) => !Number.isFinite(n)) || step < 1) return null;
    return (n: number) => n >= lo && n <= hi && (n - lo) % step === 0;
  });
  if (parts.some((p) => p === null)) return null;
  return (n) => parts.some((p) => p!(n));
}

export function nextCron(expr: string, utc: boolean, now = Date.now()): number | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [mi, h, dom, mon, dow] = [
    field(f[0], 0, 59),
    field(f[1], 0, 23),
    field(f[2], 1, 31),
    field(f[3], 1, 12),
    field(f[4].replace(/7/g, "0"), 0, 6),
  ];
  if (!mi || !h || !dom || !mon || !dow) return null;
  const d = new Date(now);
  d.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    d.setTime(d.getTime() + 60_000);
    const get = utc
      ? [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()]
      : [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
    if (mi(get[0]) && h(get[1]) && dom(get[2]) && mon(get[3]) && dow(get[4])) return d.getTime();
  }
  return null;
}

/** "každých 15 min" for the common shapes; otherwise null. */
export function cronEvery(expr: string): string | null {
  const [m, h, dom, mon, dow] = expr.trim().split(/\s+/);
  if (dom !== "*" || mon !== "*" || dow !== "*") return null;
  const step = /^\*\/(\d+)$/.exec(m ?? "");
  if (step && h === "*") return `každých ${step[1]} min`;
  if (/^\d+$/.test(m ?? "") && h === "*") return "každou hodinu";
  const hstep = /^\*\/(\d+)$/.exec(h ?? "");
  if (/^\d+$/.test(m ?? "") && hstep) return `každé ${hstep[1]} h`;
  return null;
}
