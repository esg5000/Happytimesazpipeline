/**
 * Voice test for the 3 new personas (5 persona values counting Stephen A.
 * Spliff's two modes) against real recent candidates pulled from actual
 * Stage 0-2 shadow-run logs. Calls the real writeArticle() with minimal
 * hand-built facts (title + a couple of real details from the source
 * candidate) — cheap 'blurb' length so this stays fast or cheap-ish, just
 * enough real content for voice inspection. Throwaway script, makes no
 * Sanity writes (writeArticle never touches Sanity).
 */
import { writeArticle, type TopicInput, type SourceGatheringResult, type SufficiencyResult } from '../src/agents/articleWriter';

function makeSufficiency(): SufficiencyResult {
  return {
    decision: 'blurb',
    qualifyingFactCount: 3,
    hasCoreWhat: true,
    hasCoreWhen: true,
    conflicts: [],
    disqualifiedFactCount: 0,
    disqualifiedFields: [],
    reasoning: 'test harness — forced blurb decision',
  };
}

type Case = {
  label: string;
  persona: string;
  topic: TopicInput;
  facts: SourceGatheringResult['facts'];
};

const CASES: Case[] = [
  {
    label: 'Stephen A. Spliff — regular (sports)',
    persona: 'stephen-a-spliff',
    topic: { title: "Nolan Arenado's 2-run homer lifts the Diamondbacks past the Astros 3-2", section: 'sports', verdict: 'direct-local' },
    facts: [
      { field: 'result', value: 'Diamondbacks beat Astros 3-2', source: 'AP News', sourceUrl: 'https://apnews.com/article/astros-diamondbacks-score-0b9dfd5fd085076e745c1efa802145b8' },
      { field: 'key play', value: "Nolan Arenado hit a 2-run home run", source: 'AP News' },
      { field: 'series context', value: 'Diamondbacks took the series finale against Houston', source: 'AP News' },
    ],
  },
  {
    label: 'Stephen A. Spliff — unhinged (sports)',
    persona: 'stephen-a-spliff-unhinged',
    topic: { title: "Nolan Arenado's 2-run homer lifts the Diamondbacks past the Astros 3-2", section: 'sports', verdict: 'direct-local' },
    facts: [
      { field: 'result', value: 'Diamondbacks beat Astros 3-2', source: 'AP News', sourceUrl: 'https://apnews.com/article/astros-diamondbacks-score-0b9dfd5fd085076e745c1efa802145b8' },
      { field: 'key play', value: "Nolan Arenado hit a 2-run home run", source: 'AP News' },
      { field: 'series context', value: 'Diamondbacks took the series finale against Houston', source: 'AP News' },
    ],
  },
  {
    label: 'Bill Farr (news)',
    persona: 'bill-farr',
    topic: { title: "'Cinco' is on the move again. Meet all 5 jaguars spotted in Arizona", section: 'news', verdict: 'direct-local' },
    facts: [
      { field: 'what', value: 'A jaguar nicknamed Cinco has been repeatedly photographed by trail cameras in southern Arizona', source: 'azcentral.com', sourceUrl: 'https://www.azcentral.com/story/news/environment/wildlife/2026/09/05/cinco-the-jaguar-is-among-five-big-cats-roaming-arizona/91616099007/' },
      { field: 'context', value: 'Cinco is one of 5 wild jaguars documented in Arizona in recent years, all males believed to have wandered north from Mexico', source: 'azcentral.com' },
      { field: 'agency comment', value: 'Arizona Game and Fish Department says the sightings show the border region remains a jaguar corridor', source: 'azcentral.com' },
    ],
  },
  {
    label: 'Sloan Rivers (nightlife/events)',
    persona: 'sloan-rivers',
    topic: { title: 'Labor Day weekend events: Saboten Con, My Chemical Romance, Zach Bryan, Arizona Black Rodeo and more!', section: 'nightlife', verdict: 'direct-local' },
    facts: [
      { field: 'event 1', value: 'Saboten Con anime convention runs this Labor Day weekend', source: 'ABC15', sourceUrl: 'https://www.abc15.com/entertainment/events/labor-day-weekend-events-saboten-con-my-chemical-romance-zach-bryan-arizona-black-rodeo-asu-football-and-more' },
      { field: 'event 2', value: 'My Chemical Romance and Zach Bryan both have Valley concert dates this weekend', source: 'ABC15' },
      { field: 'event 3', value: 'Arizona Black Rodeo takes place at WestWorld of Scottsdale', source: 'ABC15' },
    ],
  },
];

async function main() {
  for (const c of CASES) {
    console.log(`\n${'='.repeat(80)}\n${c.label}\n${'='.repeat(80)}`);
    const sourcingResult: SourceGatheringResult = {
      topic: c.topic,
      facts: c.facts,
      primarySourceFound: true,
      factCount: c.facts.length,
    };
    const article = await writeArticle(c.topic, sourcingResult, makeSufficiency(), { persona: c.persona as any });
    if (!article) {
      console.log('(writeArticle returned null)');
      continue;
    }
    console.log(`Title: ${article.title}`);
    console.log(`Author: ${article.author}`);
    console.log(`\n${article.bodyMarkdown}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
