import type { FileHandle } from "@lmstudio/sdk";

export type CachedChunk = {
    chunk: string;
    embedding: number[];
};

export type DocumentContextInjectionStrategy = "none" | "inject-full-content" | "retrieval";
export type ParsedFile = {
    content: string;
    // Populated lazily by embedCustomParsedFiles.ts the first time this file's
    // chunks are embedded, then reused on every later query against it.
    cachedChunks?: CachedChunk[];
};

export type ScoredEntry = { content: string; score: number; fileName?: string };

export type CustomParsedScoredEntry = { 
    content: string; 
    score: number; 
    file: FileHandle; 
};

