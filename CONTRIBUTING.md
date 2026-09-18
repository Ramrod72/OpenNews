# Contributing to OpenNews

Thanks for considering a contribution! This project aims to stay simple to
self-host and free of mandatory paid dependencies — please keep that in
mind when proposing new features.

## Getting set up

See the **Local development** section of [README.md](./README.md). In
short: `npm install --legacy-peer-deps`, `npx prisma migrate dev`,
`npm run db:seed`, `npm run dev`, and `npm run worker` in a second terminal.

## Before opening a pull request

```bash
npm run lint
npm run format:check
npx tsc --noEmit
npm test
npm run build
```

All of the above should pass. Please add or update tests for behavioral
changes — `src/**/*.test.ts` for pure-logic unit tests, `test/*.integration.test.ts`
for anything that touches the database (these run migrations against a
temporary SQLite file automatically; no setup needed).

## Adding or changing a starter feed

Edit [`config/sources.json`](./config/sources.json) (see
[config/README.md](./config/README.md) for the format and the standard for
what feeds are appropriate to include). Please only propose feeds that are:

- Published by the source specifically for syndication (a real RSS/Atom
  endpoint, not something scraped).
- From a source you can point to a public "RSS feeds" page for.

Use the "Source suggestion" issue template if you'd rather propose one
without writing the PR yourself.

## Code style

- TypeScript, strict mode. Avoid `any`.
- Prettier handles formatting (`npm run format`) — don't hand-format.
- Prefer editing existing modules over adding new abstractions; this
  project intentionally favors a small number of well-organized files over
  many tiny ones.
- Comments should explain _why_, not _what_ — see the existing code for the
  intended style.

## Reporting security issues

Please see [SECURITY.md](./SECURITY.md) — don't open a public issue for a
vulnerability.

## What kinds of contributions are especially welcome

- Additional, well-documented public feed sources.
- Improvements to the clustering heuristic (it's intentionally simple — see
  "Known limitations" in [ARCHITECTURE.md](./ARCHITECTURE.md)).
- Accessibility improvements.
- A shared (non-in-memory) rate limiter for multi-instance deployments.
- Full-text search backends (SQLite FTS5 / Postgres `tsvector`) as an
  opt-in upgrade over the current in-memory relevance scoring.

## License

By contributing, you agree your contribution will be licensed under
whatever license the repository owner ultimately selects (see
[LICENSE](./LICENSE), currently a placeholder pending that decision).
