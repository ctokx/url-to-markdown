const CORS_PROXIES = [
    'https://api.allorigins.win/raw?url=',
    'https://corsproxy.io/?',
    'https://api.codetabs.com/v1/proxy?quest='
];

let currentProxyIndex = 0;
let conversionResult = null;
let extractedSelectors = { ids: [], classes: [], tags: [] };
let currentFilter = 'all';
let lastUsedSelector = 'body';
let originalDocHead = null;

// Drill mode state (simplified)
let currentDrillParent = null; // Current parent selector for showing children
let drillOriginalHtml = null;

function normalizeTextArtifacts(text) {
    if (!text || typeof text !== 'string') return text;

    let normalized = text;
    const replacements = [
        ['Â©', '©'],
        ['Â®', '®'],
        ['Â°', '°'],
        ['Â·', '·'],
        ['Â', ''],
        ['â€™', '’'],
        ['â€˜', '‘'],
        ['â€œ', '“'],
        ['â€', '”'],
        ['â€“', '–'],
        ['â€”', '—'],
        ['â€¦', '…'],
        ['â€¢', '•'],
        ['â„¢', '™']
    ];

    for (const [bad, good] of replacements) {
        normalized = normalized.split(bad).join(good);
    }

    return normalized;
}

function sanitizeInlineText(text) {
    if (!text) return '';
    return normalizeTextArtifacts(text)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function detectDynamicShell(html) {
    const textLength = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;

    if (textLength > 1200) return false;

    const signals = [
        /id=["']__next["']/i,
        /id=["']__nuxt["']/i,
        /id=["']root["']/i,
        /data-reactroot/i,
        /webpack/i,
        /chunk[-_.]/i,
        /<script[^>]+type=["']module["']/i
    ];

    return signals.some(pattern => pattern.test(html));
}

function extractCodeLanguage(node) {
    if (!node) return '';

    const classNames = [
        node.className || '',
        node.getAttribute ? (node.getAttribute('class') || '') : '',
        node.getAttribute ? (node.getAttribute('data-language') || '') : ''
    ].join(' ');

    const patterns = [
        /(?:^|\s)language-([a-z0-9_+-]+)(?:\s|$)/i,
        /(?:^|\s)lang-([a-z0-9_+-]+)(?:\s|$)/i,
        /(?:^|\s)brush:\s*([a-z0-9_+-]+)(?:\s|$)/i
    ];

    for (const pattern of patterns) {
        const match = classNames.match(pattern);
        if (match && match[1]) return match[1].toLowerCase();
    }

    return '';
}

function escapeTableCell(text) {
    return sanitizeInlineText(text).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function buildTableMatrix(tableNode) {
    const rows = Array.from(tableNode.querySelectorAll('tr'));
    const matrix = [];
    const spans = new Map();
    let maxCols = 0;

    rows.forEach((tr, rowIndex) => {
        if (!matrix[rowIndex]) matrix[rowIndex] = [];
        let colIndex = 0;

        const placeSpans = () => {
            while (spans.has(`${rowIndex},${colIndex}`)) {
                matrix[rowIndex][colIndex] = spans.get(`${rowIndex},${colIndex}`);
                spans.delete(`${rowIndex},${colIndex}`);
                colIndex += 1;
            }
        };

        placeSpans();

        const cells = Array.from(tr.children).filter(node => node.tagName === 'TD' || node.tagName === 'TH');

        cells.forEach(cell => {
            placeSpans();

            const cellText = escapeTableCell(cell.textContent || '');
            const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
            const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);

            for (let r = 0; r < rowspan; r++) {
                const targetRow = rowIndex + r;
                if (!matrix[targetRow]) matrix[targetRow] = [];

                for (let c = 0; c < colspan; c++) {
                    const targetCol = colIndex + c;
                    if (r === 0) {
                        matrix[targetRow][targetCol] = cellText;
                    } else {
                        spans.set(`${targetRow},${targetCol}`, '');
                    }
                }
            }

            colIndex += colspan;
            placeSpans();
        });

        while (spans.has(`${rowIndex},${colIndex}`)) {
            matrix[rowIndex][colIndex] = spans.get(`${rowIndex},${colIndex}`);
            spans.delete(`${rowIndex},${colIndex}`);
            colIndex += 1;
        }

        maxCols = Math.max(maxCols, matrix[rowIndex].length);
    });

    matrix.forEach(row => {
        while (row.length < maxCols) row.push('');
    });

    return matrix.filter(row => row.some(cell => (cell || '').trim().length > 0));
}

function tableToMarkdown(tableNode) {
    const matrix = buildTableMatrix(tableNode);
    if (matrix.length === 0) return '';

    const firstRow = tableNode.querySelector('tr');
    const hasHeaderRow = !!(firstRow && firstRow.querySelector('th'));
    const header = hasHeaderRow ? matrix[0] : matrix[0].map((_, i) => `Column ${i + 1}`);
    const bodyRows = hasHeaderRow ? matrix.slice(1) : matrix;

    const colWidths = header.map((_, col) => {
        const values = [header[col], ...bodyRows.map(row => row[col] || '')];
        return Math.max(3, ...values.map(v => (v || '').length));
    });

    const renderRow = (row) => `| ${row.map((cell, i) => (cell || '').padEnd(colWidths[i], ' ')).join(' | ')} |`;
    const lines = [
        renderRow(header),
        `| ${colWidths.map(width => '-'.repeat(width)).join(' | ')} |`,
        ...bodyRows.map(renderRow)
    ];

    return `\n\n${lines.join('\n')}\n\n`;
}

function dedupeMarkdownBoilerplate(markdown) {
    const lines = markdown.split('\n');
    const deduped = [];
    const counts = new Map();
    let previous = null;
    let inCodeFence = false;

    for (const line of lines) {
        const trimmed = line.trim();

        if (trimmed.startsWith('```')) {
            inCodeFence = !inCodeFence;
            deduped.push(line);
            previous = line;
            continue;
        }

        if (!inCodeFence && line === previous && trimmed.length > 0) {
            continue;
        }

        deduped.push(line);
        previous = line;
    }

    for (const line of deduped) {
        const key = line.trim().toLowerCase();
        if (key.length < 8 || key.length > 140) continue;
        counts.set(key, (counts.get(key) || 0) + 1);
    }

    return deduped
        .filter(line => {
            const key = line.trim().toLowerCase();
            if (!key) return true;
            if (!counts.has(key)) return true;
            if (counts.get(key) < 3) return true;
            return false;
        })
        .join('\n');
}

function scoreCandidate(node) {
    const text = sanitizeInlineText(node.textContent || '');
    const textLength = text.length;
    if (textLength < 180) return -Infinity;

    const linkTextLength = Array.from(node.querySelectorAll('a'))
        .map(a => sanitizeInlineText(a.textContent || '').length)
        .reduce((sum, len) => sum + len, 0);

    const linkDensity = textLength > 0 ? linkTextLength / textLength : 1;
    const paragraphCount = node.querySelectorAll('p').length;
    const headingCount = node.querySelectorAll('h1,h2,h3').length;
    const listCount = node.querySelectorAll('li').length;

    let score = textLength * (1 - Math.min(linkDensity, 0.95));
    score += paragraphCount * 35;
    score += headingCount * 25;
    score -= listCount * 4;

    const tag = node.tagName ? node.tagName.toLowerCase() : '';
    if (tag === 'article' || tag === 'main') score *= 1.4;

    const idClass = `${node.id || ''} ${node.className || ''}`.toLowerCase();
    if (/(article|content|main|post|entry|body)/.test(idClass)) score *= 1.2;
    if (/(nav|menu|footer|header|sidebar|breadcrumb)/.test(idClass)) score *= 0.6;

    return score;
}

function pickBestContentCandidate(doc) {
    const candidates = [
        ...Array.from(doc.querySelectorAll('article, main, [role="main"]')),
        ...Array.from(doc.querySelectorAll('section, div'))
    ];

    let best = null;
    let bestScore = -Infinity;

    candidates.forEach(node => {
        const score = scoreCandidate(node);
        if (score > bestScore) {
            best = node;
            bestScore = score;
        }
    });

    return bestScore > 320 ? best : null;
}

const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
});

turndownService.use(turndownPluginGfm.gfm);

turndownService.addRule('cleanSpans', {
    filter: ['span', 'font', 'small'],
    replacement: content => content
});

turndownService.addRule('codeBlocksWithLanguage', {
    filter: function (node) {
        return node.nodeName === 'PRE';
    },
    replacement: function (_content, node) {
        const codeNode = node.querySelector('code');
        const source = codeNode ? codeNode.textContent : node.textContent;
        const language = extractCodeLanguage(codeNode || node);
        const code = normalizeTextArtifacts(source || '')
            .replace(/\r\n/g, '\n')
            .replace(/^\n+/, '')
            .replace(/\n+$/, '');
        return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
    }
});

turndownService.addRule('cleanComplexTables', {
    filter: function (node) {
        return node.nodeName === 'TABLE';
    },
    replacement: function (_content, node) {
        return tableToMarkdown(node);
    }
});

const DEMO_HTML = `<!DOCTYPE html>
<html>
<head>
    <title>Understanding Large Language Models</title>
    <meta name="description" content="A comprehensive guide to LLMs and their applications">
    <meta name="author" content="AI Research Team">
    <meta name="keywords" content="LLM, AI, machine learning, NLP">
</head>
<body>
<article class="main-content">
    <header>
        <h1>Understanding Large Language Models</h1>
        <p class="meta">Published: 2024-01-15 | Reading time: 5 min</p>
    </header>

    <section id="introduction">
        <h2>Introduction</h2>
        <p>Large Language Models (LLMs) have revolutionized <strong>natural language processing</strong>. This guide covers the key concepts, architectures, and practical applications.</p>
        <blockquote>
            "The development of LLMs represents one of the most significant advances in AI history."
        </blockquote>
    </section>

    <section id="comparison">
        <h2>Model Comparison</h2>
        <table>
            <thead>
                <tr>
                    <th>Model</th>
                    <th>Developer</th>
                    <th>Parameters</th>
                    <th>Context</th>
                </tr>
            </thead>
            <tbody>
                <tr><td>GPT-4</td><td>OpenAI</td><td>1.76T</td><td>128k</td></tr>
                <tr><td>Claude 3</td><td>Anthropic</td><td>Unknown</td><td>200k</td></tr>
                <tr><td>Llama 3</td><td>Meta</td><td>405B</td><td>128k</td></tr>
                <tr><td>Gemini</td><td>Google</td><td>Unknown</td><td>1M</td></tr>
            </tbody>
        </table>
    </section>

    <section id="code">
        <h2>API Example</h2>
        <pre><code class="language-python">from openai import OpenAI

client = OpenAI()
response = client.chat.completions.create(
    model="gpt-4",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Explain transformers."}
    ]
)
print(response.choices[0].message.content)</code></pre>
    </section>

    <section id="links">
        <h2>Resources</h2>
        <ul>
            <li><a href="/docs/getting-started">Getting Started Guide</a></li>
            <li><a href="https://arxiv.org/papers">Research Papers</a></li>
            <li><a href="#faq">FAQ Section</a></li>
        </ul>
    </section>

    <footer class="noise">
        <p>© 2024 AI Research. Subscribe to newsletter!</p>
    </footer>
</article>
<div class="advertisement">Buy our course!</div>
<nav class="sidebar">Navigation menu</nav>
</body>
</html>`;

async function fetchURL(convertAfterFetch = false) {
    const urlInput = document.getElementById('url-input');
    const url = urlInput.value.trim();

    if (!url) {
        showToast('Please enter a URL', 'error');
        return false;
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        showToast('URL must start with http:// or https://', 'error');
        return false;
    }

    showLoading('Fetching URL...');

    for (let i = 0; i < CORS_PROXIES.length; i++) {
        const proxyIndex = (currentProxyIndex + i) % CORS_PROXIES.length;
        const proxyUrl = CORS_PROXIES[proxyIndex] + encodeURIComponent(url);

        try {
            const response = await fetch(proxyUrl, {
                headers: { 'Accept': 'text/html' }
            });

            if (response.ok) {
                const html = await response.text();
                document.getElementById('html-input').value = html;
                document.getElementById('input-status').textContent = `Fetched ${(html.length / 1024).toFixed(1)}KB`;
                currentProxyIndex = proxyIndex;
                hideLoading();
                showToast('URL fetched successfully');
                updateInputStats();

                if (detectDynamicShell(html)) {
                    showToast('Page looks JS-rendered; for fuller output use CLI with --render-js', 'warning');
                }

                // Clear drill state from previous fetch
                drillOriginalHtml = null;
                currentDrillParent = null;
                originalDocHead = null;
                lastUsedSelector = 'body';
                document.getElementById('drill-path-display').classList.add('hidden');
                const searchInput = document.getElementById('selector-search');
                if (searchInput) searchInput.value = '';

                extractSelectorsFromHTML(html);
                if (convertAfterFetch) {
                    await processHTML();
                }
                return true;
            }
        } catch (e) {
            continue;
        }
    }

    hideLoading();
    showToast('Failed to fetch URL. Try pasting HTML directly.', 'error');
    return false;
}

function absolutizeUrl(value, baseUrl) {
    if (!value || !baseUrl) return value;

    const trimmed = String(value).trim();
    if (!trimmed) return trimmed;
    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(trimmed)) return trimmed;

    try {
        return new URL(trimmed, baseUrl).href;
    } catch (_error) {
        return trimmed;
    }
}

function normalizeSrcset(srcset, baseUrl) {
    if (!srcset || !baseUrl) return srcset;

    return srcset
        .split(',')
        .map(part => {
            const trimmed = part.trim();
            if (!trimmed) return trimmed;
            const pieces = trimmed.split(/\s+/);
            const src = pieces.shift();
            const descriptor = pieces.join(' ');
            const abs = absolutizeUrl(src, baseUrl);
            return descriptor ? `${abs} ${descriptor}` : abs;
        })
        .join(', ');
}

function resolveUrls(root, baseUrl, doc = null) {
    if (!root || !baseUrl) return;

    let effectiveBase = baseUrl;
    if (doc) {
        const baseTag = doc.querySelector('base[href]');
        if (baseTag) {
            effectiveBase = absolutizeUrl(baseTag.getAttribute('href'), baseUrl) || baseUrl;
        }
    }

    root.querySelectorAll('a[href], img, source, video, audio, link[rel="canonical"]').forEach(tag => {
        const attrs = ['href', 'src', 'poster', 'data-src', 'data-href', 'data-original', 'data-lazy-src'];
        attrs.forEach(attr => {
            if (!tag.hasAttribute(attr)) return;
            const raw = tag.getAttribute(attr);
            const abs = absolutizeUrl(raw, effectiveBase);
            tag.setAttribute(attr, abs);

            if ((attr === 'data-src' || attr === 'data-original' || attr === 'data-lazy-src') && !tag.getAttribute('src')) {
                tag.setAttribute('src', abs);
            }

            if (attr === 'data-href' && !tag.getAttribute('href')) {
                tag.setAttribute('href', abs);
            }
        });

        if (tag.hasAttribute('srcset')) {
            tag.setAttribute('srcset', normalizeSrcset(tag.getAttribute('srcset'), effectiveBase));
        }

        if (tag.tagName === 'IMG' && !tag.getAttribute('src') && tag.getAttribute('srcset')) {
            const firstCandidate = tag.getAttribute('srcset').split(',')[0].trim().split(/\s+/)[0];
            if (firstCandidate) tag.setAttribute('src', firstCandidate);
        }

        if (tag.tagName === 'A') {
            const text = sanitizeInlineText(tag.textContent || '');
            const href = tag.getAttribute('href');
            if (!text && href && !href.startsWith('#')) {
                tag.textContent = href;
            }
        }
    });
}

function cleanNoiseInNode(cleanNode) {
    const noiseSelectors = [
        'script', 'style', 'noscript', 'iframe', 'svg',
        '.ad', '.ads', '.advertisement', '.social-share', '.sponsored', '.promo',
        '.nav', 'nav', 'footer', '.footer', '[role="navigation"]', '[role="contentinfo"]',
        'header:not(article header):not(main header)', '.sidebar', '.cookie-banner', '.cookie', '.consent',
        '.popup', '.modal', '[role="banner"]',
        '.comments', '#comments', '.related-posts', '.related', '.newsletter', '.subscribe'
    ];

    noiseSelectors.forEach(sel => {
        try {
            cleanNode.querySelectorAll(sel).forEach(el => el.remove());
        } catch (_error) { }
    });

    cleanNode.querySelectorAll('[style*="display: none"], [style*="display:none"], [hidden], [aria-hidden="true"]').forEach(el => el.remove());

    const boilerplatePatterns = [
        /cookie/i,
        /privacy policy/i,
        /terms of (service|use)/i,
        /subscribe/i,
        /all rights reserved/i
    ];

    cleanNode.querySelectorAll('div, section, aside, p, li').forEach(node => {
        const text = sanitizeInlineText(node.textContent || '');
        if (text.length > 0 && text.length <= 220 && boilerplatePatterns.some(pattern => pattern.test(text))) {
            node.remove();
        }
    });
}

function removeMediaWithContext(cleanNode) {
    cleanNode.querySelectorAll('figure').forEach(figure => {
        const img = figure.querySelector('img');
        const figcaption = figure.querySelector('figcaption');
        const alt = img ? sanitizeInlineText(img.getAttribute('alt') || img.getAttribute('title') || '') : '';
        const caption = figcaption ? sanitizeInlineText(figcaption.textContent || '') : '';
        const chunks = [];

        if (alt) chunks.push(alt);
        if (caption) chunks.push(`caption: ${caption}`);

        if (chunks.length > 0) {
            const span = document.createElement('span');
            span.textContent = `[Image: ${chunks.join(' | ')}]`;
            figure.parentNode.replaceChild(span, figure);
        } else {
            figure.remove();
        }
    });

    cleanNode.querySelectorAll('img, video, audio, picture, canvas, source').forEach(el => {
        if (!el.parentNode) return;

        if (el.tagName === 'IMG') {
            const alt = sanitizeInlineText(el.getAttribute('alt') || el.getAttribute('title') || '');
            if (alt) {
                const span = document.createElement('span');
                span.textContent = `[Image: ${alt}]`;
                el.parentNode.replaceChild(span, el);
                return;
            }
        }

        el.remove();
    });
}

function stripLinksFromNode(cleanNode) {
    cleanNode.querySelectorAll('a').forEach(a => {
        const span = document.createElement('span');
        span.textContent = sanitizeInlineText(a.textContent || '') || a.getAttribute('href') || '';
        a.parentNode.replaceChild(span, a);
    });
}

function flattenJsonLdNode(node, output) {
    if (!node) return;

    if (Array.isArray(node)) {
        node.forEach(item => flattenJsonLdNode(item, output));
        return;
    }

    if (typeof node !== 'object') return;

    if (Array.isArray(node['@graph'])) {
        node['@graph'].forEach(item => flattenJsonLdNode(item, output));
    }

    const entry = {};
    const type = node['@type'];
    if (type) entry.type = Array.isArray(type) ? type.join(', ') : String(type);

    ['headline', 'name', 'description', 'datePublished', 'dateModified', 'inLanguage', 'url'].forEach(key => {
        if (node[key]) entry[key] = node[key];
    });

    if (node.author) {
        if (Array.isArray(node.author)) {
            entry.author = node.author.map(author => (author && typeof author === 'object' ? author.name : author)).filter(Boolean).join(', ');
        } else if (typeof node.author === 'object') {
            entry.author = node.author.name || '';
        } else {
            entry.author = node.author;
        }
    }

    if (entry.type && Object.keys(entry).length > 1) {
        output.push(entry);
    }
}

async function processHTML() {
    let rawHtml = document.getElementById('html-input').value;
    const selector = document.getElementById('selector-input').value || 'body';
    const baseUrl = document.getElementById('url-input').value.trim();

    const doAlignTables = document.getElementById('align-tables').checked;
    const doRemoveMedia = document.getElementById('remove-media').checked;
    const doCleanNoise = document.getElementById('clean-noise').checked;
    const doExtractMeta = document.getElementById('extract-meta').checked;
    const doPreserveLinks = document.getElementById('preserve-links').checked;

    if (!rawHtml.trim() && baseUrl) {
        const fetched = await fetchURL(false);
        if (!fetched) return;
        rawHtml = document.getElementById('html-input').value;
    }

    if (!rawHtml.trim()) {
        showToast('Please paste HTML or enter a URL to fetch', 'error');
        return;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, 'text/html');

    // Extract metadata - try from original doc head if we have it, otherwise from current HTML
    let metadata = {};
    if (doExtractMeta) {
        if (originalDocHead) {
            // Create a temporary doc with the original head for metadata extraction
            const tempDoc = parser.parseFromString(`<html><head>${originalDocHead}</head><body></body></html>`, 'text/html');
            metadata = extractMetadata(tempDoc, baseUrl);
        } else {
            metadata = extractMetadata(doc, baseUrl);
        }
    }

    if (baseUrl) {
        resolveUrls(doc, baseUrl, doc);
    }

    let targetElement = doc.querySelector(selector);
    let selectorUsed = selector;
    if (!targetElement) {
        showToast(`Selector "${selector}" not found, using body`, 'warning');
        targetElement = doc.body;
        selectorUsed = 'body (fallback)';
    }

    if (selector.trim() === 'body') {
        const bestCandidate = pickBestContentCandidate(doc);
        if (bestCandidate && bestCandidate !== doc.body) {
            targetElement = bestCandidate;
            if (bestCandidate.id) {
                selectorUsed = `#${bestCandidate.id} (auto)`;
            } else if (bestCandidate.classList && bestCandidate.classList.length > 0) {
                selectorUsed = `.${bestCandidate.classList[0]} (auto)`;
            } else {
                selectorUsed = `${bestCandidate.tagName.toLowerCase()} (auto)`;
            }
        }
    }

    let cleanNode = targetElement.cloneNode(true);

    if (doCleanNoise) {
        cleanNoiseInNode(cleanNode);
    }

    if (doRemoveMedia) {
        removeMediaWithContext(cleanNode);
    }

    if (!doPreserveLinks) {
        stripLinksFromNode(cleanNode);
    }

    let markdown = turndownService.turndown(cleanNode.innerHTML);
    markdown = normalizeTextArtifacts(markdown);

    if (doAlignTables) {
        markdown = alignMarkdownTables(markdown);
    }

    markdown = dedupeMarkdownBoilerplate(markdown);
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    // Determine actual selector used
    const actualSelector = (lastUsedSelector !== 'body' && selector === 'body') ? lastUsedSelector : selectorUsed;

    conversionResult = {
        markdown: markdown,
        metadata: metadata,
        sourceUrl: baseUrl || null,
        selector: actualSelector,
        timestamp: new Date().toISOString(),
        options: {
            alignTables: doAlignTables,
            removeMedia: doRemoveMedia,
            cleanNoise: doCleanNoise,
            extractMeta: doExtractMeta,
            preserveLinks: doPreserveLinks
        }
    };

    document.getElementById('markdown-output').value = markdown;
    updateStats(markdown);
    updatePreview(markdown);
    updateJSON();
}

function extractMetadata(doc, baseUrl = null) {
    const meta = {};

    const title = doc.querySelector('title');
    if (title) meta.title = sanitizeInlineText(title.textContent || '');

    const metaTags = ['description', 'author', 'keywords', 'og:title', 'og:description', 'og:image', 'og:url', 'twitter:title', 'twitter:description', 'twitter:image'];
    metaTags.forEach(name => {
        const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        if (el) {
            const key = name.replace(':', '_');
            meta[key] = sanitizeInlineText(el.getAttribute('content') || '');
        }
    });

    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) {
        const href = canonical.getAttribute('href');
        meta.canonical = baseUrl ? absolutizeUrl(href, baseUrl) : href;
    }

    const h1 = doc.querySelector('h1');
    if (h1) meta.h1 = sanitizeInlineText(h1.textContent || '');

    const lang = doc.documentElement ? doc.documentElement.getAttribute('lang') : '';
    if (lang) meta.language = lang;

    const jsonLd = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        const raw = (script.textContent || '').trim();
        if (!raw) return;
        try {
            const parsed = JSON.parse(raw);
            flattenJsonLdNode(parsed, jsonLd);
        } catch (_error) {
            // Ignore malformed JSON-LD
        }
    });
    if (jsonLd.length > 0) {
        meta.json_ld = jsonLd;
    }

    return meta;
}

