/** Turns a page title into a URL slug. */
export function slugify(title: string): string {
  let slug = "";
  try {
    slug = title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  } catch (e) {
    // some titles are weird
  }
  return slug;
}
