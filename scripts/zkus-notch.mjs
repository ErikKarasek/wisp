// Projde notch v prohlížeči a ověří věci, které se už jednou rozbily.
//
// Stránka notche je obyčejná webová stránka, takže ji jde pustit mimo Tauri:
// notch-harness.html podstrčí falešné `window.__TAURI_INTERNALS__`, uloží si
// posluchače událostí a `window.__fire(udalost, data)` do nich pošle, co chce.
// Tenhle skript z toho dělá test: nastartuje Vite, otevře harness v Chromu,
// který na Macu už je, a tvrdí o vykreslené stránce konkrétní věci.
//
// Pouští se `pnpm test:notch`. Vrací nenulový kód, když něco neplatí.

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 1431;
const ADRESA = `http://127.0.0.1:${PORT}/notch-harness.html?view=notch`;

const results = [];
/** Jedno tvrzení o stránce. Nepadá na první chybě, ať je vidět celý obraz. */
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/** Stav Macu, jaký notch čeká. Prázdný, pokud se nic nepředá. */
const snapshot = (items = []) => ({
  items,
  counts: { attention: 0, run: 0, sleep: 0, ok: 0, off: 0 },
  news: null,
  at: Date.now() - 60_000,
  live: [],
  usage: null,
  gpt: [],
  gemini: [],
  focus: false,
});

const BAD_AGENT = {
  id: "agent:a",
  name: "Hlídač závislostí",
  state: "bad",
  chip: "Selhal",
  doing: "Kvóta došla",
  when: "",
  where: "",
  character: { color: "#e0605a" },
};

