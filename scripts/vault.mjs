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
//
// Běží sám každou půlhodinu jako launchd job com.erikkarasek.vault
// ($HOME/Library/LaunchAgents), takže Wisp ho ukazuje jako kteroukoliv jinou
// automatizaci. Log v $HOME/Library/Logs/wisp-vault.log.

import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

const PAPERCLIP = "http://127.0.0.1:3100";
const VAULT = process.env.VAULT || join(homedir(), "Developer/wisp-vault");
const STATE = join(homedir(), "Library/Application Support/cz.erikkarasek.dispecink");
const DEV = join(homedir(), "Developer");
/** How many recent runs get their log read for file names. */
const RUNS_WITH_LOGS = 60;
/** How far back the notes go. */
const DAYS = 30;
/**
 * A run gets its own note only when there is something to look at. The rest
 * are rows in their day's note: 160 identical green dots make a worse graph
 * than 40 that mean something.
 */
const LONG_RUN_MIN = 5;

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
const day = (iso) => (iso ? iso.slice(0, 10) : "");
const time = (iso) => (iso ? iso.slice(11, 16) : "");
const cz = (n, one, few, many) => `${n} ${n === 1 ? one : n < 5 ? few : many}`;
const MONTHS = ["ledna", "února", "března", "dubna", "května", "června", "července", "srpna", "září", "října", "listopadu", "prosince"];
const czDay = (d) => {
  const [y, m, dd] = d.split("-").map(Number);
  return `${dd}. ${MONTHS[m - 1]} ${y}`;
};
const usd = (n) => (n ? `$${Number(n).toFixed(2)}` : "");
const mins = (r) =>
  r.finishedAt && r.startedAt ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 60_000) : null;
/** Most runs are over in seconds, and "0 min" tells you nothing. */
const dur = (r) => {
  if (!r.finishedAt || !r.startedAt) return "";
  const s = Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000);
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

const STATUS = {
  succeeded: "hotovo",
  failed: "spadlo",
  cancelled: "zrušeno",
  running: "běží",
  queued: "ve frontě",
};

/** Table rows are only as readable as their widest cell. */
const table = (head, rows) =>
  rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n") : "";