function alignMarkdownTables(md) {
    const lines = md.split('\n');
    let inTable = false;
    let tableBuffer = [];
    let result = [];

    for (let line of lines) {
        if (line.trim().startsWith('|')) {
            inTable = true;
            tableBuffer.push(line.trim());
        } else {
            if (inTable) {
                result.push(formatTable(tableBuffer));
                tableBuffer = [];
                inTable = false;
            }
            result.push(line);
        }
    }

    if (inTable) {
        result.push(formatTable(tableBuffer));
    }

    return result.join('\n');
}

function formatTable(rows) {
    const matrix = rows.map(row =>
        row.split('|').map(c => c.trim()).filter((_, i, a) => i > 0 && i < a.length - 1)
    );

    if (matrix.length === 0) return rows.join('\n');

    const colWidths = matrix[0].map((_, col) => {
        return Math.max(3, ...matrix.map(row => (row[col] ? row[col].length : 0)));
    });

    return matrix.map(row => {
        const isSep = row[0] && row[0].match(/^[:\-\s]+$/);
        const cells = row.map((cell, i) =>
            isSep ? '-'.repeat(colWidths[i]) : (cell || '').padEnd(colWidths[i], ' ')
        );
        return `| ${cells.join(' | ')} |`;
    }).join('\n');
}

