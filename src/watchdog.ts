// Safety nets that keep the Paperclip agents working without Erik: tasks Paperclip parked after a
// technical hiccup go back to the queue, an agent whose runs keep failing gets reported with a likely
// cause, and every new pull request lands on the phone with merge / close buttons.

import { invoke } from "@tauri-apps/api/core";
import type { PaperclipSnapshot } from "./model";
import { checks, type PR } from "./reviews";

type Obj = Record<string, any>;
const list = (v: Obj[] | { items: Obj[] } | null | undefined) => (Array.isArray(v) ? v : v?.items ?? []);
const pc = (method: string, path: string, body: Obj | null = null) => invoke<any>("paperclip_request", { method, path, body });

// ---------- memory that survives a wiped webview cache ----------

export async function loadState<T extends object>(name: "guard" | "watchdog"): Promise<T | null> {
  return invoke<T | null>("state_load", { name }).catch(() => null);
}
export async function saveState(name: "guard" | "watchdog", value: object) {
  await invoke("state_save", { name, value }).catch(() => {});
}

type WatchState = {
  /** How often each parked task was put back: after MAX_TRIES it is Erik's. */
  tries: Record<string, number>;
  /** Parked tasks Erik was already told about, as "issueId@blockedAt". */
  told: string[];
  /** Per agent, the oldest failed run of the streak Erik was told about. */
  failing: Record<string, string>;
  /** Pull requests already sent to the phone, as "repo#number". Missing until the first look. */
  prSeen?: string[];
};
let state: WatchState | null = null;
async function watchState(): Promise<WatchState> {
  if (state) return state;
  const saved = await loadState<Partial<WatchState>>("watchdog");
  state = { tries: saved?.tries ?? {}, told: saved?.told ?? [], failing: saved?.failing ?? {}, prSeen: saved?.prSeen };
  return state;
}
const save = () => (state ? saveState("watchdog", state) : Promise.resolve());

// ---------- putting a parked task back ----------

/**
 * Back to the queue: to review when the agent already linked a PR, otherwise to todo. A run that was cut off
 * holds the task until someone confirms it stopped; a plain status change would be undone, so that one is resolved.
 */
export async function restoreIssue(agentId: string, issueId: string, note: string) {
  const comments = list(await pc("GET", `/issues/${issueId}/comments`).catch(() => []));
  const pr = comments.some((m) => m.authorAgentId === agentId && /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/.test(String(m.body ?? "")));
  const status = pr ? "in_review" : "todo";
  const full: Obj | null = await pc("GET", `/issues/${issueId}`).catch(() => null);
  const held: Obj | null = full?.executionBlocker?.cause === "legacy_execution_requires_reconciliation" ? full.executionBlocker : null;
  if (held)
    await pc("POST", `/issues/${issueId}/recovery-actions/resolve`, {
      actionId: held.recoveryActionId,
      outcome: "restored",
      sourceIssueStatus: status,
      executionReconciliation: {
        runId: held.runId,
        providerStopped: true,
        actionOutcome: "mixed",
        outcomeEvidence: "The run was cut off; part of the work (branch, PR) may exist, so the agent checks before acting.",
      },
      resolutionNote: note,
    }).catch(() => {});
  else await pc("PATCH", `/issues/${issueId}`, { status }).catch(() => {});
}

// ---------- parked tasks ----------

/**
 * Why Paperclip parks a task when it can't go on by itself. These are hiccups (a run died, the Mac slept, the
 * limit ran out, the agent couldn't be started for a while): another go usually works. The rest
 * (deliberate_wait_without_target, workspace_validation_failed, configuration_incomplete) need Erik.
 */
const RETRYABLE = new Set([
  "stranded_assigned_issue",
  "process_lost",
  "provider_quota",
  "native_session_interrupted",
  "native_runner_process_exited",
  "codex_output_inactivity_monitor",
  "legacy_execution_requires_reconciliation",
]);
const MAX_TRIES = 3;
/** Paperclip may still be sorting a fresh block out itself. */
const SETTLE_MS = 5 * 60_000;
const WORKING = new Set(["idle", "running", "error"]);

