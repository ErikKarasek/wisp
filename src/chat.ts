// Chatting with the agents: pick one, see its conversations (Paperclip issues
// assigned to it) as a messenger thread, write to it, or give it something new.
// A message wakes the agent, and the thread refreshes while it works.

import { invoke } from "@tauri-apps/api/core";
import { pc, latestRun } from "./live";
import { mountMascot, type MountedMascot } from "./mascot/svg";
import type { MascotCharacter } from "./mascot/mascot";

type Obj = Record<string, any>;

export type ChatContext = {
  companies: { company: Obj; agents: Obj[] }[];
  character: (agentId: string) => Partial<MascotCharacter>;
  toast: (text: string, ok?: boolean) => void;
  changed: () => void;
};

const STATUS: Record<string, [string, string]> = {
  backlog: ["zásobník", "s-sleep"],
  todo: ["čeká na agenta", "s-sleep"],
  in_progress: ["pracuje na tom", "s-run"],
  in_review: ["ke kontrole", "s-you"],
  blocked: ["čeká na tebe", "s-you"],
  done: ["hotovo", "s-ok"],
  cancelled: ["zrušené", "s-off"],
};
const ENGINE: Record<string, string> = { codex_local: "ChatGPT", claude_local: "Claude", reports: "Gemini · Antigravity" };
/** The reports the Antigravity jobs file (gemini-jobs/run.sh): no agent, a title ending in the model. */
const isReport = (i: Obj) => !i.assigneeAgentId && /\((Gemini|Claude v Antigravity)\) \d{4}-\d{2}-\d{2}$/.test(i.title);
const GEMINI = "**Gemini:** ";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" }) : d.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "numeric", minute: "2-digit" });
};
/** Light Markdown for the agents' messages: code, bold, line breaks. */
const md = (t: string) =>
  esc(t)
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre>${c.trim()}</pre>`)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\n/g, "<br>");

let agentId: string | null = null;
/** An issue id, or "new" for a new conversation. */
let threadId: string | null = null;
let poll = 0;
const mascots: MountedMascot[] = [];

/** Open the chat on one agent (from its card). */
export function focusAgent(id: string) {
  agentId = id;
  threadId = null;
}

export function renderChat(el: HTMLElement, ctx: ChatContext) {
  clearInterval(poll);
  mascots.splice(0).forEach((m) => m.destroy());
  const agents: Obj[] = ctx.companies.flatMap((c) => c.agents.filter((a) => a.status !== "terminated").map((a) => ({ ...a, companyId: c.company.id })));
  // The weekly Antigravity reports: ask Gemini about them in the same place.
  if (ctx.companies[0]) agents.push({ id: "reports", name: "Reporty", adapterType: "reports", companyId: ctx.companies[0].company.id });
  if (!agents.length) {
    el.innerHTML = `<p class="muted">Žádní agenti. Založ si je v Paperclipu přes „+ Nový agent“.</p>`;
    return;
  }
  if (!agentId || !agents.some((a) => a.id === agentId)) agentId = agents[0].id;
  const agent = agents.find((a) => a.id === agentId)!;

  el.innerHTML = `<div class="chat">
    <nav class="c-agents">${agents
      .map(
        (a) => `<button class="c-agent${a.id === agentId ? " on" : ""}" data-agent="${a.id}"><span class="m"></span>
          <span><b>${esc(a.name)}</b><small>${esc(ENGINE[a.adapterType] ?? a.adapterType)}${a.status === "paused" ? " · pozastavený" : ""}</small></span></button>`,
      )
      .join("")}</nav>
    <aside class="c-threads">${agent.id === "reports" ? "" : `<button class="c-new${threadId === "new" ? " on" : ""}" data-thread="new">+ Nový úkol pro ${esc(agent.name)}</button>`}<div class="c-list"><p class="muted">Načítám…</p></div></aside>
    <section class="c-thread"><p class="muted">Načítám…</p></section>
  </div>`;
  el.querySelectorAll<HTMLElement>(".c-agent").forEach((b) => {
    const a = agents.find((x) => x.id === b.dataset.agent)!;
    const look = a.id === "reports" ? { shape: "cloud" as const, color: "#4f8df5" } : ctx.character(a.id);
    mascots.push(mountMascot(b.querySelector(".m") as HTMLElement, { character: look, expression: a.status === "paused" ? "sleepy" : "happy", seed: a.name.length }));
    b.addEventListener("click", () => {
      agentId = a.id;
      threadId = null;
      renderChat(el, ctx);
    });
  });
  el.querySelector('[data-thread="new"]')?.addEventListener("click", () => {
    threadId = "new";
    renderChat(el, ctx);
  });

  const listBox = el.querySelector(".c-list") as HTMLElement;
  const threadBox = el.querySelector(".c-thread") as HTMLElement;

  void (async () => {
    const all = await pc<Obj[] | { items: Obj[] }>("GET", `/companies/${agent.companyId}/issues`).catch(() => []);
    const mine = (Array.isArray(all) ? all : all.items)
      .filter((i) => (agent.id === "reports" ? isReport(i) : i.assigneeAgentId === agent.id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 40);
    if (!threadId) threadId = mine.find((i) => !["done", "cancelled"].includes(i.status))?.id ?? mine[0]?.id ?? (agent.id === "reports" ? null : "new");
    if (!threadId) {
      threadBox.innerHTML = `<p class="muted">Zatím žádné reporty. Přijdou z kontrol na Gemini (úterý, středa, pátek).</p>`;
      listBox.innerHTML = "";
      return;
    }
    listBox.innerHTML = mine.length
      ? mine
          .map((i) => {
            const [label, cls] = STATUS[i.status] ?? [i.status, ""];
            return `<button class="c-item${i.id === threadId ? " on" : ""}" data-thread="${i.id}"><b>${esc(i.title)}</b>
              <small><span class="chip ${cls}">${label}</span> ${when(i.updatedAt)}</small></button>`;
          })
          .join("")
      : `<p class="muted">Zatím spolu nic neřešíte.</p>`;
    el.querySelector<HTMLElement>('[data-thread="new"]')?.classList.toggle("on", threadId === "new");
    listBox.querySelectorAll<HTMLButtonElement>(".c-item").forEach((b) =>
      b.addEventListener("click", () => {
        threadId = b.dataset.thread!;
        renderChat(el, ctx);
      }),
    );
    if (threadId === "new") showNew();
    else void showThread(mine.find((i) => i.id === threadId)!);
  })();

  function composer(placeholder: string, button: string) {
    return `<div class="c-compose"><textarea rows="2" placeholder="${esc(placeholder)}"></textarea><button class="btn primary">${button}</button></div>`;
  }
  function onSend(send: (text: string) => Promise<void>) {
    const ta = threadBox.querySelector("textarea") as HTMLTextAreaElement;
    const b = threadBox.querySelector(".c-compose button") as HTMLButtonElement;
    const go = async () => {
      const text = ta.value.trim();
      if (!text || b.disabled) return;
      b.disabled = true;
      try {
        await send(text);
        ta.value = "";
      } catch (err) {
        ctx.toast(String(err));
      }
      b.disabled = false;
    };
    b.addEventListener("click", () => void go());
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void go();
      }
    });
    ta.focus();
  }
  const wake = () => invoke("paperclip_action", { kind: "agentInvoke", id: agent.id }).catch(() => {});

  function showNew() {
    threadBox.innerHTML = `<header><b>Nový úkol pro ${esc(agent.name)}</b><small>První řádek bude název, zbytek podrobnosti.</small></header>
      <div class="c-msgs"><p class="muted">Napiš, co má ${esc(agent.name)} udělat. Hned se probudí a odpoví tady.</p></div>
      ${composer(`Třeba: Zkontroluj, proč padá release check`, "Zadat")}`;
    onSend(async (text) => {
      const [first, ...rest] = text.split("\n");
      const issue = await pc<Obj>("POST", `/companies/${agent.companyId}/issues`, {
        title: first.slice(0, 120),
        description: rest.join("\n").trim() || first,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agent.id,
      });
      await wake();
      ctx.toast(`${agent.name} dostal úkol ${issue.identifier ?? ""}.`, true);
      threadId = issue.id;
      ctx.changed();
      renderChat(el, ctx);
    });
  }

  async function showThread(issue: Obj) {
    const [label, cls] = STATUS[issue.status] ?? [issue.status, ""];
    threadBox.innerHTML = `<header><b>${esc(issue.title)}</b><small><code>${esc(issue.identifier)}</code> <span class="chip ${cls}">${label}</span>
      <span class="c-typing" hidden>${esc(agent.name)} pracuje…</span></small>
      <span class="c-actions">${issue.status === "done" || issue.status === "cancelled" ? "" : `<button class="btn small" data-close>Hotovo, zavřít</button>`}</span></header>
      <div class="c-msgs"></div>
      ${composer(agent.id === "reports" ? "Zeptej se na tenhle report, třeba: jak to opravím?" : `Napiš ${agent.name}…`, "Poslat")}`;
    const msgs = threadBox.querySelector(".c-msgs") as HTMLElement;
    let count = -1;
    const load = async () => {
      const got = await pc<Obj[] | { items: Obj[] }>("GET", `/issues/${issue.id}/comments`).catch(() => null);
      if (!got) return;
      const list = (Array.isArray(got) ? got : got.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (list.length === count) return;
      count = list.length;
      const nearBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 80;
      msgs.innerHTML =
        (issue.description
          ? agent.id === "reports"
            ? `<div class="c-msg them first"><div>${md(issue.description)}</div><small>report · ${when(issue.createdAt)}</small></div>`
            : `<div class="c-msg me first"><div>${md(issue.description)}</div><small>zadání · ${when(issue.createdAt)}</small></div>`
          : "") +
        list
          .map((m) => {
            const body: string = m.body ?? "";
            if (body.startsWith(GEMINI)) return `<div class="c-msg them"><div>${md(body.slice(GEMINI.length))}</div><small>Gemini · ${when(m.createdAt)}</small></div>`;
            const kind = m.authorAgentId ? "them" : m.authorUserId || agent.id === "reports" ? "me" : "sys";
            return `<div class="c-msg ${kind}"><div>${md(body)}</div><small>${kind === "sys" ? "Paperclip · " : ""}${when(m.createdAt)}</small></div>`;
          })
          .join("");
      if (nearBottom || count <= 1) msgs.scrollTop = msgs.scrollHeight;
    };
    const typing = async () => {
      if (agent.id === "reports") return;
      const run = await latestRun(agent.companyId, agent.id).catch(() => null);
      const busy = !!run && ["running", "queued"].includes(run.status);
      const t = threadBox.querySelector<HTMLElement>(".c-typing");
      if (t) t.hidden = !busy;
    };
    await load();
    msgs.scrollTop = msgs.scrollHeight;
    void typing();
    poll = window.setInterval(() => {
      if (!threadBox.isConnected) return clearInterval(poll);
      void load();
      void typing();
    }, 4000);
    threadBox.querySelector("[data-close]")?.addEventListener("click", async () => {
      await pc("PATCH", `/issues/${issue.id}`, { status: "done" }).catch((e) => ctx.toast(String(e)));
      ctx.changed();
      renderChat(el, ctx);
    });
    if (agent.id === "reports") {
      threadBox.querySelector<HTMLElement>(".c-typing")!.textContent = "Gemini přemýšlí…";
      return onSend(async (text) => {
        await pc("POST", `/issues/${issue.id}/comments`, { body: text });
        await load();
        msgs.scrollTop = msgs.scrollHeight;
        const t = threadBox.querySelector<HTMLElement>(".c-typing")!;
        t.hidden = false;
        const got = await pc<Obj[] | { items: Obj[] }>("GET", `/issues/${issue.id}/comments`).catch(() => []);
        const past = (Array.isArray(got) ? got : got.items)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((m) => ((m.body ?? "").startsWith(GEMINI) ? `Gemini: ${m.body.slice(GEMINI.length)}` : `Erik: ${m.body}`))
          .join("\n\n");
        try {
          const answer = await invoke<string>("ask_report", { report: issue.description ?? "", thread: past, question: text });
          await pc("POST", `/issues/${issue.id}/comments`, { body: GEMINI + answer });
        } catch (err) {
          ctx.toast(String(err));
        }
        t.hidden = true;
        await load();
        msgs.scrollTop = msgs.scrollHeight;
      });
    }
    onSend(async (text) => {
      await pc("POST", `/issues/${issue.id}/comments`, { body: text });
      // A closed or waiting conversation opens again, and the agent wakes to answer.
      if (["done", "cancelled", "blocked", "in_review", "backlog"].includes(issue.status)) {
        await pc("PATCH", `/issues/${issue.id}`, { status: "todo" });
        issue.status = "todo";
      }
      await wake();
      await load();
      msgs.scrollTop = msgs.scrollHeight;
      void typing();
    });
  }
}
