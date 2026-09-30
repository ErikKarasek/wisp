// Czech, spoken-style times: "před 5 min", "dnes 3:00", "zítra 7:00", "po 8:05".

const DAY = 86_400_000;
const WEEKDAYS = ["ne", "po", "út", "st", "čt", "pá", "so"];

const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const startOfDay = (ms: number) => new Date(new Date(ms).toDateString()).getTime();

export function ago(ms: number, now = Date.now()): string {
  const diff = now - ms;
  if (diff < 60_000) return "právě teď";
  if (diff < 3_600_000) return `před ${Math.round(diff / 60_000)} min`;
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY);
  const d = new Date(ms);
  if (days === 0) return `dnes ${hm(d)}`;
  if (days === 1) return `včera ${hm(d)}`;
  return `${d.getDate()}. ${d.getMonth() + 1}. ${hm(d)}`;
}

export function ahead(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff < 60_000) return "hned";
  if (diff < 3_600_000) return `za ${Math.round(diff / 60_000)} min`;
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
  const d = new Date(ms);
  if (days === 0) return `dnes ${hm(d)}`;
  if (days === 1) return `zítra ${hm(d)}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${hm(d)}`;
  return `${d.getDate()}. ${d.getMonth() + 1}. ${hm(d)}`;
}

function plural(n: number, one: string, few: string, many: string) {
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}

export function duration(secs: number): string {
  if (secs < 60) return plural(secs, "sekundu", "sekundy", "sekund");
  if (secs < 3600) return `${Math.round(secs / 60)} min`;
  if (secs < DAY / 1000) return `${Math.round(secs / 3600)} h`;
  return plural(Math.round(secs / 86_400), "den", "dny", "dní");
}

export type CalendarTime = { hour: number | null; minute: number | null; weekday: number | null };

/** Next time a launchd StartCalendarInterval fires. */
export function nextCalendar(times: CalendarTime[], now = Date.now()): number | null {
  let best: number | null = null;
  for (const t of times) {
    for (let day = 0; day < 8; day++) {
      const hours = t.hour == null ? [...Array(24).keys()] : [t.hour];
      for (const h of hours) {
        const d = new Date(now + day * DAY);
        d.setHours(h, t.minute ?? 0, 0, 0);
        if (t.weekday != null && d.getDay() !== t.weekday % 7) continue;
        const ms = d.getTime();
        if (ms > now && (best == null || ms < best)) best = ms;
      }
    }
  }
  return best;
}

/** "5 8 * * 1" → "po 8:05". Anything fancier is shown as it is. */
export function cronInWords(cron: string): string {
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  if (!/^\d+$/.test(m ?? "") || !/^\d+$/.test(h ?? "") || dom !== "*" || mon !== "*") return cron;
  const time = `${Number(h)}:${m.padStart(2, "0")}`;
  if (dow === "*") return `denně ${time}`;
  if (/^\d$/.test(dow)) return `${WEEKDAYS[Number(dow) % 7]} ${time}`;
  return cron;
}
