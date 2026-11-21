import { test } from "node:test";
import assert from "node:assert/strict";
import { handoffComment, handoffOffers, inFlight, movedConfig, returnOffers, roomy, tight, type HandoffAgent, type HandoffIssue, type Pace } from "./handoff.ts";

const pace = (percent: number, elapsed: number | null = 50): Pace => ({ percent, elapsed, resets: "6:40pm" });
const agent = (id: string, adapterType = "claude_local"): HandoffAgent => ({ id, name: id.toUpperCase(), adapterType });
const issue = (id: string, assigneeAgentId: string, status: string, updatedAt = "2026-11-17T10:00:00Z"): HandoffIssue => ({ id, assigneeAgentId, status, updatedAt });

test("tight follows the amber ring, roomy needs real headroom", () => {
  assert.equal(tight(pace(61, 50)), true);
  assert.equal(tight(pace(60, 50)), false);
  assert.equal(tight(pace(92, null)), true);
  assert.equal(roomy(pace(40, 50)), true);
  assert.equal(roomy(pace(75, 90)), false);
  assert.equal(roomy(pace(65, 20)), false);
});

test("in flight means in progress first, then the newest to do", () => {
  const issues = [issue("a", "x", "todo", "2026-11-17T09:00:00Z"), issue("b", "x", "todo", "2026-11-17T11:00:00Z"), issue("c", "x", "done")];
  assert.equal(inFlight("x", issues)?.id, "b");
  assert.equal(inFlight("x", [...issues, issue("d", "x", "in_progress", "2026-11-16T00:00:00Z")])?.id, "d");
  assert.equal(inFlight("y", issues), null);
});

test("an offer needs a short engine, one with room, and work in flight", () => {
  const agents = [agent("w"), agent("s"), agent("g", "codex_local")];
  const issues = [issue("1", "w", "in_progress"), issue("2", "s", "done"), issue("3", "g", "todo")];
  const offers = handoffOffers({ Claude: pace(80), ChatGPT: pace(20) }, agents, issues);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].from, "Claude");
  assert.equal(offers[0].to, "ChatGPT");
  assert.deepEqual(offers[0].agents.map((x) => x.agent.id), ["w"]);
  assert.deepEqual(handoffOffers({ Claude: pace(80), ChatGPT: pace(75) }, agents, issues), []);
  assert.deepEqual(handoffOffers({ Claude: pace(80), ChatGPT: null }, agents, issues), []);
  assert.deepEqual(handoffOffers({ Claude: pace(40), ChatGPT: pace(20) }, agents, issues), []);
});

test("an agent in the middle of a run is not offered, its run would be cut off", () => {
  const agents = [{ ...agent("w"), status: "running" }, { ...agent("s"), status: "idle" }];
  const issues = [issue("1", "w", "in_progress"), issue("2", "s", "in_progress")];
  const offers = handoffOffers({ Claude: pace(80), ChatGPT: pace(20) }, agents, issues);
  assert.deepEqual(offers[0].agents.map((x) => x.agent.id), ["s"]);
  assert.deepEqual(handoffOffers({ Claude: pace(80), ChatGPT: pace(20) }, [agents[0]], issues), []);
  const moved = { w: { fromType: "claude_local", fromModel: null, at: 0 } };
  assert.deepEqual(returnOffers({ Claude: pace(10) }, [{ ...agent("w", "codex_local"), status: "running" }], moved), []);
  assert.deepEqual(returnOffers({ Claude: pace(10) }, [{ ...agent("w", "codex_local"), status: "idle" }], moved).map((x) => x.back), ["Claude"]);
});

test("a moved agent is offered back once its own engine has room", () => {
  const moved = { w: { fromType: "claude_local", fromModel: "claude-sonnet-5-5", at: 0 } };
  const agents = [agent("w", "codex_local")];
  assert.deepEqual(returnOffers({ Claude: pace(80) }, agents, moved), []);
  assert.deepEqual(returnOffers({ Claude: pace(10) }, agents, moved).map((x) => x.back), ["Claude"]);
  // Moved back by hand in the agent form: nothing to offer.
  assert.deepEqual(returnOffers({ Claude: pace(10) }, [agent("w")], moved), []);
});

test("the comment says why, in the product's Czech", () => {
  assert.equal(
    handoffComment("Claude", "ChatGPT", pace(78)),
    "Wisp přesunul tenhle úkol z Claude na ChatGPT: limit Claude byl na 78 % a obnoví se 6:40pm. Rozhovor výš platí dál, další běh už pojede na ChatGPT.",
  );
  assert.match(handoffComment("ChatGPT", "Claude", null), /Claude má zase místo/);
});

test("the new config keeps env and skills and drops the old engine's keys", () => {
  const before = { engine: "cli", command: "/x/codex", model: "gpt-6-luna", env: { PATH: 1 }, paperclipSkillSync: { desiredSkills: ["a"] } };
  assert.deepEqual(movedConfig(before, "Claude", "claude-sonnet-5-5", { engine: "cli" }), {
    model: "claude-sonnet-5-5",
    env: { PATH: 1 },
    paperclipSkillSync: { desiredSkills: ["a"] },
  });
  assert.deepEqual(movedConfig({ model: "claude-sonnet-5-5", env: {} }, "ChatGPT", "gpt-6-luna", { engine: "cli", command: "/c" }), {
    model: "gpt-6-luna",
    env: {},
    engine: "cli",
    command: "/c",
  });
});
