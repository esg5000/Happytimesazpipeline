"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("../config");
const syncDispensaries_1 = require("../agents/syncDispensaries");
async function main() {
    (0, config_1.validateConfig)();
    const { uniqueFound, saved, errors } = await (0, syncDispensaries_1.syncDispensariesToSanity)();
    console.log('');
    console.log('[dispensaries] Summary');
    console.log(`  Unique dispensaries found (after dedupe): ${uniqueFound}`);
    console.log(`  Saved to Sanity: ${saved}`);
    console.log(`  Errors: ${errors}`);
}
main().catch((e) => {
    console.error('[dispensaries] Fatal:', e);
    process.exit(1);
});
//# sourceMappingURL=syncDispensaries.js.map