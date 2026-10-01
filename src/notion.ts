import {
  APIErrorCode,
  Client,
  extractNotionId,
  isFullDataSource,
  isFullPage,
  isNotionClientError,
} from "@notionhq/client";
import type {
  DataSourceObjectResponse,
  PageObjectResponse,
  RichTextItemResponse,
} from "@notionhq/client/build/src/api-endpoints.js";

type PropertyValue = PageObjectResponse["properties"][string];
type PropertySchema = DataSourceObjectResponse["properties"][string];

/** Accepts a raw ID (with or without dashes) or any Notion URL. */
export function toNotionId(input: string): string {
  const trimmed = input.trim();
  return extractNotionId(trimmed) ?? trimmed;
}

export function plainText(rich: RichTextItemResponse[] | undefined): string {
  return (rich ?? []).map((r) => r.plain_text).join("");
}

export function pageTitle(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") return plainText(prop.title) || "Untitled";
  }
  return "Untitled";
}

export function dataSourceTitle(ds: DataSourceObjectResponse): string {
  return plainText(ds.title) || "Untitled";
}

/** Turns a Notion property value into something compact and readable. */
export function simplifyProperty(prop: PropertyValue): unknown {
  switch (prop.type) {
    case "title":
      return plainText(prop.title);
    case "rich_text":
      return plainText(prop.rich_text);
    case "number":
      return prop.number;
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select":
      return prop.multi_select.map((o) => o.name);
    case "date":
      return prop.date
        ? prop.date.end
          ? { start: prop.date.start, end: prop.date.end }
          : prop.date.start
        : null;
    case "checkbox":
      return prop.checkbox;
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "phone_number":
      return prop.phone_number;
    case "people":
      return prop.people.map((p) => ("name" in p && p.name ? p.name : p.id));
    case "relation":
      return prop.relation.map((r) => r.id);
    case "files":
      return prop.files.map((f) => f.name);
    case "created_time":
      return prop.created_time;
    case "last_edited_time":
      return prop.last_edited_time;
    case "created_by":
      return "name" in prop.created_by ? prop.created_by.name : prop.created_by.id;
    case "last_edited_by":
      return "name" in prop.last_edited_by ? prop.last_edited_by.name : prop.last_edited_by.id;
    case "unique_id":
      return prop.unique_id.prefix
        ? `${prop.unique_id.prefix}-${prop.unique_id.number}`
        : prop.unique_id.number;
    case "formula": {
      const f = prop.formula;
      if (f.type === "string") return f.string;
      if (f.type === "number") return f.number;
      if (f.type === "boolean") return f.boolean;
      if (f.type === "date") return f.date?.start ?? null;
      return null;
    }
    case "rollup": {
      const r = prop.rollup;
      if (r.type === "number") return r.number;
      if (r.type === "date") return r.date?.start ?? null;
      if (r.type === "array") return r.array.map((item) => simplifyProperty(item as PropertyValue));
      return null;
    }
    case "verification":
      return prop.verification?.state ?? null;
    default:
      return null;
  }
}

export function simplifyProperties(page: PageObjectResponse): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(page.properties)) {
    out[name] = simplifyProperty(prop);
  }
  return out;
}

export function summarizePage(page: PageObjectResponse) {
  return {
    id: page.id,
    title: pageTitle(page),
    url: page.url,
    last_edited: page.last_edited_time,
    properties: simplifyProperties(page),
  };
}

/** Describes a data source's columns so Claude knows what values are allowed. */
export function describeSchema(ds: DataSourceObjectResponse) {
  const columns: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(ds.properties)) {
    const col: Record<string, unknown> = { type: schema.type };
    if (schema.type === "select") col.options = schema.select.options.map((o) => o.name);
    if (schema.type === "multi_select") col.options = schema.multi_select.options.map((o) => o.name);
    if (schema.type === "status") col.options = schema.status.options.map((o) => o.name);
    if (schema.type === "relation") col.related_data_source_id = schema.relation.data_source_id;
    columns[name] = col;
  }
  return columns;
}

const rich = (text: string) => [{ type: "text" as const, text: { content: text.slice(0, 2000) } }];

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

/**
 * Converts a simple value ("Done", "2026-10-01", ["a","b"], true, 42) into the
 * Notion request shape for the given property type. If the caller already
 * passes a Notion-shaped object (e.g. { select: { name: "x" } }) it is used as is.
 */
