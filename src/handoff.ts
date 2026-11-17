// Moving an agent's work to the engine that has room when its own runs short (issue #27).
// Paperclip keeps the conversation in the issue and its comments, so switching the agent's
// engine is the whole handoff: the new engine reads the same thread on its next wake.
// Wisp only proposes; the move happens on a click, because waking work spends a subscription.

export type Engine = "Claude" | "ChatGPT";
export const ADAPTER: Record<Engine, string> = { Claude: "claude_local", ChatGPT: "codex_local" };
export const engineOf = (adapterType: string): Engine => (adapterType === "codex_local" ? "ChatGPT" : "Claude");

/** One subscription's window as Wisp sees it. `elapsed` is the share of the window gone, or null. */
export type Pace = { percent: number; elapsed: number | null; resets: string };

/** The same rule as the amber ring in the notch: used runs 10 points ahead of time gone. */
export const tight = (p: Pace) => p.percent >= 90 || (p.elapsed != null && p.percent > p.elapsed + 10);
/** Room enough to take someone else's work: well under the limit and not ahead itself. */
export const roomy = (p: Pace) => p.percent < 70 && !tight(p);

export type HandoffAgent = { id: string; name: string; adapterType: string; status?: string };
export type HandoffIssue = { id: string; identifier?: string; assigneeAgentId?: string | null; status: string; updatedAt: string };
/** Where an agent was moved from, so it can go back once that limit resets. */
export type Moved = { fromType: string; fromModel: string | null; at: number };

const IN_FLIGHT = ["todo", "in_progress"];

/** The issue an agent is busy with: in progress first, then the newest to do. */
export function inFlight(agentId: string, issues: HandoffIssue[]): HandoffIssue | null {
  const mine = issues.filter((i) => i.assigneeAgentId === agentId && IN_FLIGHT.includes(i.status));
  mine.sort((a, b) => (a.status === b.status ? b.updatedAt.localeCompare(a.updatedAt) : a.status === "in_progress" ? -1 : 1));
  return mine[0] ?? null;
}

export type Offer = { from: Engine; to: Engine; pace: Pace; agents: { agent: HandoffAgent; issue: HandoffIssue }[] };

/** Which agents to offer moving, per engine that runs short while the other has room. */
export function handoffOffers(paces: Partial<Record<Engine, Pace | null>>, agents: HandoffAgent[], issues: HandoffIssue[]): Offer[] {
  const out: Offer[] = [];
  for (const [from, to] of [["Claude", "ChatGPT"], ["ChatGPT", "Claude"]] as [Engine, Engine][]) {
    const p = paces[from];
    const q = paces[to];
    if (!p || !q || !tight(p) || !roomy(q)) continue;
    const busy = agents
      .filter((a) => a.status !== "terminated" && engineOf(a.adapterType) === from)
      .map((agent) => ({ agent, issue: inFlight(agent.id, issues) }))
      .filter((x): x is { agent: HandoffAgent; issue: HandoffIssue } => !!x.issue);
    if (busy.length) out.push({ from, to, pace: p, agents: busy });
  }
  return out;
}

/** Agents moved earlier whose own engine has room again. */
export function returnOffers(paces: Partial<Record<Engine, Pace | null>>, agents: HandoffAgent[], moved: Record<string, Moved>): { agent: HandoffAgent; back: Engine }[] {
  return agents
    .filter((a) => moved[a.id] && a.status !== "terminated")
    .map((agent) => ({ agent, back: engineOf(moved[agent.id].fromType) }))
    .filter(({ agent, back }) => back !== engineOf(agent.adapterType) && !!paces[back] && roomy(paces[back]!));
}

/** The comment left in the issue, so it is clear later why it ran on two engines. */
export function handoffComment(from: Engine, to: Engine, pace: Pace | null): string {
  const why = pace ? `limit ${from} byl na ${pace.percent} %${pace.resets ? ` a obnoví se ${pace.resets}` : ""}` : `${to} má zase místo`;
  return `Wisp přesunul tenhle úkol z ${from} na ${to}: ${why}. Rozhovor výš platí dál, další běh už pojede na ${to}.`;
}

/**
 * The agent's new adapter config. Like the agent form, a new engine starts its config afresh
 * but keeps everything except the engine's own keys (env, instructions, skills).
 */
export function movedConfig(config: Record<string, unknown>, to: Engine, model: string, codex: Record<string, unknown>): Record<string, unknown> {
  const { engine: _e, command: _c, ...rest } = config;
  return { ...rest, ...(to === "ChatGPT" ? codex : {}), model };
}
