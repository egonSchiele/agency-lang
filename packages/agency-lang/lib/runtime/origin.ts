export function moduleIdToOrigin(moduleId: string): string {
  // stdlib/foo.agency → std::foo
  const stdlibMatch = moduleId.match(/^(?:.*\/)?stdlib\/(.+)\.agency$/);
  if (stdlibMatch) {
    return `std::${stdlibMatch[1]}`;
  }

  // node_modules/pkg-name/... → pkg::pkg-name/...
  const pkgMatch = moduleId.match(/^(?:.*\/)?node_modules\/(.+?)\/(.+)\.agency$/);
  if (pkgMatch) {
    const subpath = pkgMatch[2];
    if (subpath === "index") {
      return `pkg::${pkgMatch[1]}`;
    }
    return `pkg::${pkgMatch[1]}/${subpath}`;
  }

  // local file → ./path
  return `./${moduleId}`;
}