function updateStats(text) {
    document.getElementById('char-count').textContent = text.length.toLocaleString();
}

function updateInputStats() {
    const html = document.getElementById('html-input').value;
    document.getElementById('input-char-count').textContent = `${html.length.toLocaleString()} chars`;
}

function updatePreview(md) {
    marked.use({ breaks: true, gfm: true });
    const preview = document.getElementById('view-preview');
    preview.innerHTML = marked.parse(md || '');
}

function updateJSON() {
    if (!conversionResult) return;

    const output = {
        ...conversionResult,
        stats: {
            characters: conversionResult.markdown.length,
            words: conversionResult.markdown.split(/\s+/).filter(w => w).length,
            lines: conversionResult.markdown.split('\n').length
        }
    };

    document.getElementById('json-output').value = JSON.stringify(output, null, 2);
}

function switchTab(tab) {
    const tabs = ['markdown', 'preview', 'json'];

    tabs.forEach(t => {
        const view = document.getElementById(`view-${t}`);
        const btn = document.getElementById(`tab-btn-${t}`);
        if (t === tab) {
            view.classList.remove('hidden');
            btn.classList.add('active');
        } else {
            view.classList.add('hidden');
            btn.classList.remove('active');
        }
    });

    if (tab === 'preview') {
        updatePreview(document.getElementById('markdown-output').value);
    }
}

