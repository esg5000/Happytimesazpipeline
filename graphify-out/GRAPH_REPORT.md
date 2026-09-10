# Graph Report - .  (2026-09-10)

## Corpus Check
- 0 files · ~99,999 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1043 nodes · 1913 edges · 76 communities (55 shown, 21 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 59 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Google News Slot Publish (Legacy)|Google News Slot Publish (Legacy)]]
- [[_COMMUNITY_Scheduled Cron Sync Jobs|Scheduled Cron Sync Jobs]]
- [[_COMMUNITY_Package Manifest|Package Manifest]]
- [[_COMMUNITY_Dispensary Sync & Categorization|Dispensary Sync & Categorization]]
- [[_COMMUNITY_Sanity Image Upload & Dispensary Sync|Sanity Image Upload & Dispensary Sync]]
- [[_COMMUNITY_Orchestrator V2 Pipeline|Orchestrator V2 Pipeline]]
- [[_COMMUNITY_Pipeline Run Status & Activity Log|Pipeline Run Status & Activity Log]]
- [[_COMMUNITY_Stage 0 Topic Discovery Queries|Stage 0 Topic Discovery Queries]]
- [[_COMMUNITY_Ingest & Topic Agent Dedup|Ingest & Topic Agent Dedup]]
- [[_COMMUNITY_Sufficiency Gate (incl. BusinessDeal Exception)|Sufficiency Gate (incl. Business/Deal Exception)]]
- [[_COMMUNITY_Research Agent (Web Search)|Research Agent (Web Search)]]
- [[_COMMUNITY_Telegram Bot Publish Flow|Telegram Bot Publish Flow]]
- [[_COMMUNITY_Source Gathering Core|Source Gathering Core]]
- [[_COMMUNITY_Event Cleanup & Gemini Probe|Event Cleanup & Gemini Probe]]
- [[_COMMUNITY_Legacy Orchestrator Image Pipeline|Legacy Orchestrator Image Pipeline]]
- [[_COMMUNITY_Restaurant Fetch Script|Restaurant Fetch Script]]
- [[_COMMUNITY_Dispensary Scraper (Playwright)|Dispensary Scraper (Playwright)]]
- [[_COMMUNITY_Sufficiency Gate|Sufficiency Gate]]
- [[_COMMUNITY_Publish Assembly|Publish Assembly]]
- [[_COMMUNITY_Playwright HTML Fetch & Ticketmaster Match|Playwright HTML Fetch & Ticketmaster Match]]
- [[_COMMUNITY_TypeScript Compiler Config|TypeScript Compiler Config]]
- [[_COMMUNITY_Dedupe Feature|Dedupe Feature]]
- [[_COMMUNITY_Article Writer (Stage 5)|Article Writer (Stage 5)]]
- [[_COMMUNITY_Verification Gate|Verification Gate]]
- [[_COMMUNITY_Orchestrator V2 Run Result Types|Orchestrator V2 Run Result Types]]
- [[_COMMUNITY_Writer Agent Personality Routing|Writer Agent Personality Routing]]
- [[_COMMUNITY_App Config & Env Validation|App Config & Env Validation]]
- [[_COMMUNITY_Pipeline API Command Routes|Pipeline API Command Routes]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Unsplash Hero Image Backfill|Unsplash Hero Image Backfill]]
- [[_COMMUNITY_Topic & Writer Agent Dedup Logic|Topic & Writer Agent Dedup Logic]]
- [[_COMMUNITY_Stage 78 Real-Chain Test|Stage 7/8 Real-Chain Test]]
- [[_COMMUNITY_Writer Voice & Section Prompts|Writer Voice & Section Prompts]]
- [[_COMMUNITY_Stage 1 Classification Helpers|Stage 1 Classification Helpers]]
- [[_COMMUNITY_Google News Slot Scoring & Rewrite|Google News Slot Scoring & Rewrite]]
- [[_COMMUNITY_EventImage Sync Helpers|Event/Image Sync Helpers]]
- [[_COMMUNITY_Pipeline README Overview|Pipeline README Overview]]
- [[_COMMUNITY_Stage 34 Test Harness|Stage 3/4 Test Harness]]
- [[_COMMUNITY_Telegram Publish Commands|Telegram Publish Commands]]
- [[_COMMUNITY_Health-Wellness Topic Prompt|Health-Wellness Topic Prompt]]
- [[_COMMUNITY_Event Fact Extraction|Event Fact Extraction]]
- [[_COMMUNITY_Page Text Extraction Heuristics|Page Text Extraction Heuristics]]
- [[_COMMUNITY_Stage 0 SerpAPIBrightData Fetch|Stage 0 SerpAPI/BrightData Fetch]]
- [[_COMMUNITY_Near-Duplicate Detection Heuristics|Near-Duplicate Detection Heuristics]]
- [[_COMMUNITY_Telegram Config & Session Bootstrap|Telegram Config & Session Bootstrap]]
- [[_COMMUNITY_Image Generation Prompt Rules|Image Generation Prompt Rules]]
- [[_COMMUNITY_Article Rewrite Fact Rules|Article Rewrite Fact Rules]]
- [[_COMMUNITY_Article LengthCharacter Caps|Article Length/Character Caps]]
- [[_COMMUNITY_Stage 1 Shadow Comparison|Stage 1 Shadow Comparison]]
- [[_COMMUNITY_Legacy Pipeline ImageResearch Routes|Legacy Pipeline Image/Research Routes]]
- [[_COMMUNITY_Daemon Scheduled Job Wrappers|Daemon Scheduled Job Wrappers]]
- [[_COMMUNITY_Gemini Interactions API Probe|Gemini Interactions API Probe]]
- [[_COMMUNITY_Sanity Article Publish Functions|Sanity Article Publish Functions]]
- [[_COMMUNITY_Ingest & Topic JSON Schemas|Ingest & Topic JSON Schemas]]
- [[_COMMUNITY_Stage 0 Dedupe Test|Stage 0 Dedupe Test]]
- [[_COMMUNITY_README Schema Overview|README Schema Overview]]
- [[_COMMUNITY_EventsSports Prompt Rules|Events/Sports Prompt Rules]]
- [[_COMMUNITY_README Telegram Server Overview|README Telegram Server Overview]]
- [[_COMMUNITY_Section Slug Constants|Section Slug Constants]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 70|Community 70]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]
- [[_COMMUNITY_Community 74|Community 74]]
- [[_COMMUNITY_Community 75|Community 75]]

