// Which Paperclip task a merged pull request finishes. Pure, so it can be tested without Tauri.

const TASK_ID = /\b[A-Z]{2,5}-\d+\b/g;
/** Text right before an ID that makes it somebody else's task: "follow-up to NEX-38", "does not fix NEX-12". */
const NOT_OWN = /(?:\b(?:follow[- ]?up|part|related|refs?|see|after|before|from|not|never|instead|unlike|blocked by|depends on)|n't)(?: of| to| on| by| fix(?:e[sd])?| close[sd]?| resolve[sd]?)?\s*[:(]?\s*$/i;
/** An ID, or a list of them, straight after the keyword. "Closes the loop on NEX-12" has no ID there. */
const OWN_IDS = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|paperclip(?:[ \t]+issue)?)[ \t]*:?[ \t]*([a-z]{2,5}-\d+(?:\s*(?:,|&|and)\s*[a-z]{2,5}-\d+)*)/gi;

/**
 * The one task a merged pull request finishes (`gh search prs` can't return the branch).
 * Own IDs are the ones in the title and the ones directly after `Closes`/`Fixes`/`Resolves`/`Paperclip:`
 * in the body; a passing mention is not. A PR with several own IDs is skipped.
 */
export function ownTaskId(pr: { title?: unknown; body?: unknown }): string | null {
  const title = String(pr.title ?? "");
  const body = String(pr.body ?? "");
  const own = new Set<string>();
  for (const m of title.matchAll(TASK_ID)) if (!NOT_OWN.test(title.slice(0, m.index))) own.add(m[0]);
  for (const m of body.matchAll(OWN_IDS)) {
    const first = m.index + m[0].length - m[1].length;
    if (NOT_OWN.test(body.slice(0, first))) continue;
    for (const id of m[1].match(TASK_ID) ?? []) own.add(id);
  }
  return own.size === 1 ? [...own][0] : null;
}
