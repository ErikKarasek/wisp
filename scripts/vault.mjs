// Builds an Obsidian vault out of what Wisp already knows: Paperclip agents,
// their issues and runs, the state changes in history.json, and the files the
// runs touched. Obsidian's graph then draws the whole thing as one web, which
// is the point: a file note that links to two agents is a collision you can see.
//
// The vault lives OUTSIDE this repo (the repo is public) and holds facts only:
// who, when, what, which file, what came out. No agent conversations.
//
//   node scripts/vault.mjs            → ~/Developer/wisp-vault
//   VAULT=/jina/cesta node scripts/vault.mjs

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const PAPERCLIP = "http://127.0.0.1:3100";
const VAULT = process.env.VAULT || join(homedir(), "Developer/wisp-vault");
const STATE = join(homedir(), "Library/Application Support/cz.erikkarasek.dispecink");
const DEV = join(homedir(), "Developer");
/** How many recent runs get their log read for file names. */
const RUNS_WITH_LOGS = 60;
/** How far back the day notes and run notes go. */
const DAYS = 30;

const api = async (path) => {
  const res = await fetch(PAPERCLIP + path, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const items = (x) => (Array.isArray(x) ? x : (x?.items ?? []));

/** A file name Obsidian and the Finder both accept, kept recognisable. */
const slug = (s) =>
  s
    .replace(/[\\/:|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 90) || "bez-nazvu";

const link = (folder, name) => `[[${folder}/${slug(name)}|${name}]]`;
const day = (iso) => (iso ? iso.slice(0, 10) : null);
/** Date and time down to the second, so two runs in one minute stay apart. */
const stamp = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 19)}` : null);
const time = (iso) => (iso ? iso.slice(11, 16) : null);
const cz = (n, one, few, many) => `${n} ${n === 1 ? one : n < 5 ? few : many}`;

const STATUS = {
  succeeded: "hotovo",
  failed: "spadlo",
  cancelled: "zrušeno",
  running: "běží",
  queued: "ve frontě",
};

async function repos() {
  const out = [];
  for (const e of await readdir(DEV, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    try {
      await readFile(join(DEV, e.name, ".git/HEAD"));
      out.push(e.name);
    } catch {}
  }
  return out;
}

/** The repo an issue is about: its title usually starts with "<repo>: …". */
function repoOf(title, known) {
  const head = /^\[?[\w\s]*\]?\s*([\w.-]+):/.exec(title || "");
  const name = head?.[1];
  if (name && known.includes(name)) return name;
  return known.find((r) => (title || "").toLowerCase().includes(r.toLowerCase())) ?? null;
}

/** File names a run touched, read from its tool calls. */
async function filesOfRun(run) {
  if (!run.logBytes) return [];
  let content = "";
  try {
    content = (await api(`/api/heartbeat-runs/${run.id}/log?offset=0&limitBytes=400000`)).content ?? "";
  } catch {
    return [];
  }
  const found = new Set();
  for (const line of content.split("\n")) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    for (const part of (rec.chunk ?? "").split("\n")) {
      let m;
      try {
        m = JSON.parse(part);
      } catch {
        continue;
      }
      if (m.type !== "acpx.tool_call") continue;
      const blob = `${m.name ?? ""} ${m.text ?? ""}`;
      for (const p of blob.matchAll(/(?:src|apps|packages|ios|relay|scripts|docs|lib|test|tests)\/[\w./-]+\.\w{2,5}/g)) {
        // Diff headers arrive as a/path and b/path; both mean the same file.
        found.add(p[0].replace(/^[ab]\//, ""));
      }
    }
  }
  return [...found];
}

const usd = (cents) => (cents ? `$${(cents / 100).toFixed(2)}` : null);

async function main() {
  const since = Date.now() - DAYS * 86_400_000;
  const known = await repos();

  const companies = (await api("/api/companies")).filter(Boolean);
  const agents = [];
  const issues = [];
  const runs = [];
  for (const c of companies) {
    for (const a of items(await api(`/api/companies/${c.id}/agents`))) agents.push({ ...a, company: c.name });
    for (const i of items(await api(`/api/companies/${c.id}/issues`))) issues.push({ ...i, company: c.name });
    for (const r of items(await api(`/api/companies/${c.id}/heartbeat-runs?limit=200`))) runs.push({ ...r, company: c.name });
  }
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const recent = runs
    .filter((r) => new Date(r.startedAt ?? r.createdAt).getTime() > since)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));

  // Files, read only for the newest runs: the logs are the expensive part.
  const runFiles = new Map();
  for (const r of recent.slice(0, RUNS_WITH_LOGS)) runFiles.set(r.id, await filesOfRun(r));

  const touchedBy = new Map(); // file → Set(agent name)
  const fileRuns = new Map(); // file → [run]
  for (const r of recent) {
    for (const f of runFiles.get(r.id) ?? []) {
      const who = agentName.get(r.agentId) ?? "?";
      (touchedBy.get(f) ?? touchedBy.set(f, new Set()).get(f)).add(who);
      (fileRuns.get(f) ?? fileRuns.set(f, []).get(f)).push(r);
    }
  }

  let history = [];
  try {
    history = JSON.parse(await readFile(join(STATE, "history.json"), "utf8"));
  } catch {}
  const byDay = new Map();
  for (const h of history) {
    if (h.at < since) continue;
    const d = new Date(h.at).toISOString().slice(0, 10);
    (byDay.get(d) ?? byDay.set(d, []).get(d)).push(h);
  }

  // A fresh build every time, so nothing stale lingers in the graph. Only the
  // folders this script owns are wiped; .obsidian and anything you write stays.
  for (const dir of ["Agenti", "Issues", "Běhy", "Soubory", "Projekty", "Dny"]) {
    await rm(join(VAULT, dir), { recursive: true, force: true });
    await mkdir(join(VAULT, dir), { recursive: true });
  }

  const write = (folder, name, body) => writeFile(join(VAULT, folder, `${slug(name)}.md`), body);
  // Several runs can start in the same second, so the run id keeps the names apart.
  const runTitle = (r) => `${stamp(r.startedAt ?? r.createdAt)} ${agentName.get(r.agentId) ?? "?"} ${r.id.slice(0, 4)}`;

  for (const a of agents) {
    const mine = recent.filter((r) => r.agentId === a.id);
    const ok = mine.filter((r) => r.status === "succeeded").length;
    const bad = mine.filter((r) => r.status === "failed").length;
    const cut = mine.filter((r) => r.status === "cancelled").length;
    const models = [...new Set(mine.map((r) => r.usageJson?.model).filter(Boolean))];
    const myIssues = issues.filter((i) => i.assigneeAgentId === a.id);
    const myFiles = [...touchedBy].filter(([, who]) => who.has(a.name)).map(([f]) => f);
    await write("Agenti", a.name, [
      "---",
      `role: ${a.role ?? a.title ?? ""}`,
      `stav: ${a.status ?? ""}`,
      `firma: ${a.company}`,
      models.length ? `model: ${models.join(", ")}` : null,
      "---",
      `# ${a.name}`,
      "",
      a.title ? `${a.title}.` : null,
      "",
      `Za ${cz(DAYS, "den", "dny", "dní")}: ${ok} hotovo, ${bad} spadlo, ${cut} zrušeno.`,
      a.pauseReason ? `\nPauza: ${a.pauseReason}` : null,
      "",
      "## Issues",
      ...(myIssues.length ? myIssues.map((i) => `- ${link("Issues", i.identifier)} ${i.title}`) : ["Žádné."]),
      "",
      "## Soubory, do kterých sahal",
      ...(myFiles.length ? myFiles.map((f) => `- ${link("Soubory", f)}`) : ["Žádné v posledních bězích."]),
      "",
      "## Běhy",
      ...mine.slice(0, 40).map((r) => `- ${link("Běhy", runTitle(r))} ${STATUS[r.status] ?? r.status}`),
      "",
    ].filter((l) => l !== null).join("\n"));
  }

  for (const i of issues) {
    const repo = repoOf(i.title, known);
    const who = agentName.get(i.assigneeAgentId);
    await write("Issues", i.identifier, [
      "---",
      `stav: ${i.status ?? ""}`,
      `priorita: ${i.priority ?? ""}`,
      `vznik: ${day(i.createdAt)}`,
      "---",
      `# ${i.identifier}: ${i.title}`,
      "",
      who ? `Dělá na tom ${link("Agenti", who)}.` : "Bez agenta.",
      repo ? `Projekt: ${link("Projekty", repo)}.` : null,
      i.completedAt ? `Hotovo ${day(i.completedAt)}.` : null,
      i.labels?.length ? `Labely: ${i.labels.map((l) => l.name ?? l).join(", ")}` : null,
      "",
      i.description ? `## Zadání\n\n${String(i.description).slice(0, 2000)}` : null,
      "",
    ].filter((l) => l !== null).join("\n"));
  }

  for (const r of recent) {
    const who = agentName.get(r.agentId);
    const files = runFiles.get(r.id) ?? [];
    const mins = r.finishedAt && r.startedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 60_000) : null;
    await write("Běhy", runTitle(r), [
      "---",
      `stav: ${STATUS[r.status] ?? r.status}`,
      `model: ${r.usageJson?.model ?? ""}`,
      `cena: ${r.usageJson?.costUsd ? `$${Number(r.usageJson.costUsd).toFixed(3)}` : null}`,
      `spuštěno: ${r.invocationSource ?? ""}`,
      "---",
      `# ${runTitle(r)}`,
      "",
      who ? `${link("Agenti", who)} · ${link("Dny", day(r.startedAt ?? r.createdAt))}` : null,
      mins !== null ? `Trvalo ${cz(mins, "minutu", "minuty", "minut")}.` : null,
      r.error ? `\n**Chyba:** ${String(r.error).slice(0, 400)}` : null,
      "",
      files.length ? "## Soubory\n\n" + files.map((f) => `- ${link("Soubory", f)}`).join("\n") : null,
      "",
    ].filter((l) => l !== null).join("\n"));
  }

  for (const [f, who] of touchedBy) {
    const repo = known.find((r) => existsSync(join(DEV, r, f)));
    await write("Soubory", f, [
      "---",
      `cesta: ${f}`,
      `agentů: ${who.size}`,
      "---",
      `# ${f}`,
      "",
      who.size > 1 ? `**Sahali do něj dva a víc agentů.** To je místo na konflikt.` : null,
      ...[...who].map((w) => `- ${link("Agenti", w)}`),
      repo ? `\nProjekt: ${link("Projekty", repo)}` : null,
      "",
      "## Běhy",
      ...(fileRuns.get(f) ?? []).slice(0, 20).map((r) => `- ${link("Běhy", runTitle(r))}`),
      "",
    ].filter((l) => l !== null).join("\n"));
  }

  for (const repo of known) {
    const mine = issues.filter((i) => repoOf(i.title, known) === repo);
    if (!mine.length) continue;
    const who = [...new Set(mine.map((i) => agentName.get(i.assigneeAgentId)).filter(Boolean))];
    await write("Projekty", repo, [
      "---",
      `issues: ${mine.length}`,
      "---",
      `# ${repo}`,
      "",
      `~/Developer/${repo}`,
      "",
      "## Agenti",
      ...(who.length ? who.map((w) => `- ${link("Agenti", w)}`) : ["Žádný."]),
      "",
      "## Issues",
      ...mine.map((i) => `- ${link("Issues", i.identifier)} ${i.title} (${i.status})`),
      "",
    ].join("\n"));
  }

  for (const [d, changes] of [...byDay].sort().reverse()) {
    const dayRuns = recent.filter((r) => day(r.startedAt ?? r.createdAt) === d);
    const bad = changes.filter((h) => h.state === "bad");
    const asked = changes.filter((h) => h.state === "you");
    await write("Dny", d, [
      "---",
      `běhů: ${dayRuns.length}`,
      `pádů: ${bad.length}`,
      "---",
      `# ${d}`,
      "",
      `${cz(changes.length, "změna stavu", "změny stavu", "změn stavu")}, ${cz(dayRuns.length, "běh", "běhy", "běhů")}.`,
      "",
      bad.length ? "## Spadlo\n\n" + bad.map((h) => `- ${new Date(h.at).toISOString().slice(11, 16)} ${h.name}: ${h.text ?? ""}`).join("\n") : null,
      "",
      asked.length ? "## Chtělo tě\n\n" + asked.slice(0, 20).map((h) => `- ${new Date(h.at).toISOString().slice(11, 16)} ${h.name}: ${h.text ?? ""}`).join("\n") : null,
      "",
      dayRuns.length ? "## Běhy\n\n" + dayRuns.map((r) => `- ${link("Běhy", runTitle(r))} ${STATUS[r.status] ?? r.status}`).join("\n") : null,
      "",
    ].filter((l) => l !== null).join("\n"));
  }

  const collisions = [...touchedBy].filter(([, w]) => w.size > 1);
  await writeFile(join(VAULT, "Wisp.md"), [
    "# Wisp",
    "",
    `Postaveno ${new Date().toISOString().slice(0, 16).replace("T", " ")} skriptem \`scripts/vault.mjs\` v ~/Developer/dispecink.`,
    "Jen fakta z Paperclipu a z historie Wispu. Žádné konverzace agentů.",
    "",
    "## Agenti",
    ...agents.map((a) => `- ${link("Agenti", a.name)} (${a.status})`),
    "",
    "## Kde se agenti potkali nad stejným souborem",
    ...(collisions.length ? collisions.map(([f, w]) => `- ${link("Soubory", f)}: ${[...w].join(", ")}`) : ["Nikde, zatím."]),
    "",
    `## Čísla`,
    `- ${issues.length} issues, ${recent.length} běhů za ${DAYS} dní`,
    `- ${touchedBy.size} souborů, kterých se běhy dotkly`,
    `- ${byDay.size} dní s nějakým pohybem`,
    "",
    "Graf otevřeš přes ⌘G nebo v levém pruhu ikonou grafu. Táhni za uzel a pruží to.",
    "",
  ].join("\n"));

  console.log(`vault: ${VAULT}`);
  console.log(`agenti ${agents.length} · issues ${issues.length} · běhy ${recent.length} · soubory ${touchedBy.size} · dny ${byDay.size} · kolize ${collisions.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