async function unpark(snap: Extract<PaperclipSnapshot, { online: true }>, s: WatchState, warn: (t: string) => void, note: (t: string) => void) {
  const open = new Set<string>();
  for (const c of snap.companies) {
    const agents = new Map(c.agents.map((a) => [a.id as string, a]));
    const wake = new Set<string>();
    for (const i of c.issues) {
      if (!["done", "cancelled"].includes(i.status)) open.add(i.id);
      if (i.status !== "blocked" || !i.assigneeAgentId) continue;
      const agent = agents.get(i.assigneeAgentId);
      // A paused agent is Erik's or the limit guard's business; it puts its tasks back itself on resume.
      if (!agent || !WORKING.has(agent.status)) continue;
      if (Date.now() - Date.parse(i.blockedTransitionAt ?? i.updatedAt) < SETTLE_MS) continue;
      const full: Obj | null = await pc("GET", `/issues/${i.id}`).catch(() => null);
      if (!full || full.status !== "blocked") continue;
      const cause: string | undefined = full.activeRecoveryAction?.cause ?? full.executionBlocker?.cause;
      // No recovery behind it: the agent blocked it on purpose and says why; the morning digest lists those.
      if (!cause) continue;
      const tries = s.tries[i.id] ?? 0;
      if (RETRYABLE.has(cause) && tries < MAX_TRIES) {
        await restoreIssue(agent.id, i.id, `Wisp: put back after "${cause}" (try ${tries + 1} of ${MAX_TRIES}).`);
        s.tries[i.id] = tries + 1;
        wake.add(agent.id);
        note(`${agent.name}: úkol ${i.identifier} se zasekl (${cause}), vrátil jsem ho do fronty.`);
        continue;
      }
      const key = `${i.id}@${full.blockedTransitionAt ?? ""}`;
      if (s.told.includes(key)) continue;
      s.told.push(key);
      const why = RETRYABLE.has(cause) ? `zasekl se už ${tries}× po sobě (${cause})` : `Paperclip ho odstavil: ${cause}`;
      const next = String(full.activeRecoveryAction?.nextAction ?? "").trim();
      warn(`${agent.name} potřebuje tebe: ${i.identifier} ${String(i.title).replace(/^\[review\]\s*/, "")} – ${why}.${next ? ` Paperclip radí: ${next.slice(0, 200)}` : ""}`);
    }
    for (const id of wake) await invoke("paperclip_action", { kind: "agentInvoke", id }).catch(() => {});
  }
  // Forget finished tasks, so the files don't grow forever.
  for (const id of Object.keys(s.tries)) if (!open.has(id)) delete s.tries[id];
  s.told = s.told.filter((k) => open.has(k.split("@")[0]));
}

// ---------- agents whose runs keep failing ----------

/** Not the agent's fault: Wisp or Erik stopped it, a task moved on, Paperclip restarted. */
const BENIGN = new Set(["cancelled", "agent_paused", "issue_reassigned", "server_shutdown_interrupted"]);
const benign = (r: Obj) =>
  r.status === "cancelled" || r.status === "interrupted" || BENIGN.has(r.errorCode) || String(r.error ?? "") === "continuation_task_ownership_changed";

