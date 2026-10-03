# Source & category configuration

This directory is the single place to configure what Veriqen News ingests. No
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
- Used in line with the publisher's terms — Veriqen News only ever stores the
  headline, byline, publish time, a short excerpt/description already present
  in the feed, and a link back to the original article. It never fetches or
  stores full article bodies, and never bypasses paywalls, logins, or
  anti-bot protections.

The starter list intentionally favors publishers with long-standing, openly
documented RSS programs (BBC, The Guardian, NPR, major tech/science trade
press, and official public-sector feeds such as USGS and UN News). Feeds do
go stale or change URLs over time — check **Admin → Feed health** after
deploying and prune or fix anything that consistently fails.

## Plans & entitlements

- **`plans.json`** — the Free/Basic/Pro subscription tiers and their
  feature/quota matrix. Each plan entry is:

  ```json
  {
    "slug": "basic",
    "name": "Basic",
    "priceCents": 499,
    "billingInterval": "month",
    "entitlements": {
      "ads_enabled": false,
      "saved_stories_limit": null,
      "ai_monthly_quota": 0
    }
  }
  ```

  Each entitlement's JSON type decides how it's stored: `true`/`false`
  becomes an on/off feature flag (`Entitlement.boolValue`); a number or
  `null` becomes a quota (`Entitlement.limitValue`, where `null` means
  unlimited). Run `npm run db:seed` after editing to apply changes —
  pricing and feature gating can change without any application code
  changes. See `prisma/seedPlans.ts` for the full list of recognized
  feature keys.

  Application code should never check a user's plan slug directly
  (`if (user.plan === "pro")`) — a centralized entitlement lookup helper
  (added in a later phase) reads these rows instead, so a plan's features
  can be changed here without touching application logic.
