// The crew in one Czech sentence, said out loud on the Mac (issue #25). It mirrors
// `statusLine()` in ios/App/Siri.swift, so Siri on the phone and the Mac say the same thing.

export type SayItem = { name: string; state: string };

/** "1 agent", "2 agenti", "5 agentů". */
export function plural(n: number, one: string, few: string, many: string): string {
  return `${n} ${n === 1 ? one : n >= 2 && n <= 4 ? few : many}`;
}

/** „Pracují 2 agenti a Hlídač závislostí selhal.“ `perms` counts Claude's permission prompts. */
export function statusSentence(items: SayItem[], perms: number): string {
  const run = items.filter((i) => i.state === "run").length;
  const waiting = items.filter((i) => i.state === "you" || i.state === "new");
  const bad = items.filter((i) => i.state === "bad");
  const parts: string[] = [];
  if (run > 0) parts.push(`${run === 1 ? "pracuje" : run <= 4 ? "pracují" : "pracuje"} ${plural(run, "agent", "agenti", "agentů")}`);
  if (perms > 0) parts.push(`${plural(perms, "povolení čeká", "povolení čekají", "povolení čeká")} na tebe`);
  if (waiting.length) parts.push(`${plural(waiting.length, "agent chce", "agenti chtějí", "agentů chce")} něco vědět`);
  if (bad.length) parts.push(failed(bad.map((i) => i.name)));
  if (!parts.length) return "Klid, nikdo nic nechce.";
  const last = parts.pop()!;
  const text = parts.length ? `${parts.join(", ")} a ${last}` : last;
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** "selhal Scout", "selhalo Scout a Devlog". */
function failed(names: string[]): string {
  return `selhal${names.length === 1 ? "" : "o"} ${names.join(" a ")}`;
}

/** Said unprompted the moment something fails: „Selhal Hlídač závislostí.“ */
export function failureSentence(names: string[]): string {
  const text = failed(names);
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}
