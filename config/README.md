# Source & category configuration

This directory is the single place to configure what Veriqen ingests. No
application code changes are required to add, remove, or re-categorize a
feed.

- **`categories.json`** — the topic sections shown in navigation. Each entry
  is `{ "slug": "technology", "name": "Technology", "order": 5 }`.
- **`sources.json`** — the RSS/Atom feeds that are polled. Each entry is:

  ```json
  {
    "name": "Publisher – Section",
    "url": "https://example.com/feed.xml",
    "homepageUrl": "https://example.com",
    "categorySlug": "technology",
    "fetchIntervalMinutes": 30
  }
  ```

  `fetchIntervalMinutes` is optional (defaults to 30).

Run `npm run db:seed` after editing either file to apply the changes to the
database (existing sources are matched and updated by feed `url`; entries
removed from the file are left in the database but can be deactivated from
the admin panel). Sources can also be added, edited, paused, or removed
entirely from **Admin → Sources** at runtime without touching this file or
redeploying.

## Choosing sources

Only add feeds that are:

- Publicly published by the source specifically for syndication (an RSS/Atom
  endpoint the publisher exposes, not a scraped page).
- Fetched at a reasonable interval that respects the publisher's
  infrastructure (see `fetchIntervalMinutes`).
- Used in line with the publisher's terms — Veriqen only ever stores the
  headline, byline, publish time, a short excerpt/description already present
  in the feed, and a link back to the original article. It never fetches or
  stores full article bodies, and never bypasses paywalls, logins, or
  anti-bot protections.

The starter list intentionally favors publishers with long-standing, openly
documented RSS programs (BBC, The Guardian, NPR, major tech/science trade
press, and official public-sector feeds such as USGS and UN News). Feeds do
go stale or change URLs over time — check **Admin → Feed health** after
deploying and prune or fix anything that consistently fails.
