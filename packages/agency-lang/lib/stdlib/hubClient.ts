/** The Hugging Face Hub as three requests: the snapshot (commit sha and
 *  file list), the signed CDN URL for one file, and one byte range of it.
 *  Every request leaves through `request`, which refuses a URL that is
 *  not https and sends the token to the hub host only. */

export const DEFAULT_HUB_URL = "https://huggingface.co";

export const GATED_MESSAGE =
  "This repo is gated. Set HF_TOKEN to a Hugging Face token that has accepted its terms.";

import { RECORD_FILE } from "./mlxModelRecord.js";

const MAX_REDIRECTS = 5;

export type HubFile = { path: string; size: number; sha256?: string };
export type HubSnapshot = { repo: string; revision: string; files: HubFile[] };

export type HubOptions = {
  hubUrl?: string;
  token?: string;
  fetch?: typeof fetch;
  /** Tests run a fake hub over http. Nothing else sets this. */
  allowHttp?: boolean;
  /** A range request that delivers no bytes for this long is abandoned
   *  and retried. Default one minute. */
  stallTimeoutMs?: number;
};

export type Chunk = { path: string; index: number; start: number; end: number };

/** Thrown when the CDN refuses a signed URL, which is what an expired
 *  signature looks like. The caller resolves the file again. */
export class Expired extends Error {}

type TreeEntry = { type: string; path: string; size: number; lfs?: { oid: string } };

const DEFAULT_STALL_MS = 60_000;

export class HubClient {
  private readonly hubUrl: string;
  private readonly hubHost: string;

  constructor(private readonly options: HubOptions = {}) {
    this.hubUrl = (options.hubUrl ?? DEFAULT_HUB_URL).replace(/\/+$/, "");
    this.requireHttps(this.hubUrl);
    this.hubHost = new URL(this.hubUrl).host;
  }

  /** The commit and the file list, with a size for every file and a
   *  sha256 for every LFS file. `revision` defaults to `main`; a given
   *  one may be a short sha. Gated repos need `token`. */
  async fetchSnapshot(repo: string, revision: string | undefined): Promise<HubSnapshot> {
    const modelUrl =
      revision === undefined
        ? `${this.hubUrl}/api/models/${repo}`
        : `${this.hubUrl}/api/models/${repo}/revision/${encodeURIComponent(revision)}`;
    const info = (await this.json(modelUrl)).body as { sha: string; gated?: unknown };
    if (info.gated !== undefined && info.gated !== false && !this.hasToken()) {
      throw new Error(GATED_MESSAGE);
    }
    const entries = await this.fetchTree(
      `${this.hubUrl}/api/models/${repo}/tree/${info.sha}?recursive=true`,
    );
    const files: HubFile[] = entries
      .filter((e) => e.type === "file")
      .map((e) =>
        e.lfs === undefined
          ? { path: e.path, size: e.size }
          : { path: e.path, size: e.size, sha256: e.lfs.oid },
      );
    const seen: Record<string, string> = Object.create(null);
    for (const file of files) {
      if (isReservedPath(file.path)) {
        throw new Error(
          `${repo} contains ${file.path}, a name the downloader keeps for itself. It cannot be downloaded with agency local download.`,
        );
      }
      // Two paths that a case-insensitive disk would store as one file.
      const key = file.path.normalize("NFC").toLowerCase();
      if (seen[key] !== undefined) {
        throw new Error(
          `${repo} contains both ${seen[key]} and ${file.path}, which are one file on a case-insensitive disk. It cannot be downloaded with agency local download.`,
        );
      }
      seen[key] = file.path;
    }
    return { repo, revision: info.sha, files };
  }

