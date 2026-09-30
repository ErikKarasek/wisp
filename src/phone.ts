// Dispečink from the phone, through the user's Telegram bot: tasks for the
// agents, replies to them, the state and the limits. The Rust side listens to
// the bot (only the chat from the settings) and passes the messages here.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pc } from "./live";

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
  "• Watcher: zkontroluj release check – nový úkol pro agenta",
  "• odpověz na zprávu od agenta – pošlu mu to do úkolu",
  "• /stav – co se děje",
  "• /limity – Claude, ChatGPT, Gemini",
].join("\n");

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
  const forward = async () => {
    const chat = ctx.chat();
    if (!chat) return;
    const from = since;
    since = new Date().toISOString();
    try {
      localStorage.setItem(KEY, since);
    } catch {
      /* private storage off: forwarding still works while the app runs */
    }
    for (const c of ctx.companies()) {
      const all = await pc<Obj[] | { items: Obj[] }>("GET", `/companies/${c.company.id}/issues`).catch(() => []);
      const mine = (Array.isArray(all) ? all : all.items).filter(
        (i) => i.originKind === "manual" && i.createdByUserId && i.assigneeAgentId && i.updatedAt > from,
      );
      for (const issue of mine) {
        const got = await pc<Obj[] | { items: Obj[] }>("GET", `/issues/${issue.id}/comments`).catch(() => []);
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
