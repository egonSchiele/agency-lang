// genModelHashes — mint pinned SHA-256 hashes for the curated models from
// Hugging Face's X-Linked-ETag header (= the file's content sha256). This
// script is the source of truth; the sha256 values committed in
// CURATED_LOCAL_MODELS and data/model-catalog.json are a snapshot — re-run it
// whenever an upstream repo re-uploads a file and the pin changes.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CURATED_LOCAL_MODELS } from "../lib/stdlib/localModels.js";

/** Split `hf:user/repo:quant` (the curated short form). Returns null for the
 *  file-form (`hf:user/repo/file.gguf`), https, or local paths. */
export function parseHfUri(uri: string): { user: string; repo: string; quant: string } | null {
  const m = /^hf:([^/]+)\/([^/:]+):([^/]+)$/.exec(uri);
  if (!m) return null;
  return { user: m[1], repo: m[2], quant: m[3] };
}

/** The lone `.gguf` whose name contains `quant`; null if zero or many (a sharded
 *  model has many → we record no pin for it). */
export function pickSingleQuantFile(files: string[], quant: string): string | null {
  const matches = files.filter((f) => f.endsWith(".gguf") && f.includes(quant));
  return matches.length === 1 ? matches[0] : null;
}

async function repoFiles(user: string, repo: string): Promise<string[]> {
  const res = await fetch(`https://huggingface.co/api/models/${user}/${repo}`);
  if (!res.ok) throw new Error(`HF API ${res.status} for ${user}/${repo}`);
  const json = (await res.json()) as { siblings?: { rfilename: string }[] };
  return (json.siblings ?? []).map((s) => s.rfilename);
}

/** HEAD the resolve URL and read X-Linked-ETag (= the file's content sha256).
 *  Uses `redirect: "manual"` because the header lives on huggingface.co's 302
 *  to the CDN, not the final CDN response. NEVER use `etag`/`x-xet-hash` (a
 *  different chunk hash). */
async function fetchSha256(user: string, repo: string, file: string): Promise<string | null> {
  // Encode per path segment so a subdir in `rfilename` (e.g. `gguf/model.gguf`)
  // keeps its slashes — `encodeURIComponent` on the whole path would break it.
  const encodedFile = file.split("/").map(encodeURIComponent).join("/");
  const url = `https://huggingface.co/${user}/${repo}/resolve/main/${encodedFile}`;
  const res = await fetch(url, { method: "HEAD", redirect: "manual" });
  const etag = res.headers.get("x-linked-etag");
  if (!etag) return null;
  return etag.replace(/"/g, "");
}

async function main(): Promise<void> {
  const out: Record<string, string> = {};
  for (const [name, info] of Object.entries(CURATED_LOCAL_MODELS)) {
    const parsed = parseHfUri(info.uri);
    if (!parsed) {
      console.warn(`skip ${name}: not an hf:user/repo:quant uri`);
      continue;
    }
    const files = await repoFiles(parsed.user, parsed.repo);
    const file = pickSingleQuantFile(files, parsed.quant);
    if (!file) {
      console.warn(`skip ${name}: not a single-file ${parsed.quant} gguf (sharded?)`);
      continue;
    }
    const sha = await fetchSha256(parsed.user, parsed.repo, file);
    if (!sha) {
      console.warn(`skip ${name}: no X-Linked-ETag`);
      continue;
    }
    out[name] = sha;
    console.log(`${name}: ${sha}`);
  }

  // Rewrite the seed catalog with the new sha256 values. Resolved from cwd
  // (run this script from the `packages/agency-lang` directory) so it edits the
  // SOURCE data file whether run from `dist/` or via tsx.
  const catalogPath = path.resolve("data/model-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  for (const [name, sha] of Object.entries(out)) {
    if (catalog.models[name]) catalog.models[name].sha256 = sha;
  }
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + "\n");

  console.log("\n--- paste these into CURATED_LOCAL_MODELS ---");
  for (const [name, sha] of Object.entries(out)) console.log(`  ${name}: sha256 "${sha}"`);
}

// Run only when invoked directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
