import { test } from "node:test";
import assert from "node:assert/strict";
import { ownTaskId } from "./ownTask.ts";

const cases: [string, { title?: string; body?: string }, string | null][] = [
  ["id in the title", { title: "Watchdog: a merged PR closes only its own task (NEX-58)" }, "NEX-58"],
  ["Closes in body", { title: "Fix", body: "Closes NEX-12" }, "NEX-12"],
  ["Fixes with colon", { title: "Fix", body: "Fixes: NEX-12" }, "NEX-12"],
  ["Resolves", { title: "Fix", body: "Resolves NEX-12." }, "NEX-12"],
  ["Paperclip: line", { title: "Fix", body: "Paperclip: NEX-63" }, "NEX-63"],
  ["Paperclip issue line", { title: "Fix", body: "Paperclip issue NEX-63" }, "NEX-63"],
  ["title and body name the same task", { title: "Fix (NEX-5)", body: "Closes NEX-5" }, "NEX-5"],
  ["follow-up in the title", { title: "Tidy up, follow-up to NEX-38" }, null],
  ["follow-up in the body", { title: "Tidy up", body: "Follow-up to NEX-38" }, null],
  ["part of", { title: "Tidy up", body: "Part of NEX-40" }, null],
  ["does not fix", { title: "Tidy up", body: "This does not fix NEX-12" }, null],
  ["doesn't close", { title: "Tidy up", body: "It doesn't close NEX-12" }, null],
  ["never fixes", { title: "Tidy up", body: "never fixes NEX-12" }, null],
  ["plain mention", { title: "Tidy up", body: "See NEX-12 for context" }, null],
  ["Fixes the flaky test from NEX-12", { title: "Tidy up", body: "Fixes the flaky test from NEX-12" }, null],
  ["Closes the loop on NEX-12's follow-up", { title: "Tidy up", body: "Closes the loop on NEX-12's follow-up" }, null],
  ["own id then follow-up on one line", { title: "Tidy up", body: "Closes NEX-5, follow-up to NEX-38" }, "NEX-5"],
  ["own id then follow-up in the title", { title: "Fix (NEX-5), follow-up to NEX-38" }, "NEX-5"],
  ["two own ids are skipped", { title: "Fix", body: "Closes NEX-5, NEX-6" }, null],
  ["two own ids with and", { title: "Fix", body: "Fixes NEX-5 and NEX-6" }, null],
  ["two keywords, two tasks", { title: "Fix", body: "Closes NEX-5\nFixes NEX-6" }, null],
  ["lowercase id is no id", { title: "Fix", body: "closes nex-5" }, null],
  ["keyword on another line than the id", { title: "Fix", body: "Closes\nNEX-5" }, "NEX-5"],
  ["no ids", { title: "Fix", body: "Nothing here" }, null],
  ["missing title and body", {}, null],
];

for (const [name, pr, want] of cases) test(name, () => assert.equal(ownTaskId(pr), want));
