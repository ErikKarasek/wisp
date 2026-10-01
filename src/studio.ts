// The character studio: pick a character for an item, tweak it, or make a new
// one. Opened for one item (from its detail) or on its own (from the sidebar).

import { fullCharacter, newId, type Config, type SavedCharacter } from "./config";
import { EXPRESSIONS, type ExpressionName, type MascotCharacter, type MascotShape } from "./mascot/mascot";
import { mascotSvg, mountMascot } from "./mascot/svg";
import { STATES, type Item, type State } from "./model";

const SHAPES: [MascotShape, string][] = [
  ["round", "Kulička"],
  ["capsule", "Kapsle"],
  ["lemon", "Citron"],
  ["cube", "Kostka"],
  ["cloud", "Mráček"],
  ["ghost", "Duch"],
];
/** Ready-made characters to start from: the gallery's second half. */
export const PRESETS: [string, Partial<MascotCharacter>][] = [
  ["Borůvka", { shape: "round", color: "#6d7fe0" }],
  ["Mátovka", { shape: "round", color: "#5fcfa8", aspect: 1.1 }],
  ["Meruňka", { shape: "round", color: "#f2a65a", eyeSize: 1.2 }],
  ["Malina", { shape: "round", color: "#f08a7e", eyeSpread: 0.8 }],
  ["Citronka", { shape: "lemon", color: "#e8d25a" }],
  ["Švestka", { shape: "lemon", color: "#8e5bb5", eyeColor: "#f4f5f8" }],
  ["Kapka", { shape: "lemon", color: "#4fb3d9", aspect: 0.85 }],
  ["Hruška", { shape: "lemon", color: "#7fc97a", aspect: 0.9, lean: -4 }],
  ["Kostička", { shape: "cube", color: "#8b9cff" }],
  ["Cihla", { shape: "cube", color: "#e0605a", aspect: 1.3, eyeSize: 0.85 }],
  ["Krabička", { shape: "cube", color: "#c9a27e", aspect: 1.15 }],
  ["Tofu", { shape: "cube", color: "#dfe3ec", eyeSize: 0.8, eyeSpread: 1.3 }],
  ["Robot", { shape: "cube", color: "#8a909b", eyeColor: "#4fb3d9", aspect: 0.9 }],
  ["Noční", { shape: "cube", color: "#3a3f4b", eyeColor: "#e8d25a" }],
  ["Pilulka", { shape: "capsule", color: "#d980c9", aspect: 1.3 }],
  ["Fazolka", { shape: "capsule", color: "#7fc97a", aspect: 1.2, lean: 6 }],
  ["Marshmallow", { shape: "capsule", color: "#f4f5f8", eyeSize: 0.9 }],
  ["Kokos", { shape: "capsule", color: "#c9a27e", aspect: 0.9, eyeSize: 1.25 }],
  ["Levandule", { shape: "capsule", color: "#b4a1f0", eyeSpread: 1.25 }],
  ["Obláček", { shape: "cloud", color: "#dfe3ec" }],
  ["Bouřka", { shape: "cloud", color: "#3a3f4b", eyeColor: "#f4f5f8" }],
  ["Cukrovka", { shape: "cloud", color: "#d980c9", eyeSize: 1.2 }],
  ["Duha", { shape: "cloud", color: "#8b9cff", aspect: 1.2 }],
  ["Pára", { shape: "cloud", color: "#4fb3d9", eyeSpread: 0.8 }],
  ["Bubák", { shape: "ghost", color: "#f4f5f8" }],
  ["Fantom", { shape: "ghost", color: "#b4a1f0", eyeSize: 1.2 }],
  ["Strašidýlko", { shape: "ghost", color: "#5fcfa8", aspect: 0.9 }],
  ["Dýňák", { shape: "ghost", color: "#f2a65a", eyeColor: "#3a1f14" }],
  ["Půlnoc", { shape: "ghost", color: "#3a3f4b", eyeColor: "#e8d25a", eyeSize: 1.15 }],
  ["Mlha", { shape: "ghost", color: "#8a909b", eyeSpread: 1.25 }],
  ["Rubín", { shape: "round", color: "#e0605a", eyeColor: "#2b2140" }],
  ["Smaragd", { shape: "round", color: "#3fae7a", eyeSize: 0.85 }],
  ["Safír", { shape: "round", color: "#3b6fd8", eyeColor: "#f4f5f8" }],
  ["Zlatíčko", { shape: "round", color: "#f2c94c", aspect: 1.2 }],
  ["Uhlík", { shape: "round", color: "#2a2d35", eyeColor: "#ff8a5b" }],
  ["Mochi", { shape: "round", color: "#f6e6dc", aspect: 1.25, eyeSize: 1.1 }],
  ["Kakao", { shape: "lemon", color: "#8a5a3c", eyeColor: "#f4f5f8" }],
  ["Ledňáček", { shape: "capsule", color: "#22b8cf", aspect: 1.05 }],
  ["Korál", { shape: "cloud", color: "#ff7f6e" }],
  ["Pistácie", { shape: "cube", color: "#a8d08d", eyeSpread: 0.85 }],
];
const BODY_COLORS = [
  "#6d7fe0", "#8b9cff", "#4fb3d9", "#5fcfa8", "#7fc97a", "#e8d25a",
  "#f2a65a", "#f08a7e", "#e0605a", "#d980c9", "#b4a1f0", "#8e5bb5",
  "#c9a27e", "#dfe3ec", "#8a909b", "#3a3f4b",
];
const EYE_COLORS = ["#111216", "#2b2140", "#3a1f14", "#f4f5f8"];
const NAMES = ["Pepík", "Bublina", "Knedlík", "Rozinka", "Drobek", "Šiška", "Fazolka", "Oříšek", "Jahůdka", "Kamínek", "Brouček", "Mufin"];
const PREVIEW: State[] = ["ok", "run", "done", "sleep", "you", "bad", "off"];

