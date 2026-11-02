import { test } from "node:test";
import assert from "node:assert/strict";
import { prChecks, prFace, prReady, type PR } from "./pr.ts";

type Check = PR["statusCheckRollup"][number];
const green: Check = { name: "CI", status: "COMPLETED", conclusion: "SUCCESS" };
const red: Check = { name: "CI", status: "COMPLETED", conclusion: "FAILURE" };
const running: Check = { name: "CI", status: "IN_PROGRESS" };
const pending: Check = { context: "legacy", state: "PENDING" };

const pr = (over: Partial<PR> = {}): PR => ({
  repo: "ErikKarasek/wisp",
  number: 22,
  title: "Fix busy_tools parsing of space-padded ps rows",
  author: { login: "ErikKarasek" },
  headRefName: "fix/NEX-76",
  createdAt: "2026-10-27T17:03:32Z",
  updatedAt: "2026-10-27T17:03:35Z",
  url: "https://github.com/ErikKarasek/wisp/pull/22",
  additions: 40,
  deletions: 3,
  changedFiles: 1,
  isDraft: false,
  body: "",
  mergeable: "MERGEABLE",
  statusCheckRollup: [green],
  ...over,
});

test("checks: green, red with a count, running, none", () => {
  assert.deepEqual(prChecks(pr()), { state: "ok", bad: 0, running: 0 });
  assert.deepEqual(prChecks(pr({ statusCheckRollup: [green, red, red] })), { state: "bad", bad: 2, running: 0 });
  assert.deepEqual(prChecks(pr({ statusCheckRollup: [green, running] })), { state: "run", bad: 0, running: 1 });
  assert.deepEqual(prChecks(pr({ statusCheckRollup: [] })), { state: "none", bad: 0, running: 0 });
  // A check still queued reports no status of its own, only a pending state.
  assert.equal(prChecks(pr({ statusCheckRollup: [pending] })).state, "run");
  // Red beats still running: there is already something to fix.
  assert.equal(prChecks(pr({ statusCheckRollup: [red, running] })).state, "bad");
});

test("ready: only when there is nothing left to do but merge", () => {
  assert.equal(prReady(pr()), true);
  // Most of Erik's repos have no workflows, so no checks is ready too.
  assert.equal(prReady(pr({ statusCheckRollup: [] })), true);
  assert.equal(prReady(pr({ statusCheckRollup: [red] })), false);
  assert.equal(prReady(pr({ statusCheckRollup: [running] })), false);
  assert.equal(prReady(pr({ isDraft: true })), false);
  assert.equal(prReady(pr({ mergeable: "CONFLICTING" })), false);
  // GitHub has not worked it out yet: not ready, and the nudge waits.
  assert.equal(prReady(pr({ mergeable: "UNKNOWN" })), false);
});

test("face: waiting on Erik says how long, the rest says why not", () => {
  assert.deepEqual(prFace(pr(), "6 dní"), { state: "you", chip: "čeká 6 dní" });
  assert.deepEqual(prFace(pr({ statusCheckRollup: [] }), "2 h"), { state: "you", chip: "čeká 2 h" });
  assert.deepEqual(prFace(pr({ statusCheckRollup: [running] }), "5 min"), { state: "run", chip: "CI běží" });
  assert.deepEqual(prFace(pr({ statusCheckRollup: [red] }), "1 den"), { state: "bad", chip: "červená CI" });
  assert.deepEqual(prFace(pr({ statusCheckRollup: [red, red] }), "1 den"), { state: "bad", chip: "červená CI (2)" });
  assert.deepEqual(prFace(pr({ mergeable: "CONFLICTING" }), "1 den"), { state: "bad", chip: "konflikt, mergnout nejde" });
  // A draft is nobody's turn yet, so it sleeps instead of asking.
  assert.deepEqual(prFace(pr({ isDraft: true }), "1 den"), { state: "sleep", chip: "rozdělaný" });
  // A draft with red checks still only sleeps: the author is still writing it.
  assert.equal(prFace(pr({ isDraft: true, statusCheckRollup: [red] }), "1 den").state, "sleep");
});
