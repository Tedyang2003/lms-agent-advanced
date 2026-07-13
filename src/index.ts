import { type PluginContext, type ToolsProviderController } from "@lmstudio/sdk";
import { configSchematics } from "./config";
import { preprocess } from "./promptPreprocessor";
import { buildExcelQueryTool } from "./tools/excel/buildExcelQueryTool";
import { buildDocQueryTool } from "./tools/docs/buildDocQueryTool";
import { buildListAttachedFilesTool } from "./tools/shared/buildListAttachedFilesTool";
import { buildDatetimeTool } from "./tools/shared/buildDatetimeTool";
import { closeAllDatabases } from "./tools/excel/buildExcelTools";

// Cached DuckDB connections hold native handles that can keep this process
// alive past a normal exit request. If the process doesn't die on its own
// promptly, LM Studio falls back to a forced OS-level kill that shells out
// via cmd.exe — which fails outright in locked-down environments (e.g.
// AppLocker blocking cmd.exe). Closing everything and exiting on our own as
// soon as a shutdown signal arrives avoids ever needing that fallback.
let shuttingDown = false;
function registerShutdownHandlers() {
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        try {
            await closeAllDatabases();
        } finally {
            process.exit(0);
        }
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGBREAK", "SIGHUP"] as const) {
        process.on(signal, shutdown);
    }
}

export async function main(context: PluginContext) {
    registerShutdownHandlers();
    context.withConfigSchematics(configSchematics);

    // Preprocessor now only registers files + announces their existence via
    // a short tag — no eager content injection, no consumeFiles, no history
    // dependency. Both excel and doc data retrieval are fully tool-driven.
    context.withPromptPreprocessor(preprocess);

    // Both excel and doc querying are tools the main model decides whether
    // to call — not forced every turn. Registered unconditionally; each
    // tool's implementation looks up its own registry (keyed by working
    // directory) to find files, independent of history/consumeFiles state.
    context.withToolsProvider(async (ctl: ToolsProviderController) => {
        const excelTool = buildExcelQueryTool(ctl);
        const docTool = buildDocQueryTool(ctl);
        const listFilesTool = buildListAttachedFilesTool(ctl);
        const datetimeTool = buildDatetimeTool();
        return [excelTool, docTool, listFilesTool, datetimeTool].filter(Boolean);
    });
}