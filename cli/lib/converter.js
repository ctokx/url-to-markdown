const TurndownService = require('turndown');
const { gfm } = require('@joplin/turndown-plugin-gfm');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const he = require('he');
const {
    alignMarkdownTables,
    normalizeTextArtifacts,
    dedupeMarkdownBoilerplate
} = require('./utils');

const META_TAGS = [
    'description',
    'author',
    'keywords',
    'og:title',
    'og:description',
    'og:image',
    'og:url',
    'twitter:title',
    'twitter:description',
    'twitter:image'
];

const NOISE_SELECTORS = [
    'script', 'style', 'noscript', 'iframe', 'svg',
    '.ad', '.ads', '.advertisement', '.sponsored', '.promo',
    '.social-share', '.share', '.share-buttons',
    '.nav', 'nav', '[role="navigation"]',
    'footer', '.footer', '[role="contentinfo"]',
    'header:not(article header):not(main header)', '[role="banner"]',
    '.sidebar', 'aside',
    '.cookie-banner', '.cookie', '.consent', '.gdpr',
    '.popup', '.modal', '.newsletter', '.subscribe',
    '.comments', '#comments', '.related-posts', '.related',
    '.breadcrumb', '.breadcrumbs'
];

const BOILERPLATE_PATTERNS = [
    /cookie/i,
    /privacy policy/i,
    /terms of (service|use)/i,
    /all rights reserved/i,
    /subscribe/i,
    /newsletter/i,
    /sign in/i,
    /log in/i,
    /accept all/i,
    /manage preferences/i
];

function sanitizeInlineText(text) {
    if (!text) return '';
    return normalizeTextArtifacts(text)
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeTableCell(text) {
    return sanitizeInlineText(text)
        .replace(/\|/g, '\\|')
        .replace(/\n+/g, ' ');
}

function normalizeMetadataObject(value) {
    if (typeof value === 'string') {
        return sanitizeInlineText(value);
    }

    if (Array.isArray(value)) {
        return value.map(normalizeMetadataObject).filter(v => v !== '' && v !== null && v !== undefined);
    }

    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const normalized = normalizeMetadataObject(v);
            if (
                normalized !== '' &&
                normalized !== null &&
                normalized !== undefined &&
                !(typeof normalized === 'object' && !Array.isArray(normalized) && Object.keys(normalized).length === 0)
            ) {
                out[k] = normalized;
            }
        }
        return out;
    }

    return value;
}

function extractCodeLanguage(node) {
    if (!node) return '';

    const classSources = [];

    if (node.getAttribute && node.getAttribute('class')) {
        classSources.push(node.getAttribute('class'));
    }

    if (node.className && typeof node.className === 'string') {
        classSources.push(node.className);
    }

    if (node.getAttribute && node.getAttribute('data-language')) {
        classSources.push(`language-${node.getAttribute('data-language')}`);
    }

    const combined = classSources.join(' ');
    if (!combined) return '';

    const patterns = [
        /(?:^|\s)language-([a-z0-9_+-]+)(?:\s|$)/i,
        /(?:^|\s)lang-([a-z0-9_+-]+)(?:\s|$)/i,
        /(?:^|\s)brush:\s*([a-z0-9_+-]+)(?:\s|$)/i
    ];

    for (const pattern of patterns) {
        const match = combined.match(pattern);
        if (match && match[1]) {
            return match[1].toLowerCase();
        }
    }

    return '';
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

    const header = hasHeaderRow
        ? matrix[0]
        : matrix[0].map((_, idx) => `Column ${idx + 1}`);

    const bodyRows = hasHeaderRow ? matrix.slice(1) : matrix;

    const colWidths = header.map((_, col) => {
        const values = [header[col], ...bodyRows.map(row => row[col] || '')];
        return Math.max(3, ...values.map(v => (v || '').length));
    });

    const renderRow = (row) => `| ${row.map((cell, i) => (cell || '').padEnd(colWidths[i], ' ')).join(' | ')} |`;

    const lines = [];
    lines.push(renderRow(header));
    lines.push(`| ${colWidths.map(width => '-'.repeat(width)).join(' | ')} |`);
    bodyRows.forEach(row => lines.push(renderRow(row)));

    return `\n\n${lines.join('\n')}\n\n`;
}

