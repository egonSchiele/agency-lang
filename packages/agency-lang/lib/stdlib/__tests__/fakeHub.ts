import * as http from "node:http";
import { createHash } from "node:crypto";

/** A stand-in for huggingface.co for the download tests. It answers the
 *  model API, the revision API, the tree API, `resolve/` with the same
 *  redirect shapes the real Hub uses (a relative hop, then an absolute one
 *  to a signed CDN URL), and the CDN with byte ranges. */

export type FakeFile = { path: string; bytes: Buffer };

export type FakeHub = {
  baseUrl: string;
  /** The same server by another host name, standing in for the CDN. */
  cdnUrl: string;
  sha: string;
  /** "<path> <start>-<end>" -> how many times that range was fetched. */
  rangeHits: Record<string, number>;
  /** Authorization header values seen per route. */
  authSeen: { api: string[]; resolve: string[]; cdn: string[] };
  /** How many of the next resolve/ requests answer 403. */
  failResolves: number;
  /** Next CDN request answers 403 once, as an expired signature does. */
  expireNextCdn: boolean;
  close: () => Promise<void>;
};

export type FakeHubOptions = {
  gated?: boolean;
  sha?: string;
  treePageSize?: number;
  /** Serve non-LFS files from `resolve/` itself with a 200, as the real
   *  Hub does, instead of redirecting to the CDN. */
  directBlobs?: boolean;
};

/** Files at or above this size get an LFS entry with a sha256, as on the
 *  real Hub, where small text files are plain git blobs. */
export const LFS_THRESHOLD = 1000;

export function sha256hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type TreeEntry = {
  type: "file" | "directory";
  path: string;
  size: number;
  lfs?: { oid: string; size: number };
};

function treeEntries(files: FakeFile[]): TreeEntry[] {
  const dirs: string[] = [];
  const out: TreeEntry[] = [];
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!dirs.includes(dir)) {
        dirs.push(dir);
        out.push({ type: "directory", path: dir, size: 0 });
      }
    }
    const entry: TreeEntry = { type: "file", path: f.path, size: f.bytes.length };
    if (f.bytes.length >= LFS_THRESHOLD) {
      entry.lfs = { oid: sha256hex(f.bytes), size: f.bytes.length };
    }
    out.push(entry);
  }
  return out;
}

export function startFakeHub(
  repo: string,
  files: FakeFile[],
  opts: FakeHubOptions = {},
): Promise<FakeHub> {
  const sha = opts.sha ?? "7b9321eabb85ce79625cac3f61ea691e4ea984b5";
  const hub: FakeHub = {
    baseUrl: "",
    cdnUrl: "",
    sha,
    rangeHits: {},
    authSeen: { api: [], resolve: [], cdn: [] },
    failResolves: 0,
    expireNextCdn: false,
    close: () => Promise.resolve(),
  };
  const entries = treeEntries(files);
  const byPath: Record<string, Buffer> = {};
  for (const f of files) {
    byPath[f.path] = f.bytes;
  }
  const json = (
    res: http.ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    const auth = req.headers.authorization;
    const p = url.pathname;

    if (p === `/api/models/${repo}`) {
      hub.authSeen.api.push(auth ?? "");
      json(res, 200, { id: repo, sha, gated: opts.gated === true ? "auto" : false });
      return;
    }
    const revision = p.match(new RegExp(`^/api/models/${repo}/revision/([^/]+)$`));
    if (revision !== null) {
      hub.authSeen.api.push(auth ?? "");
      if (sha.startsWith(revision[1])) {
        json(res, 200, { id: repo, sha, gated: opts.gated === true ? "auto" : false });
      } else {
        json(res, 404, { error: "Revision Not Found" });
      }
      return;
    }
    const tree = p.match(new RegExp(`^/api/models/${repo}/tree/([^/]+)$`));
    if (tree !== null) {
      hub.authSeen.api.push(auth ?? "");
      if (!sha.startsWith(tree[1]) && tree[1] !== "main") {
        json(res, 404, { error: "Revision Not Found" });
        return;
      }
      const pageSize = opts.treePageSize ?? entries.length;
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const page = entries.slice(start, start + pageSize);
      const headers: Record<string, string> = {};
      if (start + pageSize < entries.length) {
        const next = new URL(url.toString());
        next.searchParams.set("cursor", String(start + pageSize));
        headers.link = `<${hub.baseUrl}${next.pathname}${next.search}>; rel="next"`;
      }
      json(res, 200, page, headers);
      return;
    }
    const resolve = p.match(new RegExp(`^/${repo}/resolve/([^/]+)/(.+)$`));
    if (resolve !== null) {
      hub.authSeen.resolve.push(auth ?? "");
      if (opts.gated === true && auth === undefined) {
        json(res, 401, { error: "Access to this resource is gated." });
        return;
      }
      if (hub.failResolves > 0) {
        hub.failResolves -= 1;
        json(res, 403, { error: "forbidden" });
        return;
      }
      if (byPath[resolve[2]] === undefined) {
        json(res, 404, { error: "Entry not found" });
        return;
      }
      if (opts.directBlobs === true && byPath[resolve[2]].length < LFS_THRESHOLD) {
        serveBytes(hub, req, res, resolve[2], byPath[resolve[2]]);
        return;
      }
      // Relative hop, as the real Hub does for small files.
      res.writeHead(302, { location: `/cache/${resolve[2]}` });
      res.end();
      return;
    }
    if (p.startsWith("/cache/")) {
      const file = p.slice("/cache/".length);
      // A different host than the hub, as the real CDN is, so the tests can
      // see that the token stops at the hub.
      res.writeHead(302, { location: `${hub.cdnUrl}/cdn/${file}?sig=1` });
      res.end();
      return;
    }
    if (p.startsWith("/cdn/")) {
      const file = p.slice("/cdn/".length);
      hub.authSeen.cdn.push(auth ?? "");
      const bytes = byPath[file];
      if (bytes === undefined) {
        json(res, 404, { error: "no such object" });
        return;
      }
      if (hub.expireNextCdn) {
        hub.expireNextCdn = false;
        json(res, 403, { error: "Request has expired" });
        return;
      }
      serveBytes(hub, req, res, file, bytes);
      return;
    }
    json(res, 404, { error: `fake hub: no route for ${p}` });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      hub.baseUrl = `http://127.0.0.1:${port}`;
      hub.cdnUrl = `http://localhost:${port}`;
      hub.close = () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        });
      resolve(hub);
    });
  });
}

/** The whole file, or the requested range with a 206, counted in `rangeHits`. */
function serveBytes(
  hub: FakeHub,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
  bytes: Buffer,
): void {
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
  if (range === undefined || range === null) {
    res.writeHead(200, { "content-length": String(bytes.length) });
    res.end(req.method === "HEAD" ? undefined : bytes);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(Number(range[2]), bytes.length - 1);
  const key = `${file} ${start}-${end}`;
  hub.rangeHits[key] = (hub.rangeHits[key] ?? 0) + 1;
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${bytes.length}`,
    "content-length": String(end - start + 1),
  });
  res.end(bytes.subarray(start, end + 1));
}
