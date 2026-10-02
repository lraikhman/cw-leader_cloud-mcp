# Infiterra Billing MCP (Cloudflare Worker)

A remote MCP server, hosted on a Cloudflare Worker, that exposes the Infiterra Billing (Leader Cloud reseller) API to MCP clients such as Claude. Tools are generated from `spec/swagger.json`.

* Transport: stateless Streamable HTTP at `/mcp`
* Tools: 56 total, 41 read and 15 write (create or patch accounts, create orders, checkout, cancel subscriptions, change quantities, and so on)
* Health check: `GET /health`

## How authentication works

There are two separate layers.

1. MCP client to Worker: clients send `Authorization: Bearer <MCP_AUTH_TOKEN>`. You choose this value.
2. Worker to Leader Cloud: the Worker requests an OAuth token from `https://bss.leadercloud.com.au/oauth/token` using the password grant. The client ID and secret are sent as an HTTP Basic header, and the username and password go in the form body. The token is cached and refreshed when it expires or when the API returns 401.

## Secrets

Set each one with `npx wrangler secret put <NAME>`. Never commit these values to the repository.

| Secret | Value | Where to get it |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | A long random string of your choosing | Generate it yourself, for example `openssl rand -hex 32` |
| `INFITERRA_BASE_URL` | `https://bss.leadercloud.com.au` | Fixed value, no trailing slash |
| `INFITERRA_CLIENT_ID` | API client ID | Leader Cloud Storefront, Settings, API Credentials |
| `INFITERRA_CLIENT_SECRET` | API client secret | Leader Cloud Storefront, Settings, API Credentials |
| `INFITERRA_USERNAME` | API username | Supplied by your Leader Cloud account manager |
| `INFITERRA_PASSWORD` | API password | Supplied by your Leader Cloud account manager |

Optional: `INFITERRA_TOKEN_URL` overrides the token endpoint. It defaults to `{INFITERRA_BASE_URL}/oauth/token`.

## Deploy

Run these from the project folder. Deploying creates a new Worker named `infiterra-mcp` (the `name` in `wrangler.jsonc`). If a Worker with that name already exists in the target account, it will be overwritten, so change the name first if that is not what you want.

1. Install dependencies: `npm install`
2. Log in: `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`)
3. Pick the Cloudflare account, either with `export CLOUDFLARE_ACCOUNT_ID=<account id>` or by adding `"account_id": "<account id>"` to `wrangler.jsonc`
4. Deploy: `npm run deploy`
5. Set the six secrets from the table above
6. Check it is up: `curl https://infiterra-mcp.<your-subdomain>.workers.dev/health` should return `{"ok":true,"tools":56}`

## Connect a client

Use the URL `https://infiterra-mcp.<your-subdomain>.workers.dev/mcp` and add the header `Authorization: Bearer <MCP_AUTH_TOKEN>`.

The `workers.dev` URL is public, but every `/mcp` request needs the bearer token. For tighter control, attach a custom domain route or place the Worker behind Cloudflare Access.

## Notes on tool behaviour

* Request bodies are passed in a `body` argument.
* `$filter` and `$orderBy` are exposed as `filter` and `orderBy`. Their values are OData-style expressions.
* List endpoints are paged: `pageIndex` starts at 1 and `pageSize` is 1 to 500.
* The account PATCH tool sends `application/json-patch+json`, so `body` must be a JSON Patch array.
* Write tools are labelled WRITE in their descriptions, and cancel and delete tools are marked destructive. Confirm with the user before calling them.
* Responses over roughly 100,000 characters are truncated with a note to narrow the query.
* The Worker cannot skip TLS verification, so the Leader Cloud host must present a valid, publicly trusted certificate.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and fill in the values
2. Run `npm run dev`
3. The server listens on `http://localhost:8787/mcp`

`.dev.vars` is git-ignored.

## Regenerating tools

Replace `spec/swagger.json` and run `npm run generate`. This rewrites `src/tools.generated.ts`, which should not be edited by hand. `npm run typecheck` runs the TypeScript checks.

## Project layout

* `src/index.ts`: MCP JSON-RPC handler, bearer auth, Leader Cloud token handling, request proxying
* `src/tools.generated.ts`: generated tool definitions
* `scripts/generate.mjs`: generator that reads the swagger spec
* `spec/swagger.json`: Infiterra Billing API v3 specification
* `wrangler.jsonc`: Worker configuration
