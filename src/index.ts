import { TOOLS, type ToolDef } from "./tools.generated";

export interface Env {
  MCP_AUTH_TOKEN: string;
  INFITERRA_BASE_URL: string;
  INFITERRA_USERNAME: string;
  INFITERRA_PASSWORD: string;
  INFITERRA_CLIENT_ID?: string;
  INFITERRA_CLIENT_SECRET?: string;
  INFITERRA_TOKEN_URL?: string;
}

const SERVER_INFO = { name: "infiterra-billing-mcp", version: "1.0.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_RESULT_CHARS = 100_000;
// Required on every request to Leader Cloud / Infiterra (token endpoint and API calls).
const API_VERSION_HEADER = { "X-Api-Version": "3" };
const TOOL_MAP = new Map<string, ToolDef>(TOOLS.map((t) => [t.name, t]));

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, any>;
}

// ---------- auth ----------

async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

async function isAuthorised(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_AUTH_TOKEN) return false;
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? safeEqual(m[1].trim(), env.MCP_AUTH_TOKEN) : false;
}

// Cached Infiterra token (per isolate)
let cached: { token: string; expiresAt: number } | null = null;

function baseUrl(env: Env): string {
  return (env.INFITERRA_BASE_URL || "").replace(/\/+$/, "");
}

async function getInfiterraToken(env: Env, force = false): Promise<string> {
  if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const tokenUrl = env.INFITERRA_TOKEN_URL || `${baseUrl(env)}/oauth/token`;
  const form = new URLSearchParams({
    grant_type: "password",
    username: env.INFITERRA_USERNAME,
    password: env.INFITERRA_PASSWORD,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    ...API_VERSION_HEADER,
  };
  // Infiterra expects client credentials as HTTP Basic (base64 of "clientId:clientSecret"),
  // matching the n8n flow.
  if (env.INFITERRA_CLIENT_ID && env.INFITERRA_CLIENT_SECRET) {
    headers.Authorization = `Basic ${btoa(`${env.INFITERRA_CLIENT_ID}:${env.INFITERRA_CLIENT_SECRET}`)}`;
  }
  const res = await fetch(tokenUrl, { method: "POST", headers, body: form });
  if (!res.ok) throw new Error(`Infiterra token request failed: HTTP ${res.status}`);
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Infiterra token response had no access_token");
  cached = { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return data.access_token;
}

// ---------- tool execution ----------

function buildUrl(tool: ToolDef, args: Record<string, any>, env: Env): string {
  let path = tool.path;
  for (const p of tool.pathParams) {
    const v = args[p.arg];
    if (v === undefined || v === null || v === "") throw new Error(`Missing required path parameter: ${p.arg}`);
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
  }
  const qs = new URLSearchParams();
  for (const q of tool.queryParams) {
    const v = args[q.arg];
    if (v !== undefined && v !== null && v !== "") qs.set(q.name, String(v));
  }
  const s = qs.toString();
  return `${baseUrl(env)}${path}${s ? `?${s}` : ""}`;
}

async function callUpstream(tool: ToolDef, args: Record<string, any>, env: Env) {
  const url = buildUrl(tool, args, env);
  const send = async (token: string) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...API_VERSION_HEADER };
    let body: string | undefined;
    if (tool.hasBody && args.body !== undefined) {
      body = JSON.stringify(args.body);
      headers["Content-Type"] = tool.path.endsWith("/api/accounts/{accountId}") && tool.method === "PATCH"
        ? "application/json-patch+json"
        : "application/json";
    }
    return fetch(url, { method: tool.method, headers, body });
  };
  let res = await send(await getInfiterraToken(env));
  if (res.status === 401) res = await send(await getInfiterraToken(env, true));
  return res;
}

async function runTool(name: string, args: Record<string, any>, env: Env) {
  const tool = TOOL_MAP.get(name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool: ${name}` } };
  if (!baseUrl(env) || !env.INFITERRA_USERNAME || !env.INFITERRA_PASSWORD) {
    return { result: toolText("Server is not configured: INFITERRA_BASE_URL, INFITERRA_USERNAME and INFITERRA_PASSWORD are required.", true) };
  }
  for (const r of (tool.inputSchema.required as string[] | undefined) ?? []) {
    if (args[r] === undefined) return { result: toolText(`Missing required argument: ${r}`, true) };
  }
  try {
    const res = await callUpstream(tool, args, env);
    const raw = await res.text();
    let text = raw;
    try {
      text = JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      /* not JSON */
    }
    if (!text) text = `HTTP ${res.status} ${res.statusText} (empty body)`;
    if (text.length > MAX_RESULT_CHARS) {
      text = text.slice(0, MAX_RESULT_CHARS) + `\n\n[truncated: ${text.length} chars total. Use pageSize/pageIndex or $filter to narrow results.]`;
    }
    return { result: toolText(res.ok ? text : `HTTP ${res.status} ${res.statusText}\n${text}`, !res.ok) };
  } catch (e) {
    return { result: toolText(`Request failed: ${(e as Error).message}`, true) };
  }
}

function toolText(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

// ---------- JSON-RPC ----------

async function handleRpc(msg: JsonRpcRequest, env: Env): Promise<object | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  const ok = (result: unknown) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion as string | undefined;
      const protocolVersion = requested && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Infiterra Billing (reseller) API. List endpoints are paged (pageIndex from 1, pageSize up to 500). Tools marked WRITE change live billing data; confirm with the user before calling them.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
        })),
      });
    case "tools/call": {
      const name = msg.params?.name as string;
      const out = await runTool(name, (msg.params?.arguments as Record<string, any>) ?? {}, env);
      return "error" in out && out.error ? fail(out.error.code, out.error.message) : ok(out.result);
    }
    default:
      if (msg.method.startsWith("notifications/")) return null;
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") return json({ ok: true, tools: TOOLS.length });

    if (url.pathname !== "/mcp") return json({ error: "Not found. MCP endpoint is /mcp" }, 404);

    if (!(await isAuthorised(request, env))) {
      return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="infiterra-mcp"' });
    }

    // Stateless Streamable HTTP: no server-initiated SSE stream, no sessions.
    if (request.method === "GET" || request.method === "DELETE") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }

    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleRpc(m as JsonRpcRequest, env)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const msg = payload as JsonRpcRequest;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
    }
    const result = await handleRpc(msg, env);
    return result ? json(result) : new Response(null, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