function copyToClipboard() {
    const currentTab = document.querySelector('.tab-btn.active').id.replace('tab-btn-', '');
    let text = '';

    if (currentTab === 'markdown') {
        text = document.getElementById('markdown-output').value;
    } else if (currentTab === 'json') {
        text = document.getElementById('json-output').value;
    } else if (currentTab === 'preview') {
        text = document.getElementById('markdown-output').value;
    }

    if (text) {
        navigator.clipboard.writeText(text);
        showToast('Copied to clipboard');
    }
}

function downloadOutput() {
    const currentTab = document.querySelector('.tab-btn.active').id.replace('tab-btn-', '');
    let content, filename, type;

    if (currentTab === 'json') {
        content = document.getElementById('json-output').value;
        filename = 'content.json';
        type = 'application/json';
    } else {
        content = document.getElementById('markdown-output').value;
        filename = 'content.md';
        type = 'text/markdown';
    }

    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
}

function toggleOpt(btn) {
    const isOn = btn.classList.toggle('on');
    const checkbox = document.getElementById(btn.dataset.for);
    if (checkbox) checkbox.checked = isOn;
}

function loadDemo() {
    document.getElementById('html-input').value = DEMO_HTML;
    document.getElementById('selector-input').value = '.main-content';
    document.getElementById('url-input').value = 'https://example.com/article';
    // Sync the extract-meta toggle button + checkbox
    const metaCheckbox = document.getElementById('extract-meta');
    if (metaCheckbox) metaCheckbox.checked = true;
    const metaBtn = document.querySelector('[data-for="extract-meta"]');
    if (metaBtn) metaBtn.classList.add('on');
    document.getElementById('input-status').textContent = 'Demo loaded';
    processHTML();
}

