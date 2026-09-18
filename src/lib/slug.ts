export function slugify(input: string, maxLength = 80): string {
  const base = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return base || "story";
}

export function randomSuffix(length = 6): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length);
}
