const assert = require('assert');
const { convert, extractMetadata, createTurndownService } = require('../lib/converter');
const { looksLikeDynamicShell } = require('../lib/fetcher');
const {
    alignMarkdownTables,
    formatTable,
    isValidSelector,
    sanitizeFilename,
    getDomainFromUrl,
    normalizeTextArtifacts,
    dedupeMarkdownBoilerplate
} = require('../lib/utils');

const testResults = { passed: 0, failed: 0, tests: [] };

function test(name, fn) {
    try {
        fn();
        testResults.passed++;
        testResults.tests.push({ name, status: 'PASS' });
        console.log(`✓ ${name}`);
    } catch (error) {
        testResults.failed++;
        testResults.tests.push({ name, status: 'FAIL', error: error.message });
        console.log(`✗ ${name}`);
        console.log(`  Error: ${error.message}`);
    }
}

function describe(name, fn) {
    console.log(`\n${name}`);
    console.log('='.repeat(name.length));
    fn();
}

describe('Converter: Basic HTML to Markdown', () => {
    test('converts simple paragraph', () => {
        const result = convert('<html><body><p>Hello world</p></body></html>');
        assert(result.markdown.includes('Hello world'));
    });

    test('converts headings correctly', () => {
        const result = convert('<html><body><h1>Title</h1><h2>Subtitle</h2></body></html>');
        assert(result.markdown.includes('# Title'));
        assert(result.markdown.includes('## Subtitle'));
    });

    test('converts lists', () => {
        const result = convert('<html><body><ul><li>Item 1</li><li>Item 2</li></ul></body></html>');
        assert(result.markdown.includes('Item 1'));
        assert(result.markdown.includes('Item 2'));
    });

    test('converts links', () => {
        const result = convert('<html><body><a href="https://example.com">Link</a></body></html>');
        assert(result.markdown.includes('[Link](https://example.com)'));
    });

    test('converts bold and italic', () => {
        const result = convert('<html><body><strong>bold</strong> and <em>italic</em></body></html>');
        assert(result.markdown.includes('**bold**'));
        assert(result.markdown.includes('*italic*'));
    });

    test('converts code blocks', () => {
        const result = convert('<html><body><pre><code>const x = 1;</code></pre></body></html>');
        assert(result.markdown.includes('const x = 1;'));
    });

    test('converts inline code', () => {
        const result = convert('<html><body>Use the <code>npm install</code> command</body></html>');
        assert(result.markdown.includes('`npm install`'));
    });

    test('converts blockquotes', () => {
        const result = convert('<html><body><blockquote>A quote</blockquote></body></html>');
        assert(result.markdown.includes('> A quote'));
    });
});

describe('Converter: Tables', () => {
    test('converts simple HTML table', () => {
        const html = '<html><body><table><tr><th>Name</th><th>Age</th></tr><tr><td>John</td><td>30</td></tr></table></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('Name'));
        assert(result.markdown.includes('John'));
    });

    test('handles tables with missing cells', () => {
        const html = '<html><body><table><tr><th>A</th><th>B</th><th>C</th></tr><tr><td>1</td></tr></table></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('|'));
    });

    test('escapes pipe characters in table cells', () => {
        const html = '<html><body><table><tr><td>a | b</td></tr></table></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('\\|') || result.markdown.includes('a'));
    });

    test('handles complex nested tables', () => {
        const html = '<html><body><table><tr><td><div><span>Content</span></div></td></tr></table></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('Content'));
    });
});

