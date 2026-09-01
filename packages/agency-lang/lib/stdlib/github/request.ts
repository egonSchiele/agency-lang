import { z } from "zod";
import { getRuntimeContext } from "../../runtime/asyncContext.js";
import { runHttp, readBodyBytesCapped } from "../http.js";
import { isAbortError } from "../../runtime/errors.js";
import { resolveGithubToken } from "./credential.js";
import { githubFailureMessage, scrub } from "./errors.js";

// Hard-coded in v1. GitHub Enterprise support (GITHUB_API_URL) is issue
// #1003, and when it lands the value must be read once per process — an
// env-controlled base URL read per request would let a mid-run setEnv
// redirect authenticated calls (spec section 7).
export const GITHUB_API_BASE = "https://api.github.com";

// GitHub requires a User-Agent naming the app; constant style per wikipedia.ts.
export const GITHUB_USER_AGENT =
  "agency-lang (https://github.com/egonSchiele/agency-lang; contact via repo issues)";

/**
 * One GitHub REST endpoint, declared: method, path, params, and a zod schema
 * that validates the raw payload and transforms it to the public shape. The
 * full set of endpoints this module can ever hit is the set of these
 * declarations (prs.ts, issues.ts) — nothing else builds a request.
 */
export type GithubEndpoint<Params, Out> = {
  /** Human-readable id for error messages, e.g. "GET /repos/{owner}/{repo}/pulls/{number}". */
  name: string;
  method: "GET" | "POST" | "PATCH";
  path: (params: Params) => string;
  query?: (params: Params) => Record<string, string>;
  body?: (params: Params) => unknown;
  accept?: string;
  response: z.ZodType<Out, any>;
};

/** GitHub rejects per_page above 100. */
export const GITHUB_MAX_PER_PAGE = 100;

/** Paging as the query fields GitHub expects, clamped (per_page in
 *  [1, GITHUB_MAX_PER_PAGE], page >= 1). Endpoint declarations spread this
 *  into their query objects. */
export function pagingQuery(perPage: number, page: number): Record<string, string> {
  const clampedPerPage = Math.min(Math.max(Math.floor(perPage) || 1, 1), GITHUB_MAX_PER_PAGE);
  const clampedPage = Math.max(Math.floor(page) || 1, 1);
  return { per_page: String(clampedPerPage), page: String(clampedPage) };
}

const SIZE_CAP_PATTERN = /exceeds \d+ bytes/;

function buildUrl<Params>(endpoint: GithubEndpoint<Params, unknown>, params: Params): string {
  const queryEntries = endpoint.query ? endpoint.query(params) : undefined;
  const query = queryEntries ? `?${new URLSearchParams(queryEntries).toString()}` : "";
  return `${GITHUB_API_BASE}${endpoint.path(params)}${query}`;
}

/**
 * Run one declared endpoint. Called only from the endpoint bindings in
 * prs.ts/issues.ts, which are called only from Agency functions whose
 * interrupt has already been approved — so the token read below is always
 * downstream of an approval (spec section 3.2). The token lives only in this
 * frame, which contains no interrupt points, so no checkpoint can capture it.
 *
 * Uses the GLOBAL fetch on purpose: the fetchMocks test shim replaces
 * globalThis.fetch, and a saved reference would dodge it (spec section 8).
 */
export async function _githubRequest<Params, Out>(
  endpoint: GithubEndpoint<Params, Out>,
  params: Params,
): Promise<Out> {
  const { ctx, stack } = getRuntimeContext();
  const signal = ctx.getAbortSignal(stack);
  const token = await resolveGithubToken();
  const url = buildUrl(endpoint, params);
  return await runHttp(async () => {
    const response = await fetch(url, buildRequestInit(endpoint, params, token, signal));
    const text = await readBodyText(response, url, signal);
    if (!response.ok) {
      throw new Error(
        githubFailureMessage(response.status, response.headers, text, endpoint.method, url),
      );
    }
    return validateResponse(endpoint, decodeBody(endpoint, text));
  }, url);
}

/** Headers are complete before the RequestInit is built, so nothing mutates
 *  an object another value already holds. */
function buildRequestInit<Params>(
  endpoint: GithubEndpoint<Params, unknown>,
  params: Params,
  token: string,
  signal: AbortSignal,
): RequestInit {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: endpoint.accept ?? "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": GITHUB_USER_AGENT,
  };
  const requestBody = endpoint.body ? endpoint.body(params) : undefined;
  if (requestBody === undefined) {
    return { method: endpoint.method, headers, signal };
  }
  headers["Content-Type"] = "application/json";
  return { method: endpoint.method, headers, signal, body: JSON.stringify(requestBody) };
}

async function readBodyText(response: Response, url: string, signal: AbortSignal): Promise<string> {
  try {
    const bytes = await readBodyBytesCapped(response, url, signal);
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    if (isAbortError(e)) {
      throw e;
    }
    const message = scrub(String(e));
    // Only a size-cap trip gets the perPage advice; a mid-body network drop
    // must not point the model at a fix that cannot help.
    if (SIZE_CAP_PATTERN.test(message)) {
      throw new Error(`${message}. Request fewer results per call (smaller perPage).`);
    }
    throw new Error(message);
  }
}

function decodeBody<Params>(endpoint: GithubEndpoint<Params, unknown>, text: string): unknown {
  if ((endpoint.accept ?? "").includes("diff")) {
    return text;
  }
  if (text === "") {
    return null;
  }
  return JSON.parse(text);
}

function validateResponse<Params, Out>(endpoint: GithubEndpoint<Params, Out>, raw: unknown): Out {
  const parsed = endpoint.response.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  const issue = parsed.error.issues[0];
  const where = issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
  const why = issue ? issue.message : "unknown mismatch";
  throw new Error(
    `GitHub's response for ${endpoint.name} did not match the expected shape${where}: ${scrub(why)}. ` +
      "GitHub may have changed this API; report this.",
  );
}
