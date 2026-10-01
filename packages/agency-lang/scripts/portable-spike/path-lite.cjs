// A small POSIX-only stand-in for node:path, enough for load-time uses.
function normalizeParts(parts, absolute) {
  const out = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") { if (out.length && out[out.length - 1] !== "..") out.pop(); else if (!absolute) out.push(".."); }
    else out.push(p);
  }
  return out;
}
function normalize(p) {
  const absolute = p.startsWith("/");
  const body = normalizeParts(p.split("/"), absolute).join("/");
  return (absolute ? "/" : "") + body || (absolute ? "/" : ".");
}
function join(...parts) { return normalize(parts.filter((p) => p !== "").join("/")); }
function resolve(...parts) {
  let resolved = "";
  for (let i = parts.length - 1; i >= 0 && !resolved.startsWith("/"); i--) resolved = parts[i] + (resolved ? "/" + resolved : "");
  if (!resolved.startsWith("/")) resolved = "/" + resolved;
  return normalize(resolved);
}
function dirname(p) { const i = p.lastIndexOf("/"); return i <= 0 ? (i === 0 ? "/" : ".") : p.slice(0, i); }
function basename(p, ext) { let b = p.slice(p.lastIndexOf("/") + 1); if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; }
function extname(p) { const b = basename(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); }
function isAbsolute(p) { return p.startsWith("/"); }
function relative(from, to) {
  const f = resolve(from).split("/").filter(Boolean); const t = resolve(to).split("/").filter(Boolean);
  let i = 0; while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...f.slice(i).map(() => ".."), ...t.slice(i)].join("/");
}
const api = { normalize, join, resolve, dirname, basename, extname, isAbsolute, relative, sep: "/", delimiter: ":" };
api.posix = api;
module.exports = api;
