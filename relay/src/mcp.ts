// An MCP server over the relay, so an outside agent (Grok Bot) can read what
// Wisp's agents are doing and leave work for them. Streamable HTTP, JSON-RPC
// over a single POST, no dependencies: the whole relay is one Worker.
//
// It guards itself with its own MCP_TOKEN secret, never RELAY_TOKEN, so that
// handing the token to an outside agent can be undone on its own, and reads
// and writes the same two D1 tables the Mac and the phone use.
//
// What it deliberately cannot do: answer Claude Code's permission prompts
// ("perm"), merge or close a pull request ("pr"), and run, pause or resume a
// launchd job ("job"). Those reach further than a chat agent should, so the
// tools below cover reading plus the three harmless commands.

export interface McpEnv {
  DB: D1Database;
  MCP_TOKEN?: string;
}

type Json = Record<string, any>;

/** Protocol revisions this server knows how to answer. Newest first. */
const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const rpc = (id: unknown, result: Json) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/** A tool's answer: MCP wants content blocks, and text is enough for all of these. */
const text = (body: unknown) => ({
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body, null, 2) }],
});

const failed = (message: string) => ({ content: [{ type: "text", text: message }], isError: true });

function authorized(req: Request, env: McpEnv): boolean {
  const token = env.MCP_TOKEN;
  if (!token) return false;
  const got = req.headers.get("authorization") ?? "";
  const want = `Bearer ${token}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const TOOLS = [
  {
    name: "wisp_overview",
    description:
      "What Wisp shows on the Mac right now: the Focus, the counts, and every card with its state. Start here. Says how many seconds old the state is, because the Mac pushes it once a minute.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wisp_agents",
    description:
      "Erik's coding agents and what each is working on: name, engine (Claude or ChatGPT), status, and its open issues. Does not include the messages; use wisp_thread for those.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wisp_thread",
    description: "The conversation on one issue, oldest message first. Take the id from wisp_agents.",
    inputSchema: {
      type: "object",
      properties: { issueId: { type: "string", description: "The issue's id, or its identifier such as WISP-12." } },
      required: ["issueId"],
      additionalProperties: false,
    },
  },
  {
    name: "wisp_prs",
    description: "Open pull requests with their CI state, as Wisp sees them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wisp_waiting",
    description:
      "What is waiting on Erik: permission prompts his agents raised, and quick questions without an answer. Read-only on purpose. You cannot answer a permission prompt, only tell him it is there.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "wisp_task",
    description:
      "Give one of Erik's agents a new task. It lands as a fresh issue assigned to that agent, the same as sending it from the iPhone app. The Mac picks it up within a minute.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: { type: "string", description: "The agent's id from wisp_agents." },
        text: { type: "string", description: "The task, in the words the agent should read." },
      },
      required: ["agentId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "wisp_comment",
    description: "Write a message into an existing issue's thread, as Erik.",
    inputSchema: {
      type: "object",
      properties: {
        issueId: { type: "string", description: "The issue's id from wisp_agents." },
        text: { type: "string" },
      },
      required: ["issueId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "wisp_ask",
    description: "Ask Wisp a quick question. The answer shows up on the Mac and the phone, not back here.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
      additionalProperties: false,
    },
  },
];

type Snapshot = { state: Json; ageSeconds: number } | null;

async function snapshot(env: McpEnv): Promise<Snapshot> {
  const row = await env.DB.prepare("SELECT body, at FROM state WHERE id = 1").first<{ body: string; at: number }>();
  if (!row) return null;
  let state: Json;
  try {
    state = JSON.parse(row.body);
  } catch {
    return null;
  }
  return { state, ageSeconds: Math.max(0, Math.round((Date.now() - row.at) / 1000)) };
}

const STALE = "The Mac has not pushed a state yet, so there is nothing to read. It pushes once a minute while Wisp runs.";

/** Queue a command for the Mac, exactly as the phone does. */
async function command(env: McpEnv, cmd: Json): Promise<number> {
  const body = JSON.stringify(cmd);
  if (body.length > 20_000) throw new Error("the command is too long");
  const r = await env.DB.prepare("INSERT INTO cmds (body, at) VALUES (?1, ?2)").bind(body, Date.now()).run();
  return Number(r.meta.last_row_id);
}

const agentsOf = (state: Json): Json[] => (Array.isArray(state.agents) ? state.agents : []);

function findIssue(state: Json, wanted: string): Json | null {
  const key = wanted.trim().toLowerCase();
  for (const a of agentsOf(state)) {
    for (const i of Array.isArray(a.issues) ? a.issues : []) {
      if (String(i.id).toLowerCase() === key || String(i.identifier ?? "").toLowerCase() === key) return i;
    }
  }
  return null;
}

async function callTool(name: string, args: Json, env: McpEnv) {
  // The three writes do not need the state, so they answer before it is read.
  if (name === "wisp_task") {
    const agentId = String(args.agentId ?? "").trim();
    const body = String(args.text ?? "").trim();
    if (!agentId || !body) return failed("wisp_task needs both agentId and text.");
    const snap = await snapshot(env);
    const known = snap ? agentsOf(snap.state).some((a) => String(a.id) === agentId) : false;
    if (snap && !known) return failed(`No agent ${agentId}. Call wisp_agents for the ids that exist.`);
    const id = await command(env, { kind: "task", agentId, text: body });
    return text(`Queued as command ${id}. The Mac picks it up within a minute and the task appears in that agent's issues.`);
  }
  if (name === "wisp_comment") {
    const issueId = String(args.issueId ?? "").trim();
    const body = String(args.text ?? "").trim();
    if (!issueId || !body) return failed("wisp_comment needs both issueId and text.");
    const id = await command(env, { kind: "comment", issueId, text: body });
    return text(`Queued as command ${id}.`);
  }
  if (name === "wisp_ask") {
    const question = String(args.question ?? "").trim();
    if (!question) return failed("wisp_ask needs a question.");
    const id = await command(env, { kind: "ask", question });
    return text(`Queued as command ${id}. The answer shows up on the Mac and the phone, not in this conversation.`);
  }

  const snap = await snapshot(env);
  if (!snap) return failed(STALE);
  const { state, ageSeconds } = snap;

  if (name === "wisp_overview") {
    const items = (Array.isArray(state.items) ? state.items : []).map((i: Json) => ({
      id: i.id,
      name: i.name,
      state: i.state,
      doing: i.doing,
      when: i.when,
      group: i.group,
      engine: i.engine,
    }));
    return text({
      ageSeconds,
      focus: state.focus ?? null,
      counts: state.counts ?? null,
      waitingOnErik: (Array.isArray(state.perms) ? state.perms : []).length,
      items,
      recent: (Array.isArray(state.history) ? state.history : []).slice(0, 10),
    });
  }
  if (name === "wisp_agents") {
    return text({
      ageSeconds,
      agents: agentsOf(state).map((a) => ({
        id: a.id,
        name: a.name,
        engine: a.engine,
        status: a.status,
        issues: (Array.isArray(a.issues) ? a.issues : []).map((i: Json) => ({
          id: i.id,
          identifier: i.identifier,
          title: i.title,
          status: i.status,
          updatedAt: i.updatedAt,
          messageCount: Array.isArray(i.messages) ? i.messages.length : 0,
        })),
      })),
    });
  }
  if (name === "wisp_thread") {
    const wanted = String(args.issueId ?? "").trim();
    if (!wanted) return failed("wisp_thread needs an issueId.");
    const issue = findIssue(state, wanted);
    if (!issue) return failed(`No issue ${wanted} in the last state. Call wisp_agents for the ids that exist.`);
    return text({
      ageSeconds,
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      messages: issue.messages ?? [],
    });
  }
  if (name === "wisp_prs") {
    return text({ ageSeconds, prs: Array.isArray(state.prs) ? state.prs : [] });
  }
  if (name === "wisp_waiting") {
    const answers = Array.isArray(state.answers) ? state.answers : [];
    return text({
      ageSeconds,
      permissionPrompts: Array.isArray(state.perms) ? state.perms : [],
      unansweredQuestions: answers.filter((a: Json) => a.answer == null),
      note: "Answering a permission prompt is not something this server can do. Tell Erik it is waiting.",
    });
  }
  return failed(`No tool named ${name}.`);
}

