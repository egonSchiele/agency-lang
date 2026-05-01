const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export type BraveSearchResult = {
  title: string;
  url: string;
  description: string;
};

export type BraveSearchOptions = {
  apiKey?: string;
  count?: number;
  country?: string;
  searchLang?: string;
  safesearch?: string;
  freshness?: string;
};

export async function braveSearch(
  query: string,
  options?: BraveSearchOptions
): Promise<BraveSearchResult[]> {
  // Note: using || (not ??) so empty strings from Agency defaults fall through to env var
  const apiKey = options?.apiKey || process.env.BRAVE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing Brave Search API key. Set BRAVE_API_KEY env var or pass apiKey option."
    );
  }

  const url = new URL(BRAVE_SEARCH_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options?.count ?? 5));

  if (options?.country) url.searchParams.set("country", options.country);
  if (options?.searchLang) url.searchParams.set("search_lang", options.searchLang);
  if (options?.safesearch) url.searchParams.set("safesearch", options.safesearch);
  if (options?.freshness) url.searchParams.set("freshness", options.freshness);

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
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
