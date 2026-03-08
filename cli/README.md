# md4llm CLI

CLI for converting HTML/pages to Markdown for downstream RAG/LLM ingestion.

## Scope

- Fetch URL content or read local HTML/stdin
- Convert to Markdown with optional cleanup rules
- Extract metadata (including JSON-LD)
- Batch processing
- Optional JS-rendered fetch via Playwright

## What It Is Not

- Not a crawler framework
- Not a chunking/indexing pipeline
- Not a bypass for anti-bot/login-protected content

## Install

```bash
cd cli
npm install
```

Optional JS rendering support:

```bash
npm install playwright
npx playwright install chromium
```

## Usage

```bash
md4llm [options] <input>
```

`<input>` can be:
- `https://...` URL
- local HTML file path
- `-` (stdin)

## Options

| Option | Description |
|---|---|
| `-o, --output <file>` | Output file (or directory in batch mode). Default: stdout |
| `-s, --selector <css>` | CSS selector to extract. Default: `body` |
| `-f, --format <type>` | `md` or `json`. Default: `md` |
| `--no-clean` | Disable noise cleanup |
| `--no-tables` | Disable table alignment |
| `--no-links` | Strip links |
| `--strip-media` | Remove media elements |
| `--meta` | Extract metadata |
| `--render-js` | Force browser rendering (Playwright) |
| `--render-js-auto` | Retry/fallback render for thin app-shell pages |
| `--wait-ms <n>` | Extra wait after page load in render mode |
| `--wait-selector <css>` | Wait for selector before capture |
| `--min-content-chars <n>` | Threshold for app-shell fallback |
| `--min-words <n>` | Retry render if output words are below threshold |
| `--no-smart-extract` | Disable readability/content-density fallback |
| `--no-dedupe` | Disable repeated boilerplate dedupe |
| `--batch <file>` | Process a URL list file |
| `--concurrency <n>` | Batch worker count. Default: `3` |
| `-i, --interactive` | Interactive selector drilling |
| `-q, --quiet` | Reduce logs |

## Examples

```bash
# Basic
md4llm https://example.com

# Target specific content
md4llm https://docs.python.org/3/tutorial/ -s "#content" -o tutorial.md

# JSON output with metadata
md4llm https://example.com --meta --format json

# Strip links/media for embedding-friendly text
md4llm https://example.com --no-links --strip-media

# Browser rendering fallback for JS-heavy pages
md4llm https://example.com/docs --render-js-auto

# Batch
md4llm --batch urls.txt -o ./output/

# stdin
curl -s https://example.com | md4llm -
```

## Output (JSON)

```json
{
  "markdown": "...",
  "metadata": {},
  "selector": "body",
  "stats": {
    "characters": 0,
    "words": 0,
    "lines": 0
  },
  "sourceUrl": "https://example.com",
  "timestamp": "2026-03-08T12:00:00.000Z"
}
```

## Limits

- `--render-js` requires Playwright + browser binary.
- Some sites block headless clients.
- Content quality still depends on page structure and selector choice.