type Slider = { key: "aspect" | "lean" | "eyeSize" | "eyeSpread"; label: string; min: number; max: number; step: number; ends: [string, string] };
const SLIDERS: Slider[] = [
  { key: "aspect", label: "Postava", min: 0.75, max: 1.35, step: 0.01, ends: ["vyšší", "širší"] },
  { key: "lean", label: "Náklon", min: -12, max: 12, step: 1, ends: ["doleva", "doprava"] },
  { key: "eyeSize", label: "Velikost očí", min: 0.6, max: 1.6, step: 0.05, ends: ["malé", "velké"] },
  { key: "eyeSpread", label: "Rozestup očí", min: 0.6, max: 1.5, step: 0.05, ends: ["u sebe", "od sebe"] },
];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo: number, hi: number, step: number) => Math.round((lo + Math.random() * (hi - lo)) / step) * step;

export type StudioOptions = {
  cfg: Config;
  /** The item being dressed, if any. */
  item?: Item;
  /** Its automatic face (what it wears with no character assigned). */
  automatic?: Partial<MascotCharacter>;
  /** The name it has before any renaming. */
  defaultName?: string;
  /** Names of the items that wear a character. */
  wornBy: (characterId: string) => string[];
  save: (cfg: Config) => Promise<void>;
};

