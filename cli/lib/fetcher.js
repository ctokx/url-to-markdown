const axios = require('axios');

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
];

async function fetchUrl(url, options = {}) {
    const {
        timeout = 30000,
        retries = 2,
        renderJs = false,
        renderJsAuto = false,
        minContentChars = 1200
    } = options;

    if (renderJs) {
        return fetchUrlWithBrowser(url, options);
    }

    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout,
                maxRedirects: 5,
                headers: {
                    'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1'
                },
                responseType: 'text',
                validateStatus: (status) => status >= 200 && status < 400
            });

            const httpResult = {
                html: response.data,
                finalUrl: response.request?.res?.responseUrl || url,
                status: response.status
            };

            if (renderJsAuto && looksLikeDynamicShell(httpResult.html, minContentChars)) {
                try {
                    const rendered = await fetchUrlWithBrowser(url, options);
                    if (textLength(rendered.html) > textLength(httpResult.html)) {
                        return rendered;
                    }
                } catch (_error) {
                    // Silent fallback to HTTP result when browser rendering is unavailable.
                }
            }

            return httpResult;
        } catch (error) {
            lastError = error;

            if (error.response && error.response.status >= 400 && error.response.status < 500 && error.response.status !== 429) {
                throw new Error(`HTTP ${error.response.status}: ${error.response.statusText}`);
            }

            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
            }
        }
    }

    throw new Error(`Failed to fetch URL after ${retries + 1} attempts: ${lastError.message}`);
}

function textLength(html) {
    if (!html || typeof html !== 'string') return 0;

    return html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim().length;
}

function looksLikeDynamicShell(html, minContentChars = 1200) {
    const length = textLength(html);
    if (length >= minContentChars) return false;

    const appShellSignals = [
        /id=["']__next["']/i,
        /id=["']__nuxt["']/i,
        /id=["']root["']/i,
        /id=["']app["']/i,
        /data-reactroot/i,
        /webpack/i,
        /chunk[-_.]/i,
        /<script[^>]+type=["']module["']/i
    ];

    return appShellSignals.some(pattern => pattern.test(html));
}

async function fetchUrlWithBrowser(url, options = {}) {
    let playwright;

    try {
        playwright = require('playwright');
    } catch (_error) {
        throw new Error('Playwright is not installed. Run "npm install playwright" to enable --render-js.');
    }

    const timeout = Number(options.timeout || 30000);
    const waitMs = Math.max(0, Number(options.waitMs || 0) || 0);
    const waitSelector = options.waitSelector || null;
    const waitUntil = options.waitUntil || 'networkidle';

    const browser = await playwright.chromium.launch({ headless: true });

    try {
        const context = await browser.newContext({
            userAgent: USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
        });
        const page = await context.newPage();

        await page.goto(url, { waitUntil, timeout });

        if (waitSelector) {
            await page.waitForSelector(waitSelector, { timeout: Math.min(timeout, 10000) });
        }

        if (waitMs > 0) {
            await page.waitForTimeout(waitMs);
        }

        const html = await page.content();
        const finalUrl = page.url();

        await context.close();

        return {
            html,
            finalUrl,
            status: 200,
            rendered: true
        };
    } finally {
        await browser.close();
    }
}

async function fetchUrls(urls, options = {}) {
    const { concurrency = 3, onProgress } = options;
    const results = [];
    const queue = [...urls];
    let index = 0;

    async function processNext() {
        if (queue.length === 0) return;

        const url = queue.shift();
        const currentIndex = index++;

        try {
            const result = await fetchUrl(url, options);
            const output = { url, ...result };
            results[currentIndex] = output;
            if (onProgress) onProgress(url, currentIndex, urls.length, output);
        } catch (error) {
            const output = { url, error: error.message };
            results[currentIndex] = output;
            if (onProgress) onProgress(url, currentIndex, urls.length, output);
        }

        await processNext();
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, urls.length); i++) {
        workers.push(processNext());
    }

    await Promise.all(workers);
    return results;
}

module.exports = {
    fetchUrl,
    fetchUrls,
    looksLikeDynamicShell
};
