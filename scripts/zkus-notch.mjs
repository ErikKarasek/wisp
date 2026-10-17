// Walks the notch in a browser and checks the things that have broken once already.
//
// The notch's page is an ordinary web page, so it can run outside Tauri:
// notch-harness.html slips in a fake `window.__TAURI_INTERNALS__`, keeps the event listeners it
// is given, and `window.__fire(event, data)` sends whatever it likes into them.
// This script turns that into a test: it starts Vite, opens the harness in the Chrome that is
// already on the Mac, and asserts specific things about the rendered page.
//
// Run with `pnpm test:notch`. It exits non-zero when something does not hold.

import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const PORT = 1431;
const ADRESA = `http://127.0.0.1:${PORT}/notch-harness.html?view=notch`;

const results = [];
/** One assertion about the page. It does not stop at the first failure, so the whole picture shows. */
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : `\n      ${detail}`}`);
}

/** Click a button on the card by its text. A button that is not there is a failed check,
 * not a timeout: the run has to reach the end and show every result. */
async function klikni(page, text) {
  const b = page.locator(`.steps .perm button:text-is("${text}")`);
  if (!(await b.count())) return false;
  await b.first().click();
  await new Promise((r) => setTimeout(r, 260));
  return true;
}

/** The Mac state the notch expects. Empty when nothing is passed. */
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

/** An agent that waits on an answer: its question takes over the notch's card. */
const ASKING_AGENT = {
  id: "agent:b",
  name: "Hlídač závislostí",
  state: "you",
  chip: "Ptá se",
  doing: "",
  when: "",
  where: "",
  character: { color: "#8b9cff" },
  ask: { companyId: "c", agentId: "b", issueId: "i1", title: "Mám to vydat?" },
};

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

  // The Chrome already installed on the Mac; no browser is downloaded for this.
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

  // ---- 1. Diff numbers survive the line being truncated ----------------------
  // The ticker's line is nowrap with an ellipsis. If "+12 -3" sits at its end as plain text, it
  // is the first thing cut off and the feature becomes invisible.
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

  // ---- 2. The „Vítej zpátky“ card does not stick over a failed agent ---------
  // renderFailure refuses to redraw while it remembers which failure it showed.
  // If nobody clears that memory, somebody else's card hangs on the screen.
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

  // ---- 3. Claude's question: the answer is sent in the shape Rust expects ----
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

  // ---- 4. The buttons stay inside the card and can be hit --------------------
  // This is the original bug: the card overflows the notch and the buttons move out of reach.
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
  // After the draw settles: measured mid-animation, this used to produce false failures.
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

  // ---- 5. A permission card does not outlive its request --------------------
  // The Rust side waits ten minutes at most. If the cleanup event is lost on the way, the card
  // hangs around and clicking it stays silent, because nobody holds that request any more.
  // Time is moved here with a fake Date.now, or the test would have to wait a quarter of an hour.
  await page.setViewportSize({ width: 1000, height: 220 });
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  const perm = { id: "perm1", session: "s", project: "W", tool: "Bash", detail: "curl -X POST http://127.0.0.1:9/", rule: "Bash(curl:*)" };

  await fire("cc-permission", perm);
  await settle();
  const cerstva = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await fire("dispecink-state", snapshot());
  await settle();
  const porad = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);

  // A clean page, so the fresh card above does not interfere with the measurement.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  // The same card, but as if it had arrived twelve minutes ago.
  await page.evaluate(() => {
    window.__realNow = Date.now;
    Date.now = () => window.__realNow() - 12 * 60_000;
  });
  await fire("cc-permission", { ...perm, id: "perm2" });
  await page.evaluate(() => { Date.now = window.__realNow; });
  await fire("dispecink-state", snapshot());
  await settle();
  const stara = await page.evaluate(() => ({
    text: document.querySelector(".steps").innerText,
    asking: document.querySelector(".nt").classList.contains("asking"),
  }));

  check("povolení: karta se ukáže", cerstva.includes("CHCE SPUSTIT"), cerstva);
  check("povolení: čerstvá karta zůstane", porad.includes("CHCE SPUSTIT"), porad);
  check("povolení: karta starší než čekání Rustu zmizí sama", !stara.text.includes("CHCE SPUSTIT") && !stara.asking, JSON.stringify(stara));

  // ---- 6. An answered question gives the card back ---------------------------
  // While an agent waits on an answer, its question owns the card. Claude's question paints
  // over it; answering that one has to hand the card back. It used to stay on screen with
  // buttons that answered nobody, because the agent's question counted as already drawn.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot([ASKING_AGENT]));
  await settle();
  const agentuvDotaz = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await fire("cc-question", {
    id: "q3",
    project: "nexus-grind",
    items: [{ question: "Zůstane karta viset?", header: "Projekty", multi: false, options: [{ label: "Alfa", description: "" }, { label: "Beta", description: "" }] }],
  });
  await settle();
  await page.click('.steps .perm button:text-is("Alfa")');
  await settle();
  await fire("dispecink-state", snapshot([ASKING_AGENT]));
  await settle();
  const poOdpovedi = await page.evaluate(() => document.querySelector(".steps").innerText);
  check("otázka přes agentův dotaz: agent drží kartu", agentuvDotaz.includes("SE PTÁ"), agentuvDotaz);
  check("otázka přes agentův dotaz: po odpovědi karta nezůstane viset", !poOdpovedi.includes("Zůstane karta viset"), poOdpovedi.split("\n")[0]);

  // ---- 7. A card painted over a permission prompt gives it back ------------
  // A dropped window's error writes straight into the card. The prompt underneath it is still
  // waiting, so the next redraw has to bring it back; otherwise the notch stays open on a card
  // with no buttons and the prompt can never be answered.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  await fire("cc-permission", { ...perm, id: "perm3" });
  await settle();
  await fire("buddy-failed", "Okno se nepodařilo přenést.");
  await settle();
  const prekryto = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await fire("dispecink-state", snapshot());
  await settle();
  await klikni(page, "Povolit");
  const odpoved = await page.evaluate(() => window.__calls.filter((c) => c.cmd === "cc_decide").pop());
  check("povolení pod jinou kartou: karta ji opravdu přepsala", prekryto.includes("OKNO"), prekryto);
  check("povolení pod jinou kartou: po překreslení jde odkliknout", odpoved?.args?.id === "perm3" && odpoved?.args?.answer === "allow", JSON.stringify(odpoved));

  // ---- 8. A prompt over a quick question clears away with its answer -------
  // A quick question owns the card until it is closed, and a permission prompt paints over it.
  // Answering the prompt has to give the card back; it used to stay on screen, because the
  // quick question was still open behind it and nothing was allowed to redraw over it. Every
  // further click then went to a request nobody held any more, which looks like a dead notch.
  await open();
  await fire("notch-open", true);
  await fire("dispecink-state", snapshot());
  await fire("quick-ask", "zkopírovaný text");
  await settle();
  const rychla = await page.evaluate(() => document.querySelector(".steps").innerText.split("\n")[0]);
  await fire("cc-permission", { ...perm, id: "perm4" });
  await settle();
  await klikni(page, "Povolit");
  await fire("dispecink-state", snapshot());
  await settle();
  const poPovoleni = await page.evaluate(() => document.querySelector(".steps").innerText);
  check("povolení přes rychlou otázku: otázka drží kartu", rychla.includes("RYCHLÁ OTÁZKA"), rychla);
  check("povolení přes rychlou otázku: po odkliknutí karta nezůstane viset", !poPovoleni.includes("CHCE SPUSTIT"), poPovoleni.split("\n")[0]);

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