/** The models each adapter knows, an hour at a time: the list is slow to ask for. */
const modelCache = new Map<string, { at: number; ids: string[] }>();
async function knownModels(companyId: string, adapter: string): Promise<string[] | null> {
  if (adapter !== "claude_local" && adapter !== "codex_local") return null;
  const key = `${companyId}/${adapter}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.ids;
  const got = await pc("GET", `/companies/${companyId}/adapters/${adapter}/models`).catch(() => null);
  if (!Array.isArray(got)) return hit?.ids ?? null;
  const ids = got.map((m: Obj) => String(m.id));
  modelCache.set(key, { at: Date.now(), ids });
  return ids;
}

/** `suspect`: the model isn't on Paperclip's list and no recent run got through with it. The list lags behind
 * (Fixer runs fine on a model it lacks), so a missing model alone proves nothing. */
function hint(run: Obj, model: string | undefined, known: string[] | null, suspect: boolean): string {
  const err = `${run.error ?? ""}\n${run.stderrExcerpt ?? ""}`;
  if (suspect && model && known?.length)
    return `Model ${model} Paperclip v seznamu nemá a žádný nedávný běh s ním neprošel. Přepni agenta na některý z: ${known.slice(0, 4).join(", ")}.`;
  if (/limit failure|usage limit|rate.?limit|quota/i.test(err)) return "Došel limit předplatného. Až se obnoví, rozjede se sám.";
  if (/Command not found in PATH: "codex"/.test(err)) return "Paperclip nenašel Codex, nejspíš po aktualizaci. Cestu Wisp opraví sám do hodiny.";
  if (/Command not found in PATH/.test(err)) return "Paperclip nenašel program agenta: služba asi přišla o PATH s ~/.local/bin (po aktualizaci Paperclipu).";
  if (/Empty bearer token|PAPERCLIP_API_KEY/i.test(err)) return "Agent nemá klíč k Paperclipu: na portu 3100 asi běží jiný proces (lsof -iTCP:3100).";
  if (/terminal (service|request) failure/i.test(err))
    return `Claude běh odmítl hned na začátku. Bývá to model, který Paperclip nezná${model ? ` (agent má ${model})` : ""}, nebo odhlášený Claude.`;
  if (/not logged in|login|unauthori[sz]ed|401/i.test(err)) return "Vypadá to na odhlášení: přihlas znovu claude nebo codex.";
  return "";
}

async function failing(snap: Extract<PaperclipSnapshot, { online: true }>, s: WatchState, warn: (t: string) => void) {
  for (const c of snap.companies) {
    const cid = c.company.id as string;
    for (const a of c.agents) {
      if (a.status === "paused" || a.status === "terminated" || a.pausedAt) continue;
      const runs = list(await pc("GET", `/companies/${cid}/heartbeat-runs?agentId=${a.id}&limit=8`).catch(() => []))
        .filter((r) => r.finishedAt && r.agentId === a.id)
        .sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
      const streak: Obj[] = [];
      for (const r of runs) {
        if (benign(r)) continue;
        if (r.status !== "failed" && r.status !== "timed_out") break;
        streak.push(r);
      }
      if (!streak.length) {
        delete s.failing[a.id];
        continue;
      }
      const model: string | undefined = a.adapterConfig?.model;
      const known = await knownModels(cid, a.adapterType);
      // A model Paperclip doesn't list, with nothing but failures since: the usual suspect, so one failure is enough.
      const suspect = !!model && !!known?.length && !known.includes(model) && !runs.some((r) => r.status === "succeeded");
      if (streak.length < (suspect ? 1 : 2)) continue;
      const first = streak[streak.length - 1].id as string;
      if (s.failing[a.id] === first) continue;
      s.failing[a.id] = first;
      const last = streak[0];
      const err = String(last.error ?? last.errorCode ?? "neznámá chyba").split("\n")[0].slice(0, 200);
      const tip = hint(last, model, known, suspect);
      warn(`${a.name}: ${streak.length >= runs.length ? "všechny poslední běhy" : `${streak.length} běhy po sobě`} selhaly. Chyba: ${err}${tip ? `\n${tip}` : ""}`);
    }
  }
}

let busy = false;
/** One pass of both nets; main runs it every few minutes. */
export async function watchAgents(snap: PaperclipSnapshot | null, warn: (t: string) => void, note: (t: string) => void) {
  if (!snap?.online || busy) return;
  busy = true;
  try {
    const s = await watchState();
    await unpark(snap, s, warn, note);
    await failing(snap, s, warn);
    await save();
  } finally {
    busy = false;
  }
}

// ---------- pull requests on the phone ----------

const short = (repo: string) => repo.split("/").pop();
const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;

function prText(pr: PR) {
  const ci = checks(pr);
  const conflict = pr.mergeable === "CONFLICTING";
  return [
    `🔀 ${short(pr.repo)}#${pr.number}: ${pr.title}`,
    `+${pr.additions} −${pr.deletions} · ${pr.changedFiles} ${pr.changedFiles === 1 ? "soubor" : pr.changedFiles < 5 ? "soubory" : "souborů"} · CI ${ci.text}${conflict ? " · konflikt, mergnout nejde" : ""}`,
  ].join("\n");
}

