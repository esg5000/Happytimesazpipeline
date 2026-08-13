import { getSanityClient } from './sanityPublisher';

const ERROR_SAMPLE_MAX = 5;

/**
 * Sets `isActive` to false on all `event` documents whose `date` is in the past.
 */
export async function deactivatePastEvents(): Promise<{
  deactivated: number;
  errors: number;
  /** A few example error messages from this run, capped — not every failure. */
  errorSample: string[];
}> {
  const client = getSanityClient();
  const ids = await client.fetch<string[]>(
    `*[_type == "event" && isActive == true && defined(date) && date < now()]._id`
  );

  let deactivated = 0;
  let errors = 0;
  const errorSample: string[] = [];

  for (const id of ids) {
    try {
      await client.patch(id).set({ isActive: false }).commit();
      deactivated++;
    } catch (e) {
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[events-cleanup] Failed to deactivate ${id}:`, msg);
      if (errorSample.length < ERROR_SAMPLE_MAX) errorSample.push(`${id}: ${msg}`);
    }
  }

  return { deactivated, errors, errorSample };
}
