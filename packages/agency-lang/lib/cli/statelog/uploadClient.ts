// The statelog upload API, sealed off here. This is the only file that knows
// the endpoint paths, the request body shape, and the response envelope — so a
// change to statelog's API touches nothing else. Server responses are treated
// as untrusted: a bad body reports an error or drops the extra (the manifest)
// rather than crashing a deploy that already landed.

import type { DeployTarget } from "../deploy/target.js";
import type { AgencyBundle } from "../deploy/bundle.js";
import { resolveTrustedEndpointUrl, parseServeBaseUrl } from "./serveUrl.js";
import { createServeClient, ServeRequestError } from "./serveClient.js";
import type { ServeManifest } from "./serveClient.js";
import { statelogRequest } from "./statelogRequest.js";

export type UploadResult =
  { ok: true; endpointUrls: string[]; manifest?: ServeManifest } | { ok: false; error: string };

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

  // requireOk:false + envelope:false — upload deliberately never inspects
  // response.ok: the envelope decides the outcome whatever the HTTP status (a
  // non-2xx success envelope succeeds). The core serializes the body once.
  const result = await statelogRequest({
    method: "POST",
    url,
    apiKey: target.apiKey,
    body: {
      entrypoint: bundle.entrypoint,
      files: bundle.files.map((file) => ({ name: file.name, contents: file.contents })),
    },
    envelope: false,
    requireOk: false,
  });
  if (!result.ok) {
    switch (result.failure.kind) {
      case "unreachable":
        return { ok: false, error: `Could not reach ${target.host} (${result.failure.cause}).` };
      case "non-json":
        return { ok: false, error: result.failure.diagnostic };
      // With requireOk:false and envelope:false the core can produce no other
      // failure kind, but the switch stays exhaustive rather than silently
      // absorbing a future one.
      case "http":
      case "bad-envelope":
      case "envelope-error":
        return { ok: false, error: `Upload rejected (HTTP ${result.failure.status}).` };
    }
  }
  const envelope = result.value;

  const endpointUrls = readEndpointUrls(envelope);
  if (!endpointUrls) {
    return { ok: false, error: rejectionMessage(envelope, result.status) };
  }

  // Resolve and origin-check every response URL BEFORE the Bearer token follows
  // it to fetch /list or the caller persists it — a compromised response must
  // not redirect the API key to another origin.
  let absoluteUrls: string[];
  try {
    absoluteUrls = endpointUrls.map((relative) => resolveTrustedEndpointUrl(relative, target.host));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const manifest = await enrichManifest(absoluteUrls, target.apiKey);
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

/** Best-effort `/list` fetch to enrich the deploy output with curl examples.
 *  The manifest model and reader now live in serveClient; a fetch failure just
 *  omits the manifest, since the deploy already succeeded. */
async function enrichManifest(
  endpointUrls: string[],
  apiKey: string,
): Promise<ServeManifest | undefined> {
  const base = serveBaseUrl(endpointUrls);
  const address = base ? parseServeBaseUrl(base) : null;
  if (!address) {
    return undefined;
  }
  try {
    return await createServeClient(address, apiKey).fetchManifest();
  } catch (error) {
    if (error instanceof ServeRequestError) {
      console.error(`deploy: could not fetch manifest for curl examples: ${error.message}`);
      return undefined;
    }
    throw error;
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
