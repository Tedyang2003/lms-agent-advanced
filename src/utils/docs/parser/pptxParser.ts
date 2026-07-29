import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { Parser } from "./parserTypes";

function cleanText(text: string): string {
    return text.replace(/\s+/g, " ").replace(/\n+/g, "\n").trim();
}

/**
 * Extracts every <a:t> run from a slide XML string, in document order.
 * <a:t> is the DrawingML "text run" element — it holds the literal visible
 * text inside a text box, table cell, or shape. This is how PowerPoint
 * itself stores all typed text, so this is lossless (no OCR needed).
 */
function extractTextRuns(xml: string): string[] {
    const runs: string[] = [];
    const regex = /<a:t>([\s\S]*?)<\/a:t>/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
        const decoded = decodeXmlEntities(match[1]);
        if (decoded.length > 0) runs.push(decoded);
    }
    return runs;
}

function decodeXmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/**
 * Groups consecutive <a:t> runs that belong to the same paragraph (<a:p>) so
 * words in one sentence aren't silently mashed into the next sentence with
 * no space. PowerPoint often splits a single sentence across multiple runs
 * (e.g. for mixed formatting), so we join runs within a paragraph directly,
 * but insert a newline between paragraphs.
 */
function extractParagraphs(xml: string): string[] {
    const paragraphs: string[] = [];
    const paraRegex = /<a:p>([\s\S]*?)<\/a:p>/g;
    let paraMatch: RegExpExecArray | null;
    while ((paraMatch = paraRegex.exec(xml)) !== null) {
        const runs = extractTextRuns(paraMatch[1]);
        const joined = runs.join("").trim();
        if (joined.length > 0) paragraphs.push(joined);
    }
    return paragraphs;
}

function slideNumberFromPath(path: string): number {
    return parseInt(path.match(/slide(\d+)\.xml$/)?.[1] ?? "0", 10);
}

async function extractPptxText(
    fileBuffer: Buffer,
    options: { includeSpeakerNotes: boolean },
): Promise<{ success: true; text: string } | { success: false; reason: string }> {
    let zip: JSZip;
    try {
        zip = await JSZip.loadAsync(fileBuffer);
    } catch (error) {
        return { success: false, reason: `invalid-pptx: ${error instanceof Error ? error.message : String(error)}` };
    }

    const slidePaths = Object.keys(zip.files)
        .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
        .sort((a, b) => slideNumberFromPath(a) - slideNumberFromPath(b));

    if (slidePaths.length === 0) {
        return { success: false, reason: "no-slides-found" };
    }

    const parts: string[] = [];

    for (const slidePath of slidePaths) {
        const slideNum = slideNumberFromPath(slidePath);
        const xml = await zip.files[slidePath].async("text");
        const paragraphs = extractParagraphs(xml);

        if (paragraphs.length === 0 && !options.includeSpeakerNotes) continue;

        parts.push(`[Slide ${slideNum}]`);
        parts.push(...paragraphs);

        if (options.includeSpeakerNotes) {
            const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
            const notesFile = zip.files[notesPath];
            if (notesFile) {
                const notesXml = await notesFile.async("text");
                const notesParagraphs = extractParagraphs(notesXml);
                if (notesParagraphs.length > 0) {
                    parts.push(`[Slide ${slideNum} notes]`);
                    parts.push(...notesParagraphs);
                }
            }
        }
    }

    const fullText = cleanText(parts.join("\n"));
    if (fullText.length === 0) {
        return { success: false, reason: "no-text-found" };
    }
    return { success: true, text: fullText };
}

export const pptxTextParser: Parser = {
    name: "pptx-text",
    canParse: (file) => file.name.toLowerCase().endsWith(".pptx"),
    async parse(file, ctx) {
        const status = ctx.ctl.createStatus({
            status: "loading",
            text: `Reading text from ${file.name}...`,
        });

        let fileBuffer: Buffer;
        try {
            fileBuffer = await readFile(ctx.filePath);
        } catch {
            status.setState({ status: "canceled", text: `Cannot read ${file.name}: no local file path available` });
            return { success: false, reason: "no-local-path" };
        }

        const result = await extractPptxText(fileBuffer, { includeSpeakerNotes: true });

        if (result.success) {
            status.setState({ status: "done", text: `Extracted text from ${file.name}` });
            return { success: true, content: result.text, parserName: "pptx-text", isCustomExtraction: true };
        }
        status.setState({ status: "canceled", text: `No text found in ${file.name}: ${result.reason}` });
        return { success: false, reason: result.reason };
    },
};