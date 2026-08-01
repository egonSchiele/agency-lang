// The statelog upload API, sealed off here. This is the only file that knows
// the endpoint paths, the request body shape, and the response envelope — so a
// change to statelog's API touches nothing else.

import type { DeployTarget } from "./target.js";
import type { AgencyBundle } from "./bundle.js";

/** The `/list` manifest, narrowed to what the curl examples need. Functions
 *  currently carry no `parameters` — a known serve-side gap. */
export type Manifest = {
  nodes: { name: string; parameters: string[] }[];
  functions: { name: string }[];
};

export type UploadResult =
  | { ok: true; endpointUrls: string[]; manifest?: Manifest }
  | { ok: false; error: string };

/** statelog wraps responses in a Result envelope. */
type UploadEnvelope =
  | { success: true; value: { endpointUrls: string[] } }
  | { success: false; error: string };

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

  let envelope: UploadEnvelope;
  try {
    envelope = (await response.json()) as UploadEnvelope;
  } catch {
    return { ok: false, error: `statelog returned a non-JSON response (HTTP ${response.status}).` };
  }

  if (!envelope || envelope.success === false) {
    return { ok: false, error: envelope?.error ?? `Upload rejected (HTTP ${response.status}).` };
  }

  const endpointUrls = envelope.value.endpointUrls.map((relative) =>
    new URL(relative, target.host).toString(),
  );
  const manifest = await fetchManifest(endpointUrls, target.apiKey);
  return { ok: true, endpointUrls, manifest };
}

/** Fetch the agent's `/list` manifest. Best-effort — returns undefined on any
 *  failure, since the deploy already succeeded and this only enriches output. */
async function fetchManifest(
  endpointUrls: string[],
  apiKey: string,
): Promise<Manifest | undefined> {
  const listUrl = endpointUrls.find((url) => url.endsWith("/list"));
  if (!listUrl) {
    return undefined;
  }
  try {
    const response = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return (await response.json()) as Manifest;
  } catch (error) {
    console.error(
      `deploy: could not fetch manifest for curl examples: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

/** The serve base URL (…/serve/:user/:project/:file) shared by an agent's
 *  endpoints — the `/list` URL with its trailing segment removed. */
export function serveBaseUrl(endpointUrls: string[]): string | undefined {
  const listUrl = endpointUrls.find((url) => url.endsWith("/list"));
  return listUrl ? listUrl.slice(0, -"/list".length) : undefined;
}
