// Dispečink relay: the Mac pushes its state here and picks up commands; the
// iPhone app and its widget read the state and leave commands. One shared
// bearer token (RELAY_TOKEN secret) guards everything.

export interface Env {
  DB: D1Database;
  RELAY_TOKEN: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function authorized(req: Request, env: Env): boolean {
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${env.RELAY_TOKEN}`;
  if (!env.RELAY_TOKEN || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const KINDS = new Set(["task", "comment", "perm", "refresh"]);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response("Dispečink relay", { status: 200 });
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);

    // The Mac: the whole state, replaced each time.
    if (url.pathname === "/state" && req.method === "PUT") {
      const body = await req.text();
      if (body.length > 900_000) return json({ error: "too big" }, 413);
      await env.DB.prepare("INSERT INTO state (id, body, at) VALUES (1, ?1, ?2) ON CONFLICT(id) DO UPDATE SET body = ?1, at = ?2")
        .bind(body, Date.now())
        .run();
      return json({ ok: true });
    }
    // The phone: the last state and how old it is.
    if (url.pathname === "/state" && req.method === "GET") {
      const row = await env.DB.prepare("SELECT body, at FROM state WHERE id = 1").first<{ body: string; at: number }>();
      if (!row) return json({ empty: true });
      return new Response(`{"pushedAt":${row.at},"state":${row.body}}`, { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    // The phone: a command for the Mac.
    if (url.pathname === "/cmd" && req.method === "POST") {
      const cmd = (await req.json().catch(() => null)) as { kind?: string } | null;
      if (!cmd || !KINDS.has(cmd.kind ?? "")) return json({ error: "bad command" }, 400);
      const body = JSON.stringify(cmd);
      if (body.length > 20_000) return json({ error: "too big" }, 413);
      const r = await env.DB.prepare("INSERT INTO cmds (body, at) VALUES (?1, ?2)").bind(body, Date.now()).run();
      return json({ ok: true, id: r.meta.last_row_id });
    }
    // The Mac: commands not yet done; then it acknowledges them.
    if (url.pathname === "/cmd" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id, body, at FROM cmds WHERE done = 0 ORDER BY id LIMIT 50").all<{ id: number; body: string; at: number }>();
      return json(results.map((r) => ({ id: r.id, at: r.at, ...JSON.parse(r.body) })));
    }
    if (url.pathname === "/cmd/ack" && req.method === "POST") {
      const { ids } = (await req.json().catch(() => ({ ids: [] }))) as { ids: number[] };
      const clean = (ids ?? []).filter((n) => Number.isInteger(n)).slice(0, 50);
      if (clean.length) await env.DB.prepare(`UPDATE cmds SET done = 1 WHERE id IN (${clean.map(() => "?").join(",")})`).bind(...clean).run();
      // Old commands go away after a week.
      await env.DB.prepare("DELETE FROM cmds WHERE at < ?1").bind(Date.now() - 7 * 86_400_000).run();
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  },
};