  /** Follows `resolve/` to the URL a file's bytes come from. Each hop is
   *  resolved against the URL it came from, since the Hub sends relative
   *  locations. The walk stops at the first URL off the hub host, which
   *  is the signed CDN URL, or at a 200 from the hub itself, which is how
   *  it serves a small non-LFS file. */
  async resolveFileUrl(snapshot: HubSnapshot, filePath: string): Promise<string> {
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    let url = `${this.hubUrl}/${snapshot.repo}/resolve/${snapshot.revision}/${encodedPath}`;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.request(url, { method: "HEAD" });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location !== null) {
        url = new URL(location, url).toString();
        if (new URL(url).host !== this.hubHost) {
          this.requireHttps(url);
          return url;
        }
        continue;
      }
      if (res.ok) {
        return url;
      }
      throw new Error(`${url} answered ${res.status} while resolving ${filePath}`);
    }
    throw new Error(`Too many redirects while resolving ${filePath}`);
  }

  /** Streams one byte range of a file to `sink`, a piece at a time, and
   *  checks the server's idea of the file size and the range against the
   *  tree. Throws `Expired` on a 403. */
  async fetchRange(
    url: string,
    chunk: Chunk,
    size: number,
    sink: (piece: Uint8Array) => void,
  ): Promise<void> {
    const stall = new StallTimer(this.options.stallTimeoutMs ?? DEFAULT_STALL_MS);
    let received = 0;
    try {
      const res = await this.request(url, {
        headers: { range: `bytes=${chunk.start}-${chunk.end - 1}` },
        signal: stall.signal,
      });
      if (res.status === 403) {
        throw new Expired(`${chunk.path}: the CDN URL was refused`);
      }
      if (res.status !== 206) {
        throw new Error(`${chunk.path}: expected 206 for a byte range, got ${res.status}`);
      }
      const want = `bytes ${chunk.start}-${chunk.end - 1}/${size}`;
      const got = res.headers.get("content-range") ?? "none";
      if (got !== want) {
        throw new Error(`${chunk.path}: asked for ${want}, the server sent ${got}`);
      }
      if (res.body !== null) {
        const want = chunk.end - chunk.start;
        for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
          stall.touch();
          if (received + piece.length > want) {
            throw new Error(`${chunk.path}: the server sent more than the ${want} bytes asked for`);
          }
          sink(piece);
          received += piece.length;
        }
      }
    } catch (err) {
      throw stall.tripped ? new Error(`${chunk.path}: ${stall.reason()}`) : err;
    } finally {
      stall.stop();
    }
    if (received !== chunk.end - chunk.start) {
      throw new Error(
        `${chunk.path}: got ${received} bytes for a ${chunk.end - chunk.start}-byte range`,
      );
    }
  }

  private hasToken(): boolean {
    return this.options.token !== undefined && this.options.token !== "";
  }

  /** Every request goes through here. Refuses http, attaches the token
   *  when the URL is on the hub host, and turns a 401 or 403 into a
   *  message that says whether a token was sent. Redirects are never
   *  followed by `fetch` itself, so no hop can skip the https check;
   *  `resolveFileUrl` walks its own. */
  private async request(url: string, init: RequestInit): Promise<Response> {
    this.requireHttps(url);
    const fetchFn = this.options.fetch ?? fetch;
    const onHub = new URL(url).host === this.hubHost;
    const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
    if (onHub && this.hasToken()) {
      headers.authorization = `Bearer ${this.options.token}`;
    }
    const res = await fetchFn(url, { ...init, headers, redirect: "manual" });
    if (onHub && (res.status === 401 || res.status === 403)) {
      throw new Error(deniedMessage(url, res.status, this.hasToken()));
    }
    return res;
  }

  private async json(url: string): Promise<{ body: unknown; link: string | null }> {
    const res = await this.request(url, {});
    if (!res.ok) {
      throw new Error(`${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return { body: await res.json(), link: res.headers.get("link") };
  }

  /** Follows the `Link: <…>; rel="next"` header the tree API sends for a
   *  repo with more entries than one page holds. */
  private async fetchTree(url: string): Promise<TreeEntry[]> {
    const out: TreeEntry[] = [];
    let next: string | null = url;
    while (next !== null) {
      const page = await this.json(next);
      out.push(...(page.body as TreeEntry[]));
      const m = page.link?.match(/<([^>]+)>;\s*rel="next"/);
      next = m === undefined || m === null ? null : new URL(m[1], next).toString();
    }
    return out;
  }

  private requireHttps(url: string): void {
    if (this.options.allowHttp === true) {
      return;
    }
    if (!url.startsWith("https://")) {
      throw new Error(`Refusing to download over ${new URL(url).protocol.slice(0, -1)}: ${url}`);
    }
  }
}

/** The downloader writes its record as `.agency-model.json` and moves a
 *  file that fails its hash to `<file>.invalidSha`. A repo file with
 *  either name would collide with those, so such a repo is refused.
 *  Case is ignored, for case-insensitive filesystems. */
export function isReservedPath(filePath: string): boolean {
  const name = filePath.split("/").pop()?.toLowerCase() ?? "";
  return name === RECORD_FILE.toLowerCase() || name.endsWith(".invalidsha");
}

function deniedMessage(url: string, status: number, tokenSent: boolean): string {
  const hint = tokenSent
    ? "Check HF_TOKEN: the token may be revoked, or its account may not have accepted this repo's terms."
    : "The repo may be private or gated. Set HF_TOKEN to a token that can read it.";
  return `${url} answered ${status}. ${hint}`;
}

/** Aborts a request that goes quiet. The timer restarts on every piece
 *  of the body, so only a connection that has stopped delivering trips it. */
class StallTimer {
  readonly signal: AbortSignal;
  tripped = false;
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout;

  constructor(private readonly ms: number) {
    this.signal = this.controller.signal;
    this.timer = this.arm();
  }

  touch(): void {
    clearTimeout(this.timer);
    this.timer = this.arm();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  reason(): string {
    return `no data for ${Math.round(this.ms / 1000)}s`;
  }

  private arm(): NodeJS.Timeout {
    return setTimeout(() => {
      this.tripped = true;
      this.controller.abort();
    }, this.ms);
  }
}

/** The snapshot for a repo, for callers that need nothing else from the hub. */
export async function fetchHubSnapshot(
  repo: string,
  revision: string | undefined,
  options: HubOptions = {},
): Promise<HubSnapshot> {
  return await new HubClient(options).fetchSnapshot(repo, revision);
}
