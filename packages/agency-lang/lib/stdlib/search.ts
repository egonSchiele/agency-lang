const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

export type SearchResult = {
  title: string;
  url: string;
  description: string;
};

export type SearchOptions = {
  apiKey?: string;
  count?: number;
  country?: string;
  searchLang?: string;
  safesearch?: string;
  freshness?: string;
};

export async function _search(
  query: string,
  options?: SearchOptions,
): Promise<SearchResult[]> {
  // Note: using || (not ??) so empty strings from Agency defaults fall through to env var
  const apiKey = options?.apiKey || process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Brave Search API key. Set BRAVE_API_KEY env var or pass apiKey option.",
    );
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options?.count ?? 5));

  if (options?.country) url.searchParams.set("country", options.country);
  if (options?.searchLang)
    url.searchParams.set("search_lang", options.searchLang);
  if (options?.safesearch)
    url.searchParams.set("safesearch", options.safesearch);
  if (options?.freshness) url.searchParams.set("freshness", options.freshness);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Brave Search API error (${response.status}): ${body}`);
  }

  const data = await response.json();
  const results = data?.web?.results ?? [];

  return results.map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.url as string) ?? "",
    description: (r.description as string) ?? "",
  }));
}

export type TavilySearchOptions = {
  apiKey?: string;
  count?: number;
  searchDepth?: string;
  topic?: string;
};

export async function _tavilySearch(
  query: string,
  options?: TavilySearchOptions,
): Promise<SearchResult[]> {
  // Note: using || (not ??) so empty strings from Agency defaults fall through to env var
  const apiKey = options?.apiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Tavily API key. Set TAVILY_API_KEY env var or pass apiKey option.",
    );
  }

  // Tavily takes a JSON POST body and a Bearer token (not a query string).
  const body: Record<string, unknown> = {
    query,
    max_results: options?.count ?? 5,
  };
  if (options?.searchDepth) body.search_depth = options.searchDepth;
  if (options?.topic) body.topic = options.topic;

  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`Tavily Search API error (${response.status}): ${errBody}`);
  }

  const data = await response.json();
  // Guard the shape: Tavily returns `results: [...]`, but tolerate a missing
  // or non-array field rather than throwing in `.map`.
  const results = Array.isArray(data?.results) ? data.results : [];

  // Map Tavily's `content` (the extracted snippet) onto `description` so the
  // result shape matches Brave's SearchResult exactly — a drop-in alternative.
  return results.map((r: Record<string, unknown>) => ({
    title: (r.title as string) ?? "",
    url: (r.url as string) ?? "",
    description: (r.content as string) ?? "",
  }));
}