export function buildPropertyValue(
  name: string,
  type: string,
  value: unknown,
  resolveUser: (idOrEmail: string) => string,
): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && type in value) {
    return value;
  }
  switch (type) {
    case "title":
      return { title: rich(String(value ?? "")) };
    case "rich_text":
      return { rich_text: rich(String(value ?? "")) };
    case "number":
      return { number: value === null || value === "" ? null : Number(value) };
    case "select":
      return { select: value == null || value === "" ? null : { name: String(value) } };
    case "status":
      return { status: value == null || value === "" ? null : { name: String(value) } };
    case "multi_select":
      return { multi_select: asArray(value).map((v) => ({ name: String(v) })) };
    case "date": {
      if (value == null || value === "") return { date: null };
      if (typeof value === "object" && value !== null && "start" in value) return { date: value };
      return { date: { start: String(value) } };
    }
    case "checkbox":
      return { checkbox: value === true || value === "true" || value === 1 };
    case "url":
      return { url: value == null || value === "" ? null : String(value) };
    case "email":
      return { email: value == null || value === "" ? null : String(value) };
    case "phone_number":
      return { phone_number: value == null || value === "" ? null : String(value) };
    case "people":
      return { people: asArray(value).map((v) => ({ id: resolveUser(String(v)) })) };
    case "relation":
      return { relation: asArray(value).map((v) => ({ id: toNotionId(String(v)) })) };
    default:
      throw new Error(`Property "${name}" has type "${type}", which can't be set through this tool.`);
  }
}

/**
 * Maps a { "Column": value } object onto Notion property requests using the
 * schema. Column names are matched case-insensitively.
 */
export async function buildProperties(
  notion: Client,
  schema: Record<string, { type: string }>,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const byLower = new Map(Object.keys(schema).map((k) => [k.toLowerCase(), k]));
  const needsUsers = Object.entries(values).some(([k]) => {
    const real = byLower.get(k.toLowerCase());
    return real && schema[real].type === "people";
  });
  const emailToId = needsUsers ? await loadUserEmails(notion) : new Map<string, string>();
  const resolveUser = (v: string) => emailToId.get(v.toLowerCase()) ?? toNotionId(v);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    const real = byLower.get(key.toLowerCase());
    if (!real) {
      throw new Error(
        `Unknown property "${key}". Available properties: ${Object.keys(schema).join(", ")}`,
      );
    }
    out[real] = buildPropertyValue(real, schema[real].type, value, resolveUser);
  }
  return out;
}

async function loadUserEmails(notion: Client): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const res = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    for (const u of res.results) {
      if (u.type === "person" && u.person.email) map.set(u.person.email.toLowerCase(), u.id);
      if (u.name) map.set(u.name.toLowerCase(), u.id);
    }
    cursor = res.has_more ? (res.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return map;
}

/**
 * Resolves an ID that may point to a database (container) or a data source
 * (the table itself, Notion API 2025-09-03+). Returns the data source.
 */
export async function resolveDataSource(
  notion: Client,
  idOrUrl: string,
  dataSourceName?: string,
): Promise<DataSourceObjectResponse> {
  const id = toNotionId(idOrUrl);
  try {
    const ds = await notion.dataSources.retrieve({ data_source_id: id });
    if (isFullDataSource(ds)) return ds;
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }

  const db = await notion.databases.retrieve({ database_id: id });
  const sources = "data_sources" in db ? db.data_sources : [];
  if (sources.length === 0) throw new Error("This database has no data sources the integration can access.");
  let chosen = sources[0];
  if (dataSourceName) {
    const match = sources.find((s) => s.name.toLowerCase() === dataSourceName.toLowerCase());
    if (!match) {
      throw new Error(
        `No data source named "${dataSourceName}". Available: ${sources.map((s) => s.name).join(", ")}`,
      );
    }
    chosen = match;
  } else if (sources.length > 1) {
    // Fall through with the first one; get_database lists all of them.
  }
  const ds = await notion.dataSources.retrieve({ data_source_id: chosen.id });
  if (!isFullDataSource(ds)) throw new Error("Could not read the database schema.");
  return ds;
}

export async function retrieveFullPage(notion: Client, idOrUrl: string): Promise<PageObjectResponse> {
  const page = await notion.pages.retrieve({ page_id: toNotionId(idOrUrl) });
  if (!isFullPage(page)) throw new Error("The integration can't read this page's details.");
  return page;
}

export function isNotFound(err: unknown): boolean {
  return (
    isNotionClientError(err) &&
    (err.code === APIErrorCode.ObjectNotFound || err.code === APIErrorCode.ValidationError)
  );
}

/** Produces an error message that tells Claude (and you) how to fix the problem. */
export function describeError(err: unknown, workspaceName: string): string {
  if (isNotionClientError(err)) {
    switch (err.code) {
      case APIErrorCode.ObjectNotFound:
        return (
          `Not found in ${workspaceName}. Either the ID is wrong or the page/database hasn't been ` +
          `shared with the integration (in Notion: page menu → Connections → add the integration).`
        );
      case APIErrorCode.Unauthorized:
        return `The Notion token for ${workspaceName} is invalid or was revoked.`;
      case APIErrorCode.RestrictedResource:
        return `The integration for ${workspaceName} lacks the capability for this action (check its capabilities in Notion's integration settings).`;
      case APIErrorCode.RateLimited:
        return `Notion rate limit hit for ${workspaceName}. Try again in a few seconds.`;
      default:
        return `Notion error (${err.code}): ${err.message}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
