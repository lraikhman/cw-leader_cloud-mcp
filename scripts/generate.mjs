// Generates src/tools.generated.ts from spec/swagger.json
import { readFileSync, writeFileSync } from "node:fs";

const spec = JSON.parse(readFileSync(new URL("../spec/swagger.json", import.meta.url), "utf8"));
const defs = spec.definitions || {};
const MAX_DEPTH = 5;

function clean(s) {
  return (s || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

// Convert a swagger 2.0 schema into plain JSON Schema, inlining $refs with a depth cap.
function convert(schema, depth = 0, seen = []) {
  if (!schema || typeof schema !== "object") return {};
  if (schema.$ref) {
    const name = schema.$ref.replace("#/definitions/", "");
    if (depth >= MAX_DEPTH || seen.includes(name)) {
      return { type: "object", description: `See ${name} (nested detail omitted)`, additionalProperties: true };
    }
    return convert(defs[name] || {}, depth + 1, [...seen, name]);
  }
  const out = {};
  if (schema.allOf) {
    const merged = { type: "object", properties: {}, required: [] };
    for (const part of schema.allOf) {
      const c = convert(part, depth, seen);
      Object.assign(merged.properties, c.properties || {});
      merged.required.push(...(c.required || []));
      if (c.description && !merged.description) merged.description = c.description;
    }
    if (schema.properties) {
      for (const [k, v] of Object.entries(schema.properties)) merged.properties[k] = convert(v, depth + 1, seen);
    }
    if (!merged.required.length) delete merged.required;
    return merged;
  }
  let type = schema.type;
  if (Array.isArray(type)) type = type.find((t) => t !== "null") || "string";
  if (type) out.type = type;
  if (schema.description) out.description = clean(schema.description);
  if (schema.format && ["date-time", "date", "uuid", "email", "uri"].includes(schema.format)) out.format = schema.format;
  if (schema.format === "guid") out.format = "uuid";
  if (schema.enum) out.enum = schema.enum;
  if (schema.default !== undefined) out.default = schema.default;
  for (const k of ["minimum", "maximum", "minLength", "maxLength"]) if (schema[k] !== undefined) out[k] = schema[k];
  if (schema.items) out.items = convert(schema.items, depth + 1, seen);
  if (schema.properties) {
    out.type = "object";
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = convert(v, depth + 1, seen);
    if (schema.required?.length) out.required = schema.required;
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    out.additionalProperties = convert(schema.additionalProperties, depth + 1, seen);
  }
  if (!out.type && !out.properties && !out.items && !out.enum) out.type = "object", out.additionalProperties = true;
  return out;
}

function toolName(operationId) {
  // Accounts_GetAccounts -> accounts_get_accounts
  return operationId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/__+/g, "_")
    .toLowerCase()
    .slice(0, 64);
}

const tools = [];
const usedNames = new Set();
const argName = (n) => n.replace(/^\$/, "").replace(/[^a-zA-Z0-9_.-]/g, "_");

for (const [path, item] of Object.entries(spec.paths)) {
  for (const method of ["get", "post", "put", "patch", "delete"]) {
    const op = item[method];
    if (!op) continue;
    const params = [...(item.parameters || []), ...(op.parameters || [])];
    const properties = {};
    const required = [];
    const pathParams = [];
    const queryParams = [];
    let body = null;

    for (const p of params) {
      if (p.in === "path" || p.in === "query") {
        const arg = argName(p.name);
        const s = convert({ ...p, $ref: undefined });
        delete s.pattern;
        if (p.name === "$filter" || p.name === "$orderBy" || p.name === "$orderby") {
          s.description = `${s.description || ""} (OData-style expression passed as ${p.name})`.trim();
        }
        properties[arg] = s;
        if (p.required) required.push(arg);
        (p.in === "path" ? pathParams : queryParams).push({ arg, name: p.name });
      } else if (p.in === "body") {
        const s = convert(p.schema);
        if (p.description) s.description = clean(p.description);
        properties.body = s;
        if (p.required) required.push("body");
        body = true;
      }
    }

    let name = toolName(op.operationId || `${method}_${path}`);
    while (usedNames.has(name)) name += "_2";
    usedNames.add(name);

    const readOnly = method === "get";
    const destructive = method === "delete" || /cancel/i.test(op.operationId);
    let description = clean(op.summary || op.operationId);
    if (op.description) description += `\n${clean(op.description)}`;
    description += `\n[${method.toUpperCase()} ${path}]`;
    if (!readOnly) description += destructive ? " WRITE (destructive)." : " WRITE.";

    tools.push({
      name,
      description,
      method: method.toUpperCase(),
      path,
      pathParams,
      queryParams,
      hasBody: !!body,
      inputSchema: { type: "object", properties, ...(required.length ? { required } : {}) },
      annotations: {
        title: clean(op.summary || op.operationId).split("\n")[0],
        readOnlyHint: readOnly,
        destructiveHint: !readOnly && destructive,
        idempotentHint: readOnly || method === "put" || method === "delete",
        openWorldHint: true,
      },
    });
  }
}

const out = `// AUTO-GENERATED by scripts/generate.mjs from spec/swagger.json. Do not edit.
export interface ToolDef {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  pathParams: { arg: string; name: string }[];
  queryParams: { arg: string; name: string }[];
  hasBody: boolean;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export const TOOLS: ToolDef[] = ${JSON.stringify(tools, null, 2)};
`;
writeFileSync(new URL("../src/tools.generated.ts", import.meta.url), out);
console.log(`Generated ${tools.length} tools (${tools.filter((t) => t.method === "GET").length} read, ${tools.filter((t) => t.method !== "GET").length} write)`);
