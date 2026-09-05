# News Spotlight (`news-spotlight`)

Full-screen rotating **RSS news reader**: one story at a time with its image,
headline, and summary, cycling through your feeds. Defaults to BBC, Sky News,
The Verge, and Ars Technica.

## Options

- **RSS feeds JSON** — array of feed objects; each supports `id`, `name`,
  `url`, `category`, `priority`, `enabled`, `includeInRotation`, `maxItems`,
  and `defaultImage`.
- **Story duration** — 10–60 seconds per story.
- **Display toggles** — summary, published time, category, story counter.
- **Ken Burns motion** — slow pan/zoom on story images (off by default).
- **Breaking news mode** — high-priority items interrupt the rotation.
- **Refresh minutes** — how often feeds are re-fetched (default 15).
- **Verify SSL** — leave on unless a feed sits behind a self-signed cert.

## Notes

- Feeds are fetched through the host's app proxy with an SSRF-safe allow rule:
  public http(s) URLs only — localhost and private-range addresses are
  refused by design.
