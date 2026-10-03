// Wisp from the phone, through the user's Telegram bot: tasks for the
// agents, replies to them, the state and the limits. The Rust side listens to
// the bot (only the chat from the settings) and passes the messages here.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pc } from "./live";
import type { Awake } from "./awake";

type Obj = Record<string, any>;

export type PhoneContext = {
  /** Telegram on, remote control not switched off, a chat picked. */
  chat: () => string | null;
  companies: () => { company: Obj; agents: Obj[] }[];
  /** "Všechno v pořádku, 2 čekají na tebe…" and the limits, as lines. */
  status: () => string[];
  limits: () => string[];
};

const plain = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const HELP = [
  "Takhle se mnou můžeš mluvit:",
  "",
  "• Jméno agenta a úkol – třeba „Watcher: zkontroluj release check“. Agent se hned probudí.",
  "• Odpověď na zprávu od agenta (podrž zprávu → Odpovědět) – pošlu mu to do jeho úkolu.",
  "• Tlačítka Povolit / Vždy / Zamítnout – když Claude Code na Macu chce něco spustit a ty nejsi u Macu.",
  "",
  "/stav – kdo pracuje a co čeká na tebe",
  "/agenti – kdo tu je a na čem běží",
  "/limity – Claude, ChatGPT, Gemini",
  "",
  "/kde – kde jsi u Macu skončil a co dál",
  "/noc projekt: úkol – Claude to udělá, až budeš pryč (v noci nebo po 20 min), a pošle PR. /noc hned … začne hned, /noc ukáže frontu",
  "",
  "/mac – baterie, teplota a jestli Mac drží vzhůru",
  "/vzhuru – držet Mac vzhůru (/vzhuru 2h na dvě hodiny, /vzhuru vyp)",
  "/viko – běžet i se zavřeným víkem (/viko vyp)",
  "/nadalku – v nabíječce nespát, ať se k Macu vždycky dostaneš (/nadalku vyp)",
  "/spi – uspat Mac",
  "/pomoc – tahle zpráva",
].join("\n");

/** "2h", "90", "90 min", "1,5 h" → minutes; null when it isn't a time. */
function minutes(arg: string): number | null {
  const m = /^(\d+(?:[.,]\d+)?)\s*(h|hod\w*|m|min\w*)?$/.exec(arg.trim());
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Math.round(m[2]?.startsWith("h") ? n * 60 : n);
}
const OFF = /^(vyp\w*|off|ne|stop|konec)$/;

/** The Mac in a few lines, for /mac and as the answer to the awake commands. */
function macText(a: Awake): string {
  const heat = a.temp != null ? `${a.temp} °C` : ["v pohodě", "teplý", "horký", "přehřátý"][a.thermal];
  const lines = [
    `💻 ${a.why}`,
    `Baterie ${a.battery ?? "–"} %${a.charging ? " (nabíjí)" : a.onAc ? " (v nabíječce)" : ""} · procesor ${heat} · CPU ${a.cpu} %${a.lidClosed ? " · víko zavřené" : ""}`,
  ];
  if (a.working.length) lines.push(`Pracuje: ${a.working.join(", ")}`);
  const on: string[] = [];
  if (a.prefs.remote) on.push("na dálku");
  if (a.prefs.manual) on.push(a.prefs.untilMs ? `vzhůru do ${new Date(a.prefs.untilMs).toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" })}` : "vzhůru");
  if (a.prefs.lid) on.push("zavřené víko");
  if (on.length) lines.push(`Zapnuto: ${on.join(", ")}`);
  return lines.join("\n");
}

