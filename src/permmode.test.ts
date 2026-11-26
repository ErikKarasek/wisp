import { test } from "node:test";
import assert from "node:assert/strict";
import { carryMode, modeConfig, modeOf, supported } from "./permmode.ts";

test("Paperclip's defaults are full access", () => {
  assert.equal(modeOf("claude_local", {}), "full");
  assert.equal(modeOf("codex_local", {}), "full");
  assert.equal(modeOf("codex_local", { dangerouslyBypassApprovalsAndSandbox: true }), "full");
});

test("a Claude mode becomes the engine's own permission mode", () => {
  assert.deepEqual(modeConfig("claude_local", {}, "supervised"), { engine: "cli", dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "manual"] });
  assert.deepEqual(modeConfig("claude_local", {}, "edits"), { engine: "cli", dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "acceptEdits"] });
  assert.deepEqual(modeConfig("claude_local", {}, "auto"), { engine: "cli", dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "auto"] });
});

test("Claude on the ACP engine never asks, whatever its flags say", () => {
  assert.equal(modeOf("claude_local", { dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "manual"] }), "full");
});

test("every Claude mode reads back as itself", () => {
  for (const m of ["supervised", "edits", "auto", "full"] as const) {
    assert.equal(modeOf("claude_local", modeConfig("claude_local", {}, m)), m);
  }
});

test("switching keeps the agent's other extra args and drops the old mode", () => {
  const cfg = { engine: "cli", dangerouslySkipPermissions: false, extraArgs: ["--verbose", "--permission-mode", "auto", "--permission-mode=manual"] };
  assert.deepEqual(modeConfig("claude_local", cfg, "edits").extraArgs, ["--verbose", "--permission-mode", "acceptEdits"]);
  assert.deepEqual(modeConfig("claude_local", cfg, "full"), { dangerouslySkipPermissions: true, extraArgs: ["--verbose"] });
});

test("Codex cannot ask, so it gets its sandbox or full access", () => {
  assert.deepEqual(modeConfig("codex_local", {}, "edits"), { dangerouslyBypassApprovalsAndSandbox: false });
  assert.equal(modeOf("codex_local", { dangerouslyBypassApprovalsAndSandbox: false }), "edits");
  assert.equal(supported("codex_local", "supervised"), "edits");
  assert.equal(supported("codex_local", "auto"), "edits");
  assert.equal(supported("codex_local", "full"), "full");
  assert.equal(supported("claude_local", "auto"), "auto");
});

test("moving engines keeps the mode as close as the new engine allows", () => {
  const supervised = { model: "x", engine: "cli", dangerouslySkipPermissions: false, extraArgs: ["--permission-mode", "manual"] };
  assert.deepEqual(carryMode("claude_local", "codex_local", { ...supervised, engine: "cli" }), { model: "x", engine: "cli", dangerouslyBypassApprovalsAndSandbox: false });
  assert.deepEqual(carryMode("codex_local", "claude_local", { model: "y", engine: "cli" }), { model: "y", dangerouslySkipPermissions: true });
  assert.deepEqual(carryMode("claude_local", "codex_local", { model: "x" }), { model: "x", dangerouslyBypassApprovalsAndSandbox: true });
  assert.deepEqual(carryMode("codex_local", "claude_local", { model: "y", dangerouslyBypassApprovalsAndSandbox: false }), {
    model: "y",
    engine: "cli",
    dangerouslySkipPermissions: false,
    extraArgs: ["--permission-mode", "acceptEdits"],
  });
  assert.deepEqual(carryMode("codex_local", "claude_local", { dangerouslyBypassApprovalsAndSandbox: true }), { dangerouslySkipPermissions: true });
});
