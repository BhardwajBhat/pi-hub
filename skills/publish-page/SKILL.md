---
name: publish-page
description: Make a web page (report, chart, dashboard, diagram, comparison, small interactive tool) and publish it with the publish_page tool so the user gets a link to open on their phone or share. Use when the user asks for something to look at, a page, an artifact, a visual summary, or to publish/share HTML.
---

# Publishing pages

The user follows pi from a phone or browser through pi rc. `publish_page` uploads an
`.html` file or a folder with `index.html` to their relay and returns a link. Pages
are public to anyone with the link and run sandboxed.

## Workflow

1. **Where to write.** Unless the user wants the page in the project, write it under
   `~/.local/share/pi-rc/pages/<short-slug>/index.html` so the repo stays clean.
   Keep using the same path for the same page: republishing a path updates its link.
2. **Build it** (see below). Prefer one self-contained `index.html`; use a folder only
   when there are images or large data files. Copy any images the page needs into the
   folder and reference them with relative paths.
3. **Check before publishing.** The link is public. Do not include secrets, API keys,
   tokens, `.env` contents or personal data. If the page must contain something
   private, ask the user first.
4. **Publish** with `publish_page` (`path`, short `title`). Use `new_link: true` only
   when the user wants a separate copy, e.g. to keep the old version.
5. **Reply** with the link and one line on what the page shows. Don't repeat its content.

## Building a good page

Start from `assets/template.html` (relative to this skill) and keep its look: it
matches the pi rc web page the user reads pi in. Plain and quiet: system font, black
on white (white on black in dark mode, automatically), thin grey lines, small dim
lowercase section labels, no cards, shadows, gradients, rounded boxes or accent
colors. Use `currentColor` and the template's `--dim` / `--line` / `--code` variables;
if a chart needs several series, tell them apart with dashes or dim grey before
reaching for color, and keep any color muted.

- **Phone first.** The user will usually open it on a phone: one column, no fixed
  widths, tap targets ≥ 40px, wide tables wrapped in a horizontal scroller.
- **Content first.** Title, a one-paragraph summary of the takeaway, then detail.
  Real data from the project, not placeholders. Label units and axes.
- **Charts.** For a few series, inline SVG written directly is simplest and needs no
  network. For heavier charts, a pinned CDN build is fine, e.g.
  `https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js`.
- **Data.** Embed small data as JSON in a `<script type="application/json" id="data">`
  tag. Larger data goes in a file in the folder, loaded with `fetch('data.json')`.
- **Both color schemes.** Only use the template's variables and `currentColor`, so dark mode works.

## What does not work in a published page

- `localStorage`, `sessionStorage`, IndexedDB and cookies throw (sandboxed origin).
  Keep state in memory; it resets on reload.
- No access to the user's machine: `localhost`, the project's dev server and files
  outside the published folder are unreachable. Bake the data into the page.
- Absolute paths (`/style.css`) break; use relative ones (`style.css`).
- It is a snapshot. To change it, edit the files and publish the same path again.
