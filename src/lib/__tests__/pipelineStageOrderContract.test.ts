import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function source(...segments: string[]): string {
  return readFileSync(path.join(process.cwd(), ...segments), 'utf8');
}

const ingestion = source('src', 'lib', 'jobIngestion.ts');
const localScoring = source('src', 'lib', 'jobScoring.ts');
const jdRecovery = source('src', 'app', 'api', 'jobs', 'batch-jd-submit', 'route.ts');
const pipeline = source('src', 'app', 'api', 'pipeline', 'run', 'route.ts');
const extractionRoute = source('src', 'app', 'api', 'pipeline', 'extraction', 'route.ts');
const queues = source('src', 'lib', 'jobListQuery.ts');

test('the pipeline continuously supervises ingestion, local scoring, and JD recovery', () => {
  assert.match(pipeline, /superviseLoop\('Ingestion', runIngestionLoop\)/);
  assert.match(pipeline, /superviseLoop\('ATS Ingestion', runAtsIngestionLoop\)/);
  assert.match(pipeline, /superviseLoop\('Local Scoring', runLocalScoringLoop\)/);
  assert.match(pipeline, /superviseLoop\('JD Extraction', runJDExtraction\)/);
  assert.match(pipeline, /await Promise\.allSettled\(\[/);
});

test('ingestion routes complete JDs to local scoring and incomplete JDs to recovery', () => {
  assert.match(ingestion, /const enrichedPostingClosed = isClosedJobPosting\(finalDescription\)/);
  assert.match(ingestion, /const needsJd = !enrichedPostingClosed && !isScorableJobDescription\(finalDescription, \{ structuredSource: true \}\)/);
  assert.match(
    ingestion,
    /scoringStatus: lifecycleProtectedSource[\s\S]*?: enrichedPostingClosed \? 'skipped' : needsJd \? 'needs_jd' : 'queued'/,
  );
});

test('ingestion applies affirmative non-English information before description recovery', () => {
  const languageIndex = ingestion.indexOf('const availableLanguage = assessJobInfoLanguage({');
  const atsIndex = ingestion.indexOf('atsResult = await scrapeAtsApi(', languageIndex);
  const detailsIndex = ingestion.indexOf('const scraped = await tryFetchFullDescription({', languageIndex);

  assert.ok(languageIndex >= 0, 'ingestion language gate is missing');
  assert.ok(atsIndex > languageIndex, 'ATS enrichment must follow the language gate');
  assert.ok(detailsIndex > languageIndex, 'details recovery must follow the language gate');
  assert.match(ingestion, /&& !availableLanguage\.isAffirmativelyNonEnglish/);
});

test('confirmed closed postings are dismissed unless the Manual Import lifecycle is protected', () => {
  assert.match(ingestion, /const machineInitialStatus = lifecycleProtectedSource[\s\S]*?: enrichedPostingClosed[\s\S]*?\? 'dismissed'/);
  assert.match(localScoring, /if \(closed\)[\s\S]*?buildClosedPostingUpdate\(\)/);
  assert.match(jdRecovery, /existingDecision\.kind === 'closed'[\s\S]*?buildClosedPostingUpdate\(\)/);
  assert.match(jdRecovery, /recoveryDecision\.kind === 'closed'[\s\S]*?buildClosedPostingUpdate\(\)/);
});

test('local scoring either withholds deterministically or hands eligible jobs to Aim', () => {
  assert.match(localScoring, /scoringStatus: 'queued'/);
  assert.match(localScoring, /scoringStatus: deterministicallyRejected \? 'skipped' : 'scored'/);
  assert.match(localScoring, /currentJob\.source === 'Manual Import' \? currentJob\.status : 'dismissed'/);
});

test('local scoring applies affirmative non-English information before its JD resolver', () => {
  const languageIndex = localScoring.indexOf('const availableLanguage = assessJobInfoLanguage({');
  const resolveIndex = localScoring.indexOf('const resolved = await resolveFullDescription(scoringJob)', languageIndex);

  assert.ok(languageIndex >= 0, 'local scoring language gate is missing');
  assert.ok(resolveIndex > languageIndex, 'local scoring JD resolution must follow the language gate');
  assert.match(localScoring, /availableLanguage\.isAffirmativelyNonEnglish && !lifecycleProtected/);
  assert.match(localScoring, /passReason: availableLanguage\.reason/);
});

test('successful JD recovery returns the same jobs to local scoring before Aim', () => {
  const queueUpdate = jdRecovery.indexOf("scoringStatus: 'queued'");
  const localRetry = jdRecovery.indexOf('await scoreJobs(undefined, request.signal, {');
  assert.ok(queueUpdate >= 0, 'JD recovery must return successful descriptions to queued');
  assert.ok(localRetry > queueUpdate, 'local scoring must run after JD recovery queues the jobs');
  assert.match(jdRecovery, /jobIds: claimedJobs\.map\(\(job\) => job\.id\)/);
  assert.doesNotMatch(extractionRoute, /Waiting for Jina/);
});

test('Aim only receives locally scored jobs and Experience only receives Aim-scored jobs', () => {
  assert.match(queues, /case 'aim_fit':[\s\S]*?scoringStatus: 'scored'/);
  assert.match(queues, /case 'aim_fit':[\s\S]*?aimFitScore: null/);
  assert.match(queues, /case 'experience_fit':[\s\S]*?aimFitScore: \{ not: null \}/);
  assert.match(queues, /case 'experience_fit':[\s\S]*?reqFitScore: null/);
});
