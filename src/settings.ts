import { invoke } from "@tauri-apps/api/core";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Config, NotchPrefs } from "./config";
import type { CloudflareSnapshot } from "./model";

export type SettingsContext = {
  cfg: Config;
  save: () => Promise<void>;
  cloudflare: CloudflareSnapshot | null;
  /** Reload the cloud sources (Cloudflare, GitHub) now. */
  refreshCloud: () => Promise<void>;
  openStudio: () => void;
  setNotch: (on: boolean) => void;
  /** Save and pass the notch's settings on to it. */
  notchChanged: () => Promise<void>;
  /** Show the morning summary right away. */
  morningNow: () => void;
  toast: (text: string, ok?: boolean) => void;
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let discovered: string[] | null = null;

export async function renderSettings(el: HTMLElement, ctx: SettingsContext) {
  const [hasToken, hasBot, autostart, ccHooks] = await Promise.all([
    invoke<boolean>("secret_exists", { name: "cloudflare" }).catch(() => false),
    invoke<boolean>("secret_exists", { name: "telegram" }).catch(() => false),
    isEnabled().catch(() => false),
    invoke<boolean>("cc_hooks_installed").catch(() => false),
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

  const np = (key: keyof NotchPrefs, label: string) =>
    `<label class="toggle"><input type="checkbox" data-np="${key}" ${ctx.cfg.notchPrefs[key] ? "checked" : ""}> ${label}</label>`;
  el.innerHTML = `
  <div class="settings">
    <section class="help">
      <h3>Jak to ovládat</h3>
      <dl>
        <dt>Notch</dt><dd>Najeď myší na notch. Nahoře jsou záložky: <b>domeček</b> přehled, <b>bublina</b> chat s agenty, <b>+</b> nový úkol. Na bota můžeš klikat, na notch přetáhnout soubor a zeptat se na něj.</dd>
        <dt>⌃⌥ Mezerník</dt><dd>Kdekoli rychlá otázka pro Gemini; co máš zkopírované, vezme jako podklad.</dd>
        <dt>Claude Code</dt><dd>Když chce něco spustit, notch se otevře s <b>Povolit / Vždy / Zamítnout / Terminál</b>.</dd>
        <dt>Telegram (bot Wispu)</dt><dd><code>Watcher: zkontroluj…</code> dá agentovi úkol · odpověď na zprávu agenta mu pošle odpověď · <code>/stav</code> <code>/agenti</code> <code>/limity</code> <code>/pomoc</code> · tlačítka pro povolení, když nejsi u Macu.</dd>
        <dt>Telegram (bot job-mailu)</dt><dd>Pošli odkaz na nabídku a založí kartu · <code>/board</code> přihlášky · <code>/prehled</code> ranní přehled teď · tlačítka u odpovědí firem posouvají karty.</dd>
        <dt>iPhone</dt><dd>Appka Wisp: přehled, agenti a chat, otázky pro Gemini, povolování ze zamčené obrazovky; widgety Bot, Agenti a Limity.</dd>
      </dl>
    </section>
    <section class="notch-prefs">
      <h3>Notch</h3>
      <label class="toggle"><input type="checkbox" data-f="notch" ${ctx.cfg.notch ? "checked" : ""}>
        Postavička v notchi (na Macu bez výřezu uprostřed horní lišty)</label>
      <div class="prow"><span>Postavička</span><select data-np="bot">
        <option value="">Bílá (výchozí)</option>
        ${ctx.cfg.characters.map((c) => `<option value="${esc(c.id)}" ${ctx.cfg.notchPrefs.bot === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select></div>
      <div class="prow"><span>Claude Code</span><select data-np="claude">
        <option value="">Oranžová Claude (výchozí)</option>
        ${ctx.cfg.characters.map((c) => `<option value="${esc(c.id)}" ${ctx.cfg.notchPrefs.claude === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
      </select></div>
      <div class="prow"><span>Šířka po rozbalení</span><div class="seg">${(["s", "m", "l"] as const)
        .map((w) => `<button data-width="${w}" class="${ctx.cfg.notchPrefs.width === w ? "on" : ""}">${{ s: "Úzká", m: "Střední", l: "Široká" }[w]}</button>`)
        .join("")}</div></div>
      <div class="prow"><span>Po odjetí myši</span><div class="seg">${[0.5, 1.5, 3, 6]
        .map((d) => `<button data-delay="${d}" class="${ctx.cfg.notchPrefs.closeDelay === d ? "on" : ""}">${String(d).replace(".", ",")} s</button>`)
        .join("")}</div></div>
      <div class="prow top"><span>Ukazovat</span><div class="checks">
        ${np("showOthers", "Ostatní agenty a úlohy (malé postavičky pod botem)")}${np("showMusic", "Co hraje (Spotify, Hudba)")}
        ${np("showCalendar", "Další události z kalendáře")}${np("showMirror", "Tlačítko kamery (zrcátko)")}
        ${np("showLimits", "Limity Claude, ChatGPT a Gemini vedle zavřeného notche, pořád")}
        ${np("glow", "Záře kolem okraje obrazovky, když agent nebo Claude pracuje")}
        <small class="muted">⌃⌥Mezerník kdekoli otevře notch s rychlou otázkou pro Gemini; co máš zkopírované, vezme jako podklad.</small>
      </div></div>
      <div class="prow top"><span>Chování</span><div class="checks">
        ${np("follow", "Oči sledují myš")}${np("dance", "Tancuje, když hraje hudba")}${np("peek", "Vykoukne, když se něco stane")}
      </div></div>
      <div class="prow top"><span>Claude Code</span><div class="checks">
        <label class="check"><input type="checkbox" data-f="ccHooks" ${ccHooks ? "checked" : ""}> Ukazovat, co Claude Code v terminálu dělá, a povolovat mu příkazy z notche</label>
        <small class="muted">Přidá háčky do ~/.claude/settings.json. Když Wisp neběží, Claude se ptá v terminálu jako dřív. Na povolení čeká notch minutu, pak se zeptá terminál.</small>
      </div></div>
    </section>

    <section class="notch-prefs">
      <h3>Ranní shrnutí</h3>
      <p>Ráno bot v notchi řekne, co se přes noc stalo, co na tebe čeká a co máš dnes v kalendáři.</p>
      <label class="toggle"><input type="checkbox" data-m="enabled" ${ctx.cfg.morning.enabled ? "checked" : ""}> Zapnuté</label>
      <div class="prow"><span>Kdy</span><select data-m="hour">${[5, 6, 7, 8, 9, 10, 11]
        .map((h) => `<option value="${h}" ${ctx.cfg.morning.hour === h ? "selected" : ""}>od ${h}:00 (první chvíle, kdy je Mac vzhůru)</option>`)
        .join("")}</select></div>
      <label class="toggle"><input type="checkbox" data-m="telegram" ${ctx.cfg.morning.telegram ? "checked" : ""}> Poslat i do Telegramu</label>
      <button class="btn" data-act="morningNow" style="margin-top:8px">Ukázat teď</button>
    </section>

    <section>
      <h3>Postavičky</h3>
      <p>Vyber, uprav nebo vytvoř postavičky. Konkrétní úloze ji dáš v jejím detailu tlačítkem „Postavička“.</p>
      <button class="btn primary" data-act="studio">Otevřít ateliér</button>
    </section>

    <section>
      <h3>Cloudflare ${cfState}</h3>
      <p>Appka potřebuje od Cloudflare klíč (token), který umí jen číst. Vytvoříš ho takhle:</p>
      <ol class="steps">
        <li>Klikni na <a href="#" data-link="https://dash.cloudflare.com/profile/api-tokens">Cloudflare → API Tokens</a> a přihlas se.</li>
        <li>Dej <b>Create Token</b>, sjeď úplně dolů na <b>Custom token</b> a klikni <b>Get started</b>.</li>
        <li><b>Token name</b>: Wisp.</li>
        <li><b>Permissions</b>: v prvním řádku vyber <b>Account</b> → <b>Workers Scripts</b> → <b>Read</b>.
          Pak <b>+ Add more</b> a vyber <b>Account</b> → <b>Account Analytics</b> → <b>Read</b>.</li>
        <li><b>Account Resources</b>: nech <b>Include</b> a vyber svůj účet. Zbytek neměň.</li>
        <li><b>Continue to summary</b> → <b>Create Token</b> → zkopíruj token (ukáže se jen jednou).</li>
        <li>Vlož ho sem a dej <b>Uložit</b>. Uloží se do Klíčenky macOS.</li>
      </ol>
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
      <h3>Telegram ${!hasBot ? `<span class="pill">bez bota</span>` : ctx.cfg.telegram.enabled && ctx.cfg.telegram.chat ? `<span class="pill good">posílá</span>` : `<span class="pill">vypnutý</span>`}</h3>
      <p>Když něco selže nebo na tebe čeká, přijde zpráva. Posílá ji Wisp z Macu, takže jen když je Mac zapnutý.
        Použij bota, kterého nic jiného nečte: nového od <b>@BotFather</b>, nebo <b>@DDevlogbot</b>. Bota od job-mailu ne,
        ten si zprávy vyzvedává sám a hledání chatu by se s ním přetahovalo.</p>
      <div class="inline">
        <input type="password" data-f="botToken" placeholder="${hasBot ? "Token bota je uložený. Nový ho nahradí." : "Token bota od @BotFather"}" autocomplete="off" spellcheck="false">
        <button class="btn primary" data-act="botSave">Uložit</button>
        ${hasBot ? `<button class="btn" data-act="botDelete">Smazat</button>` : ""}
      </div>
      ${hasBot ? `
      <div class="bot" data-bot>Zjišťuju, který bot je uložený…</div>
      <div class="inline" style="margin-top:8px">
        <input type="text" data-f="chat" value="${esc(ctx.cfg.telegram.chat)}" placeholder="Chat id" spellcheck="false">
        <button class="btn" data-act="findChat">Najít můj chat</button>
        <button class="btn" data-act="testMsg">Poslat zkoušku</button>
      </div>
      <div class="chats"></div>
      <label class="toggle"><input type="checkbox" data-f="tgRemote" ${ctx.cfg.telegram.remote !== false ? "checked" : ""}>
        Ovládat z telefonu: úkoly pro agenty („Watcher: …“), odpovědi agentů a povolování Claude Code, když jsi od Macu pryč</label>
      <label class="toggle"><input type="checkbox" data-f="tgOn" ${ctx.cfg.telegram.enabled ? "checked" : ""}> Posílat upozornění do Telegramu</label>` : ""}
    </section>

    <section>
      <h3>Upozornění, zvuky a spouštění</h3>
      <label class="toggle"><input type="checkbox" data-f="notify" ${ctx.cfg.notifications ? "checked" : ""}>
        Upozornit, když něco selže nebo na mě čeká</label>
      <label class="toggle"><input type="checkbox" data-f="sounds" ${ctx.cfg.sounds ? "checked" : ""}>
        Zvuky, když něco doběhne, selže nebo šťouchnu do postavičky</label>
      <label class="toggle"><input type="checkbox" data-f="trayLimits" ${ctx.cfg.trayLimits ? "checked" : ""}>
        Limity Claude (C), ChatGPT (G) a Gemini (Ge) vedle ikonky v liště</label>
      <label class="toggle"><input type="checkbox" data-f="autostart" ${autostart ? "checked" : ""}>
        Spouštět Wisp po přihlášení</label>
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

  el.querySelector('[data-act="botSave"]')!.addEventListener("click", async () => {
    const input = el.querySelector<HTMLInputElement>('[data-f="botToken"]')!;
    if (!input.value.trim()) return ctx.toast("Nejdřív vlož token bota.");
    try {
      await invoke("secret_set", { name: "telegram", value: input.value });
      ctx.toast("Token bota uložený do Klíčenky. Teď napiš botovi a dej „Najít můj chat“.", true);
    } catch (e) {
      ctx.toast(String(e));
    }
    await again();
  });
  el.querySelector('[data-act="botDelete"]')?.addEventListener("click", async () => {
    await invoke("secret_delete", { name: "telegram" }).catch((e) => ctx.toast(String(e)));
    ctx.cfg.telegram.enabled = false;
    await ctx.save();
    await again();
  });
  el.querySelector<HTMLInputElement>('[data-f="tgRemote"]')?.addEventListener("change", async (e) => {
    ctx.cfg.telegram.remote = (e.target as HTMLInputElement).checked;
    await ctx.save();
  });
  el.querySelector<HTMLInputElement>('[data-f="chat"]')?.addEventListener("change", async (e) => {
    ctx.cfg.telegram.chat = (e.target as HTMLInputElement).value.trim();
    await ctx.save();
  });
  // Which bot is saved, with a link that opens its chat in Telegram.
  const botBox = el.querySelector<HTMLElement>("[data-bot]");
  if (botBox) {
    invoke<{ username: string; name: string; webhook: boolean }>("telegram_bot")
      .then((b) => {
        botBox.innerHTML =
          `Bot: <b>${esc(b.name)}</b> <a href="#" data-link="https://t.me/${esc(b.username)}">@${esc(b.username)}</a> ` +
          `<button class="btn" data-link="https://t.me/${esc(b.username)}">Otevřít v Telegramu</button>` +
          (b.webhook
            ? `<div class="err">Tenhle bot má webhook, jeho zprávy si bere jiná služba. Použij jiného bota.</div>`
            : "");
        botBox.querySelectorAll<HTMLElement>("[data-link]").forEach((a) =>
          a.addEventListener("click", (e) => {
            e.preventDefault();
            void openUrl(a.dataset.link!);
          }),
        );
      })
      .catch((e) => (botBox.innerHTML = `<span class="err">Token bota nefunguje: ${esc(String(e))}</span>`));
  }

  // Wait for the user's message instead of looking once: they usually write it after clicking.
  el.querySelector('[data-act="findChat"]')?.addEventListener("click", async (e) => {
    const button = e.currentTarget as HTMLButtonElement;
    const box = el.querySelector(".chats") as HTMLElement;
    button.disabled = true;
    const until = Date.now() + 90_000;
    let chats: { id: string; name: string }[] = [];
    try {
      while (Date.now() < until && box.isConnected) {
        chats = await invoke<{ id: string; name: string }[]>("telegram_chats");
        if (chats.length) break;
        const left = Math.ceil((until - Date.now()) / 1000);
        box.innerHTML = `<span class="muted">Napiš teď botovi v Telegramu cokoli (třeba „ahoj“). Čekám… ${left} s</span>`;
        await new Promise((r) => setTimeout(r, 3000));
      }
      if (!box.isConnected) return;
      box.innerHTML = chats.length
        ? `<span class="muted">Vyber sebe:</span> ` +
          chats.map((c) => `<button class="btn" data-chat="${esc(c.id)}">${esc(c.name)} · ${esc(c.id)}</button>`).join("")
        : `<span class="err">Za 90 s nepřišla žádná zpráva. Píšeš opravdu tomu botovi, který je nahoře?</span>`;
      box.querySelectorAll<HTMLButtonElement>("[data-chat]").forEach((b) =>
        b.addEventListener("click", async () => {
          ctx.cfg.telegram.chat = b.dataset.chat!;
          ctx.cfg.telegram.enabled = true;
          await ctx.save();
          await again();
          ctx.toast("Chat uložený. Zkus „Poslat zkoušku“.", true);
        }),
      );
    } catch (err) {
      box.innerHTML = `<span class="err">${esc(String(err))}</span>`;
    } finally {
      button.disabled = false;
    }
  });
  el.querySelector('[data-act="testMsg"]')?.addEventListener("click", async () => {
    try {
      await invoke("telegram_send", { chat: ctx.cfg.telegram.chat, text: "Wisp: zkušební zpráva. Tudy ti dám vědět, když něco selže." });
      ctx.toast("Odesláno.", true);
    } catch (e) {
      ctx.toast(String(e));
    }
  });
  el.querySelector<HTMLInputElement>('[data-f="tgOn"]')?.addEventListener("change", async (e) => {
    ctx.cfg.telegram.enabled = (e.target as HTMLInputElement).checked;
    await ctx.save();
    await again();
  });
  el.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-np]").forEach((input) =>
    input.addEventListener("change", async () => {
      const key = input.dataset.np as keyof NotchPrefs;
      const prefs = ctx.cfg.notchPrefs as Record<string, unknown>;
      prefs[key] = input instanceof HTMLInputElement && input.type === "checkbox" ? input.checked : input.value || null;
      await ctx.notchChanged();
    }),
  );
  el.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-m]").forEach((input) =>
    input.addEventListener("change", async () => {
      const m = ctx.cfg.morning as Record<string, unknown>;
      const key = input.dataset.m!;
      m[key] = key === "hour" ? Number(input.value) : (input as HTMLInputElement).checked;
      await ctx.save();
    }),
  );
  el.querySelector('[data-act="morningNow"]')!.addEventListener("click", () => ctx.morningNow());
  el.querySelectorAll<HTMLButtonElement>("[data-delay]").forEach((b) =>
    b.addEventListener("click", async () => {
      ctx.cfg.notchPrefs.closeDelay = Number(b.dataset.delay);
      el.querySelectorAll("[data-delay]").forEach((x) => x.classList.toggle("on", x === b));
      await ctx.notchChanged();
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-width]").forEach((b) =>
    b.addEventListener("click", async () => {
      ctx.cfg.notchPrefs.width = b.dataset.width as NotchPrefs["width"];
      el.querySelectorAll("[data-width]").forEach((x) => x.classList.toggle("on", x === b));
      await ctx.notchChanged();
    }),
  );
  el.querySelector<HTMLInputElement>('[data-f="notch"]')!.addEventListener("change", async (e) => {
    ctx.cfg.notch = (e.target as HTMLInputElement).checked;
    ctx.setNotch(ctx.cfg.notch);
    await ctx.save();
  });
  el.querySelector<HTMLInputElement>('[data-f="ccHooks"]')!.addEventListener("change", async (e) => {
    const box = e.target as HTMLInputElement;
    try {
      await invoke("cc_hooks_set", { on: box.checked });
      ctx.cfg.ccHooks = box.checked;
      await ctx.save();
      ctx.toast(box.checked ? "Claude Code teď hlásí notchi, co dělá." : "Háčky Claude Code jsou pryč.", true);
    } catch (err) {
      box.checked = !box.checked;
      ctx.toast(String(err));
    }
  });
  el.querySelector<HTMLInputElement>('[data-f="trayLimits"]')!.addEventListener("change", async (e) => {
    ctx.cfg.trayLimits = (e.target as HTMLInputElement).checked;
    await ctx.save();
    window.dispatchEvent(new Event("dispecink-tray"));
  });
  el.querySelector<HTMLInputElement>('[data-f="sounds"]')!.addEventListener("change", async (e) => {
    ctx.cfg.sounds = (e.target as HTMLInputElement).checked;
    await ctx.save();
  });

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
