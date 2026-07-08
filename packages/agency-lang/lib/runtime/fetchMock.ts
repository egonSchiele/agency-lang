// A test-only shim that replaces globalThis.fetch to serve canned HTTP
// responses. Installed by the compiled agent module when AGENCY_FETCH_MOCKS_FILE
// is set (see the imports template). Matches by URL (exact/glob/regex), optional
// method, and optional request body; returns a real Response so every consumer
// (http.ts's getReader path, email.ts's .json(), …) works off one shim.
//
// This module has NO filesystem dependency: `returnFile` is resolved and
// inlined into `return` by the CLI runner before it reaches here.

export type FetchMock = {
  url?: string;
  urlPattern?: string;
  method?: string;
  body?: string | Record<string, unknown>;
  bodyPattern?: string;
  // Resolved to `return` by the runner (lib/cli/fetchMockResolve.ts). The shim
  // ignores it and requires `return` to be present.
  returnFile?: string;
  return?: unknown;
  status?: number;
  headers?: Record<string, string>;
};

type CompiledMock = {
  matchUrl: (url: string) => boolean;
  method?: string; // uppercased; undefined = any
  matchBody?: (raw: string) => boolean; // undefined = ignore body
  body: string;
  status: number;
  headers?: Record<string, string>;
};

// Compile a glob (only `*` is special) to an anchored RegExp. Note: we do NOT
// reuse the repo's matchGlob/picomatch (lib/importPaths.ts) — picomatch's `*` is
// path-segment-aware and won't cross `/`, but URL globs must (e.g.
// `https://api.example.com/v1/*` matching `.../v1/anything/here`).
function globToRegExp(glob: string): RegExp {
  const parts = glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("^" + parts.join(".*") + "$");
}

// Deep "subset" comparison: every key/value in `subset` must be present and
// deep-equal in `actual`. Arrays must match length and elements exactly.
// Intentionally self-contained (not the repo's deepEqual/__eq): those do full
// equality, not subset matching, and keeping this local leaves the shim
// dependency-free.
function deepSubset(subset: unknown, actual: unknown): boolean {
  if (subset === null || typeof subset !== "object") {
    return subset === actual;
  }
  if (actual === null || typeof actual !== "object") {
    return false;
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(actual) || subset.length !== actual.length) {
      return false;
    }
    return subset.every((element, index) => deepSubset(element, actual[index]));
  }
  if (Array.isArray(actual)) {
    return false;
  }
  return Object.entries(subset as Record<string, unknown>).every(([key, value]) =>
    deepSubset(value, (actual as Record<string, unknown>)[key]),
  );
}

function buildBodyMatcher(mock: FetchMock): ((raw: string) => boolean) | undefined {
  if (mock.bodyPattern !== undefined) {
    const bodyRe = new RegExp(mock.bodyPattern);
    return (raw) => bodyRe.test(raw);
  }
  if (typeof mock.body === "string") {
    const want = mock.body;
    return (raw) => raw === want;
  }
  if (mock.body !== undefined) {
    const want = mock.body;
    return (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Deliberate control flow, not a swallowed error: a non-JSON request
        // body simply cannot match an object `body` (spec §4.3). Logging every
        // non-JSON body would be pure noise.
        return false;
      }
      return deepSubset(want, parsed);
    };
  }
  return undefined;
}

function compileMock(mock: FetchMock, index: number): CompiledMock {
  const where = `fetchMock[${index}]`;
  const hasUrl = mock.url !== undefined;
  const hasPattern = mock.urlPattern !== undefined;
  if (hasUrl === hasPattern) {
    throw new Error(`${where}: exactly one of "url" or "urlPattern" is required.`);
  }
  const urlRe = hasUrl ? globToRegExp(mock.url as string) : new RegExp(mock.urlPattern as string);

  if (mock.body !== undefined && mock.bodyPattern !== undefined) {
    throw new Error(`${where}: set at most one of "body" or "bodyPattern".`);
  }

  if (mock.return === undefined) {
    throw new Error(`${where}: a "return" body is required (returnFile is inlined to "return" by the runner).`);
  }
  const body = typeof mock.return === "string" ? mock.return : JSON.stringify(mock.return);

  return {
    matchUrl: (candidate: string) => urlRe.test(candidate),
    method: mock.method?.toUpperCase(),
    matchBody: buildBodyMatcher(mock),
    body,
    status: mock.status ?? 200,
    headers: mock.headers,
  };
}

function isRequestInput(input: any): boolean {
  return typeof input === "object" && input !== null && !(input instanceof URL);
}

// Pull the URL string out of any of fetch's three input forms.
function extractUrl(input: any): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url; // Request
}

// Pull the method, uppercased, from init or a Request; default GET.
function extractMethod(input: any, init: any): string {
  let raw = init?.method;
  if (raw === undefined && isRequestInput(input)) {
    raw = input.method;
  }
  return String(raw ?? "GET").toUpperCase();
}

export function installFetchMock(mocks: FetchMock[]): () => void {
  if (!Array.isArray(mocks)) {
    throw new Error(
      "installFetchMock: expected an array of fetch mocks (AGENCY_FETCH_MOCKS_FILE must hold a JSON array).",
    );
  }
  const compiled = mocks.map(compileMock);
  const real = globalThis.fetch;

  const mockFetch = async (input: any, init?: any): Promise<Response> => {
    const signal = init?.signal;
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    const url = extractUrl(input);
    const method = extractMethod(input, init);

    // Lazily read the request body only when a matcher needs it, and memoize.
    // NOTE: this assumes STRING bodies (agency callers pass pre-serialized JSON;
    // std::http passes no body). A structured body (object/URLSearchParams/
    // Buffer) stringifies lossily to "[object Object]", so callers must
    // pre-serialize anything they expect body-matching to compare.
    let bodyText: string | null = null;
    const getBody = async (): Promise<string> => {
      if (bodyText !== null) {
        return bodyText;
      }
      let text: string;
      if (init?.body != null) {
        text = typeof init.body === "string" ? init.body : String(init.body);
      } else if (isRequestInput(input) && typeof input.clone === "function") {
        text = await input.clone().text();
      } else {
        text = "";
      }
      bodyText = text;
      return text;
    };

    for (const mock of compiled) {
      if (!mock.matchUrl(url)) {
        continue;
      }
      if (mock.method && mock.method !== method) {
        continue;
      }
      if (mock.matchBody && !mock.matchBody(await getBody())) {
        continue;
      }
      return new Response(mock.body, { status: mock.status, headers: mock.headers });
    }

    const declared = mocks.map((mock) => mock.url ?? mock.urlPattern).join(", ");
    throw new Error(
      `No fetchMock matched ${method} ${url}. Declared: [${declared}]. Add an entry to fetchMocks.`,
    );
  };

  globalThis.fetch = mockFetch as unknown as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}
