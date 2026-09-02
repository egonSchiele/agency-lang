import { describe, it, expect, afterEach, vi } from "vitest";
import { z } from "zod";
import { withCtx, jsonResponse, stubToken } from "./testUtils.js";
import { _githubRequest, pagingQuery, GITHUB_API_BASE, type GithubEndpoint } from "./request.js";
import { _resetGithubCredentialCacheForTests, _resolveAndCache } from "./credential.js";
import { AWS_OBJECT_BYTE_LIMIT } from "../../constants.js";

function oversizedResponse(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(AWS_OBJECT_BYTE_LIMIT + 1));
        controller.close();
      },
    }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  _resetGithubCredentialCacheForTests();
});

// A minimal JSON endpoint: validates {ok: boolean} and transforms it.
const pingEndpoint: GithubEndpoint<{ n: number }, { fine: boolean }> = {
  name: "GET /repos/o/r/pulls/{n}",
  method: "GET",
  path: (params) => `/repos/o/r/pulls/${params.n}`,
  response: z.object({ ok: z.boolean() }).transform((raw) => ({ fine: raw.ok })),
};

const diffEndpoint: GithubEndpoint<{ n: number }, string> = {
  name: "GET /repos/o/r/pulls/{n} (diff)",
  method: "GET",
  path: (params) => `/repos/o/r/pulls/${params.n}`,
  accept: "application/vnd.github.v3.diff",
  response: z.string(),
};

const listEndpoint: GithubEndpoint<{ state: string }, unknown[]> = {
  name: "GET /repos/o/r/pulls",
  method: "GET",
  path: () => "/repos/o/r/pulls",
  query: (params) => ({ state: params.state, per_page: "30", page: "1" }),
  response: z.array(z.unknown()),
};

const postEndpoint: GithubEndpoint<{ title: string }, { id: number }> = {
  name: "POST /repos/o/r/issues",
  method: "POST",
  path: () => "/repos/o/r/issues",
  body: (params) => ({ title: params.title }),
  response: z.object({ id: z.number() }),
};

describe("pagingQuery", () => {
  it.each([
    [30, 1, "30", "1"],
    [500, 0, "100", "1"],
    [0, -3, "1", "1"],
  ])("clamps %d/%d", (perPage, page, wantPerPage, wantPage) => {
    expect(pagingQuery(perPage, page)).toEqual({ per_page: wantPerPage, page: wantPage });
  });
});

describe("_githubRequest", () => {
  it("sends auth, accept, api-version, and user-agent headers to the pinned base", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: true }));
    const out = await withCtx(() => _githubRequest(pingEndpoint, { n: 1 }));
    expect(out).toEqual({ fine: true });
    const [url, init] = spy.mock.calls[0];
    expect(String(url)).toBe(`${GITHUB_API_BASE}/repos/o/r/pulls/1`);
    const headers = init!.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token-value");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(headers["User-Agent"]).toContain("agency-lang");
  });

  it("fails loudly, naming the endpoint, when the response shape is wrong", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ ok: "not-a-boolean" }));
    await expect(withCtx(() => _githubRequest(pingEndpoint, { n: 1 }))).rejects.toThrow(
      /GET \/repos\/o\/r\/pulls\/\{n\}.*expected shape/s,
    );
  });

  it("validates and returns raw text for a diff accept type", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("diff --git a b"));
    const out = await withCtx(() => _githubRequest(diffEndpoint, { n: 1 }));
    expect(out).toBe("diff --git a b");
  });

  it("serializes query parameters", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));
    await withCtx(() => _githubRequest(listEndpoint, { state: "open" }));
    expect(String(spy.mock.calls[0][0])).toBe(
      `${GITHUB_API_BASE}/repos/o/r/pulls?state=open&per_page=30&page=1`,
    );
  });

  it("posts a JSON body with content-type", async () => {
    stubToken();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ id: 1 }, 201));
    await withCtx(() => _githubRequest(postEndpoint, { title: "t" }));
    const init = spy.mock.calls[0][1]!;
    expect(init.body).toBe('{"title":"t"}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("maps a 401 through githubFailureMessage", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "Bad credentials" }, 401),
    );
    await expect(withCtx(() => _githubRequest(pingEndpoint, { n: 1 }))).rejects.toThrow(
      /gh auth login/,
    );
  });

  it("forgets the cached token on a 401 so a replaced credential is picked up", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ message: "Bad credentials" }, 401),
    );
    await expect(withCtx(() => _githubRequest(pingEndpoint, { n: 1 }))).rejects.toThrow(/401/);
    // With the cache still holding "test-token-value" this would return it.
    const fresh = {
      env: { GITHUB_TOKEN: "fresh" },
      ghAuthToken: async () => null,
      keyringGet: async () => null,
    };
    expect(await _resolveAndCache(fresh)).toBe("fresh");
  });

  it("names the endpoint when a successful response is not JSON", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>oops</html>"));
    await expect(withCtx(() => _githubRequest(pingEndpoint, { n: 1 }))).rejects.toThrow(
      /GET \/repos\/o\/r\/pulls\/\{n\}.*not valid JSON/s,
    );
  });

  it("suggests a smaller perPage only when the endpoint is paginated", async () => {
    stubToken();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(oversizedResponse());
    await expect(withCtx(() => _githubRequest(listEndpoint, { state: "open" }))).rejects.toThrow(
      /exceeds.*perPage/s,
    );
    vi.spyOn(globalThis, "fetch").mockResolvedValue(oversizedResponse());
    const diffFailure = withCtx(() => _githubRequest(diffEndpoint, { n: 1 }));
    await expect(diffFailure).rejects.toThrow(/exceeds/);
    await expect(diffFailure).rejects.not.toThrow(/perPage/);
  });

  // The no-credential-means-no-fetch test lives in
  // request.nocredential.test.ts: it mocks the credential module wholesale,
  // which vi.mock only allows per-file.
});
