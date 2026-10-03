import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/siteUrl";

// robots.txt is a crawl-budget courtesy, never a security boundary — every
// route listed below is also protected by its own `robots: { index: false
// }` page metadata (the signal a crawler actually needs to deindex
// something), and /admin and /api are separately enforced by real
// authentication (src/proxy.ts / src/lib/auth) regardless of what this
// file says. See SECURITY.md's threat model.
export default function robots(): MetadataRoute.Robots {
  const siteUrl = getSiteUrl();

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Each entry here is a path prefix (standard robots.txt semantics),
      // so "/admin" already covers every route under it without needing a
      // separate "/admin/*" line — same for "/api". _next/*, CSS, JS, and
      // image assets are deliberately not listed: they're required to
      // render the public pages above, so they stay allowed by default.
      disallow: ["/account", "/bookmarks", "/login", "/register", "/admin", "/api"],
    },
    sitemap: `${siteUrl}/sitemap.xml`,
  };
}
