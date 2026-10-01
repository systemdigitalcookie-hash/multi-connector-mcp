# Notion multi-workspace MCP connector

One MCP server that connects Claude to **several client Notion workspaces** at the same time.
Each client has its own Notion integration token. Every tool call names the client it's for, so data from different clients never gets mixed.

```
Claude ──HTTPS──▶ Railway: this server ──▶ Notion (client A token)
                                         ──▶ Notion (client B token) …
```

## Tools

| Tool | What it does |
|---|---|
| `list_clients` | Lists the configured workspaces and checks each token |
| `search` | Searches page and database titles in a client's workspace |
| `fetch_page` | Reads a page (its properties plus the full content as markdown) |
| `get_database` | Shows a database's columns and the allowed select/status options |
| `query_database` | Lists or filters database rows (tasks, projects…) |
| `create_page` | Creates a database row or a sub-page, with markdown content |
| `update_page` | Changes properties, appends content, or applies find-and-replace edits |
| `get_comments` / `add_comment` | Reads and writes page comments |

None of the tools can delete anything.

## 1. Add a client (repeat for each workspace)

1. In the client's workspace, go to **Notion → Settings → Connections → Develop or manage integrations → New integration**.
   - Type: **Internal**, Workspace: the client's workspace.
   - Capabilities: Read content, Update content, Insert content, Read comments, Insert comments, Read user information **including email addresses** (this lets you assign people by email).
   - Copy the **Internal Integration Secret** (`ntn_…`).
2. Share content with the integration. On each top-level page or teamspace page Claude should see, open **••• → Connections → add your integration**. Child pages are included automatically.
3. In Railway, open the service and go to **Variables**. Add:
   - `NOTION_TOKEN_<CLIENT>` = `ntn_…` (for example `NOTION_TOKEN_ACME`)
   - `NOTION_NAME_<CLIENT>` = `Acme Corp` (optional display name)

   Railway redeploys automatically. The client is now available as `acme`.

## 2. Connect to Claude

The connector URL is:

```
https://<your-railway-domain>/mcp/<MCP_SECRET>
```

- **Claude (web, desktop, mobile):** go to Settings → Connectors → **Add custom connector**, paste the URL, and leave the OAuth fields empty.
  On a Team plan, an owner adds it under Organization settings → Connectors, and then each member connects it.
- **Claude Code:**
  `claude mcp add --transport http notion-clients https://<domain>/mcp --header "Authorization: Bearer <MCP_SECRET>"`

Then try asking: *"Search the Acme Notion for the Q4 roadmap"* or *"Add a task to Globex's Tasks database: …, due Friday"*.

## Security notes

- **Anyone with the URL has full read/write access to every connected client.** Share it only with your team, and never paste it into public places.
- To revoke access, change `MCP_SECRET` in Railway. The old URL stops working right away, and everyone has to re-add the connector with the new URL.
- Tokens are stored only in Railway variables, never in git.
- Logs record the tool name, client and timing, but never page content or tokens.
- To cut off one client, delete its Notion integration, or remove its `NOTION_TOKEN_…` variable.

## Development

```bash
npm install
cp .env.example .env   # fill in values
npm run dev            # http://localhost:3000/mcp/<MCP_SECRET>
npm run typecheck
```

The server is stateless (Streamable HTTP, a fresh MCP server per request), so restarts and redeploys never break a Claude conversation.
