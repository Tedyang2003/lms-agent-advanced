const BOUNDARY_SCAN_WINDOW = 80;
const MIN_SHRINK_RATIO = 0.8; // never shrink a chunk by more than ~20% to find a boundary

// Snaps a naive character-count cut point back to the nearest sentence end or
// whitespace within a small window, so chunks don't split mid-word/mid-sentence.
function snapToBoundary(text: string, start: number, naiveEnd: number): number {
    const floor = Math.max(
        start + Math.floor((naiveEnd - start) * MIN_SHRINK_RATIO),
        naiveEnd - BOUNDARY_SCAN_WINDOW,
    );
    for (let i = naiveEnd; i > floor; i--) {
        const lastTwo = text.slice(i - 2, i);
        if (lastTwo === ". " || lastTwo === "? " || lastTwo === "! " || text[i - 1] === "\n") {
            return i;
        }
    }
    for (let i = naiveEnd; i > floor; i--) {
        if (text[i - 1] === " " || text[i - 1] === "\n") return i;
    }
    return naiveEnd;
}

export function chunkText(text: string, chunkSize = 1000, overlap = 150): string[] {
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const naiveEnd = Math.min(start + chunkSize, text.length);
        const end = naiveEnd < text.length ? snapToBoundary(text, start, naiveEnd) : naiveEnd;
        chunks.push(text.slice(start, end));
        if (end === text.length) break;
        start = end - overlap;
    }
    return chunks;
}
