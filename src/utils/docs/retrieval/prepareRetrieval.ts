function isLikelyBoilerplate(line: string): boolean {
    const trimmed = line.trim();
    if (trimmed.length === 0) return true;

    // Pure URL
    if (/^https?:\/\/\S+$/.test(trimmed)) return true;

    // Pure page counter, e.g. "4/8"
    if (/^\d{1,3}\/\d{1,3}$/.test(trimmed)) return true;

    // Date/time stamp lines, e.g. "6/29/26, 10:22 AM" or "29 Jun 2026 08:22AM"
    if (/\d{1,2}[\/\s]\w+[\/\s]\d{2,4}.{0,15}\d{1,2}:\d{2}\s*(AM|PM)?/i.test(trimmed) && trimmed.length < 80) return true;

    // Copyright / legal footer
    if (/copyright|all rights reserved|terms (and|&) conditions|privacy policy/i.test(trimmed)) return true;

    // Nav-menu-like lines: many capitalized words mashed together with no
    // normal sentence punctuation, e.g. "Top StoriesLatest NewsSingaporeWorld..."
    // Heuristic: short-ish line, no period at end, has 4+ capital-letter "word starts"
    // packed close together (avg word length low, capital density high).
    const words = trimmed.split(/\s+/);
    const capStarts = words.filter(w => /^[A-Z]/.test(w)).length;
    const hasSentencePunctuation = /[.?!]"?$/.test(trimmed);
    if (!hasSentencePunctuation && words.length >= 4 && capStarts / words.length > 0.6 && trimmed.length < 120) {
        return true;
    }

    // Very short fragment lines unlikely to be real sentence content on their own
    if (trimmed.length < 15 && !/[.?!]$/.test(trimmed)) return true;

    return false;
}

export function cleanCitationText(text: string): string {
    const lines = text.split(/\n+/);
    const kept = lines.filter(line => !isLikelyBoilerplate(line));
    return kept.join(" ").replace(/\s+/g, " ").trim();
}