function createTurndownService() {
    const turndownService = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        emDelimiter: '*'
    });

    turndownService.use(gfm);

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

    return turndownService;
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

    if (type) {
        entry.type = Array.isArray(type) ? type.join(', ') : String(type);
    }

    const keys = [
        'headline',
        'name',
        'description',
        'datePublished',
        'dateModified',
        'inLanguage',
        'url',
        'mainEntityOfPage'
    ];

    keys.forEach(key => {
        if (node[key]) entry[key] = node[key];
    });

    if (node.keywords) {
        entry.keywords = Array.isArray(node.keywords) ? node.keywords.join(', ') : node.keywords;
    }

    if (node.author) {
        if (Array.isArray(node.author)) {
            entry.author = node.author
                .map(author => (author && typeof author === 'object' ? author.name : author))
                .filter(Boolean)
                .join(', ');
        } else if (typeof node.author === 'object') {
            entry.author = node.author.name || '';
        } else {
            entry.author = node.author;
        }
    }

    if (node.publisher) {
        if (typeof node.publisher === 'object') {
            entry.publisher = node.publisher.name || '';
        } else {
            entry.publisher = node.publisher;
        }
    }

    if (entry.type && Object.keys(entry).length > 1) {
        output.push(entry);
    }

    if (entry.type && /FAQPage/i.test(entry.type) && Array.isArray(node.mainEntity)) {
        const faq = node.mainEntity
            .map(item => {
                if (!item || typeof item !== 'object') return null;
                const q = item.name;
                const a = item.acceptedAnswer && item.acceptedAnswer.text;
                if (!q || !a) return null;
                return { question: q, answer: a };
            })
            .filter(Boolean);

        if (faq.length > 0) {
            output.push({ type: 'FAQ', items: faq });
        }
    }

    if (entry.type && /BreadcrumbList/i.test(entry.type) && Array.isArray(node.itemListElement)) {
        const items = node.itemListElement
            .map(item => {
                if (!item || typeof item !== 'object') return null;
                if (item.item && typeof item.item === 'object') {
                    return item.item.name || item.name || null;
                }
                return item.name || null;
            })
            .filter(Boolean);

        if (items.length > 0) {
            output.push({ type: 'Breadcrumb', items });
        }
    }
}

function extractJsonLdMetadata(doc) {
    const output = [];
    const scripts = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));

    scripts.forEach(script => {
        const raw = (script.textContent || '').trim();
        if (!raw) return;

        try {
            const parsed = JSON.parse(raw);
            flattenJsonLdNode(parsed, output);
        } catch (_error) {
            // Ignore malformed JSON-LD blocks
        }
    });

    return output.map(normalizeMetadataObject).filter(Boolean);
}

