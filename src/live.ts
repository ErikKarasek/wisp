// What an agent is doing right now, read from its Paperclip run log: the
// commands it runs, the files it touches and what it says, step by step.
// The log is fetched in pieces from where the last read stopped.

import { invoke } from "@tauri-apps/api/core";

export const pc = <T = any,>(method: string, path: string, body?: unknown) =>
  invoke<T>("paperclip_request", { method, path, body: body ?? null });

export type Step =
  | { kind: "say"; text: string }
  | { kind: "think"; text: string }
  | { kind: "tool"; id: string; title: string; detail: string; status: "running" | "done" | "failed"; output: string };

/** What the agent said or thought last, for the bubble in the notch. */
export type Voice = { kind: "say" | "think"; text: string };

export type Run = { id: string; status: string; startedAt: string | null; finishedAt: string | null; invocationSource: string };

const TOOL_NAMES = new Set(["Terminal", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch", "Task", "TodoWrite", "tool call"]);

export async function latestRun(companyId: string, agentId: string): Promise<Run | null> {
  const runs = await pc<Run[] | { items: Run[] }>("GET", `/companies/${companyId}/heartbeat-runs?agentId=${agentId}&limit=1`);
  const list = Array.isArray(runs) ? runs : runs.items;
  return list?.[0] ?? null;
}

/** Reads one run's log incrementally and keeps its steps. */
export class LiveRun {
  steps: Step[] = [];
  private offset = 0;
  private partial = "";
  private tools = new Map<string, Extract<Step, { kind: "tool" }>>();

  constructor(readonly runId: string) {}

  async poll(): Promise<Step[]> {
    // Up to a few hundred KB at a time; long runs catch up over several polls.
    for (let i = 0; i < 4; i++) {
      const res = await pc<{ content: string; nextOffset?: number }>("GET", `/heartbeat-runs/${this.runId}/log?offset=${this.offset}&limitBytes=200000`);
      const content = res.content ?? "";
      if (!content) break;
      this.offset = res.nextOffset ?? this.offset + new TextEncoder().encode(content).length;
      this.feed(content);
      if (content.length < 200000) break;
    }
    return this.steps;
  }

  private feed(content: string) {
    const text = this.partial + content;
    const lines = text.split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let rec: { stream?: string; chunk?: string };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.stream !== "stdout" || !rec.chunk) continue;
      for (const part of rec.chunk.split("\n")) {
        if (!part.trim()) continue;
        try {
          this.message(JSON.parse(part));
        } catch {
          /* not a message */
        }
      }
    }
  }

  private message(m: any) {
    // The engine streams two kinds of words: what the agent says, and the
    // chain of thought on the "thought" channel. Both arrive a word at a time,
    // so each one grows the step it started instead of making a new one.
    if (m.type === "acpx.text_delta" && (m.channel === "output" || m.channel === "thought")) {
      const kind = m.channel === "thought" ? "think" : "say";
      const last = this.steps.at(-1);
      if (last?.kind === kind) last.text += m.text;
      else this.steps.push({ kind, text: m.text } as Step);
      return;
    }
    if (m.type !== "acpx.tool_call" || !m.toolCallId) return;
    let step = this.tools.get(m.toolCallId);
    if (!step) {
      step = { kind: "tool", id: m.toolCallId, title: m.name ?? "Nástroj", detail: "", status: "running", output: "" };
      this.tools.set(m.toolCallId, step);
      this.steps.push(step);
    }
    // Updates carry the real command or path as the name, and "command: why" as text.
    if (m.name && !TOOL_NAMES.has(m.name)) step.title = m.name;
    const text: string = m.text ?? "";
    if (m.name && text.startsWith(`${m.name}: `)) {
      const why = text.slice(m.name.length + 2);
      if (why && why !== m.name) step.detail = why;
    }
    if (m.status === "completed" || m.status === "failed") {
      step.status = m.status === "failed" ? "failed" : "done";
      const out = /```[a-z]*\n([\s\S]*?)```/.exec(text);
      if (out) step.output = out[1].trim();
    }
  }
}

/** One short line for a step, for the notch and lists. */
export function stepLine(s: Step): string {
  if (s.kind === "say" || s.kind === "think") return s.text.replace(/\s+/g, " ").trim();
  return (s.detail || s.title).replace(/\s+/g, " ").trim();
}

/** The last two sentences, so a bubble holds a thought and not a paragraph. */
function tail(text: string, max = 170): string {
  const one = text.replace(/\s+/g, " ").trim();
  const parts = one.split(/(?<=[.!?…])\s+/);
  let out = parts.slice(-2).join(" ");
  if (out.length > max) out = `…${out.slice(-max)}`;
  return out;
}

/**
 * What to put in the bubble: the newest thing the agent said or thought. Tool
 * calls don't clear it, so the bubble holds the last words while the steps
 * below it churn; that is how it reads as one agent and not two feeds.
 */
export function voiceOf(steps: Step[]): Voice | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind !== "say" && s.kind !== "think") continue;
    const text = tail(s.text);
    if (text) return { kind: s.kind, text };
  }
  return null;
}
