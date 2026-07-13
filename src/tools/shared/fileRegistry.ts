import type { FileHandle } from "@lmstudio/sdk";
import { FILE_REGISTRY_MAX_CONVERSATIONS } from "../../constants";

// Structured-data (spreadsheet/CSV/JSON) and doc files each need their own
// conversationKey -> fileName -> FileHandle store (separate below) so a data
// file and a document can share the same fileName without colliding. They
// share ONE eviction budget, though — FILE_REGISTRY_MAX_CONVERSATIONS
// conversations tracked in total across BOTH kinds of files, not that many
// per kind (which would silently allow double the intended memory footprint).
export interface FileRegistry {
    register(conversationKey: string, file: FileHandle): void;
    lookup(conversationKey: string, fileName: string): FileHandle | undefined;
    getAll(conversationKey: string): FileHandle[];
    // Reflects the SHARED budget below, not a per-registry one — both
    // structuredDataRegistry and docFileRegistry report the same numbers.
    getCapacity(): { used: number; max: number };
}

const structuredDataStore = new Map<string, Map<string, FileHandle>>();
const docStore = new Map<string, Map<string, FileHandle>>();

// Shared LRU order across both stores. Map iteration order follows insertion
// order, and delete+set on an existing key moves it to the end — so the
// eviction below drops the least recently touched conversation, not just the
// oldest-created one. register() runs on every preprocessor turn for every
// file still in an active conversation's history (promptPreprocessor.ts), so
// a conversation that's still being used keeps getting touched and never
// becomes the eviction target.
const conversationOrder = new Map<string, true>();

function touchConversation(conversationKey: string): void {
    if (conversationOrder.has(conversationKey)) {
        conversationOrder.delete(conversationKey);
    } else if (conversationOrder.size >= FILE_REGISTRY_MAX_CONVERSATIONS) {
        const oldestKey = conversationOrder.keys().next().value;
        if (oldestKey !== undefined) {
            conversationOrder.delete(oldestKey);
            structuredDataStore.delete(oldestKey);
            docStore.delete(oldestKey);
        }
    }
    conversationOrder.set(conversationKey, true);
}

function createFileRegistry(store: Map<string, Map<string, FileHandle>>): FileRegistry {
    return {
        register(conversationKey, file) {
            touchConversation(conversationKey);
            let files = store.get(conversationKey);
            if (!files) {
                files = new Map();
                store.set(conversationKey, files);
            }
            files.set(file.name, file);
        },
        lookup(conversationKey, fileName) {
            return store.get(conversationKey)?.get(fileName);
        },
        getAll(conversationKey) {
            return Array.from(store.get(conversationKey)?.values() ?? []);
        },
        getCapacity() {
            return { used: conversationOrder.size, max: FILE_REGISTRY_MAX_CONVERSATIONS };
        },
    };
}

export const structuredDataRegistry = createFileRegistry(structuredDataStore);
export const docFileRegistry = createFileRegistry(docStore);
