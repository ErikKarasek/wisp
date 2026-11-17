import { test } from "node:test";
import assert from "node:assert/strict";
import { statusSentence, type SayItem } from "./say.ts";

const it = (name: string, state: string): SayItem => ({ name, state });

test("nothing going on", () => {
  assert.equal(statusSentence([it("A", "ok"), it("B", "sleep")], 0), "Klid, nikdo nic nechce.");
});

test("one or several agents at work, with the verb agreeing", () => {
  assert.equal(statusSentence([it("A", "run")], 0), "Pracuje 1 agent.");
  assert.equal(statusSentence([it("A", "run"), it("B", "run")], 0), "Pracují 2 agenti.");
  assert.equal(statusSentence(Array.from({ length: 5 }, (_, i) => it(`A${i}`, "run")), 0), "Pracuje 5 agentů.");
});

test("everything joined with commas and a final a", () => {
  const items = [it("A", "run"), it("B", "run"), it("C", "you"), it("Hlídač závislostí", "bad")];
  assert.equal(
    statusSentence(items, 1),
    "Pracují 2 agenti, 1 povolení čeká na tebe, 1 agent chce něco vědět a selhal Hlídač závislostí.",
  );
});

test("several failures are named together", () => {
  assert.equal(statusSentence([it("Scout", "bad"), it("Devlog", "bad")], 0), "Selhalo Scout a Devlog.");
});

test("a failed agent is not counted again as wanting something", () => {
  assert.equal(statusSentence([it("A", "bad"), it("B", "new")], 3), "3 povolení čekají na tebe, 1 agent chce něco vědět a selhal A.");
});
