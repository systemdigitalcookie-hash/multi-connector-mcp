import { Client } from "@notionhq/client";

export interface NotionWorkspace {
  /** Stable identifier used in tool calls, e.g. "acme". */
  slug: string;
  /** Human-friendly name shown to Claude, e.g. "Acme Corp". */
  name: string;
  notion: Client;
}

export interface Config {
  port: number;
  secret: string;
  workspaces: Map<string, NotionWorkspace>;
}

const TOKEN_PREFIX = "NOTION_TOKEN_";
const NAME_PREFIX = "NOTION_NAME_";

/**
 * Reads client workspaces from env vars:
 *   NOTION_TOKEN_ACME=ntn_...        (required, one per client)
 *   NOTION_NAME_ACME="Acme Corp"     (optional display name)
 * The part after the prefix becomes the slug ("acme").
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.MCP_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error(
      "MCP_SECRET must be set to a random string of at least 32 characters " +
        "(generate one with: openssl rand -hex 32)",
    );
  }

  const workspaces = new Map<string, NotionWorkspace>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(TOKEN_PREFIX) || !value?.trim()) continue;
    const suffix = key.slice(TOKEN_PREFIX.length);
    const slug = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!slug) continue;
    const name = env[NAME_PREFIX + suffix]?.trim() || suffix.replace(/_/g, " ");
    workspaces.set(slug, {
      slug,
      name,
      notion: new Client({ auth: value.trim() }),
    });
  }

  if (workspaces.size === 0) {
    console.warn(
      `No Notion workspaces configured yet. Add a ${TOKEN_PREFIX}<CLIENT> environment variable per client.`,
    );
  }

  return {
    port: Number(env.PORT) || 3000,
    secret,
    workspaces,
  };
}