function clearInput() {
    document.getElementById('html-input').value = '';
    document.getElementById('input-status').textContent = '';
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    const content = document.getElementById('toast-content');
    const messageEl = document.getElementById('toast-message');

    content.className = 'toast';
    if (type === 'error') {
        content.style.background = '#B91C1C';
    } else if (type === 'warning') {
        content.style.background = '#B45309';
    } else {
        content.style.background = '#15803D';
    }

    messageEl.textContent = message;
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
    toast.style.pointerEvents = 'auto';

    clearTimeout(window._toastTimer);
    window._toastTimer = setTimeout(() => {
        toast.style.transform = 'translateY(80px)';
        toast.style.opacity = '0';
        toast.style.pointerEvents = 'none';
    }, 2500);
}

function showLoading(text = 'Loading...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
}

function showHelp() {
    document.getElementById('help-modal').classList.remove('hidden');
}

function hideHelp() {
    document.getElementById('help-modal').classList.add('hidden');
}

document.addEventListener('keydown', (e) => {
    if (e.key === '?' && !e.ctrlKey && !e.metaKey && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
        e.preventDefault();
        showHelp();
    }

    if (e.key === 'Escape') {
        hideHelp();
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        processHTML();
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        copyToClipboard();
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        fetchURL(true);
    }

    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'X') {
        e.preventDefault();
        clearInput();
    }
});

