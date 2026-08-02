// The statelog upload API, sealed off here. This is the only file that knows
// the endpoint paths, the request body shape, and the response envelope — so a
// change to statelog's API touches nothing else. Server responses are treated
// as untrusted: a bad body reports an error or drops the extra (the manifest)
// rather than crashing a deploy that already landed.

import type { DeployTarget } from "../deploy/target.js";
import type { AgencyBundle } from "../deploy/bundle.js";
import { resolveTrustedEndpointUrl } from "./serveUrl.js";

/** The `/list` manifest, narrowed to what the curl examples need. Functions
 *  currently carry no `parameters` — a known serve-side gap. */
export type Manifest = {
  nodes: { name: string; parameters: string[] }[];
  functions: { name: string }[];
};

export type UploadResult =
  | { ok: true; endpointUrls: string[]; manifest?: Manifest }
  | { ok: false; error: string };

/**
 * Upload the bundle and return the agent's serve endpoints (absolute URLs).
 * Best-effort fetches the `/list` manifest too, so the caller can print curl
 * examples with real node parameters; a manifest fetch failure is not fatal.
 */
export async function uploadBundle(
  target: DeployTarget,
  bundle: AgencyBundle,
): Promise<UploadResult> {
  const url = new URL(
    `/api/projects/${encodeURIComponent(target.projectId)}/upload`,
    target.host,
  ).toString();

  const body = JSON.stringify({
    entrypoint: bundle.entrypoint,
    files: bundle.files.map((file) => ({ name: file.name, contents: file.contents })),
  });

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `Could not reach ${target.host} (${detail}).` };
  }

  let envelope: unknown;
  try {
    envelope = await response.json();
  } catch {
    return { ok: false, error: `statelog returned a non-JSON response (HTTP ${response.status}).` };
  }

  const endpointUrls = readEndpointUrls(envelope);
  if (!endpointUrls) {
    return { ok: false, error: rejectionMessage(envelope, response.status) };
  }

  // Resolve and origin-check every response URL BEFORE the Bearer token follows
  // it to fetch /list or the caller persists it — a compromised response must
  // not redirect the API key to another origin.
  let absoluteUrls: string[];
  try {
    absoluteUrls = endpointUrls.map((relative) =>
      resolveTrustedEndpointUrl(relative, target.host),
    );
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const manifest = await fetchManifest(absoluteUrls, target.apiKey);
  return { ok: true, endpointUrls: absoluteUrls, manifest };
}

/** Endpoint URLs from a `{ success: true, value: { endpointUrls } }` envelope,
 *  or null if the response isn't that success shape. */
function readEndpointUrls(envelope: unknown): string[] | null {
  if (
    typeof envelope === "object" &&
    envelope !== null &&
    (envelope as { success?: unknown }).success === true
  ) {
    const urls = (envelope as { value?: { endpointUrls?: unknown } }).value?.endpointUrls;
    if (Array.isArray(urls)) {
      return urls as string[];
    }
  }
  return null;
}

/** The error text from a `{ success: false, error }` envelope, or a fallback. */
function rejectionMessage(envelope: unknown, status: number): string {
  const error = (envelope as { error?: unknown } | null)?.error;
  return typeof error === "string" ? error : `Upload rejected (HTTP ${status}).`;
}

/** Fetch the agent's `/list` manifest. Best-effort — returns undefined on any
 *  failure or unexpected shape, since the deploy already succeeded and this only
 *  enriches the output. */
async function fetchManifest(
  endpointUrls: string[],
  apiKey: string,
): Promise<Manifest | undefined> {
  const listUrl = manifestUrl(endpointUrls);
  if (!listUrl) {
    return undefined;
  }
  try {
    const response = await fetch(listUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      return undefined;
    }
    const body = (await response.json()) as { nodes?: unknown; functions?: unknown };
    if (!Array.isArray(body.nodes) || !Array.isArray(body.functions)) {
      return undefined;
    }
    return body as Manifest;
  } catch (error) {
    console.error(
      `deploy: could not fetch manifest for curl examples: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** The manifest endpoint — the file-level `…/<file>/list`, not a `/node/list`
 *  from a node that happens to be named `list`. */
function manifestUrl(endpointUrls: string[]): string | undefined {
  return endpointUrls.find(
    (url) => url.endsWith("/list") && !url.includes("/node/") && !url.includes("/function/"),
  );
}

/** The serve base URL (…/serve/:user/:project/:file) shared by an agent's
 *  endpoints — the manifest URL with its trailing `/list` removed. */
export function serveBaseUrl(endpointUrls: string[]): string | undefined {
  const listUrl = manifestUrl(endpointUrls);
  return listUrl ? listUrl.slice(0, -"/list".length) : undefined;
}