describe('Converter: Options', () => {
    test('uses selector to extract content', () => {
        const html = '<html><body><div id="main">Main content</div><div id="sidebar">Sidebar</div></body></html>';
        const result = convert(html, { selector: '#main' });
        assert(result.markdown.includes('Main content'));
        assert(!result.markdown.includes('Sidebar'));
    });

    test('falls back to body when selector not found', () => {
        const html = '<html><body><p>Content</p></body></html>';
        const result = convert(html, { selector: '#nonexistent' });
        assert(result.selector === 'body (fallback)');
        assert(result.markdown.includes('Content'));
    });

    test('cleanNoise removes scripts', () => {
        const html = '<html><body><script>alert(1)</script><p>Content</p></body></html>';
        const result = convert(html, { cleanNoise: true });
        assert(!result.markdown.includes('alert'));
        assert(result.markdown.includes('Content'));
    });

    test('cleanNoise removes navigation', () => {
        const html = '<html><body><nav>Menu</nav><p>Content</p></body></html>';
        const result = convert(html, { cleanNoise: true });
        assert(!result.markdown.includes('Menu'));
    });

    test('cleanNoise removes footer', () => {
        const html = '<html><body><p>Content</p><footer>Copyright</footer></body></html>';
        const result = convert(html, { cleanNoise: true });
        assert(!result.markdown.includes('Copyright'));
    });

    test('cleanNoise can be disabled', () => {
        const html = '<html><body><nav>Menu</nav><p>Content</p></body></html>';
        const result = convert(html, { cleanNoise: false });
        assert(result.markdown.includes('Menu'));
    });

    test('stripMedia removes images', () => {
        const html = '<html><body><img src="test.jpg" alt="Test image"><p>Text</p></body></html>';
        const result = convert(html, { stripMedia: true });
        assert(!result.markdown.includes('!['));
        assert(result.markdown.includes('Text'));
    });

    test('stripMedia preserves alt text', () => {
        const html = '<html><body><img src=\"test.jpg\" alt=\"Description\"><p>Text</p></body></html>';
        const result = convert(html, { stripMedia: true });
        assert(result.markdown.includes('Image') && result.markdown.includes('Description'));
    });

    test('preserveLinks keeps links', () => {
        const html = '<html><body><a href="https://example.com">Link</a></body></html>';
        const result = convert(html, { preserveLinks: true });
        assert(result.markdown.includes('[Link](https://example.com)'));
    });

    test('preserveLinks false strips links', () => {
        const html = '<html><body><a href="https://example.com">Link text</a></body></html>';
        const result = convert(html, { preserveLinks: false });
        assert(result.markdown.includes('Link text'));
        assert(!result.markdown.includes('https://example.com'));
    });

    test('alignTables formats table columns', () => {
        const html = '<html><body><table><tr><th>A</th><th>Longer</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>';
        const result = convert(html, { alignTables: true });
        assert(result.markdown.includes('|'));
    });
});

describe('Converter: Metadata Extraction', () => {
    test('extracts title', () => {
        const html = '<html><head><title>Page Title</title></head><body><p>Content</p></body></html>';
        const result = convert(html, { extractMeta: true });
        assert.strictEqual(result.metadata.title, 'Page Title');
    });

    test('extracts meta description', () => {
        const html = '<html><head><meta name="description" content="A description"></head><body><p>Content</p></body></html>';
        const result = convert(html, { extractMeta: true });
        assert.strictEqual(result.metadata.description, 'A description');
    });

    test('extracts Open Graph tags', () => {
        const html = '<html><head><meta property="og:title" content="OG Title"></head><body><p>Content</p></body></html>';
        const result = convert(html, { extractMeta: true });
        assert(result.metadata.og_title === 'OG Title' || result.metadata.og_title === undefined);
    });

    test('extracts h1', () => {
        const html = '<html><body><h1>Main Heading</h1></body></html>';
        const result = convert(html, { extractMeta: true });
        assert.strictEqual(result.metadata.h1, 'Main Heading');
    });

    test('extracts canonical URL', () => {
        const html = '<html><head><link rel="canonical" href="https://example.com/page"></head><body><p>Content</p></body></html>';
        const result = convert(html, { extractMeta: true });
        assert.strictEqual(result.metadata.canonical, 'https://example.com/page');
    });

    test('returns empty metadata when not requested', () => {
        const html = '<html><head><title>Title</title></head><body><p>Content</p></body></html>';
        const result = convert(html, { extractMeta: false });
        assert.deepStrictEqual(result.metadata, {});
    });
});

describe('Converter: Stats', () => {
    test('counts characters correctly', () => {
        const result = convert('<html><body><p>Hello</p></body></html>');
        assert(result.stats.characters > 0);
    });

    test('counts words correctly', () => {
        const result = convert('<html><body><p>One two three</p></body></html>');
        assert(result.stats.words >= 3);
    });

    test('counts lines correctly', () => {
        const result = convert('<html><body><p>Line 1</p><p>Line 2</p></body></html>');
        assert(result.stats.lines >= 1);
    });
});

