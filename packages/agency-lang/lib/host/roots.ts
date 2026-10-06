// The inside of a `Root`. A root is a directory an approval named, spelled
// the way file effects spell their payloads: realpathed once, by `root` in
// nodeFiles.ts or by the host that made it. Every file operation on the
// host takes one; nothing takes a bare string root.
//
// Only files under lib/host may read `real`. Everything else asks the
// host for a path (`resolvePath`) or for the operation it wants. The lint
// rule in eslint.config.js refuses `.real` outside this directory. This
// file imports no Node module, so every host can make a Root.

/** A directory an approval named, realpathed once. */
export type Root = { real: string };

/** The path inside a root. For files under lib/host. */
export function rootPath(root: Root): string {
  return root.real;
}
