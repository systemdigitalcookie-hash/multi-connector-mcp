import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isFullComment, isFullDataSource, isFullPage } from "@notionhq/client";
import { z } from "zod";
import type { NotionWorkspace } from "./config.js";
import {
  buildProperties,
  dataSourceTitle,
  describeError,
  describeSchema,
  isNotFound,
  pageTitle,
  plainText,
  resolveDataSource,
  retrieveFullPage,
  summarizePage,
  toNotionId,
} from "./notion.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const MAX_MARKDOWN_CHARS = 100_000;

export function registerTools(server: McpServer, workspaces: Map<string, NotionWorkspace>) {
  const slugs = [...workspaces.keys()] as [string, ...string[]];
  if (slugs.length === 0) {
    server.registerTool(
      "list_clients",
      {
        title: "List client workspaces",
        description: "Lists the client Notion workspaces this connector can access.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () =>
        json({
          clients: [],
          note: "No client workspaces are configured yet. Add NOTION_TOKEN_<CLIENT> variables on Railway.",
        }),
    );
    return;
  }
  const clientList = [...workspaces.values()].map((w) => `"${w.slug}" (${w.name})`).join(", ");

  const clientParam = z
    .enum(slugs)
    .describe(`Which client's Notion workspace to use. One of: ${clientList}`);

  /** Wraps a handler with workspace lookup, logging and friendly errors. */
  function withClient<A extends { client: string }>(
    tool: string,
    handler: (ws: NotionWorkspace, args: A) => Promise<ToolResult>,
  ) {
    return async (args: A): Promise<ToolResult> => {
      const ws = workspaces.get(args.client);
      const started = Date.now();
      if (!ws) {
        return { isError: true, content: [{ type: "text", text: `Unknown client "${args.client}". Use one of: ${clientList}` }] };
      }
      try {
        const result = await handler(ws, args);
        log({ tool, client: ws.slug, ok: true, ms: Date.now() - started });
        return result;
      } catch (err) {
        const message = describeError(err, ws.name);
        log({ tool, client: ws.slug, ok: false, ms: Date.now() - started, error: message });
        return { isError: true, content: [{ type: "text", text: message }] };
      }
    };
  }

  // ── list_clients ──────────────────────────────────────────────────────────
  server.registerTool(
    "list_clients",
    {
      title: "List client workspaces",
      description:
        "Lists the client Notion workspaces this connector can access, and checks that each token works. " +
        "Call this first if you are unsure which client the user means.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const rows = await Promise.all(
        [...workspaces.values()].map(async (ws) => {
          try {
            const me = await ws.notion.users.me({});
            const workspace = me.type === "bot" ? (me.bot.workspace_name ?? null) : null;
            return { client: ws.slug, name: ws.name, notion_workspace: workspace, status: "ok" };
          } catch (err) {
            return { client: ws.slug, name: ws.name, status: "error", error: describeError(err, ws.name) };
          }
        }),
      );
      return json(rows);
    },
  );

  // ── search ────────────────────────────────────────────────────────────────
  server.registerTool(
    "search",
    {
      title: "Search a client's Notion",
      description:
        "Searches page and database titles in one client's Notion workspace. Only content shared with " +
        "the integration is visible. Returns IDs you can pass to fetch_page / query_database.",
      inputSchema: {
        client: clientParam,
        query: z.string().optional().describe("Text to search for in titles. Omit to list recently edited items."),
        type: z.enum(["all", "page", "database"]).default("all").describe("Restrict results to pages or databases."),
        limit: z.number().int().min(1).max(100).default(20),
        cursor: z.string().optional().describe("next_cursor from a previous call, to get more results."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient("search", async (ws, { query, type, limit, cursor }) => {
      const res = await ws.notion.search({
        query: query || undefined,
        page_size: limit,
        start_cursor: cursor,
        sort: query ? undefined : { timestamp: "last_edited_time", direction: "descending" },
        filter:
          type === "all"
            ? undefined
            : { property: "object", value: type === "page" ? "page" : "data_source" },
      });
      const results = res.results.map((r) => {
        if (r.object === "page" && isFullPage(r)) {
          return { type: "page", id: r.id, title: pageTitle(r), url: r.url, last_edited: r.last_edited_time };
        }
        if (r.object === "data_source" && isFullDataSource(r)) {
          return {
            type: "database",
            data_source_id: r.id,
            database_id: r.parent.type === "database_id" ? r.parent.database_id : undefined,
            title: dataSourceTitle(r),
            url: r.url,
            last_edited: r.last_edited_time,
          };
        }
        return { type: r.object, id: r.id };
      });
      return json({ results, next_cursor: res.has_more ? res.next_cursor : null });
    }),
  );

  // ── fetch_page ────────────────────────────────────────────────────────────
  server.registerTool(
    "fetch_page",
    {
      title: "Read a page",
      description:
        "Reads a Notion page from a client's workspace: its properties plus the full content as markdown. " +
        "Accepts a page ID or a Notion URL.",
      inputSchema: {
        client: clientParam,
        page: z.string().describe("Page ID or Notion URL."),
        include_content: z.boolean().default(true).describe("Set false to only return properties."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient("fetch_page", async (ws, { page, include_content }) => {
      let full;
      try {
        full = await retrieveFullPage(ws.notion, page);
      } catch (err) {
        if (isNotFound(err)) {
          // Maybe it's a database rather than a page.
          try {
            const ds = await resolveDataSource(ws.notion, page);
            return json({
              note: "This ID is a database, not a page. Use query_database to read its rows.",
              data_source_id: ds.id,
              title: dataSourceTitle(ds),
              columns: describeSchema(ds),
            });
          } catch {
            /* fall through to the original error */
          }
        }
        throw err;
      }
      const result: Record<string, unknown> = summarizePage(full);
      if (include_content) {
        const md = await ws.notion.pages.retrieveMarkdown({ page_id: full.id });
        let content = md.markdown;
        if (content.length > MAX_MARKDOWN_CHARS) {
          content = content.slice(0, MAX_MARKDOWN_CHARS) + "\n\n[…content truncated…]";
        } else if (md.truncated) {
          content += "\n\n[…Notion truncated this page's content…]";
        }
        result.content = content;
      }
      return json(result);
    }),
  );

  // ── get_database ──────────────────────────────────────────────────────────
  server.registerTool(
    "get_database",
    {
      title: "Describe a database",
      description:
        "Shows a database's columns, their types and the allowed select/status options. " +
        "Call this before creating or updating rows so you use valid property names and values.",
      inputSchema: {
        client: clientParam,
        database: z.string().describe("Database ID, data source ID, or Notion URL."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient("get_database", async (ws, { database }) => {
      const id = toNotionId(database);
      let otherSources: { id: string; name: string }[] = [];
      try {
        const db = await ws.notion.databases.retrieve({ database_id: id });
        if ("data_sources" in db) otherSources = db.data_sources;
      } catch {
        /* it's probably a data source ID */
      }
      const ds = await resolveDataSource(ws.notion, database);
      return json({
        data_source_id: ds.id,
        title: dataSourceTitle(ds),
        url: ds.url,
        columns: describeSchema(ds),
        ...(otherSources.length > 1 ? { all_data_sources: otherSources } : {}),
      });
    }),
  );

  // ── query_database ────────────────────────────────────────────────────────
  server.registerTool(
    "query_database",
    {
      title: "Query a database",
      description:
        "Lists rows of a database in a client's workspace (e.g. tasks, projects), with optional Notion " +
        "filter and sorts. Example filter: {\"property\":\"Status\",\"status\":{\"equals\":\"In progress\"}}. " +
        "Example sorts: [{\"property\":\"Due\",\"direction\":\"ascending\"}].",
      inputSchema: {
        client: clientParam,
        database: z.string().describe("Database ID, data source ID, or Notion URL."),
        filter: z.record(z.string(), z.any()).optional().describe("Notion API filter object."),
        sorts: z.array(z.record(z.string(), z.any())).optional().describe("Notion API sorts array."),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe("next_cursor from a previous call, to get more rows."),
        data_source_name: z
          .string()
          .optional()
          .describe("Only needed when a database has several data sources (see get_database)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient("query_database", async (ws, { database, filter, sorts, limit, cursor, data_source_name }) => {
      const ds = await resolveDataSource(ws.notion, database, data_source_name);
      const res = await ws.notion.dataSources.query({
        data_source_id: ds.id,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filter: filter as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sorts: sorts as any,
        page_size: limit,
        start_cursor: cursor,
      });
      const rows = res.results.filter(isFullPage).map(summarizePage);
      return json({
        database: dataSourceTitle(ds),
        data_source_id: ds.id,
        count: rows.length,
        rows,
        next_cursor: res.has_more ? res.next_cursor : null,
      });
    }),
  );

  // ── create_page ───────────────────────────────────────────────────────────
  server.registerTool(
    "create_page",
    {
      title: "Create a page or database row",
      description:
        "Creates a new page in a client's workspace, either as a row in a database or as a sub-page of an " +
        "existing page. Properties use simple values, e.g. {\"Status\":\"In progress\",\"Due\":\"2026-10-15\"," +
        "\"Tags\":[\"Design\"],\"Assignee\":\"jane@client.com\"}. Content is markdown.",
      inputSchema: {
        client: clientParam,
        parent: z.string().describe("ID or URL of the parent database or parent page."),
        title: z.string().optional().describe("Page title."),
        properties: z
          .record(z.string(), z.any())
          .optional()
          .describe("Database columns to set (database parents only). Use get_database to see valid names/options."),
        content: z.string().optional().describe("Page body as markdown."),
        data_source_name: z.string().optional().describe("Only for databases with several data sources."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withClient("create_page", async (ws, { parent, title, properties, content, data_source_name }) => {
      let ds;
      try {
        ds = await resolveDataSource(ws.notion, parent, data_source_name);
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }

      let created;
      if (ds) {
        const schema = ds.properties;
        const values: Record<string, unknown> = { ...(properties ?? {}) };
        const titleProp = Object.entries(schema).find(([, s]) => s.type === "title")?.[0];
        if (title && titleProp && !Object.keys(values).some((k) => k.toLowerCase() === titleProp.toLowerCase())) {
          values[titleProp] = title;
        }
        created = await ws.notion.pages.create({
          parent: { type: "data_source_id", data_source_id: ds.id },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: (await buildProperties(ws.notion, schema, values)) as any,
          markdown: content || undefined,
        });
      } else {
        if (properties && Object.keys(properties).length > 0) {
          throw new Error("Properties can only be set when the parent is a database. For a page parent, use title and content.");
        }
        created = await ws.notion.pages.create({
          parent: { type: "page_id", page_id: toNotionId(parent) },
          properties: { title: { title: [{ type: "text", text: { content: title ?? "Untitled" } }] } },
          markdown: content || undefined,
        });
      }
      return json({
        created: true,
        id: created.id,
        url: "url" in created ? created.url : undefined,
      });
    }),
  );

  // ── update_page ───────────────────────────────────────────────────────────
  server.registerTool(
    "update_page",
    {
      title: "Update a page",
      description:
        "Updates a page in a client's workspace: change properties (simple values, same format as " +
        "create_page), append markdown to the end, and/or apply find-and-replace edits to the content. " +
        "This tool never deletes pages.",
      inputSchema: {
        client: clientParam,
        page: z.string().describe("Page ID or Notion URL."),
        title: z.string().optional().describe("New title."),
        properties: z.record(z.string(), z.any()).optional().describe("Properties to change."),
        append_content: z.string().optional().describe("Markdown to add at the end of the page."),
        edits: z
          .array(
            z.object({
              old_text: z.string().describe("Exact text currently in the page (as shown by fetch_page)."),
              new_text: z.string().describe("Replacement text."),
            }),
          )
          .optional()
          .describe("Find-and-replace edits on the page content."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withClient("update_page", async (ws, { page, title, properties, append_content, edits }) => {
      const current = await retrieveFullPage(ws.notion, page);
      const done: string[] = [];

      const values: Record<string, unknown> = { ...(properties ?? {}) };
      if (title) {
        const titleProp = Object.entries(current.properties).find(([, p]) => p.type === "title")?.[0];
        if (titleProp) values[titleProp] = title;
      }
      if (Object.keys(values).length > 0) {
        const schema = Object.fromEntries(
          Object.entries(current.properties).map(([name, p]) => [name, { type: p.type }]),
        );
        await ws.notion.pages.update({
          page_id: current.id,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: (await buildProperties(ws.notion, schema, values)) as any,
        });
        done.push(`updated properties: ${Object.keys(values).join(", ")}`);
      }

      if (edits && edits.length > 0) {
        await ws.notion.pages.updateMarkdown({
          page_id: current.id,
          type: "update_content",
          update_content: {
            content_updates: edits.map((e) => ({ old_str: e.old_text, new_str: e.new_text })),
            allow_deleting_content: false,
          },
        });
        done.push(`applied ${edits.length} content edit(s)`);
      }

      if (append_content) {
        await ws.notion.pages.updateMarkdown({
          page_id: current.id,
          type: "insert_content",
          insert_content: { content: append_content, position: { type: "end" } },
        });
        done.push("appended content");
      }

      if (done.length === 0) throw new Error("Nothing to update: pass title, properties, append_content or edits.");
      return json({ updated: true, id: current.id, url: current.url, changes: done });
    }),
  );

  // ── comments ──────────────────────────────────────────────────────────────
  server.registerTool(
    "get_comments",
    {
      title: "Read comments",
      description: "Lists the open comments on a page in a client's workspace.",
      inputSchema: {
        client: clientParam,
        page: z.string().describe("Page ID or Notion URL."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    withClient("get_comments", async (ws, { page }) => {
      const res = await ws.notion.comments.list({ block_id: toNotionId(page), page_size: 100 });
      const comments = res.results.filter(isFullComment).map((c) => ({
        id: c.id,
        discussion_id: c.discussion_id,
        created: c.created_time,
        author: c.created_by.id,
        text: plainText(c.rich_text),
      }));
      return json({ comments });
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment",
      description:
        "Adds a comment to a page in a client's workspace, or replies in an existing discussion thread.",
      inputSchema: {
        client: clientParam,
        page: z.string().optional().describe("Page ID or URL (for a new top-level comment)."),
        discussion_id: z.string().optional().describe("Reply in this discussion instead (from get_comments)."),
        text: z.string().describe("Comment text (markdown)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    withClient("add_comment", async (ws, { page, discussion_id, text }) => {
      if (!page && !discussion_id) throw new Error("Pass either page or discussion_id.");
      const res = discussion_id
        ? await ws.notion.comments.create({ discussion_id, markdown: text })
        : await ws.notion.comments.create({ parent: { page_id: toNotionId(page!) }, markdown: text });
      return json({ created: true, id: res.id });
    }),
  );
}

export function log(entry: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}
