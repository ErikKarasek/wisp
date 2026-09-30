// Pull requests waiting for Erik: what changed, whether CI is green, and the
// merge / close buttons. The Fixer opens them; only Erik merges.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

type PR = {
  repo: string;
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  body: string;
  mergeable: string;
  statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string; status?: string }[];
};

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function checks(pr: PR): { cls: string; text: string } {
  const all = pr.statusCheckRollup ?? [];
  if (!all.length) return { cls: "s-sleep", text: "bez kontrol" };
  const bad = all.filter((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c.conclusion ?? c.state ?? ""));
  const running = all.filter((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING");
  if (bad.length) return { cls: "s-bad", text: `červená (${bad.length})` };
  if (running.length) return { cls: "s-run", text: "CI běží" };
  return { cls: "s-ok", text: "zelená" };
}

/** A unified diff, split by file, with added and removed lines coloured. */
function diffHtml(diff: string) {
  const files = diff.split(/^diff --git /m).filter(Boolean);
  return files
    .map((f) => {
      const lines = f.split("\n");
      const name = /b\/(\S+)/.exec(lines[0])?.[1] ?? lines[0];
      const body = lines
        .slice(1)
        .filter((l) => !/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(l))
        .map((l) => `<span class="${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}">${esc(l)}</span>`)
        .join("\n");
      return `<details open><summary>${esc(name)}</summary><pre class="diff">${body}</pre></details>`;
    })
    .join("");
}

let openPr: string | null = null;

export async function renderReviews(el: HTMLElement, repos: string[], toast: (t: string, ok?: boolean) => void, changed: () => void) {
  el.innerHTML = `<p class="muted">Načítám pull requesty…</p>`;
  let prs: PR[] = [];
  try {
    prs = await invoke<PR[]>("github_prs", { repos });
  } catch (err) {
    el.innerHTML = `<p class="err">${esc(String(err))}</p>`;
    return;
  }
  const draw = () => {
    el.innerHTML = prs.length
      ? `<div class="reviews">${prs
          .map((pr) => {
            const key = `${pr.repo}#${pr.number}`;
            const c = checks(pr);
            return `<div class="pr${openPr === key ? " on" : ""}" data-key="${esc(key)}">
              <button class="pr-head" data-toggle="${esc(key)}">
                <code>${esc(pr.repo.split("/")[1])} #${pr.number}</code><b>${esc(pr.title)}</b>
                <span class="who">${esc(pr.author?.login ?? "")}</span>
                <span class="size"><i class="add">+${pr.additions}</i> <i class="del">−${pr.deletions}</i> · ${pr.changedFiles} ${pr.changedFiles === 1 ? "soubor" : "souborů"}</span>
                <span class="chip ${c.cls}">${c.text}</span>
              </button>
              ${openPr === key ? `<div class="pr-body"><p class="muted">Načítám změny…</p></div>` : ""}
            </div>`;
          })
          .join("")}</div>`
      : `<div class="empty-state"><b>Nic ke kontrole.</b><span>Až Fixer něco opraví, jeho pull request se objeví tady.</span></div>`;
    el.querySelectorAll<HTMLElement>("[data-toggle]").forEach((b) =>
      b.addEventListener("click", () => {
        openPr = openPr === b.dataset.toggle ? null : b.dataset.toggle!;
        draw();
      }),
    );
    const body = el.querySelector<HTMLElement>(".pr-body");
    if (body && openPr) void loadPr(body, prs.find((p) => `${p.repo}#${p.number}` === openPr)!);
  };

  async function loadPr(box: HTMLElement, pr: PR) {
    const diff = await invoke<string>("github_pr_diff", { repo: pr.repo, number: pr.number }).catch((e) => `!${e}`);
    const c = checks(pr);
    box.innerHTML = `
      ${pr.body ? `<div class="desc">${esc(pr.body)}</div>` : ""}
      <div class="facts"><span>Větev: <b>${esc(pr.headRefName)}</b></span><span>CI: <b>${c.text}</b></span>
        <span>Sloučitelný: <b>${pr.mergeable === "MERGEABLE" ? "ano" : pr.mergeable === "CONFLICTING" ? "konflikt" : "zjišťuje se"}</b></span></div>
      ${diff.startsWith("!") ? `<p class="err">${esc(diff.slice(1))}</p>` : diffHtml(diff)}
      <div class="btns">
        <button class="btn primary" data-act="merge" ${pr.isDraft || pr.mergeable === "CONFLICTING" ? "disabled" : ""}>Mergnout</button>
        <button class="btn" data-act="close">Zavřít bez mergnutí</button>
        <button class="btn" data-act="open">Otevřít na GitHubu</button>
      </div>`;
    box.querySelectorAll<HTMLButtonElement>("[data-act]").forEach((b) =>
      b.addEventListener("click", async () => {
        const act = b.dataset.act!;
        if (act === "open") return void openUrl(pr.url);
        if (b.dataset.armed !== "1") {
          b.dataset.armed = "1";
          const label = b.textContent;
          b.textContent = act === "merge" ? `Opravdu mergnout do main${c.cls === "s-ok" ? "" : " (CI není zelená)"}?` : "Opravdu zavřít?";
          setTimeout(() => {
            b.dataset.armed = "";
            b.textContent = label;
          }, 4000);
          return;
        }
        b.disabled = true;
        try {
          await invoke("github_pr_action", { repo: pr.repo, number: pr.number, action: act });
          toast(act === "merge" ? "Mergnuto." : "Zavřeno.", true);
          openPr = null;
          changed();
          void renderReviews(el, repos, toast, changed);
        } catch (err) {
          toast(String(err));
          b.disabled = false;
        }
      }),
    );
  }

  draw();
  return prs.length;
}