document.getElementById('url-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        fetchURL(true);
    }
});

document.getElementById('help-modal').addEventListener('click', (e) => {
    if (e.target.id === 'help-modal') {
        hideHelp();
    }
});

document.getElementById('html-input').addEventListener('input', () => {
    const html = document.getElementById('html-input').value;
    updateInputStats();
    if (html.trim()) {
        extractSelectorsFromHTML(html);
    }
});

function extractSelectorsFromHTML(html) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const ids = new Set();
    const classes = new Set();
    const tags = new Set();

    const contentTags = ['article', 'main', 'section', 'div', 'aside', 'header', 'footer', 'nav'];

    doc.body.querySelectorAll('*').forEach(el => {
        if (el.id) {
            ids.add(el.id);
        }

        el.classList.forEach(cls => {
            if (cls && !cls.match(/^(js-|is-|has-|ng-|v-|_)/)) {
                classes.add(cls);
            }
        });

        const tag = el.tagName.toLowerCase();
        if (contentTags.includes(tag)) {
            tags.add(tag);
        }
    });

    extractedSelectors = {
        ids: Array.from(ids).sort(),
        classes: Array.from(classes).sort(),
        tags: Array.from(tags).sort()
    };

    updateSelectorDatalist();
    showSelectorPanel();
}

