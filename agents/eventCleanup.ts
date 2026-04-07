import { getSanityClient } from './sanityPublisher';

/**
 * Sets `isActive` to false on all `event` documents whose `date` is in the past.
 */
export async function deactivatePastEvents(): Promise<{
  deactivated: number;
  errors: number;
}> {
  const client = getSanityClient();
  const ids = await client.fetch<string[]>(
    `*[_type == "event" && isActive == true && defined(date) && date < now()]._id`
  );

  let deactivated = 0;
  let errors = 0;

  for (const id of ids) {
    try {
      await client.patch(id).set({ isActive: false }).commit();
      deactivated++;
    } catch (e) {
      errors++;
      console.error(
        `[events-cleanup] Failed to deactivate ${id}:`,
        e instanceof Error ? e.message : e
      );
    }
  }

  return { deactivated, errors };
}
