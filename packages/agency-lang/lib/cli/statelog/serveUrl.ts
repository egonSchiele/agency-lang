// The one place that knows statelog serve-URL shape and trust rules. A hosted
// agent's serve base is exactly `…/serve/:userId/:projectId/:filename`; every
// request URL is built from it, and every URL the server hands back is checked
// against the deploy target's origin before the API key follows it.

/**
 * Resolve a response-supplied endpoint URL against the trusted host, then
 * reject it if it left that origin, embedded credentials, or used a non-HTTP(S)
 * scheme. Resolve first, validate second — a relative `/serve/...` (which
 * statelog returns) is legitimate and must survive. Throws on any violation.
 */
export function resolveTrustedEndpointUrl(rawUrl: string, targetHost: string): string {
  if (typeof rawUrl !== "string") {
    throw new Error(`endpoint URL must be a string, got ${typeof rawUrl}`);
  }
  const target = new URL(targetHost);
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl, target);
  } catch {
    throw new Error(`invalid endpoint URL: ${rawUrl}`);
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error(`endpoint URL must use HTTP(S): ${rawUrl}`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`endpoint URL must not embed credentials: ${rawUrl}`);
  }
  if (endpoint.origin !== target.origin) {
    throw new Error(
      `endpoint origin ${endpoint.origin} does not match target ${target.origin}`,
    );
  }
  return endpoint.toString();
}

/** A parsed, canonicalized serve base. Identifiers are decoded for use;
 *  `serveUrl` re-encodes each exactly once. */
export type ServeAddress = {
  serveUrl: string;
  origin: string;
  userId: string;
  projectId: string;
  filename: string;
};

/**
 * Parse a serve base URL, accepting *only* the exact
 * `…/serve/:userId/:projectId/:filename` shape. A trailing slash is
 * canonicalized away; anything else — query, hash, credentials, a non-HTTP(S)
 * scheme, empty identifiers, or extra/command segments (`…/node/main`) — is
 * rejected with `null`.
 */
export function parseServeBaseUrl(rawUrl: string): ServeAddress | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.search || parsed.hash) return null;

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 4 || segments[0] !== "serve") return null;

  const userId = decodeURIComponent(segments[1]);
  const projectId = decodeURIComponent(segments[2]);
  const filename = decodeURIComponent(segments[3]);
  const serveUrl = `${parsed.origin}/serve/${encodeURIComponent(userId)}/${encodeURIComponent(
    projectId,
  )}/${encodeURIComponent(filename)}`;
  return { serveUrl, origin: parsed.origin, userId, projectId, filename };
}

/** Build a request URL under a serve base, encoding each dynamic segment once.
 *  Validates the base through `parseServeBaseUrl` first. */
export function serveRouteUrl(serveUrl: string, segments: string[]): string {
  const address = parseServeBaseUrl(serveUrl);
  if (!address) {
    throw new Error(`not a serve base URL: ${serveUrl}`);
  }
  if (segments.length === 0) {
    return address.serveUrl;
  }
  const suffix = segments.map((segment) => encodeURIComponent(segment)).join("/");
  return `${address.serveUrl}/${suffix}`;
}

/** The statelog web-app page for an agent's project. */
export function projectPageUrl(address: ServeAddress): string {
  const url = new URL("/projects/show", address.origin);
  url.searchParams.set("id", address.projectId);
  return url.toString();
}