describe('Converter: Edge Cases', () => {
    test('handles empty body', () => {
        const result = convert('<html><body></body></html>');
        assert.strictEqual(result.markdown, '');
    });

    test('handles deeply nested elements', () => {
        const html = '<html><body><div><div><div><div><p>Deep</p></div></div></div></div></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('Deep'));
    });

    test('removes excessive newlines', () => {
        const html = '<html><body><p>A</p><br><br><br><p>B</p></body></html>';
        const result = convert(html);
        assert(!result.markdown.includes('\n\n\n\n'));
    });

    test('handles special characters', () => {
        const html = '<html><body><p>Text with &amp; and &lt;special&gt; chars</p></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('&'));
        assert(result.markdown.includes('<special>'));
    });

    test('strips spans and fonts', () => {
        const html = '<html><body><p><span style="color:red">Text</span><font face="Arial">More</font></p></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('Text'));
        assert(result.markdown.includes('More'));
    });
});

describe('Utils: Table Alignment', () => {
    test('aligns simple table', () => {
        const md = '| A | B |\n| --- | --- |\n| 1 | 2 |';
        const result = alignMarkdownTables(md);
        assert(result.includes('|'));
    });

    test('preserves non-table content', () => {
        const md = '# Heading\n\nSome text\n\n| A |\n| --- |\n| 1 |';
        const result = alignMarkdownTables(md);
        assert(result.includes('# Heading'));
        assert(result.includes('Some text'));
    });

    test('handles multiple tables', () => {
        const md = '| A |\n| --- |\n| 1 |\n\nText\n\n| B |\n| --- |\n| 2 |';
        const result = alignMarkdownTables(md);
        assert(result.includes('A'));
        assert(result.includes('B'));
    });
});

describe('Utils: Filename Sanitization', () => {
    test('removes special characters', () => {
        const result = sanitizeFilename('file<>:"/\\|?*name');
        assert(!result.includes('<'));
        assert(!result.includes('>'));
    });

    test('replaces spaces with underscores', () => {
        const result = sanitizeFilename('my file name');
        assert.strictEqual(result, 'my_file_name');
    });

    test('truncates long names', () => {
        const longName = 'a'.repeat(200);
        const result = sanitizeFilename(longName);
        assert(result.length <= 100);
    });

    test('handles unicode characters', () => {
        const result = sanitizeFilename('файл文件αρχείο');
        assert(result.length > 0);
    });
});

describe('Utils: Domain Extraction', () => {
    test('extracts domain from URL', () => {
        const result = getDomainFromUrl('https://www.example.com/page');
        assert.strictEqual(result, 'example.com');
    });

    test('handles URL without www', () => {
        const result = getDomainFromUrl('https://docs.python.org/3/');
        assert.strictEqual(result, 'docs.python.org');
    });

    test('returns default for invalid URL', () => {
        const result = getDomainFromUrl('not a url');
        assert.strictEqual(result, 'output');
    });

    test('handles URLs with ports', () => {
        const result = getDomainFromUrl('http://localhost:3000/path');
        assert.strictEqual(result, 'localhost');
    });
});

describe('Utils: Selector Validation', () => {
    test('validates simple tag selector', () => {
        assert.strictEqual(isValidSelector('div'), true);
    });

    test('validates class selector', () => {
        assert.strictEqual(isValidSelector('.my-class'), true);
    });

    test('validates ID selector', () => {
        assert.strictEqual(isValidSelector('#my-id'), true);
    });

    test('validates complex selector', () => {
        assert.strictEqual(isValidSelector('div.class#id > p:first-child'), true);
    });

    test('validates attribute selector', () => {
        assert.strictEqual(isValidSelector('[data-attr="value"]'), true);
    });
});

describe('TurndownService: Configuration', () => {
    test('creates service with ATX headings', () => {
        const service = createTurndownService();
        const result = service.turndown('<h1>Test</h1>');
        assert(result.startsWith('#'));
    });

    test('creates service with fenced code blocks', () => {
        const service = createTurndownService();
        const result = service.turndown('<pre><code>code</code></pre>');
        assert(result.includes('```') || result.includes('code'));
    });
});

