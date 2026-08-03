// The link between a directory and its hosted agent, stored as `remote.serveUrl`
// in agency.json. Reads and writes the raw JSON so unrelated config keys survive
// a link; URL shape/trust is delegated to serveUrl.ts.

import * as fs from "fs";
import { parseServeBaseUrl } from "../statelog/serveUrl.js";
import type { ServeAddress } from "../statelog/serveUrl.js";

export type RemoteBinding = ServeAddress;

/** The linked agent, or null when unlinked, unreadable, or the stored URL is not
 *  a canonical serve base. */
export function readBinding(configPath: string): RemoteBinding | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const serveUrl = (parsed as { remote?: { serveUrl?: unknown } }).remote?.serveUrl;
  if (typeof serveUrl !== "string") {
    return null;
  }
  return parseServeBaseUrl(serveUrl);
}

/** Write the link into agency.json, replacing only the `remote` key. Reads the
 *  raw object first (never the parsed AgencyConfig, which would drop unknown
 *  keys); a missing file is created, and an invalid-JSON or non-object root
 *  throws before any write so the file is left untouched. */
export function writeBinding(configPath: string, binding: RemoteBinding): void {
  let root: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    // JSON.parse throws before the write below, leaving the file unchanged.
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${configPath} must contain a JSON object at its root`);
    }
    root = parsed as Record<string, unknown>;
  }
  root.remote = { serveUrl: binding.serveUrl };
  fs.writeFileSync(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf-8");
}
