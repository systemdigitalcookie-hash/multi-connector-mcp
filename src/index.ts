import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { log, registerTools } from "./tools.js";

const config = loadConfig();
const secretHash = createHash("sha256").update(config.secret).digest();

/** Constant-time check of a presented key against MCP_SECRET. */
function isValidKey(key: string | undefined): boolean {
  if (!key) return false;
  const presented = createHash("sha256").update(key).digest();
  return timingSafeEqual(presented, secretHash);
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
}

function buildServer(): McpServer {
  const server = new McpServer(
    { name: "notion-multi-workspace", version: "1.0.0" },
    {
      instructions:
        "Gives access to several client Notion workspaces. Every tool except list_clients needs a " +
        "`client` argument; never mix data between clients. If the user doesn't say which client, ask " +
        "or call list_clients. Before creating or updating database rows, call get_database to learn " +
        "the valid property names and options.",
    },
  );
  registerTools(server, config.workspaces);
  return server;
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, clients: config.workspaces.size });
});

/**
 * Stateless Streamable HTTP: a fresh server + transport per request. This keeps
 * the service horizontally scalable and restart-safe on Railway.
 */
async function handleMcp(req: Request, res: Response) {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log({ event: "mcp_error", error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
}

const methodNotAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed." },
    id: null,
  });
};

// Secret-URL auth: https://<host>/mcp/<MCP_SECRET>  (for Claude custom connectors)
app.post("/mcp/:key", (req, res) => {
  if (!isValidKey(req.params.key)) return void res.status(404).json({ error: "Not found" });
  void handleMcp(req, res);
});
app.get("/mcp/:key", methodNotAllowed);
app.delete("/mcp/:key", methodNotAllowed);

// Header auth: https://<host>/mcp with "Authorization: Bearer <MCP_SECRET>" (for Claude Code / API)
app.post("/mcp", (req, res) => {
  if (!isValidKey(bearerToken(req))) return void res.status(401).json({ error: "Unauthorized" });
  void handleMcp(req, res);
});
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(config.port, () => {
  log({
    event: "started",
    port: config.port,
    clients: [...config.workspaces.values()].map((w) => w.slug),
  });
});