function updateSelectorDatalist() {
    const datalist = document.getElementById('selector-list');
    datalist.innerHTML = '';

    extractedSelectors.ids.forEach(id => {
        const option = document.createElement('option');
        option.value = `#${id}`;
        datalist.appendChild(option);
    });

    extractedSelectors.classes.forEach(cls => {
        const option = document.createElement('option');
        option.value = `.${cls}`;
        datalist.appendChild(option);
    });

    extractedSelectors.tags.forEach(tag => {
        const option = document.createElement('option');
        option.value = tag;
        datalist.appendChild(option);
    });

    const dropdownBtn = document.getElementById('selector-dropdown-btn');
    if (extractedSelectors.ids.length || extractedSelectors.classes.length || extractedSelectors.tags.length) {
        dropdownBtn.classList.remove('hidden');
    } else {
        dropdownBtn.classList.add('hidden');
    }
}

function showSelectorPanel() {
    const total = extractedSelectors.ids.length + extractedSelectors.classes.length + extractedSelectors.tags.length;
    if (total === 0) return;

    document.getElementById('selector-panel').classList.remove('hidden');
    document.getElementById('selector-count').textContent = `(${total} found)`;
    renderSelectorItems();
}

function hideSelectorPanel() {
    document.getElementById('selector-panel').classList.add('hidden');
}

function toggleSelectorDropdown() {
    const panel = document.getElementById('selector-panel');
    if (panel.classList.contains('hidden')) {
        showSelectorPanel();
    } else {
        hideSelectorPanel();
    }
}

function filterSelectors(filter) {
    currentFilter = filter;

    document.querySelectorAll('.selector-filter').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });

    // Clear search when changing filter
    const searchInput = document.getElementById('selector-search');
    if (searchInput) searchInput.value = '';

    renderSelectorItems();
}

/**
 * Search/filter selectors by query
 */
function searchSelectors(query) {
    renderSelectorItems(query.toLowerCase().trim());
}