export function startPhone(ctx: PhoneContext) {
  const send = (text: string) => {
    const chat = ctx.chat();
    if (chat) void invoke("telegram_send", { chat, text }).catch(() => {});
  };
  const agents = (): Obj[] => ctx.companies().flatMap((c) => c.agents.filter((a) => a.status !== "terminated").map((a) => ({ ...a, companyId: c.company.id })));
  const wake = (id: string) => invoke("paperclip_action", { kind: "agentInvoke", id }).catch(() => {});

  void listen<{ text: string; replyTo: string }>("tg-message", async (e) => {
    const { text, replyTo } = e.payload;
    try {
      if (/^\/(start|pomoc|help)\b/i.test(text)) return send(HELP);
      if (/^\/stav\b/i.test(text)) return send(ctx.status().join("\n"));
      if (/^\/limity\b/i.test(text)) return send(ctx.limits().join("\n") || "Limity zatím nemám načtené.");
      // The night shift: Claude works on a task while Erik is away (night.rs).
      const noc = /^\/noc\b\s*([\s\S]*)$/i.exec(text);
      if (noc) return send(await invoke<string>("night_command", { arg: noc[1] }));
      if (/^\/kde\b/i.test(text)) return send(await invoke<string>("resume_text"));

      // The Mac itself: keep it awake, closed lid, remote, sleep.
      const cmd = /^\/(mac|vzhuru|viko|nadalku|spi)\b\s*(.*)$/is.exec(plain(text));
      if (cmd) {
        const [, name, rawArg] = cmd;
        const arg = rawArg.trim();
        const set = (patch: Record<string, unknown>) => invoke<Awake>("awake_set", { patch });
        if (name === "mac") return send(macText(await invoke<Awake>("awake_status")));
        if (name === "spi") {
          await invoke("telegram_send", { chat: ctx.chat(), text: "Uspávám Mac. Probudí ho otevření víka nebo klávesa." }).catch(() => {});
          return void setTimeout(() => void invoke("awake_sleep"), 2000);
        }
        if (name === "vzhuru") {
          if (OFF.test(arg)) return send(macText(await set({ manual: false, timerMin: 0 })));
          const min = arg ? minutes(arg) : 0;
          if (min == null) return send("Nerozumím času. Zkus /vzhuru 2h, /vzhuru 90 nebo /vzhuru vyp.");
          return send(macText(await set({ manual: true, timerMin: min })));
        }
        if (name === "viko") {
          const a = await invoke<Awake>("awake_status");
          if (!a.lidReady) return send("Zavřené víko ještě není nastavené. U Macu otevři panel Wispu a u „Zavřené víko“ klikni na Nastavit (jednou zadáš heslo).");
          return send(macText(await set({ lid: !OFF.test(arg) })));
        }
        if (name === "nadalku") {
          const on = !OFF.test(arg);
          const a = await set({ remote: on });
          const note = on
            ? a.onAc
              ? "V nabíječce teď Mac neusne, ani se zavřeným víkem. Displej zhasne jako obvykle."
              : "Až bude v nabíječce, přestane usínat. Na baterii usne jako vždy."
            : "Mac zase usíná jako obvykle.";
          return send(`${note}\n\n${macText(a)}`);
        }
      }
      if (/^\/agenti\b/i.test(text)) {
        const engine: Record<string, string> = { claude_local: "Claude", codex_local: "ChatGPT" };
        const list = agents().filter((a) => a.status !== "terminated");
        return send(
          [
            "Agenti:",
            ...list.map((a) => `• ${a.name} (${engine[a.adapterType] ?? a.adapterType})${a.status === "paused" ? " – pozastavený" : ""}`),
            "",
            `Úkol dáš tak, že napíšeš jméno a co má udělat, třeba „${list[0]?.name ?? "Watcher"}: …“.`,
          ].join("\n"),
        );
      }

      // A reply to an agent's message: a comment on that task.
      const ref = /\b([A-Z]{2,6}-\d+)\b/.exec(replyTo)?.[1];
      if (ref) {
        for (const c of ctx.companies()) {
          const all = await pc<Obj[] | { items: Obj[] }>("GET", `/companies/${c.company.id}/issues`);
          const issue = (Array.isArray(all) ? all : all.items).find((i) => i.identifier === ref);
          if (!issue) continue;
          await pc("POST", `/issues/${issue.id}/comments`, { body: text });
          if (["done", "cancelled", "blocked", "in_review", "backlog"].includes(issue.status)) await pc("PATCH", `/issues/${issue.id}`, { status: "todo" });
          const who = agents().find((a) => a.id === issue.assigneeAgentId);
          if (who) await wake(who.id);
          return send(who ? `Posláno ${who.name} (${ref}). Odpověď ti sem pošlu.` : `Zapsáno k ${ref}.`);
        }
        return send(`Úkol ${ref} jsem nenašel.`);
      }

      // "Watcher: …" or "Watcher …": a new task for that agent.
      const who = agents()
        .sort((a, b) => b.name.length - a.name.length)
        .find((a) => plain(text).startsWith(plain(a.name)));
      if (who) {
        const body = text.slice(who.name.length).replace(/^[\s:,–-]+/, "").trim();
        if (!body) return send(`Co má ${who.name} udělat? Napiš třeba „${who.name}: …“.`);
        const [first, ...rest] = body.split("\n");
        const issue = await pc<Obj>("POST", `/companies/${who.companyId}/issues`, {
          title: first.slice(0, 120),
          description: rest.join("\n").trim() || first,
          status: "todo",
          priority: "medium",
          assigneeAgentId: who.id,
        });
        await wake(who.id);
        return send(`${who.name} dostal úkol ${issue.identifier}. Až odpoví, pošlu ti to sem.`);
      }
      send(`Nevím, komu to patří.\n\n${HELP}\n\nAgenti: ${agents().map((a) => a.name).join(", ")}`);
    } catch (err) {
      send(`Nepovedlo se: ${String(err).slice(0, 200)}`);
    }
  });

  // The agents' answers on tasks you gave them (from the app or the phone) come to the phone.
  // Where forwarding got to survives a restart; a first start looks an hour back.
  const KEY = "dispecink.phone.since";
  const load = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  let since = load() ?? new Date(Date.now() - 60 * 60_000).toISOString();
  let forwarding = false;
  const forward = async () => {
    const chat = ctx.chat();
    if (!chat || forwarding) return;
    forwarding = true;
    const from = since;
    const next = new Date().toISOString();
    try {
      await forwardSince(from);
      // Only a finished run moves the mark; a failed one is retried from the same place.
      since = next;
      try {
        localStorage.setItem(KEY, since);
      } catch {
        /* private storage off: forwarding still works while the app runs */
      }
    } catch {
      /* Paperclip busy or down: next minute again */
    } finally {
      forwarding = false;
    }
  };
  const forwardSince = async (from: string) => {
    for (const c of ctx.companies()) {
      const all = await pc<Obj[] | { items: Obj[] }>("GET", `/companies/${c.company.id}/issues`);
      const mine = (Array.isArray(all) ? all : all.items).filter(
        (i) => i.originKind === "manual" && i.createdByUserId && i.assigneeAgentId && i.updatedAt > from,
      );
      for (const issue of mine) {
        const got = await pc<Obj[] | { items: Obj[] }>("GET", `/issues/${issue.id}/comments`);
        const news = (Array.isArray(got) ? got : got.items).filter((m) => m.authorAgentId && m.createdAt > from);
        const who = c.agents.find((a) => a.id === issue.assigneeAgentId)?.name ?? "Agent";
        for (const m of news) {
          const body = String(m.body ?? "").replace(/\*\*|`/g, "").slice(0, 1500);
          send(`${who} · ${issue.identifier} ${issue.title}\n\n${body}\n\n↩ Odpověz na tuhle zprávu a pošlu mu to.`);
        }
      }
    }
  };
  setInterval(() => void forward(), 60_000);
  setTimeout(() => void forward(), 10_000);
}
