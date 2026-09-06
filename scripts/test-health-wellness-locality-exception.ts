/**
 * Direct Stage 1 test of the health-wellness-az locality exception, using
 * the exact two real candidates from a prior run that were dropped for
 * "no Arizona connection": the Al Jazeera sleep study and the Cure Today
 * weight-loss study (see topic-discovery-2026-09-03T19-18-44-385Z.json's
 * skipped list). Calls the real Stage 1 quick-pass + full-pass functions
 * directly (both exported specifically for this kind of verification) —
 * no full Stage 0 fetch needed since these exact titles/links are already
 * known. Also runs a scope-check control: the SAME two candidates
 * relabeled with a different queryClass, to confirm the exception does
 * NOT leak to other query classes. Throwaway script, makes no writes.
 */
import {
  runStage1QuickPassForCandidate,
  runStage1VerdictForCandidate,
  quickPassIsHighConfidence,
  type RawNewsItem,
} from '../src/agents/topicDiscovery';

const REAL_CASES: { title: string; link: string; sourceOutlet: string }[] = [
  {
    title: 'Sleeping in on weekends is good for the heart: What research has shown',
    link: 'https://www.aljazeera.com/news/2026/8/31/sleeping-in-on-weekends-is-good-for-the-heart-what-research-has-shown',
    sourceOutlet: 'Al Jazeera',
  },
  {
    title: 'Weight-Loss Medication Helps Some Breast Cancer Survivors Reach 5% Goal',
    link: 'https://www.curetoday.com/view/weight-loss-medication-helps-some-breast-cancer-survivors-reach-5-goal',
    sourceOutlet: 'Cure Today',
  },
];

function makeItem(
  c: (typeof REAL_CASES)[number],
  queryClass: RawNewsItem['queryClass']
): RawNewsItem {
  return {
    title: c.title,
    link: c.link,
    sourceOutlet: c.sourceOutlet,
    queryClass,
    matchedQuery: '(test-harness, not a real Stage 0 query)',
  };
}

async function classify(item: RawNewsItem): Promise<{ source: string; verdict: string; section: string; skipReason?: string }> {
  const quick = await runStage1QuickPassForCandidate(item);
  if (quick && quickPassIsHighConfidence(quick)) {
    return { source: 'quick-pass', verdict: quick.verdict, section: quick.section, skipReason: quick.skipReason };
  }
  const full = await runStage1VerdictForCandidate(item);
  return { source: 'full-pass (web_search)', verdict: full.verdict, section: full.section, skipReason: full.skipReason };
}

async function main() {
  console.log('=== health-wellness-az (the fix should apply) ===');
  for (const c of REAL_CASES) {
    const item = makeItem(c, 'health-wellness-az');
    const r = await classify(item);
    const wouldBeKept = r.verdict !== 'national-skip';
    console.log(
      `"${c.title}"\n  via ${r.source} -> verdict=${r.verdict}, section=${r.section}${r.skipReason ? `, skipReason="${r.skipReason}"` : ''}\n  ${wouldBeKept ? 'PASS (would be kept by prompt exception alone)' : 'verdict is still national-skip — relies on the code-level gate override to be kept'}`
    );
  }

  console.log('\n=== SCOPE CHECK: same content, queryClass=local-native (should NOT get the exception) ===');
  for (const c of REAL_CASES) {
    const item = makeItem(c, 'local-native');
    const r = await classify(item);
    console.log(
      `"${c.title}"\n  via ${r.source} -> verdict=${r.verdict}, section=${r.section}${r.skipReason ? `, skipReason="${r.skipReason}"` : ''}\n  ${r.verdict === 'national-skip' ? 'correctly still national-skip (no exception leaked to this class)' : 'UNEXPECTED — exception should not apply outside health-wellness-az'}`
    );
  }

  console.log('\n=== SCOPE CHECK: same content, queryClass=cannabis-az (should NOT get the exception) ===');
  for (const c of REAL_CASES) {
    const item = makeItem(c, 'cannabis-az');
    const r = await classify(item);
    console.log(
      `"${c.title}"\n  via ${r.source} -> verdict=${r.verdict}, section=${r.section}${r.skipReason ? `, skipReason="${r.skipReason}"` : ''}\n  ${r.verdict === 'national-skip' ? 'correctly still national-skip (no exception leaked to this class)' : 'UNEXPECTED — exception should not apply outside health-wellness-az'}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
