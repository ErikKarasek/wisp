import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Config } from "./config";
import type { CloudflareSnapshot } from "./model";

export type SettingsContext = {
  cfg: Config;
  save: () => Promise<void>;
  cloudflare: CloudflareSnapshot | null;
  /** Reload the cloud sources (Cloudflare, GitHub) now. */
  refreshCloud: () => Promise<void>;
  openStudio: () => void;
  toast: (text: string, ok?: boolean) => void;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let discovered: string[] | null = null;

export async function renderSettings(el: HTMLElement, ctx: SettingsContext) {
  const [hasToken, autostart] = await Promise.all([
    invoke<boolean>("secret_exists", { name: "cloudflare" }).catch(() => false),
    isEnabled().catch(() => false),
  ]);
  const cf = ctx.cloudflare;
  const cfState = !hasToken
    ? `<span class="pill">neuložený</span>`
    : cf && cf.configured && "workers" in cf
      ? `<span class="pill good">funguje · ${cf.workers.length} Workerů</span>`
      : cf && cf.configured && "error" in cf
        ? `<span class="pill bad">chyba</span> <span class="err">${esc(cf.error)}</span>`
        : `<span class="pill">uložený</span>`;

  const repos = Array.from(new Set([...(ctx.cfg.githubRepos ?? []), ...(discovered ?? [])])).sort();
  const on = new Set(ctx.cfg.githubRepos ?? []);

  el.innerHTML = `
  <div class="settings">
    <section>
      <h3>Postavičky</h3>
      <p>Vyber, uprav nebo vytvoř postavičky. Konkrétní úloze ji dáš v jejím detailu tlačítkem „Postavička“.</p>
      <button class="btn primary" data-act="studio">Otevřít ateliér</button>
    </section>

    <section>
      <h3>Cloudflare ${cfState}</h3>
      <p>Na Workery stačí token jen pro čtení. Vytvoř ho na
        <a href="#" data-link="https://dash.cloudflare.com/profile/api-tokens">dash.cloudflare.com → API Tokens</a>
        přes <b>Create Custom Token</b> s oprávněními <b>Account · Workers Scripts · Read</b> a
        <b>Account · Account Analytics · Read</b>. Uloží se do Klíčenky macOS, appka ho nikam jinam neposílá.</p>
      <div class="inline">
        <input type="password" data-f="cfToken" placeholder="${hasToken ? "Token je uložený. Nový ho nahradí." : "Vlož token"}" autocomplete="off" spellcheck="false">
        <button class="btn primary" data-act="cfSave">Uložit</button>
        ${hasToken ? `<button class="btn" data-act="cfDelete">Smazat</button>` : ""}
      </div>
    </section>

    <section>
      <h3>GitHub Actions</h3>
      <p>Používá tvoje přihlášení v <code>gh</code>. Vyber repa, jejichž workflowy chceš vidět.</p>
      <div class="checks">
        ${repos.length ? repos.map((r) => `<label><input type="checkbox" data-repo="${esc(r)}" ${on.has(r) ? "checked" : ""}> ${esc(r)}</label>`).join("") : `<span class="muted">Zatím žádná repa.</span>`}
      </div>
      <button class="btn" data-act="discover">Najít repa s workflowy</button>
    </section>

    <section>
      <h3>Upozornění a spouštění</h3>
      <label class="toggle"><input type="checkbox" data-f="notify" ${ctx.cfg.notifications ? "checked" : ""}>
        Upozornit, když něco selže nebo na mě čeká</label>
      <label class="toggle"><input type="checkbox" data-f="autostart" ${autostart ? "checked" : ""}>
        Spouštět Dispečink po přihlášení</label>
    </section>
  </div>`;

  el.querySelectorAll<HTMLAnchorElement>("[data-link]").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      void openUrl(a.dataset.link!);
    }),
  );

  const again = () => renderSettings(el, ctx);

  el.querySelector('[data-act="studio"]')!.addEventListener("click", ctx.openStudio);

  el.querySelector('[data-act="cfSave"]')!.addEventListener("click", async () => {
    const input = el.querySelector<HTMLInputElement>('[data-f="cfToken"]')!;
    if (!input.value.trim()) return ctx.toast("Nejdřív vlož token.");
    try {
      await invoke("secret_set", { name: "cloudflare", value: input.value });
      input.value = "";
      ctx.toast("Token uložený do Klíčenky.", true);
      await ctx.refreshCloud();
    } catch (e) {
      ctx.toast(String(e));
    }
    await again();
  });
  el.querySelector('[data-act="cfDelete"]')?.addEventListener("click", async () => {
    await invoke("secret_delete", { name: "cloudflare" }).catch((e) => ctx.toast(String(e)));
    await ctx.refreshCloud();
    await again();
  });

  el.querySelector('[data-act="discover"]')!.addEventListener("click", async (e) => {
    const b = e.currentTarget as HTMLButtonElement;
    b.disabled = true;
    b.textContent = "Hledám…";
    try {
      discovered = await invoke<string[]>("github_discover");
      if (ctx.cfg.githubRepos === null) {
        ctx.cfg.githubRepos = discovered;
        await ctx.save();
        await ctx.refreshCloud();
      }
    } catch (err) {
      ctx.toast(String(err));
    }
    await again();
  });
  el.querySelectorAll<HTMLInputElement>("[data-repo]").forEach((c) =>
    c.addEventListener("change", async () => {
      const set = new Set(ctx.cfg.githubRepos ?? []);
      if (c.checked) set.add(c.dataset.repo!);
      else set.delete(c.dataset.repo!);
      ctx.cfg.githubRepos = [...set].sort();
      await ctx.save();
      await ctx.refreshCloud();
    }),
  );

  el.querySelector<HTMLInputElement>('[data-f="notify"]')!.addEventListener("change", async (e) => {
    ctx.cfg.notifications = (e.target as HTMLInputElement).checked;
    await ctx.save();
  });
  el.querySelector<HTMLInputElement>('[data-f="autostart"]')!.addEventListener("change", async (e) => {
    const want = (e.target as HTMLInputElement).checked;
    try {
      if (want) await enable();
      else await disable();
    } catch (err) {
      ctx.toast(String(err));
    }
    await again();
  });
}
