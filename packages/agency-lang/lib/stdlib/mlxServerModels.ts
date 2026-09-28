import { readClientConfig } from "./localModels.js";

/** Where the MLX server listens unless `MLX_BASE_URL` or
 *  `client.baseUrl.mlx` says otherwise. The same default smoltalk's `mlx`
 *  provider uses. */
export const MLX_DEFAULT_BASE_URL = "http://127.0.0.1:8080/v1";

/** An explicit URL, then `client.baseUrl.mlx`, then `MLX_BASE_URL`, then the
 *  default. The same order smoltalk's `mlx` provider uses. */
export function mlxBaseUrl(explicit: string = ""): string {
  if (explicit !== "") {
    return explicit;
  }
  const configured = readClientConfig().baseUrl?.mlx;
  if (typeof configured === "string" && configured !== "") {
    return configured;
  }
  return process.env.MLX_BASE_URL || MLX_DEFAULT_BASE_URL;
}

/** The models the server at `baseUrl` serves, or null if nothing answers.
 *  An empty baseUrl means the mlx provider's default. */
export async function _mlxServerModels(baseUrl: string = ""): Promise<string[] | null> {
  try {
    const res = await fetch(`${mlxBaseUrl(baseUrl)}/models`);
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { data?: { id: string }[] };
    return (body.data ?? []).map((m) => m.id);
  } catch {
    return null;
  }
}

/** Whether a failed request's message means nothing is listening at the
 *  server's address: the refused connection the OpenAI SDK and fetch each
 *  describe in their own words. */
export function isNoServerError(error: string): boolean {
  return /connection error|ECONNREFUSED|fetch failed/i.test(error);
}
