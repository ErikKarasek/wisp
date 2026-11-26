// How much an agent may do without asking (issue #26, part 2). Wisp sets it on the engine
// when Paperclip starts the work, so a prompt a mode would have settled is never asked.
// Engines differ, and the mode degrades honestly: Codex runs non-interactively and cannot
// ask at all, so it gets full access or its own sandbox, nothing in between.
//
// Claude has two engines in Paperclip. The default, ACP, can only approve everything or
// deny what it would have asked; it never asks anyone. So any mode short of full access
// moves a Claude agent to the CLI engine, where Claude's own --permission-mode applies and
// its prompts reach Wisp's hook, which puts them in the notch and on Telegram.

export type PermMode = "supervised" | "edits" | "auto" | "full";
type Obj = Record<string, unknown>;

export const MODES: Record<"claude_local" | "codex_local", { id: PermMode; label: string }[]> = {
  claude_local: [
    { id: "supervised", label: "Pod dohledem: ptá se na příkazy i úpravy souborů" },
    { id: "edits", label: "Úpravy sám: soubory mění bez ptaní, na ostatní se ptá" },
    { id: "auto", label: "Auto: rozhoduje Claudova vlastní kontrola, na zbytek se ptá" },
    { id: "full", label: "Plný přístup: na nic se neptá" },
  ],
  codex_local: [
    { id: "edits", label: "Sandbox: píše jen do své pracovní složky, ptát se neumí" },
    { id: "full", label: "Plný přístup: na nic se neptá" },
  ],
};

const CLAUDE_FLAG: Record<Exclude<PermMode, "full">, string> = { supervised: "manual", edits: "acceptEdits", auto: "auto" };

const args = (config: Obj): string[] => (Array.isArray(config.extraArgs) ? config.extraArgs.filter((a): a is string => typeof a === "string") : []);

/** extraArgs without a --permission-mode the mode would set again. */
function withoutModeFlag(list: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--permission-mode") i++;
    else if (!list[i].startsWith("--permission-mode=")) out.push(list[i]);
  }
  return out;
}

/** The mode an agent runs in now. Paperclip's defaults are full access for both engines. */
export function modeOf(adapterType: string, config: Obj): PermMode {
  if (adapterType === "codex_local") {
    const bypass = config.dangerouslyBypassApprovalsAndSandbox ?? config.dangerouslyBypassSandbox;
    return bypass === false ? "edits" : "full";
  }
  if (config.engine !== "cli" || config.dangerouslySkipPermissions !== false) return "full";
  const list = args(config);
  const i = list.indexOf("--permission-mode");
  const flag = i >= 0 ? list[i + 1] : list.find((a) => a.startsWith("--permission-mode="))?.split("=")[1];
  return flag === "acceptEdits" ? "edits" : flag === "auto" ? "auto" : "supervised";
}

/** The adapterConfig keys that put the agent in that mode. Paperclip merges them key by key. */
export function modeConfig(adapterType: string, config: Obj, mode: PermMode): Obj {
  if (adapterType === "codex_local") return { dangerouslyBypassApprovalsAndSandbox: mode === "full" };
  const rest = withoutModeFlag(args(config));
  if (mode === "full") return { dangerouslySkipPermissions: true, extraArgs: rest };
  return { engine: "cli", dangerouslySkipPermissions: false, extraArgs: [...rest, "--permission-mode", CLAUDE_FLAG[mode]] };
}

/** A mode the engine cannot do falls to the nearest one it can, never to more access. */
export function supported(adapterType: string, mode: PermMode): PermMode {
  const ids = (MODES[adapterType as keyof typeof MODES] ?? MODES.claude_local).map((m) => m.id);
  return ids.includes(mode) ? mode : mode === "full" ? "full" : "edits";
}

/**
 * An agent's config on another engine, in the nearest mode that engine can do. Each engine's
 * own keys are dropped first: Claude's --permission-mode handed to Codex would stop its runs.
 */
export function carryMode(fromType: string, toType: string, config: Obj): Obj {
  const mode = supported(toType, modeOf(fromType, config));
  const { dangerouslySkipPermissions: _s, dangerouslyBypassApprovalsAndSandbox: _b, dangerouslyBypassSandbox: _d, extraArgs: _x, engine, ...others } = config;
  // Codex needs its CLI engine; a Claude agent gets the CLI engine back only from its mode.
  const rest = toType === "claude_local" || engine === undefined ? others : { ...others, engine };
  const extra = withoutModeFlag(args(config));
  const base = extra.length ? { ...rest, extraArgs: extra } : rest;
  const set = modeConfig(toType, base, mode);
  const out = { ...base, ...set };
  if (Array.isArray(out.extraArgs) && out.extraArgs.length === 0) delete out.extraArgs;
  return out;
}
