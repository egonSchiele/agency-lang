// std::http — fetch helpers available to every Waypoint program.
export async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  return response.json();
}
