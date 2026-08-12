export interface JobScoreHistoryItem {
  id: string;
  evaluationType: string;
  model: string;
  promptVersion: string;
  policyVersion?: string | null;
  schemaVersion?: string | null;
  requestId?: string | null;
  resultHash?: string | null;
  batchId?: string | null;
  batchItemId?: string | null;
  decisionCode?: string | null;
  aimFitScore?: number | null;
  experienceFitScore?: number | null;
  travelScore?: number | null;
  aimReason?: string | null;
  experienceReason?: string | null;
  domainMatch?: boolean | null;
  requiredDomain?: string | null;
  candidateDomain?: string | null;
  qualificationBasis?: 'direct' | 'adjacent' | 'unsupported' | null;
  mandatoryRequirementAssessments?: unknown;
  aimAssessments?: unknown;
  travelAssessment?: unknown;
  compensationAssessment?: unknown;
  inputBindings?: unknown;
  sourceAimEventId?: string | null;
  cleanedJdArtifactId?: string | null;
  workerProvenance?: unknown;
  passed: boolean;
  staleAt?: string | null;
  staleReason?: string | null;
  createdAt: string;
}

export type TravelRange = {
  kind: 'none' | 'point' | 'range' | 'maximum' | 'minimum' | 'qualitative';
  minimumPercent: number;
  maximumPercent: number;
  label: string;
  sourceText: string | null;
};

export type ScoreAuthorityState = 'current' | 'stale_replay_needed' | 'unscored';

export interface JobListItem {
  id: string;
  title: string;
  company: string;
  status: string;
  location?: string | null;
  url?: string | null;
  source?: string | null;
  sourceId?: string | null;
  manualAts?: string | null;
  postedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  contextBatched?: boolean;
  afBatchId?: string | null;
  jdBatchId?: string | null;
  scoringStatus?: string | null;
  scoreAttempts?: number;
  scoreError?: string | null;
  experienceStatus?: string | null;
  fitScore?: number | null;
  aimFitScore?: number | null;
  fitCategory?: string | null;
  tailoringStaged?: boolean;
  reqFitScore?: number | null;
  travelScore?: number | null;
  travelRange?: TravelRange | null;
  description?: string | null;
  contextPacket?: unknown;
  passReason?: string | null;
  fitRationale?: string | null;
  reqFitRationale?: string | null;
  recommendedResume?: string | null;
  compensation?: string | null;
  scoreHistory?: JobScoreHistoryItem[];
  currentScore?: JobScoreHistoryItem | null;
  currentAim?: JobScoreHistoryItem | null;
  currentExperience?: JobScoreHistoryItem | null;
  staleScore?: JobScoreHistoryItem | null;
  staleScoreReason?: string | null;
  scoreAuthorityState?: ScoreAuthorityState;
  [key: string]: unknown;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}
