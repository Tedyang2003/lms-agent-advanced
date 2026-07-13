import type { FileHandle } from "@lmstudio/sdk";

// Excel and doc files each need their own conversationKey -> fileName -> FileHandle
// map (separate instances below) so a spreadsheet and a document can share the
// same fileName without colliding.
export interface FileRegistry {
    register(conversationKey: string, file: FileHandle): void;
    lookup(conversationKey: string, fileName: string): FileHandle | undefined;
    getAll(conversationKey: string): FileHandle[];
}

export function createFileRegistry(): FileRegistry {
    const registry = new Map<string, Map<string, FileHandle>>();

    return {
        register(conversationKey, file) {
            if (!registry.has(conversationKey)) {
                registry.set(conversationKey, new Map());
            }
            registry.get(conversationKey)!.set(file.name, file);
        },
        lookup(conversationKey, fileName) {
            return registry.get(conversationKey)?.get(fileName);
        },
        getAll(conversationKey) {
            return Array.from(registry.get(conversationKey)?.values() ?? []);
        },
    };
}

export const excelFileRegistry = createFileRegistry();
export const docFileRegistry = createFileRegistry();
