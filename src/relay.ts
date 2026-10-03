// The iPhone app's side of Wisp: every minute the state goes to the relay
// (agents, their conversations, limits, what waits on Erik), and the phone's
// commands come back as "relay-cmd" events. Permission answers are handled in Rust.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { pc } from "./live";

type Obj = Record<string, any>;

export type RelayContext = {
  companies: () => { company: Obj; agents: Obj[] }[];
  /** The cards, the counts, the limits and the Focus: what the Mac shows. */
  overview: () => Obj;
  /** How an item looks (its character, as the Mac draws it). */
  character: (itemId: string) => Obj;
  /** The phone's character editor; see setLook in main.ts. */
  setLook: (target: string, charId: string | null, name: string | null, look: Obj | null) => Promise<void>;
  toast: (text: string) => void;
};

const ENGINE: Record<string, string> = { codex_local: "ChatGPT", claude_local: "Claude" };
const list = (v: Obj[] | { items: Obj[] }) => (Array.isArray(v) ? v : v.items ?? []);

async function threads(companies: { company: Obj; agents: Obj[] }[], character: (id: string) => Obj) {
  const out: Obj[] = [];
  for (const c of companies) {
    const issues = list(await pc<Obj[] | { items: Obj[] }>("GET", `/companies/${c.company.id}/issues`).catch(() => []));
    for (const a of c.agents.filter((x) => x.status !== "terminated")) {
      const mine = issues
        .filter((i) => i.assigneeAgentId === a.id)
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .slice(0, 6);
      const withMessages = await Promise.all(
        mine.map(async (i) => {
          const comments = list(await pc<Obj[] | { items: Obj[] }>("GET", `/issues/${i.id}/comments`).catch(() => []))
            .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
            .slice(-12);
          return {
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            status: i.status,
            updatedAt: i.updatedAt,
            messages: [
              ...(i.description ? [{ who: "me", body: String(i.description).slice(0, 1500), at: i.createdAt }] : []),
              ...comments.map((m) => ({
                who: m.authorAgentId ? "agent" : m.authorUserId ? "me" : "sys",
                body: String(m.body ?? "").slice(0, 1500),
                at: m.createdAt,
              })),
            ],
          };
        }),
      );
      out.push({ id: a.id, name: a.name, engine: ENGINE[a.adapterType] ?? a.adapterType, status: a.status, character: character(`agent:${a.id}`), issues: withMessages });
    }
  }
  return out;
}

/** Quick questions from the phone and Gemini's answers, newest first. */
const answers: Obj[] = [];

export function startRelay(ctx: RelayContext): { push: () => Promise<void> } {
  let busy = false;
  const push = async () => {
    if (busy) return;
    busy = true;
    try {
      const companies = ctx.companies();
      await invoke("relay_push", { state: { at: Date.now(), ...ctx.overview(), answers, agents: await threads(companies, ctx.character) } });
    } catch {
      /* no relay set up, or offline: the next minute tries again */
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void push(), 5_000);
  setInterval(() => void push(), 60_000);

  const agents = (): Obj[] => ctx.companies().flatMap((c) => c.agents.map((a) => ({ ...a, companyId: c.company.id })));
  const wake = (id: string) => invoke("paperclip_action", { kind: "agentInvoke", id }).catch(() => {});

  void listen<Obj>("relay-cmd", async (e) => {
    const cmd = e.payload;
    try {
      if (cmd.kind === "task") {
        const a = agents().find((x) => x.id === cmd.agentId);
        const text = String(cmd.text ?? "").trim();
        if (!a || !text) return;
        const [first, ...rest] = text.split("\n");
        await pc("POST", `/companies/${a.companyId}/issues`, {
          title: first.slice(0, 120),
          description: rest.join("\n").trim() || first,
          status: "todo",
          priority: "medium",
          assigneeAgentId: a.id,
        });
        await wake(a.id);
        ctx.toast(`Z telefonu: úkol pro ${a.name}.`);
      } else if (cmd.kind === "ask") {
        const question = String(cmd.question ?? "").trim();
        if (!question) return;
        const entry: Obj = { id: String(cmd.askId ?? cmd.id), question, answer: null, at: Date.now() };
        answers.unshift(entry);
        answers.splice(10);
        void push();
        entry.answer = await invoke<string>("ask_quick", { question, context: String(cmd.context ?? "") }).catch((e) => `Nepovedlo se: ${e}`);
      } else if (cmd.kind === "job" && ["run", "pause", "resume"].includes(cmd.action)) {
        await invoke("job_action", { label: String(cmd.label), action: cmd.action });
      } else if (cmd.kind === "agent" && ["agentPause", "agentResume", "agentInvoke"].includes(cmd.action)) {
        await invoke("paperclip_action", { kind: cmd.action, id: String(cmd.agentId) });
      } else if (cmd.kind === "pr" && ["merge", "close"].includes(cmd.action) && typeof cmd.repo === "string") {
        // Merge or close from the phone: the same call as the Mac's buttons, after the phone asked "really?".
        await invoke("github_pr_action", { repo: cmd.repo, number: Number(cmd.number), action: cmd.action });
        ctx.toast(`Z telefonu: PR #${cmd.number} ${cmd.action === "merge" ? "mergnut" : "zavřen"}.`);
        void push();
      } else if (cmd.kind === "look" && typeof cmd.target === "string") {
        // The phone sends everything as strings, the look as JSON.
        let look: Obj | null = null;
        if (cmd.character) look = JSON.parse(String(cmd.character));
        await ctx.setLook(cmd.target, cmd.charId ? String(cmd.charId) : null, cmd.name ? String(cmd.name).slice(0, 40) : null, look);
        ctx.toast("Z telefonu: postavička změněná.");
      } else if (cmd.kind === "comment") {
        const text = String(cmd.text ?? "").trim();
        if (!text || typeof cmd.issueId !== "string") return;
        const issue = await pc<Obj>("GET", `/issues/${cmd.issueId}`);
        await pc("POST", `/issues/${issue.id}/comments`, { body: text });
        if (["done", "cancelled", "blocked", "in_review", "backlog"].includes(issue.status)) await pc("PATCH", `/issues/${issue.id}`, { status: "todo" });
        if (issue.assigneeAgentId) await wake(issue.assigneeAgentId);
      }
    } catch (err) {
      ctx.toast(`Příkaz z telefonu se nepovedl: ${String(err).slice(0, 120)}`);
    }
    void push();
  });
  return { push };
}