async function repos() {
  const out = [];
  for (const e of await readdir(DEV, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    if (existsSync(join(DEV, e.name, ".git"))) out.push(e.name);
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

  // Worth its own note: a failure, a file changed, or a run long enough to be
  // worth asking about. A cancelled run on its own says nothing (Wisp put the
  // Mac to sleep under it), so it stays a row in its day.
  const worthANote = (r) =>
    r.status === "failed" || (runFiles.get(r.id) ?? []).length > 0 || (mins(r) ?? 0) >= LONG_RUN_MIN;
  const noted = recent.filter(worthANote);

  // Names you can read in the graph. Two runs in one minute are rare enough
  // that only the second one pays for it with the run id.
  const taken = new Set();
  const runTitle = new Map();
  for (const r of noted) {
    const base = `${day(r.startedAt ?? r.createdAt)} ${time(r.startedAt ?? r.createdAt)} ${agentName.get(r.agentId) ?? "?"}`;
    const name = taken.has(base) ? `${base} ${r.id.slice(0, 4)}` : base;
    taken.add(name);
    runTitle.set(r.id, name);
  }
  const runLink = (r) =>
    runTitle.has(r.id)
      ? link("Běhy", runTitle.get(r.id))
      : `[[Dny/${day(r.startedAt ?? r.createdAt)}|${time(r.startedAt ?? r.createdAt)}]]`;

  // A fresh build every time, so nothing stale lingers in the graph. Only the
  // folders this script owns are wiped; .obsidian and anything you write stays.
  for (const dir of ["Agenti", "Issues", "Běhy", "Soubory", "Projekty", "Dny"]) {
    await rm(join(VAULT, dir), { recursive: true, force: true });
    await mkdir(join(VAULT, dir), { recursive: true });
  }
  const write = (folder, name, lines) => writeFile(join(VAULT, folder, `${slug(name)}.md`), lines.filter((l) => l !== null).join("\n") + "\n");

  // ---------- agents ----------
  for (const a of agents) {
    const mine = recent.filter((r) => r.agentId === a.id);
    const ok = mine.filter((r) => r.status === "succeeded").length;
    const bad = mine.filter((r) => r.status === "failed").length;
    const cut = mine.filter((r) => r.status === "cancelled").length;
    const cost = mine.reduce((s, r) => s + (Number(r.usageJson?.costUsd) || 0), 0);
    const models = [...new Set(mine.map((r) => r.usageJson?.model).filter(Boolean))];
    const myIssues = issues.filter((i) => i.assigneeAgentId === a.id);
    const open = myIssues.filter((i) => !["done", "cancelled"].includes(i.status));
    const myFiles = [...touchedBy].filter(([, who]) => who.has(a.name)).map(([f]) => f);
    await write("Agenti", a.name, [
      "---",
      "tags:",
      "  - agent",
      `stav: ${a.status ?? ""}`,
      `firma: ${a.company}`,
      models.length ? `model: ${models.join(", ")}` : null,
      `běhů: ${mine.length}`,
      `útrata: ${cost.toFixed(2)}`,
      "---",
      `# ${a.name}`,
      "",
      a.title ? `${a.title}.` : null,
      "",
      `Za ${cz(DAYS, "den", "dny", "dní")}: **${ok} hotovo**, ${bad} spadlo, ${cut} zrušeno${cost ? `, dohromady za ${usd(cost)}` : ""}.`,
      bad + cut > ok ? "\n> [!warning] Víc běhů skončilo jinak než úspěchem." : null,
      a.pauseReason ? `\n> [!note] Pauza: ${a.pauseReason}` : null,
      "",
      "## Poslední běhy",
      "",
      table(
        ["Kdy", "Stav", "Model", "Trvalo", "Cena"],
        mine.slice(0, 12).map((r) => [
          runLink(r),
          STATUS[r.status] ?? r.status,
          r.usageJson?.model ?? "",
          dur(r),
          usd(r.usageJson?.costUsd),
        ]),
      ) || "Žádné.",
      "",
      "## Otevřené issues",
      "",
      open.length ? open.map((i) => `- ${link("Issues", i.identifier)} ${i.title}`).join("\n") : "Žádné.",
      myIssues.length > open.length ? `\nHotových nebo zrušených: ${myIssues.length - open.length}.` : null,
      "",
      "## Soubory, do kterých sahal",
      "",
      myFiles.length ? myFiles.map((f) => `- ${link("Soubory", f)}`).join("\n") : "Žádné v posledních bězích.",
    ]);
  }

  // ---------- issues ----------
  for (const i of issues) {
    const repo = repoOf(i.title, known);
    const who = agentName.get(i.assigneeAgentId);
    const done = ["done", "cancelled"].includes(i.status);
    await write("Issues", i.identifier, [
      "---",
      "tags:",
      "  - issue",
      `stav: ${i.status ?? ""}`,
      `priorita: ${i.priority ?? ""}`,
      `vznik: ${day(i.createdAt)}`,
      done && i.completedAt ? `hotovo: ${day(i.completedAt)}` : null,
      "---",
      `# ${i.identifier}`,
      "",
      `**${i.title}**`,
      "",
      [who ? `Dělá na tom ${link("Agenti", who)}` : "Bez agenta", repo ? `projekt ${link("Projekty", repo)}` : null, `stav ${i.status}`]
        .filter(Boolean)
        .join(" · ") + ".",
      i.labels?.length ? `\nLabely: ${i.labels.map((l) => l.name ?? l).join(", ")}` : null,
      "",
      i.description ? "## Zadání\n\n" + String(i.description).slice(0, 2000) : null,
    ]);
  }

  // ---------- runs worth a note ----------
  for (const r of noted) {
    const who = agentName.get(r.agentId);
    const files = runFiles.get(r.id) ?? [];
    const d = day(r.startedAt ?? r.createdAt);
    await write("Běhy", runTitle.get(r.id), [
      "---",
      "tags:",
      "  - běh",
      `stav: ${STATUS[r.status] ?? r.status}`,
      `agent: ${who ?? ""}`,
      `den: ${d}`,
      r.usageJson?.model ? `model: ${r.usageJson.model}` : null,
      r.usageJson?.costUsd ? `cena: ${Number(r.usageJson.costUsd).toFixed(3)}` : null,
      mins(r) !== null ? `minut: ${mins(r)}` : null,
      "---",
      `# ${runTitle.get(r.id)}`,
      "",
      [who ? link("Agenti", who) : null, link("Dny", d), STATUS[r.status] ?? r.status, r.invocationSource]
        .filter(Boolean)
        .join(" · "),
      dur(r) ? `\nTrvalo ${dur(r)}.` : null,
      r.error ? `\n> [!bug] ${String(r.error).slice(0, 400)}` : null,
      "",
      files.length ? "## Soubory\n\n" + files.map((f) => `- ${link("Soubory", f)}`).join("\n") : null,
    ]);
  }

  // ---------- files ----------
  for (const [f, who] of touchedBy) {
    const repo = known.find((r) => existsSync(join(DEV, r, f)));
    const rs = fileRuns.get(f) ?? [];
    await write("Soubory", f, [
      "---",
      "tags:",
      "  - soubor",
      `cesta: ${f}`,
      `agentů: ${who.size}`,
      repo ? `projekt: ${repo}` : null,
      "---",
      `# ${f.split("/").pop()}`,
      "",
      `\`${f}\`${repo ? ` v ${link("Projekty", repo)}` : ""}`,
      "",
      who.size > 1 ? "> [!warning] Sahali do něj dva a víc agentů. Tady vznikne konflikt.\n" : null,
      "## Kdo",
      "",
      [...who].map((w) => `- ${link("Agenti", w)}`).join("\n"),
      "",
      "## Kdy",
      "",
      table(
        ["Běh", "Agent", "Stav"],
        rs.slice(0, 15).map((r) => [runLink(r), agentName.get(r.agentId) ?? "", STATUS[r.status] ?? r.status]),
      ) || "",
    ]);
  }

  // ---------- projects ----------
  for (const repo of known) {
    const mine = issues.filter((i) => repoOf(i.title, known) === repo);
    const files = [...touchedBy].filter(([f]) => existsSync(join(DEV, repo, f))).map(([f]) => f);
    if (!mine.length && !files.length) continue;
    const who = [...new Set(mine.map((i) => agentName.get(i.assigneeAgentId)).filter(Boolean))];
    const open = mine.filter((i) => !["done", "cancelled"].includes(i.status));
    await write("Projekty", repo, [
      "---",
      "tags:",
      "  - projekt",
      `issues: ${mine.length}`,
      `otevřených: ${open.length}`,
      "---",
      `# ${repo}`,
      "",
      `\`~/Developer/${repo}\``,
      "",
      who.length ? "Pracují tu: " + who.map((w) => link("Agenti", w)).join(", ") + "." : "Zatím tu nikdo nepracoval.",
      "",
      mine.length ? "## Issues\n\n" + table(
        ["Issue", "Co", "Stav", "Kdo"],
        mine.slice(0, 40).map((i) => [
          link("Issues", i.identifier),
          i.title.replace(/^\[?[\w\s]*\]?\s*[\w.-]+:\s*/, "").slice(0, 70),
          i.status,
          agentName.get(i.assigneeAgentId) ?? "",
        ]),
      ) : null,
      "",
      files.length ? "## Soubory, kterých se agenti dotkli\n\n" + files.map((f) => `- ${link("Soubory", f)}`).join("\n") : null,
    ]);
  }

  // ---------- days ----------
  for (const [d, changes] of [...byDay].sort().reverse()) {
    const dayRuns = recent.filter((r) => day(r.startedAt ?? r.createdAt) === d);
    const bad = changes.filter((h) => h.state === "bad");
    const asked = changes.filter((h) => h.state === "you");
    const cost = dayRuns.reduce((s, r) => s + (Number(r.usageJson?.costUsd) || 0), 0);
    await write("Dny", d, [
      "---",
      "tags:",
      "  - den",
      `datum: ${d}`,
      `běhů: ${dayRuns.length}`,
      `pádů: ${bad.length}`,
      cost ? `útrata: ${cost.toFixed(2)}` : null,
      "---",
      `# ${d}`,
      "",
      `${czDay(d)}. ${cz(dayRuns.length, "běh", "běhy", "běhů")}, ${cz(changes.length, "změna stavu", "změny stavu", "změn stavu")}${cost ? `, za ${usd(cost)}` : ""}.`,
      "",
      bad.length
        ? "## Spadlo\n\n" + bad.map((h) => `- **${new Date(h.at).toTimeString().slice(0, 5)}** ${h.name}: ${h.text ?? ""}`).join("\n")
        : null,
      "",
      asked.length
        ? "## Chtělo tě\n\n" + asked.slice(0, 20).map((h) => `- **${new Date(h.at).toTimeString().slice(0, 5)}** ${h.name}: ${h.text ?? ""}`).join("\n")
        : null,
      "",
      dayRuns.length ? "## Běhy\n\n" + table(
        ["Kdy", "Kdo", "Stav", "Trvalo"],
        dayRuns.map((r) => [
          runLink(r),
          agentName.get(r.agentId) ?? "",
          STATUS[r.status] ?? r.status,
          dur(r),
        ]),
      ) : null,
    ]);
  }

  // ---------- the home note ----------
  const collisions = [...touchedBy].filter(([, w]) => w.size > 1);
  const hot = [...fileRuns].sort((a, b) => b[1].length - a[1].length).slice(0, 5);
  const broken = issues.filter((i) => i.status === "blocked" || i.blockerAttention);
  const spend = recent.reduce((s, r) => s + (Number(r.usageJson?.costUsd) || 0), 0);
  const week = recent.filter((r) => new Date(r.startedAt ?? r.createdAt).getTime() > Date.now() - 7 * 86_400_000);
  const days = [...byDay].sort().reverse();
  await writeFile(
    join(VAULT, "Wisp.md"),
    [
      "---",
      "tags:",
      "  - rozcestník",
      `postaveno: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      "---",
      "# Wisp",
      "",
      `Za posledních ${cz(DAYS, "den", "dny", "dní")}: **${recent.length} běhů**, z toho ${week.length} za poslední týden, ` +
        `${issues.length} issues, ${touchedBy.size} dotčených souborů${spend ? `, dohromady za ${usd(spend)}` : ""}.`,
      "",
      "## Agenti",
      "",
      table(
        ["Agent", "Stav", "Hotovo", "Spadlo", "Zrušeno", "Cena"],
        agents.map((a) => {
          const mine = recent.filter((r) => r.agentId === a.id);
          return [
            link("Agenti", a.name),
            a.status ?? "",
            String(mine.filter((r) => r.status === "succeeded").length),
            String(mine.filter((r) => r.status === "failed").length),
            String(mine.filter((r) => r.status === "cancelled").length),
            usd(mine.reduce((s, r) => s + (Number(r.usageJson?.costUsd) || 0), 0)),
          ];
        }),
      ),
      "",
      "## Kde se agenti potkali nad stejným souborem",
      "",
      collisions.length
        ? collisions.map(([f, w]) => `- ${link("Soubory", f)}: ${[...w].join(", ")}`).join("\n")
        : "Nikde, zatím. Až se to stane, bude to tady a v grafu jako soubor se dvěma čarami.",
      "",
      "## Nejvytíženější soubory",
      "",
      hot.length ? hot.map(([f, rs]) => `- ${link("Soubory", f)} · ${cz(rs.length, "běh", "běhy", "běhů")}`).join("\n") : "Zatím žádné.",
      "",
      broken.length ? "## Zaseknuté issues\n\n" + broken.map((i) => `- ${link("Issues", i.identifier)} ${i.title}`).join("\n") : null,
      "",
      "## Poslední dny",
      "",
      table(
        ["Den", "Běhů", "Spadlo"],
        days.slice(0, 10).map(([d, ch]) => [
          link("Dny", d),
          String(recent.filter((r) => day(r.startedAt ?? r.createdAt) === d).length),
          String(ch.filter((h) => h.state === "bad").length),
        ]),
      ),
      "",
      "---",
      "",
      "Staví to `scripts/vault.mjs` v `~/Developer/dispecink`, jen fakta z Paperclipu a z historie Wispu, žádné konverzace agentů.",
      "Běhy, které dopadly dobře, nic nezměnily a trvaly krátce, nemají vlastní poznámku a najdeš je v denní.",
      "Graf otevřeš ⌘G. Táhni za uzel a pruží to.",
    ]
      .filter((l) => l !== null)
      .join("\n") + "\n",
  );

  console.log(`vault: ${VAULT}`);
  console.log(
    `agenti ${agents.length} · issues ${issues.length} · běhy ${recent.length} (poznámek ${noted.length}) · soubory ${touchedBy.size} · dny ${byDay.size} · kolize ${collisions.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
