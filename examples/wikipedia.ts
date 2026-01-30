export async function getSummary(page: string): Promise<string> {
  /*

curl -X 'GET' \
  'https://en.wikipedia.org/api/rest_v1/page/summary/radiohead?redirect=true' \
  -H 'accept: application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/Summary/1.4.2"'
  */

  const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page)}?redirect=true`, {
    method: 'GET',
    headers: {
      'accept': 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/Summary/1.4.2"'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      return `No summary found for page "${page}".`;
    }
    throw new Error(`Error fetching summary for page "${page}": ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.extract as string;
}

export async function getHtml(page: string): Promise<string> {
  /*

curl -X 'GET' \
  'https://en.wikipedia.org/api/rest_v1/page/summary/radiohead?redirect=true' \
  -H 'accept: application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/Summary/1.4.2"'
  */

  const response = await fetch(`https://en.wikipedia.org/api/rest_v1/page/html/${encodeURIComponent(page)}?redirect=true`, {
    method: 'GET',
    headers: {
      'accept': 'application/json; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/Summary/1.4.2"'
    }
  });

  if (!response.ok) {
    if (response.status === 404) {
      return `No HTML content found for page "${page}".`;
    }
    throw new Error(`Error fetching HTML for page "${page}": ${response.status} ${response.statusText}`);
  }

  const data = await response.text();
  return data.substring(0, 100000) as string;
}