function renderSelectorItems(searchQuery = '') {
    const container = document.getElementById('selector-items');
    container.innerHTML = '';

    const addItem = (selector, type) => {
        // Apply search filter
        if (searchQuery && !selector.toLowerCase().includes(searchQuery)) {
            return;
        }

        const item = document.createElement('button');
        item.className = `selector-item ${type}`;
        item.textContent = selector;
        item.onclick = () => selectSelector(selector);
        container.appendChild(item);
    };

    if (currentFilter === 'all' || currentFilter === 'id') {
        extractedSelectors.ids.forEach(id => addItem(`#${id}`, 'id'));
    }

    if (currentFilter === 'all' || currentFilter === 'class') {
        extractedSelectors.classes.forEach(cls => addItem(`.${cls}`, 'class'));
    }

    if (currentFilter === 'all' || currentFilter === 'tag') {
        extractedSelectors.tags.forEach(tag => addItem(tag, 'tag'));
    }

    // Update count
    const count = container.children.length;
    document.getElementById('selector-count').textContent = `(${count})`;
}

function selectSelector(selector) {
    document.getElementById('selector-input').value = selector;

    const rawHtml = document.getElementById('html-input').value;
    if (rawHtml.trim()) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(rawHtml, 'text/html');
        const element = doc.querySelector(selector);

        if (element) {
            // Store the original document head for metadata extraction
            if (doc.head) {
                originalDocHead = doc.head.innerHTML;
            }
            // Store original HTML for drilling
            if (!drillOriginalHtml) {
                drillOriginalHtml = rawHtml;
            }
            // Track the selector used
            lastUsedSelector = currentDrillParent ? `${currentDrillParent} ${selector}` : selector;

            document.getElementById('html-input').value = element.outerHTML;
            updateInputStats();

            // Show children of this element
            showChildrenOf(selector, element);

            showToast(`Selected: ${selector}`);
        } else {
            showToast(`Selector "${selector}" not found`, 'warning');
        }
    }
}

/**
 * Show children of selected element in the selector panel
 */
function showChildrenOf(parentSelector, parentElement) {
    currentDrillParent = lastUsedSelector;

    const children = getChildElements(parentElement);

    // Update path display
    const pathDisplay = document.getElementById('drill-path-display');
    const pathText = document.getElementById('drill-path-text');

    if (children.length > 0) {
        pathDisplay.classList.remove('hidden');
        pathText.textContent = currentDrillParent;

        // Show children in selector items
        const container = document.getElementById('selector-items');
        container.innerHTML = '';

        children.forEach(child => {
            const item = document.createElement('button');
            item.className = `selector-item ${child.hasId ? 'id' : child.hasClass ? 'class' : 'tag'}`;

            let text = child.label;
            if (child.childCount > 0) {
                text += ` (${child.childCount})`;
            }
            item.textContent = text;
            item.title = child.textPreview || 'No text content';

            item.onclick = () => selectSelector(child.selector);
            container.appendChild(item);
        });

        document.getElementById('selector-count').textContent = `(${children.length} children)`;
    } else {
        pathDisplay.classList.add('hidden');
        hideSelectorPanel();
    }
}

/**
 * Reset drill path and show all selectors again
 */
function resetDrillPath() {
    currentDrillParent = null;

    // Restore original HTML
    if (drillOriginalHtml) {
        document.getElementById('html-input').value = drillOriginalHtml;
        updateInputStats();
        extractSelectorsFromHTML(drillOriginalHtml);
        drillOriginalHtml = null;
    }

    // Hide path display
    document.getElementById('drill-path-display').classList.add('hidden');

    // Show normal selectors
    renderSelectorItems();
    showToast('Showing all selectors');
}

/**
 * Get child elements of an element
 */
function getChildElements(parentElement) {
    const children = [];

    parentElement.querySelectorAll(':scope > *').forEach((el, index) => {
        const tag = el.tagName.toLowerCase();

        // Skip non-content elements
        if (['script', 'style', 'noscript', 'meta', 'link'].includes(tag)) return;

        let selector = tag;
        let label = tag;

        // Prefer ID if available
        if (el.id) {
            selector = `#${el.id}`;
            label = `#${el.id}`;
        }
        // Then class
        else if (el.classList.length > 0) {
            const mainClass = el.classList[0];
            selector = `.${mainClass}`;
            label = `.${mainClass}`;
        }
        // Fall back to nth-child for duplicates
        else {
            selector = `${tag}:nth-child(${index + 1})`;
            label = `${tag}[${index + 1}]`;
        }

        // Get text preview
        let textPreview = el.textContent.trim().slice(0, 30);
        if (textPreview.length >= 30) textPreview += '...';

        const childCount = el.querySelectorAll(':scope > *').length;

        children.push({
            element: el,
            selector,
            label,
            tag,
            textPreview,
            childCount,
            hasId: !!el.id,
            hasClass: el.classList.length > 0
        });
    });

    return children;
}