function prKeyboard(pr: PR) {
  const k = prKey(pr);
  const row = [
    ...(pr.mergeable === "CONFLICTING" || pr.isDraft ? [] : [{ text: "Mergnout", callback_data: `pr:m:${k}` }]),
    { text: "Zavřít", callback_data: `pr:c:${k}` },
  ];
  return [row, [{ text: "Otevřít na GitHubu", url: pr.url }]];
}

/** At the first look, the open ones are sent too, newest first, but no more than this. */
const FIRST_LOOK = 6;

/** Each new pull request once, with buttons. */
export async function announcePrs(prs: PR[]) {
  if (!prs.length) return;
  const s = await watchState();
  if (!s.prSeen) {
    // Older ones beyond the first few only get remembered, so a long backlog doesn't flood the phone.
    const newest = [...prs].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    s.prSeen = newest.slice(FIRST_LOOK).map(prKey);
  }
  let changed = false;
  for (const pr of prs) {
    if (pr.isDraft || s.prSeen.includes(prKey(pr))) continue;
    // Telegram off or remote control off: the morning digest and the Mac list still show it.
    const sent = await invoke("telegram_buttons", { text: prText(pr), keyboard: prKeyboard(pr) }).then(() => true).catch(() => false);
    if (!sent) continue;
    s.prSeen.push(prKey(pr));
    changed = true;
  }
  if (changed) {
    s.prSeen = s.prSeen.slice(-300);
    await save();
  }
}

/** A button under a pull request message: ask "really?" first, then merge or close. */
export async function prButton(data: string, messageId: number, prs: PR[], done: (text: string) => void) {
  const m = /^pr:([mcMCb]):([\w.-]+\/[\w.-]+)#(\d+)$/.exec(data);
  if (!m) return;
  const [, act, repo, num] = m;
  const number = Number(num);
  const pr = prs.find((p) => p.repo === repo && p.number === number);
  const edit = (text: string, keyboard: object[] = []) => invoke("telegram_edit", { messageId, text, keyboard }).catch(() => {});
  const base = pr ? prText(pr) : `🔀 ${short(repo)}#${number}`;
  if (act === "b") return void edit(base, pr ? prKeyboard(pr) : []);
  if (act === "m" || act === "c") {
    if (!pr) return void edit(`${base}\n\nUž není otevřený.`);
    const green = checks(pr).cls === "s-ok";
    const ask = act === "m" ? `Opravdu mergnout do main?${green ? "" : " CI není zelená."}` : "Opravdu zavřít bez mergnutí?";
    return void edit(`${base}\n\n${ask}`, [
      [
        { text: act === "m" ? "Ano, mergnout" : "Ano, zavřít", callback_data: `pr:${act.toUpperCase()}:${repo}#${number}` },
        { text: "Zpět", callback_data: `pr:b:${repo}#${number}` },
      ],
    ]);
  }
  const action = act === "M" ? "merge" : "close";
  await edit(`${base}\n\n⏳ ${action === "merge" ? "Merguju" : "Zavírám"}…`);
  try {
    await invoke("github_pr_action", { repo, number, action });
    await edit(`${base}\n\n${action === "merge" ? "✅ Mergnuto." : "✖️ Zavřeno."}`);
    done(`Z Telegramu: ${short(repo)}#${number} ${action === "merge" ? "mergnut" : "zavřen"}.`);
  } catch (e) {
    await edit(`${base}\n\n❌ Nepovedlo se: ${String(e).slice(0, 300)}`, pr ? prKeyboard(pr) : []);
  }
}
