import { oneNoteConverter } from "@tedyang2003/onenote-converter-wasm";
import type { Parser } from "./parserTypes";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";


function findTocFile(tempDir: string): string | undefined {
    return readdirSync(tempDir).find((name) => name.toLocaleLowerCase().endsWith(".html"));
}

interface TocPageEntry {
    level: number;
    filePath: string;
    title: string;
}

function decodeHtmlEntities(text: string): string {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

function getOrderedPageEntries(tempDir: string, tocFile: string): TocPageEntry[] {
    const tocHtml = readFileSync(path.join(tempDir, tocFile), "utf8");
    const entryRegex = /<li class="l(\d+)[^"]*"><a href="([^"]+)"[^>]*title="([^"]*)"/g;
    const entries: TocPageEntry[] = [];
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(tocHtml)) !== null) {
        entries.push({
            level: Number(match[1]),
            title: decodeHtmlEntities(match[3]),
            filePath: path.join(tempDir, decodeURIComponent(match[2])),
        });
    }
    return entries;
}

function promoteFirstRowToHeader(html: string): string {
    return html.replace(
        /(<table\b[^>]*>\s*(?:<tbody\b[^>]*>)?\s*<tr\b[^>]*>)([\s\S]*?)(<\/tr>)/g,
        (_full, rowStart, rowContent, rowEnd) => {
            const promotedRow = rowContent
                .replace(/<td(\s[^>]*)?>/gi, "<th$1>")
                .replace(/<\/td>/gi, "</th>");
            return rowStart + promotedRow + rowEnd;
        }
    );
}

function flattenCellContent(html: string): string {
    return html.replace(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_full, tag, attrs, innerContent) => {
        const flattened = innerContent
            .replace(/<div\b[^>]*>/gi, "")
            .replace(/<\/div>/gi, "")
            .replace(/<p\b[^>]*>/gi, "")
            .replace(/<\/p>/gi, " ")
            .trim();
        return `<${tag}${attrs}>${flattened}</${tag}>`;
    });
}

function stripDuplicateTitleLine(markdown: string, title: string): string {
    const lines = markdown.split("\n");
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++;
    if (i < lines.length && lines[i].trim() === title.trim()) {
        lines.splice(i, 1);
    }
    return lines.join("\n");
}

function collapseBlankLines(text: string): string {
    return text.replace(/\n{3,}/g, "\n\n");
}

export const oneNoteParser: Parser = {
    name: "onenote",
    canParse: (file) => file.name.toLowerCase().endsWith(".one"),
    async parse(file, ctx) {

        let filePath: string;
        try {
            filePath = await file.getFilePath();
        } catch {
            return { success: false, reason: "no-local-directory-path-found" }
        }

        const tempDir = mkdtempSync(path.join(tmpdir(), "onenote-"))
        try {
            //call oneNoteConverter
            try {
                oneNoteConverter(filePath, tempDir, path.dirname(filePath));
            } catch (err) {
                // Some pages can fail while others succeed — the renderer writes every page it
                // CAN before throwing at the end, so a thrown error here doesn't mean tempDir
                // is empty. Keep going and read whatever's actually on disk.
                ctx.ctl.debug(`[oneNoteParser] oneNoteConverter reported an error (may have partial output): ${err}`);
            }

            // walk tempDir for all internal note pages turned to HTML
            const tocFile = findTocFile(tempDir);
            const pageEntries = tocFile ? getOrderedPageEntries(tempDir, tocFile) : [];

            const turndownService = new TurndownService();
            turndownService.use(tables);

            // Clean SVG
            turndownService.addRule("stripSvg", {
                filter: (node) => node.nodeName.toLowerCase() === "svg",
                replacement: () => "[drawing/ink content omitted]",
            });


            // Clean Images
            turndownService.addRule("imagePlaceholder", {
                filter: "img",
                replacement: () => "[image]",
            });


            // Clean Style and Scripts
            turndownService.addRule("stripStyleAndScript", {
                filter: ["style", "script", "title"],
                replacement: () => "",
            });



            const pageMarkdown = pageEntries
                .filter((entry) => existsSync(entry.filePath))
                .map((entry) => {
                    const html = readFileSync(entry.filePath, "utf8");
                    const rawMarkdown = turndownService.turndown(flattenCellContent(promoteFirstRowToHeader(html)));
                    const markdown = stripDuplicateTitleLine(rawMarkdown, entry.title);
                    const heading = "#".repeat(Math.min(entry.level + 1, 6));
                    return `${heading} ${entry.title}\n\n${markdown}`;

                });

            if (pageMarkdown.length === 0) {
                return { success: false, reason: "no-pages-found" };
            }

            const content = collapseBlankLines(pageMarkdown.join("\n\n---\n\n"));

            return {
                success: true,
                content,
                parserName: "onenote",
                isCustomExtraction: true,
            };
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    },
};