## God Nodes (most connected - your core abstractions)
1. `getSanityClient()` - 44 edges
2. `config` - 29 edges
3. `scripts` - 22 edges
4. `syncNewsApiToSanity()` - 20 edges
5. `uploadImageBufferToSanity()` - 20 edges
6. `syncSerpApiEventsToSanity()` - 20 edges
7. `registerDaemonApiRoutes()` - 18 edges
8. `validateConfig()` - 17 edges
9. `syncNightlifeToSanity()` - 17 edges
10. `generateSlug()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `runPipeline` --semantically_similar_to--> `syncNewsApiToSanity`  [INFERRED] [semantically similar]
  orchestrator.ts → agents/newsApiSync.ts
- `writeArticle` --semantically_similar_to--> `generateSlug`  [INFERRED] [semantically similar]
  src/agents/articleWriter.ts → utils/slug.ts
- `publishFromSession` --semantically_similar_to--> `publishStoryWithImages`  [INFERRED] [semantically similar]
  telegramBotCore.ts → telegramHttpServer.ts
- `syncDispensariesToSanity` --semantically_similar_to--> `syncRestaurantsForCity`  [INFERRED] [semantically similar]
  agents/syncDispensaries.ts → scripts/fetchRestaurants.ts
- `parseCityFromAddress (agents)` --semantically_similar_to--> `parseCityFromAddress (fetchRestaurants)`  [INFERRED] [semantically similar]
  agents/syncDispensaries.ts → scripts/fetchRestaurants.ts

## Hyperedges (group relationships)
- **Daemon cron-scheduled sync jobs** — daemonServer_runScheduledPipeline, daemonServer_runScheduledSerpApiEventsSync, daemonServer_runScheduledGoogleNewsSync, daemonServer_runScheduledPastEventsCleanup, syncRunLogger_recordSyncRun [EXTRACTED 0.90]
- **Ingest → write → image → publish pattern** — ingestAgent_ingestToTopic, imageAgent_generateImage, sanityPublisher_publishArticleToSanity, editorAgent_scoreArticleQuality [INFERRED 0.85]
- **Telegram draft session flow** — telegramSessionStore_getTelegramSession, telegramSessionStore_persistTelegramSessions, telegramSessionStore_resetTelegramSession, telegramBotCore_publishFromSession [EXTRACTED 0.90]
- **Hero image backfill / generation pipeline** — unsplashHero_fetchUnsplashHeroImageBuffer, backfillHeroImages_run, generateHeroImagesForSlugs_run, schema_post [INFERRED 0.85]
- **SerpApi Google Maps → Sanity patch/upsert pattern** — syncDispensaries_syncDispensariesToSanity, fetchRestaurants_syncRestaurantsForCity, schema_dispensary, schema_restaurant [INFERRED 0.85]
- **Topic generation → article writing content pipeline** — topicAgent_generateTopics, writerAgent_writeArticle, schema_post [INFERRED 0.85]
- **Stage 3 Event Source Checker Ladder** — sourceGathering_gatherTicketmasterEventSources, sourceGathering_gatherWuevEventSources, sourceGathering_gatherDtphxEventSources, sourceGathering_gatherEventSources [EXTRACTED 1.00]
- **Pipeline V2 Stage 3-8 Chain** — sourceGathering_gatherSources, sufficiencyGate_evaluateSufficiency, articleWriter_writeArticle, verificationGate_verifyArticle, imageSourcing_sourceImage, publishAssembly_assemblePublishDocument [EXTRACTED 1.00]
- **Ported (Not Imported) Helper Duplication** — researchAgent_htmlToPlainText, sourceGathering_htmlToPlainText, researchAgent_fetchPagePlainTextWithPlaywright, sourceGathering_fetchPagePlainTextWithPlaywright [INFERRED 0.85]
- **Two Parallel Daily-Run Paths (GitHub Actions vs Daemon)** — readme_github_actions_workflow, readme_daemonServer, readme_node_cron, readme_orchestrator [EXTRACTED 1.00]
- **Topic-Write-Image-Publish Agent Chain** — readme_topicAgent, readme_writerAgent, readme_imageAgent, readme_sanityPublisher, readme_orchestrator [EXTRACTED 1.00]
- **Personality Voices Mapped to Content Sections** — personality_fat_jimmy, personality_health_nut, personality_sonny_blaze, section_food_prompt, section_health_wellness_prompt, section_cannabis_prompt [INFERRED 0.85]

## Communities (76 total, 21 thin omitted)

### Community 0 - "Google News Slot Publish (Legacy)"
Cohesion: 0.05
Nodes (60): EditorScoreResult, scoreArticleQuality(), applyGoogleNewsScoringOverrides(), buildSlot2Queries(), capSlotPoolByRecency(), fetchSerpGoogleNews(), fetchSlotCandidatePool(), flattenGoogleNewsResults() (+52 more)

### Community 1 - "Scheduled Cron Sync Jobs"
Cohesion: 0.05
Nodes (66): AZ_CITY_HINTS, BONUS_NON_EVENT_TOPIC, buildDtphxEventFacts(), buildEventsQuery(), buildFetchCandidates(), buildSerpApiEventFacts(), buildTicketmasterEventFacts(), buildVenuePageFacts() (+58 more)

### Community 2 - "Package Manifest"
Cohesion: 0.08
Nodes (41): deactivatePastEvents(), getSanityClient(), buildUnsplashSearchQuery(), pickHighestResolutionPhoto(), triggerUnsplashDownload(), UnsplashPhotoRow, UnsplashSearchResponse, config (+33 more)

### Community 3 - "Dispensary Sync & Categorization"
Cohesion: 0.04
Nodes (47): author, dependencies, axios, dotenv, express, form-data, grammy, multer (+39 more)

### Community 4 - "Sanity Image Upload & Dispensary Sync"
Cohesion: 0.06
Nodes (38): buildSearchQuery (backfill), fetchPostsWithoutHeroImage, patchHeroImage (backfill), backfillHeroImages run(), formatDateRange, logPotentialRecurringByTitlePrefix, cleanupEvents main(), matchesFamilyDeleteKeywords (+30 more)

### Community 5 - "Orchestrator V2 Pipeline"
Cohesion: 0.11
Nodes (31): uploadImageToSanity(), dedupeKey(), documentIdFromKey(), formatHours(), inferCategories(), looksLikeCannabisDispensary(), normalizeKeyPart(), parseCityFromAddress() (+23 more)

### Community 6 - "Pipeline Run Status & Activity Log"
Cohesion: 0.07
Nodes (34): writeArticle, buildDedupeKey, checkForDuplicates, Pipeline V2 Stage 0-9 Funnel, buildQueryLadder, generateImageWithGptImage1, sourceImage, resolveCategoryDocId (orchestratorV2) (+26 more)

### Community 7 - "Stage 0 Topic Discovery Queries"
Cohesion: 0.06
Nodes (29): AZ_PLACE_NAME_RE, AZ_PLACE_NAMES, ComparisonResult, LOW_VALUE_STUB_DOMAINS, NearDuplicateMerge, NON_PLURAL_S_WORDS, OpenAiUsageBucket, OpenAiUsageTotals (+21 more)

### Community 8 - "Ingest & Topic Agent Dedup"
Cohesion: 0.09
Nodes (23): countPostDocuments(), uploadVideoBufferToSanity(), transcribeAudio(), RunPipelineOptions, activityLog, ActivityLogEntry, appendActivityLog(), getPipelineStatusSnapshot() (+15 more)

### Community 9 - "Sufficiency Gate (incl. Business/Deal Exception)"
Cohesion: 0.10
Nodes (25): buildReasoning(), BusinessDealCheck, checkBusinessDealPath(), countSubstantialSentences(), decideFormat(), detectConflicts(), disqualifyContentReason(), DOMAIN_SUFFICIENCY_OVERRIDES (+17 more)

### Community 10 - "Research Agent (Web Search)"
Cohesion: 0.16
Nodes (22): IMAGE_PROMPT_PATH, getExistingSlugs(), applyMergePublishNotes(), downloadTelegramFile(), downloadTelegramFileWithMeta(), executeTelegramDaemonCommand(), publishFromSession(), PublishSource (+14 more)

### Community 11 - "Telegram Bot Publish Flow"
Cohesion: 0.12
Nodes (24): AMBIGUOUS_TERM_RULES, applyDisambiguation(), buildAiAltText(), buildAltText(), buildImageGenerationPrompt(), buildImageSearchQuery(), buildQueryLadder(), dedupeAndCleanTerms() (+16 more)

### Community 12 - "Source Gathering Core"
Cohesion: 0.15
Nodes (24): buildEnrichedNotes(), clampScore(), enrichTopSourcesWithFetchedPageText(), extractOutputTextFromResponse(), extractSearchQueries(), extractTargetedResearchAngles(), factCheckArticleMarkdownAnthropic(), FactCheckWarning (+16 more)

### Community 13 - "Event Cleanup & Gemini Probe"
Cohesion: 0.13
Nodes (21): INGEST_PROMPT_PATH, IngestInput, ingestToTopic(), fetchRecentPostTitles(), generateSingleTopic(), generateTopics(), GenerateTopicsOptions, isCloseTitleMatch() (+13 more)

### Community 14 - "Legacy Orchestrator Image Pipeline"
Cohesion: 0.14
Nodes (20): AXIOS_REDIRECT_OPTS, COMMON_DEALS_PATHS, DEALS_URL_MAP, DispensaryRow, findDealsUrl(), getFinalUrlFromAxiosResponse(), joinUrl(), loadPage() (+12 more)

### Community 15 - "Restaurant Fetch Script"
Cohesion: 0.16
Nodes (22): buildTicketmasterClassificationSummary(), documentIdFromTitle(), extractTicketmasterVenueFields(), fetchTicketmasterEventsForCity(), isExcludedAudience(), matchesHappyTimesCategories(), normalizeTitle(), parseTicketmasterStartIso() (+14 more)

### Community 16 - "Dispensary Scraper (Playwright)"
Cohesion: 0.17
Nodes (21): asFiniteNumber(), asNonEmptyString(), asStringArray(), CITIES, extractSerpApiImageUrl(), fetchMapsPage(), isRestaurantLike(), { runFetchRestaurants } (+13 more)

### Community 17 - "Sufficiency Gate"
Cohesion: 0.22
Nodes (18): generateImage(), generateImagePrompt(), generateAndUploadHeroForGoogleNews(), appendSourcesSectionMarkdown(), ResearchAndWriteOptions, ResearchAndWriteResult, runResearchAndWrite(), publishArticleToSanity() (+10 more)

### Community 18 - "Publish Assembly"
Cohesion: 0.15
Nodes (15): downloadImage(), publishAssembledDocument(), autoFeatureIfStale(), FeaturedPostSnapshot, getCurrentFeaturedPost(), GOOGLE_NEWS_SYNC_SLOT_IDS, GoogleNewsPublishMeta, GoogleNewsSyncSlotId (+7 more)

### Community 19 - "Playwright HTML Fetch & Ticketmaster Match"
Cohesion: 0.14
Nodes (18): assemblePublishDocument(), buildDisclaimer(), deriveCategoriesAndRef(), extractEntity(), HarnessFact, HarnessSourceGatheringResult, HarnessTopicInput, ImageResultInput (+10 more)

### Community 20 - "TypeScript Compiler Config"
Cohesion: 0.11
Nodes (17): compilerOptions, declaration, declarationMap, esModuleInterop, forceConsistentCasingInFileNames, lib, module, moduleResolution (+9 more)

### Community 21 - "Dedupe Feature"
Cohesion: 0.15
Nodes (13): deriveOutletLabel(), Fact, FactConflict, fallbackSlug(), FormatDecision, runTestHarness(), SourceCredit, SourceGatheringResult (+5 more)

### Community 22 - "Article Writer (Stage 5)"
Cohesion: 0.22
Nodes (16): AZ_CITY_HINTS, buildDedupeKey(), checkForDuplicates(), DedupeCandidateInput, DedupeCheckResult, DedupeMatch, deriveDedupeKeyFromExistingPost(), extractCityHint() (+8 more)

### Community 23 - "Verification Gate"
Cohesion: 0.17
Nodes (15): applyWriterArticleLengthSafetyTruncate(), buildPersonalityPromptAppend(), buildSectionPromptAppend(), PERSONALITY_BY_SECTION, PERSONALITY_PROMPT_DIR, SECTION_PROMPT_DIR, SECTION_PROMPT_FILES, truncateBodyMarkdownAtLastSentence() (+7 more)

### Community 24 - "Orchestrator V2 Run Result Types"
Cohesion: 0.15
Nodes (12): Fact, HarnessSourceGatheringResult, HarnessTopicInput, MechanicalCheckResult, ProseCheckResult, runMechanicalCheck(), runProseFidelityCheck(), runTestHarness() (+4 more)

### Community 25 - "Writer Agent Personality Routing"
Cohesion: 0.18
Nodes (13): DroppedTopic, OrchestratorV2PublishRunResult, OrchestratorV2RunResult, PublishedTopic, RealPublishFailure, RealPublishRecord, resolveCategoryDocId(), runOrchestratorV2() (+5 more)

### Community 26 - "App Config & Env Validation"
Cohesion: 0.20
Nodes (14): runPipelineJob, appendActivityLog, getPipelineStatusSnapshot, recordScheduledPipelineFinish, countPostDocuments, registerDaemonApiRoutes, POST /api/command /publish route, POST /api/command runWriter route (+6 more)

### Community 28 - "Community 28"
Cohesion: 0.17
Nodes (12): fetchRecentPostTitles, generateSingleTopic (topicAgent), generateTopics, isCloseTitleMatch, normalizeTitleForDedup, PERSONALITY_BY_SECTION, applyWriterArticleLengthSafetyTruncate, buildPersonalityPromptAppend (+4 more)

### Community 29 - "Unsplash Hero Image Backfill"
Cohesion: 0.24
Nodes (10): Fat Jimmy (Food/Nightlife Voice), Sonny Blaze (Cannabis Voice), cannabis.prompt.txt (section), food.prompt.txt (section), Local Specificity Rule (shared section snippet), Phoenix Nightlife Not Club-Heavy Rule, nightlife.prompt.txt (section), Ground Topics in Real Places Rule (3-5 named businesses) (+2 more)

### Community 30 - "Topic & Writer Agent Dedup Logic"
Cohesion: 0.29
Nodes (10): buildCandidateStoryBlock(), buildPrompt(), buildStage1ClassificationCriteria(), Candidate, CANDIDATES, extractInteractionOutputText(), main(), probeOne() (+2 more)

### Community 31 - "Stage 7/8 Real-Chain Test"
Cohesion: 0.24
Nodes (10): WrittenArticle, ImageSourcingOutcome, AssemblyResult, main(), REAL_TOPICS, RealTopic, resolveCategoryDocId(), runOne() (+2 more)

### Community 32 - "Writer Voice & Section Prompts"
Cohesion: 0.27
Nodes (11): buildCandidateStoryBlock(), buildStage1ClassificationCriteria(), clampScore(), extractOutputTextFromResponse(), mergeSearchSummariesByUrl(), normalizeUrl(), openaiResponsesCall(), parseStage1Fields() (+3 more)

### Community 33 - "Stage 1 Classification Helpers"
Cohesion: 0.20
Nodes (10): public/images/hero README, daemonServer.ts, Deterministic Pipeline Design, Pipeline Error Handling Policy, daily-pipeline.yml (GitHub Actions), node-cron scheduler (PIPELINE_CRON), orchestrator.ts, HappyTimesAZ AI Publishing Pipeline (+2 more)

### Community 34 - "Google News Slot Scoring & Rewrite"
Cohesion: 0.22
Nodes (10): editorAgent openAiJson, scoreArticleQuality, fetchSerpGoogleNews, fetchSlotCandidatePool, rewriteArticle, rewriteArticleWithSlotRules, runSlotPickTopN, scoreAndGate (+2 more)

### Community 35 - "Event/Image Sync Helpers"
Cohesion: 0.20
Nodes (10): deactivatePastEvents, downloadImage, getSanityClient, uploadImageToSanity, buildTicketmasterClassificationSummary, fetchTicketmasterEventsForCity, isExcludedAudience, matchesHappyTimesCategories (+2 more)

### Community 36 - "Pipeline README Overview"
Cohesion: 0.22
Nodes (8): The Health Nut (Wellness Voice), topicAgent.ts, topic.prompt.txt, No Clinical/Medical Content Rule, health-wellness.prompt.txt (section), Avoid Repetition / Vary Angle Rule, Health-Wellness Lifestyle-Only Scope Rule, Greater Phoenix Metro Coverage Area

### Community 37 - "Stage 3/4 Test Harness"
Cohesion: 0.31
Nodes (9): ingestToTopic, getExistingSlugs, applyMergePublishNotes, executeTelegramDaemonCommand, publishFromSession, publishStoryFromSourceNotes, publishStoryWithImages, getTelegramSession (+1 more)

### Community 38 - "Telegram Publish Commands"
Cohesion: 0.22
Nodes (9): buildGoogleNewsSearchUrl(), extractSourceOutlet(), fetchBrightDataNewsForQuery(), fetchSerpNewsForQuery(), fetchStage0NewsForQuery(), flattenBrightDataNewsResults(), flattenStage0Results(), parsePublishedDate() (+1 more)

### Community 39 - "Health-Wellness Topic Prompt"
Cohesion: 0.22
Nodes (9): extractAzPlaceNames(), extractDateTokens(), extractLeadingListicleCount(), hasConflictingDateTokens(), hasConflictingListicleCounts(), hasConflictingPlaceNames(), isMoreCompleteRepresentative(), jaccardSimilarity() (+1 more)

### Community 40 - "Event Fact Extraction"
Cohesion: 0.39
Nodes (7): AuditCategory, auditDispensaryWebsiteUrls(), checkUrlOnce(), classifyHttpStatus(), DispensaryRow, main(), normalizeWebsiteUrl()

### Community 41 - "Page Text Extraction Heuristics"
Cohesion: 0.29
Nodes (6): Hard Character Caps (bodyMarkdown 6500 / excerpt 180 / seoDescription 155 / seoTitle 70), List/Roundup Rule (Google News Rewrite), bodyMarkdown/excerpt Hard Character Caps, List & Roundup Rules (writer base), Writer Base Article JSON Schema, seoDescription 155-char Hard Limit (Sanity 160 cap)

### Community 42 - "Stage 0 SerpAPI/BrightData Fetch"
Cohesion: 0.29
Nodes (7): FACE RULE (no frontal faces), Apple News Editorial Photography Prompt Structure, VISUAL_STYLE Enum (editorial_realistic, cinematic_hyperreal, film_35mm_grain, documentary_candid, neon_night_street, illustrated_watercolor, bold_vector_flat, playful_cartoon, clay_3d), DALL·E 2 image generation (1024x1024), imageAgent.ts, image.prompt.txt, Visual Style Selection Rules (writer base)

### Community 43 - "Near-Duplicate Detection Heuristics"
Cohesion: 0.29
Nodes (7): Stay-Factual / No-Invention Rule (Google News Rewrite), Attribution Rule (outlet + link), Conflict Handling Rule (disputed facts), HARD RULE - Facts Only (Stage 5 Write), Stage 5 Article JSON Schema (with factsUsed/sourceCredits), Title Hard Cap (under 100 chars, crash-prevention), Writer Article JSON Schema

### Community 44 - "Telegram Config & Session Bootstrap"
Cohesion: 0.25
Nodes (8): validateConfig, validateTelegramBaseConfig, registerTelegramHandlers, startApiServer, telegramPollingDev main, telegramServer main, hydrateTelegramSessionsFromDisk, persistTelegramSessions

### Community 45 - "Image Generation Prompt Rules"
Cohesion: 0.25
Nodes (8): compareAgainstTodaysSlotOutput(), fetchTodaysGoogleNewsPostsFromSanity(), getOpenAiUsageTotals(), passesEditorialAppropriatenessGate(), resetOpenAiUsageTotals(), runStage1Batched(), runTopicDiscoveryShadow(), writeShadowLog()

### Community 46 - "Article Rewrite Fact Rules"
Cohesion: 0.48
Nodes (7): generateImage, generateImagePrompt, generateAndUploadHeroForGoogleNews, runPipeline, runResearchAndWrite, uploadImageBufferToSanity, POST /api/command/researchAndWrite route

### Community 47 - "Article Length/Character Caps"
Cohesion: 0.60
Nodes (6): daemonServer main, runScheduledGoogleNewsSync, runScheduledPastEventsCleanup, runScheduledPipeline, runScheduledSerpApiEventsSync, recordSyncRun

### Community 48 - "Stage 1 Shadow Comparison"
Cohesion: 0.40
Nodes (6): buildPrompt (probe), buildStage1ClassificationCriteria (copied from topicDiscovery.ts), extractInteractionOutputText, probe-gemini main(), probeOne, Gemini Interactions API vs legacy endpoint 503 investigation

### Community 49 - "Legacy Pipeline Image/Research Routes"
Cohesion: 0.40
Nodes (4): Editor Notes as Direct Story Brief, Topic JSON Schema (title, section, description, keywords), Topic Output JSON Schema (title, section, description, keywords), PRIMARY SOURCE MATERIAL Mandate Rule

### Community 50 - "Daemon Scheduled Job Wrappers"
Cohesion: 0.50
Nodes (5): autoFeatureIfStale, markdownToPortableText, publishArticleToSanity, publishGoogleNewsArticleToSanity, resolveGoogleNewsPrimaryCategorySlug

### Community 51 - "Gemini Interactions API Probe"
Cohesion: 0.50
Nodes (4): capStage0PoolByRecency(), dedupeStage0Pool(), runStage0Discovery(), main()

### Community 52 - "Sanity Article Publish Functions"
Cohesion: 0.50
Nodes (4): Article Output Schema, sanityPublisher.ts, Sanity CMS Integration (post schema), validator.ts

### Community 53 - "Ingest & Topic JSON Schemas"
Cohesion: 0.50
Nodes (4): events.prompt.txt (section), Only Reference Real Verifiable Recurring Events Rule, No Fabricated Player Stats/Scores Rule, sports.prompt.txt (section)

### Community 54 - "Stage 0 Dedupe Test"
Cohesion: 0.67
Nodes (3): telegramHttpServer.ts, telegramPollingDev.ts, telegramServer.ts

### Community 55 - "README Schema Overview"
Cohesion: 0.67
Nodes (3): SECTION_VALUES (publishAssembly), ArticleSchema, SECTION_SLUGS

## Ambiguous Edges - Review These
- `syncRun schema` → `cleanupEvents main()`  [AMBIGUOUS]
  schemas/syncRun.ts · relation: conceptually_related_to
- `HappyTimesAZ AI Publishing Pipeline` → `public/images/hero README`  [AMBIGUOUS]
  public/images/hero/README.txt · relation: conceptually_related_to

## Knowledge Gaps
- **376 isolated node(s):** `requiredEnvVars`, `PipelineResult`, `name`, `version`, `description` (+371 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `syncRun schema` and `cleanupEvents main()`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `HappyTimesAZ AI Publishing Pipeline` and `public/images/hero README`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `config` connect `Package Manifest` to `Google News Slot Publish (Legacy)`, `Scheduled Cron Sync Jobs`, `Orchestrator V2 Pipeline`, `Stage 0 Topic Discovery Queries`, `Ingest & Topic Agent Dedup`, `Research Agent (Web Search)`, `Telegram Bot Publish Flow`, `Source Gathering Core`, `Event Cleanup & Gemini Probe`, `Restaurant Fetch Script`, `Dispensary Scraper (Playwright)`, `Sufficiency Gate`, `Publish Assembly`, `Dedupe Feature`, `Verification Gate`, `Orchestrator V2 Run Result Types`, `Topic & Writer Agent Dedup Logic`?**
  _High betweenness centrality (0.090) - this node is a cross-community bridge._
- **Why does `getSanityClient()` connect `Package Manifest` to `Google News Slot Publish (Legacy)`, `Orchestrator V2 Pipeline`, `Stage 0 Topic Discovery Queries`, `Event Fact Extraction`, `Ingest & Topic Agent Dedup`, `Research Agent (Web Search)`, `Event Cleanup & Gemini Probe`, `Legacy Orchestrator Image Pipeline`, `Restaurant Fetch Script`, `Image Generation Prompt Rules`, `Sufficiency Gate`, `Publish Assembly`, `Playwright HTML Fetch & Ticketmaster Match`, `Dispensary Scraper (Playwright)`, `Article Writer (Stage 5)`, `Writer Agent Personality Routing`, `Stage 7/8 Real-Chain Test`?**
  _High betweenness centrality (0.042) - this node is a cross-community bridge._
- **Why does `uploadImageBufferToSanity()` connect `Sufficiency Gate` to `Google News Slot Publish (Legacy)`, `Package Manifest`, `Ingest & Topic Agent Dedup`, `Research Agent (Web Search)`, `Telegram Bot Publish Flow`, `Legacy Orchestrator Image Pipeline`, `Publish Assembly`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Are the 5 inferred relationships involving `getSanityClient()` (e.g. with `resolveCategoryDocId()` and `publishAssembledDocument()`) actually correct?**
  _`getSanityClient()` has 5 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `uploadImageBufferToSanity()` (e.g. with `runTestHarness()` and `publishAssembledDocument()`) actually correct?**
  _`uploadImageBufferToSanity()` has 2 INFERRED edges - model-reasoned connections that need verification._