/** Handles POST /mcp. Returns null when the path is not ours. */
export async function handleMcp(req: Request, url: URL, env: McpEnv): Promise<Response | null> {
  if (url.pathname !== "/mcp") return null;
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST a JSON-RPC request here" }), {
      status: 405,
      headers: { "content-type": "application/json", allow: "POST" },
    });
  }
  if (!env.MCP_TOKEN) {
    return new Response(JSON.stringify({ error: "MCP_TOKEN is not set, so the MCP server is off" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  if (!authorized(req, env)) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
    });
  }

  const msg = (await req.json().catch(() => null)) as Json | Json[] | null;
  if (msg === null || Array.isArray(msg)) {
    // A batch is legal JSON-RPC but nothing here needs one, and answering half
    // of a batch is worse than refusing all of it.
    return rpcError(null, -32600, "Send one JSON-RPC request per POST.", 400);
  }

  const { id, method, params } = msg as { id?: unknown; method?: string; params?: Json };

  // Notifications carry no id and want no body back.
  if (id === undefined) return new Response(null, { status: 202 });

  if (method === "initialize") {
    const asked = String(params?.protocolVersion ?? "");
    return rpc(id, {
      protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "wisp-relay", version: "1.0.0" },
      instructions:
        "Wisp is Erik's own dashboard over his coding agents. Read with wisp_overview first. Writing a task or a comment puts real work in front of a real agent, so say what you are about to do before you do it.",
    });
  }
  if (method === "ping") return rpc(id, {});
  if (method === "tools/list") return rpc(id, { tools: TOOLS });
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `No tool named ${name}.`);
    const args = (params?.arguments ?? {}) as Json;
    try {
      return rpc(id, await callTool(name, args, env));
    } catch (e) {
      return rpc(id, failed(`${name} failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  if (method === "resources/list") return rpc(id, { resources: [] });
  if (method === "prompts/list") return rpc(id, { prompts: [] });
  return rpcError(id, -32601, `Unknown method ${method}.`);
}
