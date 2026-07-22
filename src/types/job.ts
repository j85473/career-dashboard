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
  luckyStatus?: string | null;
  luckyFitScore?: number | null;
  luckyAimFitScore?: number | null;
  luckyFitCategory?: string | null;
  luckyPassReason?: string | null;
  reqFitScore?: number | null;
  travelScore?: number | null;
  description?: string | null;
  contextPacket?: unknown;
  passReason?: string | null;
  fitRationale?: string | null;
  reqFitRationale?: string | null;
  recommendedResume?: string | null;
  compensation?: string | null;
  scoreHistory?: Array<{
    id: string;
    evaluationType: string;
    model: string;
    promptVersion: string;
    requestId?: string | null;
    aimFitScore?: number | null;
    experienceFitScore?: number | null;
    travelScore?: number | null;
    domainMatch?: boolean | null;
    requiredDomain?: string | null;
    candidateDomain?: string | null;
    passed: boolean;
    createdAt: string;
  }>;
  [key: string]: unknown;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}
