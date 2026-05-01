"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivatePastEvents = deactivatePastEvents;
const sanityPublisher_1 = require("./sanityPublisher");
/**
 * Sets `isActive` to false on all `event` documents whose `date` is in the past.
 */
async function deactivatePastEvents() {
    const client = (0, sanityPublisher_1.getSanityClient)();
    const ids = await client.fetch(`*[_type == "event" && isActive == true && defined(date) && date < now()]._id`);
    let deactivated = 0;
    let errors = 0;
    for (const id of ids) {
        try {
            await client.patch(id).set({ isActive: false }).commit();
            deactivated++;
        }
        catch (e) {
            errors++;
            console.error(`[events-cleanup] Failed to deactivate ${id}:`, e instanceof Error ? e.message : e);
        }
    }
    return { deactivated, errors };
}
//# sourceMappingURL=eventCleanup.js.map