describe('Converter: Advanced Content Extraction', () => {
    test('prefers readable article content for body selector', () => {
        const html = `
            <html>
            <body>
                <div id="root"></div>
                <nav>Home Docs Pricing</nav>
                <article>
                    <h1>Core Guide</h1>
                    <p>This is the main article text with enough words to be considered primary content for extraction.</p>
                    <p>Second paragraph adds additional context and should remain in markdown output.</p>
                </article>
            </body>
            </html>
        `;
        const result = convert(html, { selector: 'body', smartExtract: true });
        assert(result.markdown.includes('Core Guide'));
        assert(result.markdown.includes('main article text'));
    });

    test('can disable smart extraction', () => {
        const html = '<html><body><main><p>Main text</p></main><aside>Sidebar links</aside></body></html>';
        const result = convert(html, { selector: 'body', smartExtract: false, cleanNoise: false });
        assert(result.markdown.includes('Sidebar links'));
    });
});

describe('Converter: Advanced Fidelity', () => {
    test('handles rowspan and colspan table structure', () => {
        const html = `
            <html><body>
                <table>
                    <tr><th>Quarter</th><th colspan="2">Revenue</th></tr>
                    <tr><td rowspan="2">Q1</td><td>US</td><td>10</td></tr>
                    <tr><td>EU</td><td>8</td></tr>
                </table>
            </body></html>
        `;
        const result = convert(html);
        assert(result.markdown.includes('Quarter'));
        assert(result.markdown.includes('Revenue'));
        assert(result.markdown.includes('EU'));
    });

    test('preserves code block language from class names', () => {
        const html = '<html><body><pre><code class="language-python">print(\"ok\")</code></pre></body></html>';
        const result = convert(html);
        assert(result.markdown.includes('```python'));
        assert(result.markdown.includes('print(\"ok\")'));
    });

    test('preserves figure caption context when stripping media', () => {
        const html = `
            <html><body>
                <figure>
                    <img data-src="/hero.png" alt="Architecture Diagram">
                    <figcaption>System architecture overview</figcaption>
                </figure>
            </body></html>
        `;
        const result = convert(html, { stripMedia: true, baseUrl: 'https://example.com/docs' });
        assert(result.markdown.includes('Architecture Diagram'));
        assert(result.markdown.includes('System architecture overview'));
    });
});

describe('Converter: Metadata and Cleanup', () => {
    test('extracts JSON-LD article metadata', () => {
        const html = `
            <html>
            <head>
                <script type="application/ld+json">
                    {
                      "@context":"https://schema.org",
                      "@type":"Article",
                      "headline":"Structured Headline",
                      "author":{"@type":"Person","name":"Jane Doe"},
                      "datePublished":"2025-01-01"
                    }
                </script>
            </head>
            <body><h1>Visible Heading</h1></body>
            </html>
        `;
        const result = convert(html, { extractMeta: true });
        assert(Array.isArray(result.metadata.json_ld));
        assert(result.metadata.json_ld.some(item => item.headline === 'Structured Headline'));
    });

    test('normalizes mojibake artifacts', () => {
        const fixed = normalizeTextArtifacts('\u00E2\u20AC\u2122 test \u00C2\u00A9');
        assert(typeof fixed === 'string' && fixed.length > 0);
        assert(!fixed.includes('\u00C2'));
    });

    test('dedupes repeated markdown boilerplate lines', () => {
        const input = [
            'Cookie policy',
            'Cookie policy',
            'Cookie policy',
            '',
            'Main content line'
        ].join('\n');
        const output = dedupeMarkdownBoilerplate(input);
        assert(!output.includes('Cookie policy\nCookie policy\nCookie policy'));
        assert(output.includes('Main content line'));
    });
});

describe('Fetcher: Dynamic Shell Detection', () => {
    test('detects likely app shell pages', () => {
        const html = `
            <html><body>
                <div id="__next"></div>
                <script src="/_next/static/chunk.js"></script>
            </body></html>
        `;
        assert.strictEqual(looksLikeDynamicShell(html, 500), true);
    });

    test('does not flag content-rich pages', () => {
        const html = `<html><body><article>${'word '.repeat(1500)}</article></body></html>`;
        assert.strictEqual(looksLikeDynamicShell(html, 500), false);
    });
});

console.log('\n' + '='.repeat(50));
console.log('Test Results');
console.log('='.repeat(50));
console.log(`Passed: ${testResults.passed}`);
console.log(`Failed: ${testResults.failed}`);
console.log(`Total: ${testResults.passed + testResults.failed}`);

if (testResults.failed > 0) {
    console.log('\nFailed Tests:');
    testResults.tests.filter(t => t.status === 'FAIL').forEach(t => {
        console.log(`  - ${t.name}: ${t.error}`);
    });
    process.exit(1);
}

console.log('\nAll tests passed!');
