export async function _search(
  query: string,
  limit: number = 5,
): Promise<{ title: string; description: string; excerpt: string }[]> {
  const url = `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${limit}`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Wikipedia search failed for "${query}": ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  return (data.pages ?? []).map(
    (page: { title: string; description: string; excerpt: string }) => ({
      title: page.title ?? "",
      description: page.description ?? "",
      excerpt: (page.excerpt ?? "").replace(/<[^>]*>/g, ""),
    }),
  );
}

export async function _summary(title: string): Promise<{
  title: string;
  description: string;
  extract: string;
  url: string;
}> {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Wikipedia summary failed for "${title}": ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  return {
    title: data.title ?? "",
    description: data.description ?? "",
    extract: data.extract ?? "",
    url: data.content_urls?.desktop?.page ?? "",
  };
}

export async function _article(
  title: string,
): Promise<{ title: string; text: string; url: string }> {
  const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=true&titles=${encodeURIComponent(title)}&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Wikipedia article failed for "${title}": ${response.status} ${response.statusText}`,
    );
  }
  const data = await response.json();
  const pages = data.query?.pages ?? {};
  const pageId = Object.keys(pages)[0];
  if (!pageId || pageId === "-1") {
    throw new Error(`Wikipedia article not found: "${title}"`);
  }
  const page = pages[pageId];
  return {
    title: page.title ?? "",
    text: page.extract ?? "",
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent((page.title ?? title).replace(/ /g, "_"))}`,
  };
}
