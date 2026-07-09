/** Turn a URL into a filesystem-safe slug for screenshot filenames. */
export function slugForUrl(url: string): string {
  let path = url;
  try {
    const u = new URL(url);
    path = u.pathname + (u.search ? u.search : "");
  } catch {
    /* use raw */
  }
  const slug = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "index";
}

/** Make a slug unique within a set, appending -2, -3, … on collision. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  taken.add(slug);
  return slug;
}
