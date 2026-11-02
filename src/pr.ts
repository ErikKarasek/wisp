// What a pull request waiting to be merged adds up to: its checks, whether there
// is anything left to do but merge it, and the face it gets in the crew. Pure and
// without imports, so `node --test` can run it without Tauri or a bundler.

/** One open pull request, as `gh pr list --json` reports it. */
export type PR = {
  repo: string;
  number: number;
  title: string;
  author: { login: string };
  headRefName: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  isDraft: boolean;
  body: string;
  mergeable: string;
  statusCheckRollup: { name?: string; context?: string; conclusion?: string; state?: string; status?: string }[];
};

const CI_FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"]);

/** What a pull request's checks add up to, and how many of them are red or still going. */
export function prChecks(pr: PR): { state: "ok" | "bad" | "run" | "none"; bad: number; running: number } {
  const all = pr.statusCheckRollup ?? [];
  const bad = all.filter((c) => CI_FAILED.has(c.conclusion ?? c.state ?? "")).length;
  const running = all.filter((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING").length;
  return { state: !all.length ? "none" : bad ? "bad" : running ? "run" : "ok", bad, running };
}

/**
 * Green, no conflict, not a draft: nothing left to do but merge it. A pull request
 * with no checks at all counts too; most of Erik's repos have no workflows.
 */
export function prReady(pr: PR): boolean {
  const ci = prChecks(pr).state;
  return !pr.isDraft && pr.mergeable === "MERGEABLE" && (ci === "ok" || ci === "none");
}

/**
 * The state and the short status for the crew. Red checks and a conflict are work
 * for whoever opened it, so those go angry; everything else that is open waits on
 * Erik, and then the status is how long it has been waiting (`waited` already in
 * words, because the wording belongs to the model).
 */
export function prFace(pr: PR, waited: string): { state: "sleep" | "bad" | "run" | "you"; chip: string } {
  const ci = prChecks(pr);
  if (pr.isDraft) return { state: "sleep", chip: "rozdělaný" };
  if (ci.state === "bad") return { state: "bad", chip: ci.bad > 1 ? `červená CI (${ci.bad})` : "červená CI" };
  if (pr.mergeable === "CONFLICTING") return { state: "bad", chip: "konflikt, mergnout nejde" };
  if (ci.state === "run") return { state: "run", chip: "CI běží" };
  return { state: "you", chip: `čeká ${waited}` };
}
