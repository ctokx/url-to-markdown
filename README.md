# URL to Markdown

Convert webpage HTML into Markdown that is easier to use in RAG/LLM pipelines.

This repo has two parts:
- Web app (`index.html`) for manual conversion
- CLI (`cli/`) for scripted and batch workflows

## What It Does

- Converts HTML to Markdown (Turndown + GFM)
- Supports CSS selector targeting (`--selector` / selector input)
- Cleans common page noise (ads, nav, cookie banners, hidden elements)
- Optional media stripping with context placeholders
- Optional link stripping
- Table normalization/alignment
- Code fence language detection from HTML classes
- Metadata extraction (title/meta tags/canonical/Open Graph/Twitter + JSON-LD)
- Basic boilerplate dedupe in output
- Smart content fallback when converting full `body`

## Current Limits (Important)

- Web app fetching relies on public CORS proxies.
- Web app cannot reliably handle many JS-rendered, anti-bot, or authenticated pages.
- CLI `--render-js` needs Playwright installed and a browser binary available.
- This project does not do chunking, embedding, retrieval, or vector indexing.

## Quick Start

### Web App

Open `index.html` directly, or serve locally:

```bash
python -m http.server 8000
```

Then open `http://localhost:8000`.

### CLI

```bash
cd cli
npm install
node bin/md4llm.js https://example.com
```

Optional JS-render support:

```bash
npm install playwright
npx playwright install chromium
```

## CLI Examples

```bash
# Basic conversion
md4llm https://example.com

# Extract only article content
md4llm https://example.com -s "article" -o output.md

# JSON output with metadata
md4llm https://example.com --meta --format json

# Strip links and media for cleaner embeddings
md4llm https://example.com --no-links --strip-media

# Batch mode
md4llm --batch urls.txt -o ./output/

# Use browser rendering for JS-heavy pages
md4llm https://example.com/docs --render-js-auto
```

## Web Options

- `Align Tables`
- `Strip Media`
- `Smart Clean`
- `Extract Meta`
- `Keep Links`

## Keyboard Shortcuts (Web)

- `Ctrl+Enter`: Convert
- `Ctrl+Shift+C`: Copy output
- `Ctrl+Shift+F`: Fetch URL
- `Ctrl+Shift+X`: Clear input
- `?`: Show help
- `Esc`: Close modal

## Output Shape (JSON)

```json
{
  "markdown": "...",
  "metadata": {},
  "sourceUrl": "https://example.com/page",
  "selector": "article",
  "timestamp": "2026-03-08T12:00:00.000Z",
  "options": {},
  "stats": {
    "characters": 0,
    "words": 0,
    "lines": 0
  }
}
```

## RAG/LLM Use (Minimal Guidance)

Typical flow:
1. Convert page(s) to Markdown with relevant selector/options.
2. Normalize/chunk in your ingestion pipeline.
3. Store chunks + metadata in your retrieval store.

## Next Steps

1. Add golden-fixture regression tests with real pages (docs/blogs/forums/tables-heavy pages).
2. Add a `--chunk` mode in CLI (size/overlap/token-estimate) for direct ingestion prep.
3. Add a first-party fetch service for the web app (replace public CORS proxies).
4. Add quality scoring in JSON output (content ratio, link density, boilerplate ratio).
5. Add deterministic normalization profiles (`strict`, `balanced`, `raw`) for different training/indexing use cases.

## Project Layout

```text
index.html
app.html
css/main.css
js/app.js
js/config.js
cli/
```

## License

MIT