function absolutizeUrl(value, baseUrl) {
    if (!value || !baseUrl) return value;

    const trimmed = String(value).trim();
    if (!trimmed) return trimmed;

    if (/^(mailto:|tel:|javascript:|data:|#)/i.test(trimmed)) {
        return trimmed;
    }

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
            const url = pieces.shift();
            const descriptor = pieces.join(' ');
            const abs = absolutizeUrl(url, baseUrl);
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

    Array.from(root.querySelectorAll('a[href], img, source, video, audio, link[rel="canonical"]')).forEach(tag => {
        const attrNames = ['href', 'src', 'poster', 'data-src', 'data-href', 'data-original', 'data-lazy-src'];

        attrNames.forEach(attr => {
            if (!tag.hasAttribute(attr)) return;
            const raw = tag.getAttribute(attr);
            const abs = absolutizeUrl(raw, effectiveBase);
            tag.setAttribute(attr, abs);

            // Promote lazy-load attributes into src/href when the primary attr is missing.
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
            if (firstCandidate) {
                tag.setAttribute('src', firstCandidate);
            }
        }

        if (tag.tagName === 'A') {
            const text = sanitizeInlineText(tag.textContent || '');
            const href = tag.getAttribute('href');
            if (!text && href && !/^#/.test(href)) {
                tag.textContent = href;
            }
        }
    });
}

function extractMetadata(doc, baseUrl = null) {
    const meta = {};

    const title = doc.querySelector('title');
    if (title) meta.title = title.textContent.trim();

    META_TAGS.forEach(name => {
        const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        if (el) {
            const key = name.replace(/:/g, '_');
            meta[key] = el.getAttribute('content');
        }
    });

    const canonical = doc.querySelector('link[rel="canonical"]');
    if (canonical) {
        const href = canonical.getAttribute('href');
        meta.canonical = baseUrl ? absolutizeUrl(href, baseUrl) : href;
    }

    const h1 = doc.querySelector('h1');
    if (h1) meta.h1 = h1.textContent.trim();

    const htmlLang = doc.documentElement && doc.documentElement.getAttribute('lang');
    if (htmlLang) meta.language = htmlLang;

    const jsonLd = extractJsonLdMetadata(doc);
    if (jsonLd.length > 0) {
        meta.json_ld = jsonLd;
    }

    return normalizeMetadataObject(meta);
}

function cleanNoise(element) {
    NOISE_SELECTORS.forEach(sel => {
        try {
            Array.from(element.querySelectorAll(sel)).forEach(el => el.remove());
        } catch (_error) {
            // Ignore invalid selectors in older documents
        }
    });

    Array.from(element.querySelectorAll('[style*="display: none"], [style*="display:none"], [hidden], [aria-hidden="true"]'))
        .forEach(el => el.remove());

    // Remove small boilerplate nodes with legal/subscription/cookie language.
    Array.from(element.querySelectorAll('div, section, aside, p, li')).forEach(node => {
        const text = sanitizeInlineText(node.textContent || '');
        if (!text) return;

        if (text.length <= 220 && BOILERPLATE_PATTERNS.some(pattern => pattern.test(text))) {
            node.remove();
        }
    });
}

function removeMedia(element) {
    // Preserve figure context before stripping media tags.
    Array.from(element.querySelectorAll('figure')).forEach(figure => {
        const img = figure.querySelector('img');
        const captionNode = figure.querySelector('figcaption');

        const alt = img ? sanitizeInlineText(img.getAttribute('alt') || img.getAttribute('title') || '') : '';
        const caption = captionNode ? sanitizeInlineText(captionNode.textContent || '') : '';

        const chunks = [];
        if (alt) chunks.push(alt);
        if (caption) chunks.push(`caption: ${caption}`);

        if (chunks.length > 0) {
            const span = element.ownerDocument.createElement('span');
            span.textContent = `[Image: ${chunks.join(' | ')}]`;
            figure.parentNode.replaceChild(span, figure);
        } else {
            figure.remove();
        }
    });

    Array.from(element.querySelectorAll('img, video, audio, picture, canvas, source')).forEach(media => {
        if (!media.parentNode) return;

        if (media.tagName === 'IMG') {
            const alt = sanitizeInlineText(media.getAttribute('alt') || media.getAttribute('title') || '');
            if (alt) {
                const span = element.ownerDocument.createElement('span');
                span.textContent = `[Image: ${alt}]`;
                media.parentNode.replaceChild(span, media);
                return;
            }
        }

        media.remove();
    });
}

function stripLinks(element) {
    Array.from(element.querySelectorAll('a')).forEach(a => {
        const span = element.ownerDocument.createElement('span');
        const text = sanitizeInlineText(a.textContent || '');
        span.textContent = text || a.getAttribute('href') || '';
        a.parentNode.replaceChild(span, a);
    });
}

function scoreCandidate(node) {
    if (!node || !node.textContent) return -Infinity;

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

function guessSelectorForElement(el) {
    if (!el) return 'body';
    if (el.id) return `#${el.id}`;
    if (el.classList && el.classList.length > 0) {
        return `.${el.classList[0]}`;
    }
    return (el.tagName || 'body').toLowerCase();
}

function pickBestContentCandidate(doc) {
    const preferred = [
        ...Array.from(doc.querySelectorAll('article, main, [role="main"]')),
        ...Array.from(doc.querySelectorAll('section, div'))
    ];

    if (preferred.length === 0) return null;

    let best = null;
    let bestScore = -Infinity;

    preferred.forEach(node => {
        const score = scoreCandidate(node);
        if (score > bestScore) {
            best = node;
            bestScore = score;
        }
    });

    return bestScore > 320 ? best : null;
}

function extractReadableContent(html, baseUrl) {
    try {
        const dom = new JSDOM(html, { url: baseUrl || 'https://example.com/' });
        const reader = new Readability(dom.window.document, {
            charThreshold: 180,
            nbTopCandidates: 10
        });

        const article = reader.parse();
        if (!article || !article.content) return null;

        const length = sanitizeInlineText(article.textContent || '').length;
        if (length < 220) return null;

        return article;
    } catch (_error) {
        return null;
    }
}

function convert(html, options = {}) {
    const {
        selector = 'body',
        baseUrl = null,
        alignTables = true,
        cleanNoise: doCleanNoise = true,
        stripMedia = false,
        preserveLinks = true,
        extractMeta = false,
        smartExtract = true,
        dedupeBoilerplate = true
    } = options;

    const normalizedHtml = normalizeTextArtifacts(html || '');
    const dom = new JSDOM(normalizedHtml, { url: baseUrl || 'https://example.com/' });
    const doc = dom.window.document;

    let metadata = {};
    if (extractMeta) {
        metadata = extractMetadata(doc, baseUrl);
    }

    if (baseUrl) {
        resolveUrls(doc, baseUrl, doc);
    }

    let targetElement = doc.querySelector(selector);
    let selectorUsed = selector;

    if (!targetElement) {
        targetElement = doc.body;
        selectorUsed = 'body (fallback)';
    }

    // Readability + density fallback only when selector is body.
    if (smartExtract && selector.trim() === 'body') {
        const readable = extractReadableContent(normalizedHtml, baseUrl);
        if (readable && readable.content) {
            const readableDoc = new JSDOM(`<body>${readable.content}</body>`).window.document;
            targetElement = readableDoc.body;
            selectorUsed = 'readability (auto)';

            if (extractMeta) {
                if (!metadata.title && readable.title) metadata.title = readable.title;
                if (!metadata.author && readable.byline) metadata.author = readable.byline;
            }
        } else {
            const best = pickBestContentCandidate(doc);
            if (best && best !== doc.body) {
                targetElement = best;
                selectorUsed = `${guessSelectorForElement(best)} (auto)`;
            }
        }
    }

    let cleanNode = targetElement.cloneNode(true);

    if (doCleanNoise) {
        cleanNoise(cleanNode);
    }

    if (stripMedia) {
        removeMedia(cleanNode);
    }

    if (!preserveLinks) {
        stripLinks(cleanNode);
    }

    const turndownService = createTurndownService();
    let markdown = turndownService.turndown(cleanNode.innerHTML);

    markdown = he.decode(markdown || '');
    markdown = normalizeTextArtifacts(markdown);

    if (alignTables) {
        markdown = alignMarkdownTables(markdown);
    }

    markdown = markdown.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

    if (dedupeBoilerplate) {
        markdown = dedupeMarkdownBoilerplate(markdown);
        markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
    }

    return {
        markdown,
        metadata: normalizeMetadataObject(metadata),
        selector: selectorUsed,
        stats: {
            characters: markdown.length,
            words: markdown.split(/\s+/).filter(w => w).length,
            lines: markdown.split('\n').length
        }
    };
}

module.exports = {
    convert,
    extractMetadata,
    createTurndownService
};