async function main() {
  const vite = spawn("npx", ["vite", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop = () => vite.kill("SIGTERM");
  process.on("exit", stop);
  await new Promise((ok, fail) => {
    const t = setTimeout(() => fail(new Error("Vite se nerozjel do 20 s")), 20_000);
    vite.stdout.on("data", (d) => String(d).includes("ready in") && (clearTimeout(t), ok()));
    vite.on("error", fail);
  });

  // Chrome, který je na Macu nainstalovaný; prohlížeč se kvůli tomuhle nestahuje.
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: 1000, height: 220 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const open = async () => {
    await page.goto(ADRESA, { waitUntil: "load" });
    await page.waitForFunction(() => !!document.querySelector(".nt") && !!window.__fire, null, { timeout: 10_000 });
    await page.evaluate(() => localStorage.removeItem("wisp-recap-week"));
  };
  const fire = (event, payload) => page.evaluate(([e, p]) => window.__fire(e, p), [event, payload]);
  const settle = () => page.waitForTimeout(350);

  // ---- 1. Čísla z diffu přežijí useknutí řádku -------------------------------
  // Řádek v tickeru je nowrap s ellipsis. Když "+12 -3" zůstane na jeho konci
  // jako obyčejný text, ukousne se jako první a feature je neviditelná.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  await fire("cc-event", { session: "s", project: "dispecink", kind: "start", text: "" });
  for (const text of [
    "Upravuje mini.ts +12 -3",
    "Upravuje hodne-dlouhy-nazev-nejake-komponenty.component.tsx +1 -1",
    "Píše claudecode.rs +84",
  ]) {
    await fire("cc-event", { session: "s", project: "dispecink", kind: "step", text });
  }
  await settle();
  const ticker = await page.evaluate(() =>
    [...document.querySelectorAll(".ticker .step")].map((d) => ({
      text: d.querySelector(".tx")?.innerText ?? "",
      churn: d.querySelector(".churn")?.innerText.replace(/\s+/g, " ").trim() ?? null,
      sirka: d.querySelector(".churn")?.getBoundingClientRect().width ?? 0,
    })),
  );
  const long = ticker.find((t) => t.text.includes("component.tsx"));
  check("ticker: čísla jsou ve vlastním prvku, ne v useknutelném textu", ticker.every((t) => !/[+-]\d/.test(t.text)), JSON.stringify(ticker));
  check("ticker: dlouhý název souboru nesebere čísla", !!long && long.sirka > 0 && long.churn === "+1 -1", JSON.stringify(long));
  check("ticker: samotné přidání se píše bez nuly", ticker.at(-1)?.churn === "+84", JSON.stringify(ticker.at(-1)));

  // ---- 2. Karta „Vítej zpátky“ se nezasekne nad spadlým agentem --------------
  // renderFailure se odmítá překreslit, dokud si pamatuje, kterou chybu ukázal.
  // Když tu paměť nikdo nesmaže, zůstane na obrazovce viset cizí karta.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot([BAD_AGENT]));
  await settle();
  const first = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await fire("resume", { project: "nexus-grind", title: null, summary: "Něco se ladilo.", next: "Dodělat to.", branch: "main", dirty: 1, lastCommit: "x", agoMin: 40, night: [] });
  await settle();
  const onResume = await page.evaluate(() => ({
    head: document.querySelector(".steps").innerText.split("\n")[0],
    asking: document.querySelector(".nt").classList.contains("asking"),
  }));
  await page.click('.steps .perm button:text("Jasně")');
  await fire("dispecink-state", snapshot([BAD_AGENT]));
  await settle();
  const after = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  check("selhání: karta se nakreslí", first.includes("SELHAL"), first);
  check("návrat k Macu: „Vítej zpátky“ převezme kartu", onResume.head.includes("VÍTEJ ZPÁTKY") && onResume.asking, JSON.stringify(onResume));
  check("po zavření se karta vrátí k selhání, nezůstane viset", after.includes("SELHAL"), after);

  // ---- 3. Claudova otázka: odpověď se pošle ve tvaru, co čeká Rust -----------
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  await fire("cc-question", {
    id: "q1",
    project: "dispecink",
    items: [
      { question: "Kudy?", header: "Cesta", multi: false, options: [{ label: "Rychle", description: "dneska" }, { label: "Pořádně", description: "za dva dny" }] },
      { question: "Co navíc?", header: "Navíc", multi: true, options: [{ label: "Testy", description: "" }, { label: "Dokumentace", description: "" }, { label: "Nic", description: "" }] },
    ],
  });
  await settle();
  await page.click('.steps .perm button:text-is("Rychle")');
  await settle();
  const second = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await page.click('.steps .perm button:text-is("Testy")');
  await page.click('.steps .perm button:text-is("Dokumentace")');
  await page.click('.steps .perm button:text-is("Hotovo")');
  await settle();
  const sent = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "cc_decide").at(-1)?.args);
  check("otázka: jedna odpověď posune na další otázku", second.includes("2/2"), second);
  check(
    "otázka: řetězec u jedné volby, pole u více",
    sent?.id === "q1" && JSON.parse(sent.answer)["Kudy?"] === "Rychle" && JSON.stringify(JSON.parse(sent.answer)["Co navíc?"]) === '["Testy","Dokumentace"]',
    JSON.stringify(sent),
  );

  // ---- 4. Tlačítka zůstanou v kartě a dají se trefit -------------------------
  // Tohle je ta původní chyba: karta přeteče notch a tlačítka zmizí z dosahu.
  await page.setViewportSize({ width: 900, height: 180 });
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  await fire("cc-question", {
    id: "q2",
    project: "dispecink",
    items: Array.from({ length: 4 }, (_, i) => ({
      question: `Pěkně dlouhá otázka číslo ${i + 1}, aby se karta do notche rozhodně nevešla.`,
      header: `Otázka ${i + 1}`,
      multi: false,
      options: [
        { label: "První", description: "Dlouhý popis první možnosti přes celý řádek a ještě kus." },
        { label: "Druhá", description: "Dlouhý popis druhé možnosti, taky přes celý řádek." },
      ],
    })),
  });
  await settle();
  // Po dokreslení: dřív naměřeno uprostřed animace vycházely falešné propadáky.
  await page.waitForTimeout(600);
  const buttons = await page.evaluate(() => {
    const card = document.querySelector(".card.hero").getBoundingClientRect();
    const steps = document.querySelector(".card.hero > .steps");
    return {
      preteka: steps.scrollHeight > steps.clientHeight,
      tlacitka: [...document.querySelectorAll(".steps .perm button")].map((b) => {
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { t: b.innerText, vKarte: r.bottom <= card.bottom + 1, trefim: !!el && (b === el || b.contains(el)) };
      }),
    };
  });
  check("přetékající karta: obsah se opravdu nevejde (jinak test nic netestuje)", buttons.preteka, JSON.stringify(buttons));
  check("přetékající karta: tlačítka zůstanou uvnitř karty", buttons.tlacitka.every((b) => b.vKarte), JSON.stringify(buttons.tlacitka));
  check("přetékající karta: na tlačítka jde kliknout", buttons.tlacitka.every((b) => b.trefim), JSON.stringify(buttons.tlacitka));

  check("stránka nespadla", errors.length === 0, errors.join("\n"));

  await browser.close();
  stop();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} prošlo`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error("Test se nerozeběhl:", e.message);
  process.exit(2);
});
