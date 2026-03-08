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

function normalizeTextArtifacts(text) {
    if (!text || typeof text !== 'string') return text;

    let normalized = text;

    // Common UTF-8/Windows-1252 mojibake artifacts seen in scraped pages
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
        ['â„¢', '™'],
        ['Ã—', '×'],
        ['Ã·', '÷']
    ];

    for (const [bad, good] of replacements) {
        normalized = normalized.split(bad).join(good);
    }

    return normalized;
}

function dedupeMarkdownBoilerplate(markdown) {
    if (!markdown || typeof markdown !== 'string') return markdown;

    const lines = markdown.split('\n');
    const deduped = [];
    let previous = null;
    let inCodeFence = false;

    // Remove consecutive duplicate lines outside code fences
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

    // Remove globally repeated short boilerplate lines when repeated 3+ times
    const freq = new Map();
    for (const line of deduped) {
        const key = line.trim().toLowerCase();
        if (key.length < 8 || key.length > 140) continue;
        if (key.startsWith('#') || key.startsWith('```') || key.startsWith('|')) continue;
        freq.set(key, (freq.get(key) || 0) + 1);
    }

    const repeated = new Set(
        Array.from(freq.entries())
            .filter(([, count]) => count >= 3)
            .map(([key]) => key)
    );

    if (repeated.size === 0) {
        return deduped.join('\n');
    }

    return deduped
        .filter(line => !repeated.has(line.trim().toLowerCase()))
        .join('\n');
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

function isValidSelector(selector) {
    try {
        return /^[a-zA-Z0-9\-_#.\[\]="':,\s*>+~()]+$/.test(selector);
    } catch (e) {
        return false;
    }
}

function sanitizeFilename(name) {
    return name
        .replace(/[^a-zA-Z0-9\-_]/g, '_')
        .replace(/_+/g, '_')
        .substring(0, 100);
}

function getDomainFromUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname.replace(/^www\./, '');
    } catch (e) {
        return 'output';
    }
}

module.exports = {
    alignMarkdownTables,
    formatTable,
    isValidSelector,
    sanitizeFilename,
    getDomainFromUrl,
    normalizeTextArtifacts,
    dedupeMarkdownBoilerplate
};