export function openStudio(o: StudioOptions) {
  const { cfg, item } = o;
  type Sel = { kind: "auto" } | { kind: "saved"; id: string } | { kind: "new" };
  const assigned = item ? cfg.assignments[item.id] : undefined;
  let sel: Sel = assigned && cfg.characters.some((c) => c.id === assigned)
    ? { kind: "saved", id: assigned }
    : item
      ? { kind: "auto" }
      : cfg.characters[0]
        ? { kind: "saved", id: cfg.characters[0].id }
        : { kind: "new" };
  let draft = { name: "", character: fullCharacter({}) };
  let source = "";
  let previewState: State = "ok";

  const root = document.createElement("div");
  root.className = "studio-backdrop";
  root.innerHTML = `
    <div class="studio" role="dialog" aria-label="Postavičky">
      <header><h2>Postavičky${item ? ` <em>pro ${esc(item.name)}</em>` : ""}</h2>
        <button class="icon-btn" data-act="close" title="Zavřít (Esc)">✕</button></header>
      <div class="studio-body">
        <aside class="gallery"></aside>
        <section class="editor">
          <div class="preview"><div class="m big"></div><div class="exprs"></div></div>
          <div class="form">
            ${item ? `<label class="row">Jméno na kartě<input type="text" data-f="cardName" maxlength="40" placeholder="${esc(o.defaultName ?? item.name)}"></label>` : ""}
            <label class="row">Jméno postavičky<input type="text" data-f="name" maxlength="30"></label>
            <div class="row"><span>Tvar</span><div class="shapes"></div></div>
            <div class="row"><span>Barva</span><div class="swatches" data-f="color"></div></div>
            <div class="row"><span>Oči</span><div class="swatches" data-f="eyeColor"></div></div>
            ${SLIDERS.map((s) => `<label class="row slider">${s.label}<span class="range"><small>${s.ends[0]}</small>
              <input type="range" data-f="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}"><small>${s.ends[1]}</small></span></label>`).join("")}
            <p class="note"></p>
            <div class="btns">
              <button class="btn" data-act="random">Náhodně</button>
              <button class="btn" data-act="delete">Smazat</button>
              <span class="spacer"></span>
              <button class="btn" data-act="saveNew">Uložit jako novou</button>
              <button class="btn primary" data-act="apply"></button>
            </div>
          </div>
        </section>
      </div>
    </div>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;

  const preview = mountMascot(q(".m.big"), { character: draft.character, expression: STATES[previewState].expr, seed: 9 });

  // Expression chips: see how the character looks in each state.
  q(".exprs").innerHTML = PREVIEW.map((s) => `<button data-s="${s}">${STATES[s].label}</button>`).join("");
  q(".exprs").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    previewState = b.dataset.s as State;
    preview.setExpression(EXPRESSIONS[STATES[previewState].expr as ExpressionName]);
    root.querySelectorAll(".exprs button").forEach((x) => x.classList.toggle("on", x === b));
  });
  (q(".exprs button") as HTMLElement).classList.add("on");

  const savedChar = (id: string) => cfg.characters.find((c) => c.id === id);
  const dirty = () => JSON.stringify(draft) !== source;

  function load(next: Sel) {
    sel = next;
    if (next.kind === "saved") {
      const c = savedChar(next.id)!;
      draft = { name: c.name, character: { ...c.character } };
    } else if (next.kind === "auto") {
      draft = { name: item?.name ?? "", character: fullCharacter(o.automatic ?? {}) };
    } else {
      draft = { name: pick(NAMES), character: randomCharacter() };
    }
    source = next.kind === "new" ? "" : JSON.stringify(draft);
    syncForm();
    renderGallery();
  }

  function randomCharacter(): MascotCharacter {
    const color = pick(BODY_COLORS);
    return fullCharacter({
      shape: pick(SHAPES)[0],
      color,
      eyeColor: color === "#3a3f4b" || color === "#8e5bb5" ? "#f4f5f8" : "#111216",
      aspect: rnd(0.85, 1.2, 0.01),
      lean: rnd(-6, 6, 1),
      eyeSize: rnd(0.8, 1.3, 0.05),
      eyeSpread: rnd(0.85, 1.2, 0.05),
    });
  }

  function syncForm() {
    q<HTMLInputElement>('[data-f="name"]').value = draft.name;
    if (item) q<HTMLInputElement>('[data-f="cardName"]').value = cfg.names[item.id] ?? "";
    for (const s of SLIDERS) q<HTMLInputElement>(`[data-f="${s.key}"]`).value = String(draft.character[s.key]);
    renderPickers();
    preview.setCharacter(draft.character);
    renderNote();
  }

  function renderPickers() {
    const c = draft.character;
    q(".shapes").innerHTML = SHAPES.map(
      ([shape, label]) =>
        `<button class="shape${c.shape === shape ? " on" : ""}" data-shape="${shape}" title="${label}">${mascotSvg({ ...c, shape, lean: 0 }, "neutral", 34)}</button>`,
    ).join("");
    const swatches = (key: "color" | "eyeColor", list: string[]) =>
      list.map((col) => `<button class="sw${c[key].toLowerCase() === col ? " on" : ""}" data-col="${col}" style="background:${col}" title="${col}"></button>`).join("") +
      `<label class="sw custom" title="Vlastní barva" style="background:${c[key]}"><input type="color" value="${c[key]}"></label>`;
    q('[data-f="color"]').innerHTML = swatches("color", BODY_COLORS);
    q('[data-f="eyeColor"]').innerHTML = swatches("eyeColor", EYE_COLORS);
  }

  function renderGallery() {
    const tile = (key: string, name: string, ch: Partial<MascotCharacter>, on: boolean, extra = "") =>
      `<button class="tile${on ? " on" : ""}" data-key="${key}">${mascotSvg(ch, "happy", 52)}<span>${esc(name)}</span>${extra}</button>`;
    const shown = (id: string) => (sel.kind === "saved" && sel.id === id ? draft.character : savedChar(id)!.character);
    q(".gallery").innerHTML =
      (item ? tile("auto", "Automatická", sel.kind === "auto" ? draft.character : o.automatic ?? {}, sel.kind === "auto") : "") +
      cfg.characters
        .map((c) => {
          const n = o.wornBy(c.id).length;
          return tile(c.id, sel.kind === "saved" && sel.id === c.id ? draft.name || c.name : c.name, shown(c.id), sel.kind === "saved" && sel.id === c.id, n ? `<i>${n}×</i>` : "");
        })
        .join("") +
      (sel.kind === "new" ? tile("new", draft.name || "Nová", draft.character, true) : "") +
      `<button class="tile add" data-key="add"><b>+</b><span>Nová</span></button>` +
      `<h6 class="gallery-head">Hotové postavičky</h6>` +
      PRESETS.map(([name, ch], n) => tile(`preset:${n}`, name, ch, false)).join("");
  }

  function renderNote() {
    const apply = q<HTMLButtonElement>('[data-act="apply"]');
    const del = q<HTMLButtonElement>('[data-act="delete"]');
    del.hidden = sel.kind !== "saved";
    q<HTMLButtonElement>('[data-act="saveNew"]').hidden = sel.kind === "new";
    let note = "";
    if (item) {
      apply.textContent = sel.kind === "auto" && !dirty() ? "Použít automatickou" : `Použít pro ${item.name}`;
    } else {
      apply.textContent = sel.kind === "new" ? "Vytvořit" : "Uložit";
    }
    if (sel.kind === "saved") {
      const who = o.wornBy(sel.id).filter((n) => n !== item?.name);
      if (who.length && dirty()) note = `Úprava se projeví i u: ${who.join(", ")}. Jinak dej „Uložit jako novou“.`;
      else if (who.length) note = `Nosí ji taky: ${who.join(", ")}.`;
    } else if (sel.kind === "auto" && dirty()) {
      note = "Z automatické podoby vznikne nová postavička.";
    }
    q(".note").textContent = note;
  }

  function changed() {
    preview.setCharacter(draft.character);
    renderPickers();
    renderGallery();
    renderNote();
  }

  // ----- form events -----
  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    const f = t.dataset.f;
    if (f === "name") {
      draft.name = t.value;
      renderGallery();
      renderNote();
    } else if (f && SLIDERS.some((s) => s.key === f)) {
      draft.character = { ...draft.character, [f]: Number(t.value) };
      preview.setCharacter(draft.character);
      renderGallery();
      renderNote();
    } else if (t.type === "color") {
      const key = t.closest('[data-f="eyeColor"]') ? "eyeColor" : "color";
      draft.character = { ...draft.character, [key]: t.value };
      preview.setCharacter(draft.character);
      (t.parentElement as HTMLElement).style.background = t.value;
      renderGallery();
      renderNote();
    }
  });
  root.addEventListener("change", (e) => {
    if ((e.target as HTMLInputElement).type === "color") renderPickers();
  });

  root.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    if (el === root) return close();
    const shape = el.closest<HTMLElement>("[data-shape]");
    if (shape) {
      draft.character = { ...draft.character, shape: shape.dataset.shape as MascotShape };
      return changed();
    }
    const sw = el.closest<HTMLElement>("button[data-col]");
    if (sw) {
      const key = sw.closest('[data-f="eyeColor"]') ? "eyeColor" : "color";
      draft.character = { ...draft.character, [key]: sw.dataset.col! };
      return changed();
    }
    const tile = el.closest<HTMLElement>(".tile");
    if (tile) {
      const key = tile.dataset.key!;
      if (key === "add") return load({ kind: "new" });
      if (key === "new") return;
      if (key.startsWith("preset:")) {
        // A ready-made one: a new character to keep, tweak or wear.
        const [name, ch] = PRESETS[Number(key.slice(7))];
        sel = { kind: "new" };
        draft = { name, character: fullCharacter(ch) };
        source = "";
        syncForm();
        renderGallery();
        return changed();
      }
      return load(key === "auto" ? { kind: "auto" } : { kind: "saved", id: key });
    }
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") return close();
    if (act === "random") {
      draft.character = randomCharacter();
      if (sel.kind === "new") draft.name = pick(NAMES);
      q<HTMLInputElement>('[data-f="name"]').value = draft.name;
      for (const s of SLIDERS) q<HTMLInputElement>(`[data-f="${s.key}"]`).value = String(draft.character[s.key]);
      return changed();
    }
    if (act === "delete" && sel.kind === "saved") {
      const id = sel.id;
      const who = o.wornBy(id);
      const b = el as HTMLButtonElement;
      if (b.dataset.armed !== "1") {
        b.dataset.armed = "1";
        b.textContent = who.length ? `Smazat? Nosí ji ${who.length}×` : "Opravdu smazat?";
        setTimeout(() => {
          b.dataset.armed = "";
          b.textContent = "Smazat";
        }, 4000);
        return;
      }
      cfg.characters = cfg.characters.filter((c) => c.id !== id);
      for (const [k, v] of Object.entries(cfg.assignments)) if (v === id) delete cfg.assignments[k];
      await o.save(cfg);
      return load(item ? { kind: "auto" } : cfg.characters[0] ? { kind: "saved", id: cfg.characters[0].id } : { kind: "new" });
    }
    if (act === "saveNew") {
      const c = createFromDraft();
      if (item) cfg.assignments[item.id] = c.id;
      await finish();
      return load({ kind: "saved", id: c.id });
    }
    if (act === "apply") {
      if (sel.kind === "new" || (sel.kind === "auto" && dirty())) {
        const c = createFromDraft();
        if (item) cfg.assignments[item.id] = c.id;
      } else if (sel.kind === "saved") {
        const c = savedChar(sel.id)!;
        c.name = draft.name.trim() || c.name;
        c.character = { ...draft.character };
        if (item) cfg.assignments[item.id] = c.id;
      } else if (item) {
        delete cfg.assignments[item.id];
      }
      await finish();
      if (item) return close();
      return load(sel.kind === "new" ? { kind: "saved", id: cfg.characters[cfg.characters.length - 1].id } : sel);
    }
  });

  function createFromDraft(): SavedCharacter {
    const c: SavedCharacter = { id: newId(), name: draft.name.trim() || item?.name || "Postavička", character: { ...draft.character } };
    cfg.characters.push(c);
    return c;
  }

  async function finish() {
    if (item) {
      const v = q<HTMLInputElement>('[data-f="cardName"]').value.trim();
      if (v && v !== (o.defaultName ?? item.name)) cfg.names[item.id] = v;
      else delete cfg.names[item.id];
    }
    await o.save(cfg);
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);

  function close() {
    preview.destroy();
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }

  load(sel);
}
