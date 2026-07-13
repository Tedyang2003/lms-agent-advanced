import type {
    PromptPreprocessorController,
    PredictionProcessStatusController,
    RetrievalResultEntry,
} from "@lmstudio/sdk";

/**
 * Normalized capability surface usable from either the preprocessor path
 * (PromptPreprocessorController) or a tool-call path (ToolsProviderController
 * + per-call toolCtx). Different callers need different subsets — retrieval
 * needs getConfigValue/addCitations, structured-data just needs client/abortSignal/status —
 * but everything goes through this one shape so adapters live in one place.
 */
export interface PluginCapableCtl {
    client: PromptPreprocessorController["client"];
    abortSignal: AbortSignal;
    getConfigValue: (key: string) => any;
    debug: (...args: any[]) => void;
    addCitations: (entries: RetrievalResultEntry[]) => void;
    createStatus: PromptPreprocessorController["createStatus"];
}

function makeNoopStatus(): PredictionProcessStatusController {
    const noop: any = { setState: () => {}, addSubStatus: () => noop };
    return noop;
}

export function adaptFromPreprocessor(
    ctl: PromptPreprocessorController,
    configSchematics: any,
): PluginCapableCtl {
    return {
        client: ctl.client,
        abortSignal: ctl.abortSignal,
        getConfigValue: (key) => ctl.getPluginConfig(configSchematics).get(key),
        debug: ctl.debug.bind(ctl),
        addCitations: ctl.addCitations.bind(ctl),
        createStatus: ctl.createStatus.bind(ctl),
    };
}

export function adaptFromTool(buildCtl: any, toolCtx: any, configSchematics: any): PluginCapableCtl {
    return {
        client: buildCtl.client,
        abortSignal: toolCtx?.signal ?? buildCtl.abortSignal,
        getConfigValue: (key) => buildCtl.getPluginConfig(configSchematics).get(key),
        debug: (...args) => { console.log(...args); },
        addCitations: () => {}, // no tool-side citation UI, per SDK docs
        createStatus: (opts: { status: string; text: string }) => {
            if (typeof toolCtx?.status === "function") toolCtx.status(opts.text);
            return {
                setState: (next: { status: string; text: string }) => {
                    if (typeof toolCtx?.status === "function") toolCtx.status(next.text);
                },
                addSubStatus: () => makeNoopStatus(),
            } as any;
        },
    };
}