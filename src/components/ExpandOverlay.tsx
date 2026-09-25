import React, { useState } from 'react';
import { Bookmark, CheckCircle, XCircle, ExternalLink, AlertTriangle, Edit2, Loader2, Save, Copy } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { identifyAts, ATS_OPTIONS } from '@/lib/atsUtils';
import { useModalDialog } from '@/hooks/useModalDialog';
import { showAlert, showConfirm, showOptions } from '@/lib/modal';
import type { JobListItem } from '@/types/job';
import { travelOpportunityTier } from '@/lib/travelOpportunity';
import { TravelRangeTrack } from '@/components/TravelRangeTrack';
import { aimDisplayFromAssessment, aimScoreFillClass } from '@/lib/aimDisplay';
import { companyDisplayName } from '@/lib/companyPresentation';
import { ALREADY_APPLIED_REASON, isAppliedDuplicateReason } from '@/lib/appliedDuplicatePolicy';

type HiddenRepeat = { id: string; title: string; company: string; location: string | null; source: string | null; dismissedAt: string };
type CombinedCopy = { id: string; title: string; company: string; location: string | null; source: string | null; url: string | null; combinedAt: string; automatic: boolean };
/** Mirrors CONSOLIDATED_REASON_PREFIX (src/lib/jobUrlReconciliation.ts), which is server-only. */
const COMBINED_REASON_PREFIX = 'Consolidated after URL edit into job ';

type DuplicateMergeReviewCard = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  status: string;
  source: string | null;
  url: string | null;
  tailoringStaged: boolean;
  hasSubmittedResume: boolean;
  aimFitScore: number | null;
  reqFitScore: number | null;
};

type DuplicateMergeScorePlan = {
  value: number | null;
  mode: 'none' | 'preserved' | 'carried' | 'average';
  sources: Array<{ jobId: string; eventId: string; value: number }>;
};

type DuplicateMergeReview = {
  conflictMessage: string;
  cards: [DuplicateMergeReviewCard, DuplicateMergeReviewCard];
  plan: {
    survivorId: string;
    redundantId: string;
    survivorStatus: string;
    survivorReason: string;
    blockedReason: string | null;
    aim: DuplicateMergeScorePlan;
    experience: DuplicateMergeScorePlan;
  };
};

interface ExpandOverlayProps {
  job: JobListItem;
  onClose: () => void;
  onStatusChange: (id: string, status: string, reason?: string) => void | Promise<void>;
  onToggleTailoring?: (id: string, isStaged: boolean) => void;
  onJobUpdate?: (id: string, updates: Partial<JobListItem>) => void;
  onCompanySelect: (company: string) => void;
  primaryScore?: 'aim' | 'experience';
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for browsers that expose the API but deny the write.
    }
  }

  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', '');
  textArea.style.position = 'fixed';
  textArea.style.top = '0';
  textArea.style.left = '-9999px';
  textArea.style.opacity = '0';
  document.body.appendChild(textArea);

  try {
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);
    if (!document.execCommand('copy')) {
      throw new Error('The browser rejected the clipboard copy command.');
    }
  } finally {
    textArea.remove();
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asRecords = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => item !== null) : [];
const textValue = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value ? value : fallback;
const evidenceIds = (leaf: Record<string, unknown>) => [...asRecords(leaf.support), ...asRecords(leaf.conflict)]
  .map((binding) => typeof binding.evidenceId === 'string' ? binding.evidenceId : null)
  .filter((id): id is string => id !== null);



export function ExpandOverlay({ job: initialJob, onClose, onStatusChange, onToggleTailoring, onJobUpdate, onCompanySelect, primaryScore = 'aim' }: ExpandOverlayProps) {
  const dialogRef = useModalDialog(onClose);
  const [job, setJob] = useState(initialJob);
  const companyLabel = companyDisplayName(job.company, job.source);
  const [passReason, setPassReason] = useState('');
  const [passReasonType, setPassReasonType] = useState('Not interested');
  const [showPassInput, setShowPassInput] = useState(false);


  const [isEditingJD, setIsEditingJD] = useState(false);
  const [manualJD, setManualJD] = useState(initialJob.description || '');
  const [isLoadingJD, setIsLoadingJD] = useState(!initialJob?.description);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scoreAuthorityLoading, setScoreAuthorityLoading] = useState(!initialJob.scoreAuthorityState);
  const [isEditingMeta, setIsEditingMeta] = useState(false);
  const [manualTitle, setManualTitle] = useState(initialJob.title || '');
  const [manualCompany, setManualCompany] = useState(initialJob.company || '');
  const [manualLocation, setManualLocation] = useState(initialJob.location || '');
  const [directUrl, setDirectUrl] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [hiddenRepeats, setHiddenRepeats] = useState<HiddenRepeat[]>([]);
  const [restoringRepeat, setRestoringRepeat] = useState(false);
  const [combinedCopies, setCombinedCopies] = useState<CombinedCopy[]>([]);
  const [separatingId, setSeparatingId] = useState<string | null>(null);
  const [mergeReview, setMergeReview] = useState<DuplicateMergeReview | null>(null);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeError, setMergeError] = useState('');
  const [mergeCompleted, setMergeCompleted] = useState('');
  const [linkUpdateError, setLinkUpdateError] = useState('');
  const isApplicationCard = job?.status === 'applied' || job?.status === 'interviewing';

  // An applied card lists the copies that were hidden because they repeat it,
  // so a wrong match is one click away instead of buried in Dismissed.
  React.useEffect(() => {
    if (!job?.id || !isApplicationCard) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHiddenRepeats([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/jobs/${job.id}/repeats`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { repeats: [] }))
      .then((data) => setHiddenRepeats(Array.isArray(data.repeats) ? data.repeats : []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [job?.id, isApplicationCard]);

  // Any card can hold copies of the same job that arrived from other sources.
  const isCombinedCopy = job.status === 'dismissed' && Boolean(job.passReason?.startsWith(COMBINED_REASON_PREFIX));
  React.useEffect(() => {
    if (!job?.id || isCombinedCopy) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCombinedCopies([]);
      return;
    }
    const controller = new AbortController();
    fetch(`/api/jobs/${job.id}/combined`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : { copies: [] }))
      .then((data) => setCombinedCopies(Array.isArray(data.copies) ? data.copies : []))
      .catch(() => undefined);
    return () => controller.abort();
  }, [job?.id, isCombinedCopy]);

  React.useEffect(() => {
    if (!initialJob?.id) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setJob(initialJob);
    setScoreAuthorityLoading(true);

    if (initialJob.description) {
      setManualJD(initialJob.description);
      setIsLoadingJD(false);
      setLoadError(null);
    } else {
      setIsLoadingJD(true);
      setLoadError(null);
    }

    let cancelled = false;
    const controller = new AbortController();

    // Always load authoritative score provenance. A list item contains scalar
    // projections only and must never be trusted when the newest score event
    // may have been invalidated.
    fetch(`/api/jobs/${initialJob.id}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 100)}`);
        }
        return res.json();
      })
      .then((data) => {
        if (!cancelled && data?.job) {
          setJob(data.job);
          setManualJD(data.job.description || '');
        } else if (!cancelled && !data?.job) {
          setLoadError("API returned OK but 'job' field missing.");
        }
      })
      .catch((err) => {
        if (!cancelled && !(err instanceof DOMException && err.name === 'AbortError')) {
          console.warn('Failed to load job details', err);
          if (!initialJob.description) setLoadError(err.message || String(err));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingJD(false);
          setScoreAuthorityLoading(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJob?.id]);

  if (!job) return null;

  const scoreAuthorityState = job.scoreAuthorityState;
  const currentScore = scoreAuthorityState === 'current' ? job.currentScore ?? null : null;
  const currentAim = job.aimAuthorityState === 'current' ? job.currentAim ?? null : null;
  const currentExperience = job.experienceAuthorityState === 'current' ? job.currentExperience ?? null : null;
  const staleScore = scoreAuthorityState === 'stale_replay_needed' ? job.staleScore ?? null : null;
  const scoreAuthorityPending = scoreAuthorityLoading || scoreAuthorityState === undefined;
  const shouldConfirmBeforeRescore = currentScore != null
    || job.fitScore != null
    || !['pending_af'].includes(job.status);

  const rawScore = currentAim?.aimFitScore ?? currentScore?.aimFitScore ?? null;
  const hasAimScore = rawScore != null;
  const score = rawScore ?? 0;
  const aimDisplayBand = hasAimScore && currentAim
    && ['career-dashboard-aim-result-v2', 'career-dashboard-duplicate-score-merge-v1'].includes(currentAim.schemaVersion || '')
    ? aimDisplayFromAssessment(currentAim.aimAssessments, score)
    : null;
  const isDismissedForCurrentMode = job.status === 'passed' || job.status === 'dismissed';
  let scoreColor = hasAimScore ? 'fill-red' : 'fill-muted';
  let bucket = 'c';
  if (!hasAimScore) {
    scoreColor = 'fill-muted';
  } else if (isDismissedForCurrentMode) {
    scoreColor = 'fill-red';
    bucket = 'c';
  } else {
    scoreColor = aimScoreFillClass(score, currentAim?.schemaVersion ?? currentScore?.schemaVersion);
    bucket = aimDisplayBand?.cardClass === 'fit-a' ? 'a' : aimDisplayBand?.cardClass === 'fit-b' ? 'b'
      : score >= 80 ? 'a' : score >= 65 ? 'b' : 'c';
  }

  const experienceFitScore: number | null = currentExperience?.experienceFitScore ?? currentScore?.experienceFitScore ?? null;
  const hasExperienceScore = experienceFitScore != null;
  const experienceScore = experienceFitScore ?? 0;

  const handleUpdateJD = async () => {
    try {
      let skipRescore = false;
      if (shouldConfirmBeforeRescore) {
        const wantsRescore = await showConfirm('Do you want to send this job back to the queue for re-scoring? Choosing No saves the edit and keeps the current score, which will still reflect the description as it read before this edit.', 'Yes', 'No');
        if (!wantsRescore) {
          skipRescore = true;
        }
      }

      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          description: manualJD,
          skipRescore,
          forceRescore: !skipRescore,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update the job description.');
      setIsEditingJD(false);
      setJob(data.job);
      await showAlert(data.rescoreQueued
        ? 'Description updated and queued for rescoring.'
        : skipRescore
          ? 'Description updated. The existing score was kept and still reflects the previous description.'
          : 'Description updated.');
    } catch(reason) {
      console.error('Failed to update JD', reason);
      await showAlert(reason instanceof Error ? reason.message : 'Failed to update job description.');
    }
  };

  const handleUpdateMeta = async () => {
    try {
      // Renaming the company keeps the score; only title and location edits
      // are offered a rescore.
      const scoringDetailsChanged = manualTitle !== (job.title || '') || manualLocation !== (job.location || '');
      let skipRescore = !scoringDetailsChanged;
      if (scoringDetailsChanged && shouldConfirmBeforeRescore) {
        const wantsRescore = await showConfirm('These details affect job fit. Do you want to send this job back to the queue for re-scoring? Choosing No saves the edit and keeps the current score, which will still reflect the details as they read before this edit.', 'Yes', 'No');
        skipRescore = !wantsRescore;
      }
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          title: manualTitle,
          company: manualCompany,
          location: manualLocation,
          skipRescore,
          forceRescore: !skipRescore,
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update the job details.');
      setIsEditingMeta(false);
      setJob(data.job);
      if (onJobUpdate) onJobUpdate(job.id, data.job);
      await showAlert(data.rescoreQueued
        ? 'Job details updated and queued for rescoring.'
        : skipRescore && scoringDetailsChanged
          ? 'Job details updated. The existing score was kept and still reflects the previous details.'
          : 'Job details updated.');
    } catch(reason) {
      console.error('Failed to update meta', reason);
      await showAlert(reason instanceof Error ? reason.message : 'Failed to update job details.');
    }
  };

  const updateJob = async (updates: Partial<JobListItem>) => {
    try {
      const res = await fetch(`/api/jobs/${job.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to update the job.');
      setJob((current) => ({ ...current, ...(data.job || updates) }));
      if (onJobUpdate) onJobUpdate(job.id, data.job || updates);
    } catch(reason) {
      console.error('Failed to update job', reason);
      await showAlert(reason instanceof Error ? reason.message : 'Failed to update the job.');
    }
  };

  const handlePass = () => {
    if (!showPassInput) {
      setShowPassInput(true);
    } else {
      const finalReason = passReasonType === 'Other' ? passReason.trim() : passReasonType;
      if (finalReason) {
        onStatusChange(job.id, 'passed', finalReason);
        onClose();
      }
    }
  };

  const handlePromote = () => {
    onStatusChange(job.id, 'promoted');
    onClose();
  };

  const handleCopy = async (text: string, successMessage: string) => {
    try {
      await copyTextToClipboard(text);
      await showAlert(successMessage);
    } catch (error) {
      console.error('Failed to copy to clipboard', error);
      await showAlert('Unable to copy automatically. Please select and copy the text manually.');
    }
  };

  const isHiddenRepeat = job.status === 'dismissed'
    && isAppliedDuplicateReason(job.passReason)
    && job.passReason !== ALREADY_APPLIED_REASON;

  const handleNotARepeat = async () => {
    setRestoringRepeat(true);
    try {
      const res = await fetch(`/api/jobs/${job.id}/not-a-repeat`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The job could not be restored.');
      setJob(data.job);
      if (onJobUpdate) onJobUpdate(job.id, data.job);
      await showAlert(data.job.status === 'inbox'
        ? 'Restored to the Inbox. This job will not be hidden as a repeat of that application again.'
        : data.job.status === 'cooldown'
          ? 'Restored. It is in Cooldown because you applied at this employer recently, and will not be hidden as a repeat again.'
          : 'Restored and sent back to scoring. It will not be hidden as a repeat of that application again.');
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'The job could not be restored.');
    }
    setRestoringRepeat(false);
  };

  /** Undo an automatic combine: the copy returns to where its own scores put it. */
  const handleSeparate = async (copyId: string) => {
    const confirmed = await showConfirm('Separate this copy? It returns as its own card and will never be combined with this one again.');
    if (!confirmed) return;
    setSeparatingId(copyId);
    try {
      const res = await fetch(`/api/jobs/${copyId}/separate`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'The copy could not be separated.');
      if (copyId === job.id) {
        setJob(data.copy);
        if (onJobUpdate) onJobUpdate(job.id, data.copy);
      } else {
        setCombinedCopies((copies) => copies.filter((copy) => copy.id !== copyId));
        if (data.survivor) {
          setJob(data.survivor);
          if (onJobUpdate) onJobUpdate(job.id, data.survivor);
        }
      }
      const status = data.copy?.status;
      await showAlert(status === 'inbox'
        ? 'Separated. The copy is back in the Inbox as its own card.'
        : status === 'cooldown'
          ? 'Separated. The copy is its own card again, in Cooldown because you applied at this employer recently.'
          : 'Separated. The copy is its own card again and has gone back to scoring.');
    } catch (reason) {
      await showAlert(reason instanceof Error ? reason.message : 'The copy could not be separated.');
    }
    setSeparatingId(null);
  };

  const openDuplicateMergeReview = async (targetJobId: string, conflictMessage: string) => {
    setMergeError('');
    setLinkUpdateError('');
    const res = await fetch(`/api/jobs/${job.id}/merge?withJobId=${encodeURIComponent(targetJobId)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.cards || !data.plan) {
      setLinkUpdateError(data.error || 'The two-card merge review could not be loaded. No changes were saved.');
      return;
    }
    setMergeReview({ ...data, conflictMessage });
  };

  const handleMergeReview = async () => {
    if (!mergeReview || mergeReview.plan.blockedReason) return;
    const other = mergeReview.cards.find((card) => card.id !== job.id);
    if (!other) return;
    setMergeBusy(true);
    setMergeError('');
    const res = await fetch(`/api/jobs/${job.id}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intoJobId: other.id, route: 'card_merge' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setMergeError(data.error || 'The cards could not be merged. Nothing was changed.');
      setMergeBusy(false);
      return;
    }
    if (onJobUpdate) {
      onJobUpdate(data.consolidatedJobId, { status: 'dismissed', tailoringStaged: false });
      onJobUpdate(data.job.id, data.job);
    }
    setJob(data.job);
    setManualJD(data.job.description || '');
    setDirectUrl('');
    setMergeReview(null);
    setMergeCompleted(`Merged into the ${data.job.status.replaceAll('_', ' ')} card. Scores and source history were preserved.`);
    setMergeBusy(false);
  };

  const handleScrape = async () => {
    if (!directUrl.trim()) return;
    
    const choice = await showOptions('What would you like to do with this new URL?', [
      { label: 'Update link only', value: 'link_only' },
      { label: 'Refresh JD and queue score', value: 'scrape_score', primary: true }
    ]);

    if (!choice) return;

    const linkOnly = choice === 'link_only';

    setIsScraping(true);
    setLinkUpdateError('');
    setMergeCompleted('');
    try {
      const res = await fetch(`/api/jobs/${job.id}/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: directUrl, skipRescore: false, linkOnly })
      });
      const data = await res.json();
      if (res.ok) {
        setJob(data.job);
        setManualJD(data.job.description);
        setDirectUrl('');
        if (onJobUpdate) {
          if (data.consolidatedJobId) onJobUpdate(data.consolidatedJobId, { status: 'dismissed', tailoringStaged: false });
          onJobUpdate(data.job.id, data.job);
        }
        await showAlert(data.consolidatedJobId
          ? `This posting was already saved. The duplicate was consolidated into the existing ${data.job.status} record. Its scores and history were preserved.`
          : data.linkOnly
          ? 'Link updated. Existing scores were preserved.'
          : data.rescoreQueued
          ? 'Scrape successful. The job description was updated and a rescore was queued.'
          : data.scoreInvalidated
            ? 'Scrape successful. The inputs were updated without queueing, so the prior score is now hidden.'
            : 'Scrape successful. The job description was updated.');
      } else if (typeof data.mergeTargetJobId === 'string' && data.mergeTargetJobId) {
        await openDuplicateMergeReview(data.mergeTargetJobId, data.error || 'This link already belongs to another saved card.');
      } else {
        if (data.job) setJob(data.job);
        await showAlert(data.error || 'The link could not be updated.');
        if (data.needManual) setIsEditingJD(true);
      }
    } catch (err) {
      console.error('Scraping failed', err);
      await showAlert("Scraping failed. You can now manually edit the description.");
      setIsEditingJD(true);
    }
    setIsScraping(false);
  };

  const resumeBarRow = (
    <div className="expand-score-row" key="resume" style={{ marginTop: primaryScore === 'aim' ? '0' : '12px' }}>
      <div className="expand-score-top">
        <span className="expand-score-label">Aim Fit</span>
        <span className="expand-score-num">
          {hasAimScore ? score : scoreAuthorityState === 'stale_replay_needed' ? 'Replay needed' : scoreAuthorityPending ? 'Checking' : 'Pending'}
        </span>
      </div>
      <div className="expand-score-track"><div className={`expand-score-fill ${scoreColor}`} style={{width: `${score}%`}}></div></div>
    </div>
  );

  const expBarRow = (
    <div className="expand-score-row" key="exp" style={{ marginTop: primaryScore === 'experience' ? '0' : '12px' }}>
      <div className="expand-score-top">
        <span className="expand-score-label">Experience Fit</span>
        <span className="expand-score-num">
          {hasExperienceScore ? experienceFitScore : scoreAuthorityState === 'stale_replay_needed' ? 'Replay needed' : scoreAuthorityPending ? 'Checking' : 'Pending'}
        </span>
      </div>
      <div className="expand-score-track">
        <div
          className={`expand-score-fill ${!hasExperienceScore ? 'fill-muted' : experienceScore >= 80 ? 'fill-green' : experienceScore >= 65 ? 'fill-amber' : 'fill-red'}`}
          style={{width: `${experienceScore}%`}}
        ></div>
      </div>
    </div>
  );

  const authoritativeTravelScore = currentAim?.travelScore ?? currentScore?.travelScore ?? null;
  const travelTier = travelOpportunityTier(authoritativeTravelScore);
  const travelRange = job.travelRange;

  const travelBarRow = travelRange ? (
    <div className="expand-score-row" key="travel" style={{ marginTop: '12px' }}>
      <div className="expand-score-top">
        <span className="expand-score-label">Travel · {travelTier}</span>
        <span className="expand-score-num">{travelRange.label}</span>
      </div>
      <TravelRangeTrack range={travelRange} expanded />
      {travelRange.sourceText && travelRange.sourceText !== travelRange.label && <div className="travel-range-source">{travelRange.sourceText}</div>}
    </div>
  ) : null;

  const isHumanDecisionReason = job.status === 'passed' || /^Promoted by user:/i.test(job.passReason || '');
  const passReasonToDisplay = isHumanDecisionReason
    ? job.passReason || ''
    : currentAim?.aimReason || currentScore?.aimReason || '';

  const resumeRationaleSection = passReasonToDisplay ? (
    <div key="resumeRationale" style={{ marginTop: '20px' }}>
      <div className="expand-section-title">
        {isHumanDecisionReason ? 'Human Decision Note' : 'Aim Fit Rationale'}
      </div>
      <div className="expand-desc">{passReasonToDisplay}</div>
    </div>
  ) : null;

  const experienceReason = currentExperience?.experienceReason || currentScore?.experienceReason || '';
  const expRationaleSection = experienceReason ? (
    <div key="expRationale" style={{ marginTop: '20px' }}>
      <div className="expand-section-title">Experience Rationale</div>
      <div className="expand-desc">{experienceReason}</div>
    </div>
  ) : null;

  const aimAssessment = asRecord(currentAim?.aimAssessments);
  const aimRubric = asRecord(aimAssessment?.rubric);
  const aimComponents = asRecord(aimAssessment?.components);
  const aimFactualVector = asRecord(aimAssessment?.factualVector);
  const aimEvidenceCatalog = new Map(asRecords(aimFactualVector?.evidenceCatalog).map((entry) => [String(entry.evidenceId), entry]));
  const aimStage1Answers = asRecords(aimFactualVector?.answers).filter((answer) => String(answer.questionId).startsWith('S1.'));
  const aimComponentsSection = aimAssessment ? (
    <div className="scoring-detail-section" key="aimComponents">
      <div className="expand-section-title">Aim components</div>
      <div className="scoring-detail-list">
        {aimDisplayBand && (
          <div className="scoring-detail-card">
            <strong>{aimDisplayBand.label} · {score}/100</strong>
            <span>Band {aimDisplayBand.minimum}–{aimDisplayBand.maximum}</span>
          </div>
        )}
        {typeof aimAssessment.variant === 'string' && aimAssessment.variant !== 'scored_survivor' && (
          <div className="scoring-detail-card">
            <strong>{textValue(aimAssessment.variant).replaceAll('_', ' ')}</strong>
            <span>{Array.isArray(aimAssessment.localTriggerCodes) && aimAssessment.localTriggerCodes.length
              ? aimAssessment.localTriggerCodes.map(String).join(', ')
              : Array.isArray(aimAssessment.triggerQuestionIds) && aimAssessment.triggerQuestionIds.length
                ? aimAssessment.triggerQuestionIds.map(String).join(', ')
                : textValue(aimAssessment.decision)}</span>
          </div>
        )}
        {aimStage1Answers.map((answer) => {
          const cited = Array.isArray(answer.evidenceIds)
            ? answer.evidenceIds.map((id) => aimEvidenceCatalog.get(String(id))).filter(Boolean) as Record<string, unknown>[]
            : [];
          return (
            <div className="scoring-detail-card" key={String(answer.questionId)}>
              <strong>{String(answer.questionId)} · {textValue(answer.answer)}</strong>
              {cited.map((evidence) => <blockquote key={String(evidence.evidenceId)}>“{textValue(evidence.exactQuote)}”</blockquote>)}
            </div>
          );
        })}
        {aimComponents && Object.entries(aimComponents).map(([component, points]) => (
          <div className="scoring-detail-card" key={component}>
            <strong>{component.replace(/([A-Z])/g, ' $1')} · {String(points)} pts</strong>
          </div>
        ))}
        {asRecords(aimAssessment.hardStops).filter((stop) => stop.state !== 'absent').map((stop) => (
          <div className="scoring-detail-card" key={textValue(stop.code)}>
            <strong>{textValue(stop.code).replaceAll('_', ' ')} · {textValue(stop.state)}</strong>
            <span>{textValue(stop.rationale)}</span>
          </div>
        ))}
        {aimRubric && Object.entries(aimRubric).map(([category, rawBand]) => {
          const band = asRecord(rawBand);
          return band ? (
            <div className="scoring-detail-card" key={category}>
              <strong>{category.replace(/([A-Z])/g, ' $1')} · {textValue(band.band)} · {String(band.points ?? 0)} pts</strong>
              <span>{textValue(band.rationale)}</span>
            </div>
          ) : null;
        })}
      </div>
    </div>
  ) : null;

  const experienceAssessment = asRecord(currentExperience?.mandatoryRequirementAssessments);
  const hardRequirementsNotMet = Array.isArray(experienceAssessment?.hardRequirementsNotMet)
    ? experienceAssessment.hardRequirementsNotMet.map(String)
    : [];
  const simpleExperienceAssessment = experienceAssessment && typeof experienceAssessment.pass1RawOutput === 'string';
  const experienceCriteria = asRecords(experienceAssessment?.criteria);
  const experienceOutcomes = new Map(asRecords(experienceAssessment?.outcomes).map((outcome) => [String(outcome.criterionId), outcome]));
  const experienceCriteriaSection = simpleExperienceAssessment ? (
    <div className="scoring-detail-section" key="experienceCriteria">
      <div className="expand-section-title">Experience Fit judgment</div>
      <div className="scoring-detail-list">
        <div className="scoring-detail-card">
          <strong>{hardRequirementsNotMet.length ? 'Hard requirement mismatch' : 'No hard requirement mismatch identified'}</strong>
          {hardRequirementsNotMet.map((requirement) => <span key={requirement}>{requirement}</span>)}
        </div>
        <details className="scoring-preview-detail">
          <summary>Terra hard-gate response</summary>
          <pre>{textValue(experienceAssessment.pass1RawOutput)}</pre>
        </details>
        {typeof experienceAssessment.pass2RawOutput === 'string' && (
          <details className="scoring-preview-detail">
            <summary>Terra holistic-score response</summary>
            <pre>{experienceAssessment.pass2RawOutput}</pre>
          </details>
        )}
      </div>
    </div>
  ) : experienceAssessment ? (
    <div className="scoring-detail-section" key="experienceCriteria">
      <div className="expand-section-title">Experience criteria and evidence</div>
      <div className="scoring-detail-list">
        {experienceCriteria.map((criterion) => {
          const criterionId = String(criterion.criterionId);
          const outcome = experienceOutcomes.get(criterionId);
          const source = asRecord(criterion.source);
          const leaves = asRecords(outcome?.leaves);
          const ids = [...new Set(leaves.flatMap(evidenceIds))];
          return (
            <div className="scoring-detail-card" key={criterionId}>
              <strong>{textValue(criterion.classification)} · {textValue(outcome?.outcome)} · {textValue(criterion.normalizedMeaning)}</strong>
              {typeof source?.exactQuote === 'string' && source.exactQuote && <blockquote>“{source.exactQuote}”</blockquote>}
              {leaves.map((leaf) => (
                <span key={String(leaf.leafId)}>{textValue(leaf.outcome)} — {textValue(leaf.rationale)}</span>
              ))}
              <span className="mono-value">Evidence: {ids.length ? ids.join(', ') : 'none cited'}</span>
            </div>
          );
        })}
      </div>
    </div>
  ) : null;

  const latestScore = primaryScore === 'experience' ? currentExperience || currentAim || currentScore : currentAim || currentExperience || currentScore;
  const scoreAuditSection = latestScore ? (
    <div style={{ marginTop: '20px' }}>
      <div className="expand-section-title">Score Audit</div>
      <div className="expand-desc score-audit">
        <span>{latestScore.model} · {latestScore.promptVersion}</span>
        <span>Decision: {latestScore.decisionCode || (latestScore.passed ? 'passed' : 'not passed')} · policy {latestScore.policyVersion || 'legacy'} · schema {latestScore.schemaVersion || 'legacy'}</span>
        {latestScore.qualificationBasis && <span>Qualification basis: {latestScore.qualificationBasis}</span>}
        {(latestScore.requiredDomain || latestScore.candidateDomain) && <span>{latestScore.domainMatch === false ? 'Domain mismatch' : 'Domain match'}: {latestScore.requiredDomain || 'not specified'} → {latestScore.candidateDomain || 'not specified'}</span>}
        <span className="mono-value">Event {latestScore.id}{latestScore.batchId ? ` · batch ${latestScore.batchId}` : ''}</span>
        {latestScore.sourceAimEventId && <span className="mono-value">Source Aim event {latestScore.sourceAimEventId}</span>}
        {latestScore.cleanedJdArtifactId && <span className="mono-value">Cleaned JD artifact {latestScore.cleanedJdArtifactId}</span>}
        {latestScore.resultHash && <span className="mono-value">Result SHA-256 {latestScore.resultHash}</span>}
        <span>Recorded {new Date(latestScore.createdAt).toLocaleString()}</span>
      </div>
    </div>
  ) : scoreAuthorityState === 'stale_replay_needed' ? (
    <div className="score-authority-warning" role="status" style={{ marginTop: '20px' }}>
      <div className="expand-section-title"><AlertTriangle size={15} /> Score replay needed</div>
      <div className="expand-desc score-audit">
        <span>The newest A/E score was invalidated. Its values and rationales are hidden until a fresh replay finishes.</span>
        <span>{job.staleScoreReason || staleScore?.staleReason || 'No invalidation reason was recorded.'}</span>
        {staleScore && (
          <span>Invalidated score: {staleScore.model} · {staleScore.promptVersion} · recorded {new Date(staleScore.createdAt).toLocaleString()}</span>
        )}
      </div>
    </div>
  ) : scoreAuthorityPending ? (
    <div className="score-authority-pending" role="status" style={{ marginTop: '20px' }}>
      <Loader2 size={15} className="animate-spin" /> Checking immutable score authority…
    </div>
  ) : null;

  if (mergeReview) {
    const scoreResult = (label: string, scorePlan: DuplicateMergeScorePlan) => {
      if (scorePlan.value === null) return `${label}: no current score on either card`;
      if (scorePlan.mode === 'average') return `${label}: ${scorePlan.value} (rounded average of ${scorePlan.sources.map((source) => source.value).join(' and ')})`;
      if (scorePlan.mode === 'carried') return `${label}: ${scorePlan.value} carried onto the surviving card`;
      return `${label}: ${scorePlan.value} preserved`;
    };
    return (
      <div className="expand-overlay open">
        <div className="expand-modal duplicate-merge-modal" role="dialog" aria-modal="true" aria-labelledby="duplicate-merge-title" tabIndex={-1} ref={dialogRef}>
          <div className="duplicate-merge-header">
            <div>
              <span className="advanced-kicker">Duplicate link found · nothing has changed yet</span>
              <h2 id="duplicate-merge-title">Review these two cards</h2>
              <p>{mergeReview.conflictMessage}</p>
            </div>
            <button className="expand-close" onClick={() => setMergeReview(null)} aria-label="Cancel duplicate merge">✕</button>
          </div>

          <div className="duplicate-merge-content">
            <div className="duplicate-merge-grid">
              {mergeReview.cards.map((card) => {
                const survives = card.id === mergeReview.plan.survivorId;
                return (
                  <article className={`duplicate-merge-card ${survives ? 'survivor' : 'redundant'}`} key={card.id}>
                    <div className="duplicate-merge-card-heading">
                      <span>{survives ? 'Surviving card' : 'Will be consolidated'}</span>
                      <strong>{card.status.replaceAll('_', ' ')}</strong>
                    </div>
                    <h3>{card.title}</h3>
                    <p>{companyDisplayName(card.company, card.source)} · {card.location || 'Location not provided'}</p>
                    {companyDisplayName(card.company, card.source) !== card.company && <small>Listed employer: {card.company}</small>}
                    <dl>
                      <div><dt>Aim Fit</dt><dd>{card.aimFitScore ?? 'No score'}</dd></div>
                      <div><dt>Experience Fit</dt><dd>{card.reqFitScore ?? 'No score'}</dd></div>
                      <div><dt>Source</dt><dd>{card.source || 'Unknown'}</dd></div>
                    </dl>
                    {card.hasSubmittedResume && <div className="duplicate-merge-protection">Submitted résumé attached</div>}
                    {card.tailoringStaged && <div className="duplicate-merge-protection">Tailoring in progress</div>}
                    {card.url && <a href={card.url} target="_blank" rel="noreferrer">Open this card’s link <ExternalLink size={13} /></a>}
                  </article>
                );
              })}
            </div>

            <div className="duplicate-merge-result" role="status">
              <strong>What Merge will do</strong>
              <span>{mergeReview.plan.survivorReason}</span>
              <span>{scoreResult('Aim Fit', mergeReview.plan.aim)}</span>
              <span>{scoreResult('Experience Fit', mergeReview.plan.experience)}</span>
              <span>The other card will remain outside the Inbox as retained consolidation history.</span>
            </div>
            {(mergeReview.plan.blockedReason || mergeError) && (
              <div className="duplicate-merge-error" role="alert">{mergeReview.plan.blockedReason || mergeError}</div>
            )}
          </div>

          <div className="duplicate-merge-actions">
            <button className="expand-btn" onClick={() => setMergeReview(null)} disabled={mergeBusy}>Cancel</button>
            <button className="expand-btn primary" onClick={() => void handleMergeReview()} disabled={mergeBusy || Boolean(mergeReview.plan.blockedReason)}>
              {mergeBusy ? <><Loader2 size={14} className="animate-spin" /> Merging…</> : 'Merge these cards'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="expand-overlay open" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="expand-modal" role="dialog" aria-modal="true" aria-labelledby="job-dialog-title" tabIndex={-1} ref={dialogRef}>
        <div className="expand-header">
        <div className="expand-header-left">
          <button
            type="button"
            className="expand-logo expand-logo-button"
            style={{ position: 'relative', overflow: 'hidden' }}
            onClick={() => onCompanySelect(job.company)}
            aria-label={`Show all jobs at ${companyLabel}`}
            title={`Show all jobs at ${companyLabel}`}
          >
            <span style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
              {companyLabel.trim().slice(0, 2).toUpperCase()}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img 
              src={`https://www.google.com/s2/favicons?domain=${companyLabel.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}.com&sz=128`}
              alt=""
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'white' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            {!isEditingMeta ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <div className="expand-title" id="job-dialog-title">{job.title}</div>
                  <button onClick={() => setIsEditingMeta(true)} className="expand-btn" style={{ padding: '2px 6px', fontSize: '11px', background: 'transparent', border: 'none', color: 'var(--muted)' }} title="Edit Title/Company">
                    <Edit2 size={12} />
                  </button>
                  <button type="button" onClick={() => void handleCopy(job.id, `Job ID copied to clipboard: ${job.id}`)} className="expand-btn" style={{ padding: '2px 6px', fontSize: '11px', background: 'transparent', border: 'none', color: 'var(--muted)', marginLeft: '4px' }} title="Copy Job ID" aria-label="Copy Job ID">
                    <Copy size={12} />
                  </button>
                </div>
                <div className="expand-company">{companyLabel} · {job.location || 'Location not provided'}</div>
                {companyLabel !== job.company && <div style={{ color: 'var(--muted)', fontSize: '12px', marginTop: '4px' }}>Listed employer: {job.company}</div>}
              </>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px', maxWidth: '400px' }}>
                <input 
                  type="text" 
                  value={manualTitle} 
                  onChange={(e) => setManualTitle(e.target.value)} 
                  className="feedback-input" 
                  style={{ fontSize: '20px', fontWeight: 600, padding: '4px 8px' }}
                  placeholder="Job Title"
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input 
                    type="text" 
                    value={manualCompany} 
                    onChange={(e) => setManualCompany(e.target.value)} 
                    className="feedback-input" 
                    style={{ flex: 1, padding: '4px 8px' }}
                    placeholder="Company"
                  />
                  <input 
                    type="text" 
                    value={manualLocation} 
                    onChange={(e) => setManualLocation(e.target.value)} 
                    className="feedback-input" 
                    style={{ flex: 1, padding: '4px 8px' }}
                    placeholder="Location"
                  />
                </div>
                <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                  <button onClick={handleUpdateMeta} className="expand-btn primary" style={{ padding: '4px 12px', fontSize: '12px' }}>Save</button>
                  <button onClick={() => setIsEditingMeta(false)} className="expand-btn" style={{ padding: '4px 12px', fontSize: '12px' }}>Cancel</button>
                </div>
              </div>
            )}
            
            <div className="expand-company" style={{ fontSize: '11px', marginTop: '3px' }}>
              Posted {job.postedAt ? formatDistanceToNow(new Date(job.postedAt)) : '1d'} ago · In Dash {job.createdAt ? formatDistanceToNow(new Date(job.createdAt)) : 'just now'}
            </div>
            <div className="expand-badges">
              <span className={`expand-badge ${hasAimScore ? bucket : 'meta'}`}>
                {hasAimScore
                  ? aimDisplayBand ? `${aimDisplayBand.label} · ${score}` : `${bucket.toUpperCase()} · ${score}`
                  : scoreAuthorityState === 'stale_replay_needed'
                    ? 'Score replay needed'
                    : scoreAuthorityPending
                      ? 'Checking score authority'
                      : 'Pending scoring'}
              </span>
              
              {job.status === 'passed' && (
                <span className="expand-badge meta" style={{ background: 'var(--border2)', color: 'var(--text-muted)' }}>🚫 Passed</span>
              )}
              {(job.status === 'applied' || job.status === 'interviewing') && (
                <span className="expand-badge meta" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#34d399' }}>✓ Applied</span>
              )}
              {job.status === 'interviewing' && (
                <span className="expand-badge meta" style={{ background: 'rgba(96, 165, 250, 0.15)', color: '#60a5fa' }}>🎙️ Interviewing</span>
              )}
              


              <span className="expand-badge meta">{job.location || 'Location not provided'}</span>
              {job.source && job.source.toLowerCase() !== 'careerforce' && (
                <span 
                  className="expand-badge meta" 
                  style={{ cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const targetUrl = job.source?.toLowerCase() === 'indeed' && job.sourceId 
                      ? `https://www.indeed.com/viewjob?jk=${job.sourceId}` 
                      : (job.url || '');
                    if (targetUrl) window.open(targetUrl, '_blank', 'noreferrer');
                  }}
                  title="Open original source"
                >
                  Via {job.source}
                </span>
              )}
              
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <select
                  className="expand-badge meta"
                  style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981', border: 'none', appearance: 'none', cursor: 'pointer', paddingRight: '20px' }}
                  value={job.manualAts || identifyAts(job)}
                  onChange={(e) => updateJob({ manualAts: e.target.value })}
                >
                  <option value={identifyAts(job)} disabled>⚙️ ATS: {identifyAts(job)}</option>
                  {ATS_OPTIONS.map(ats => <option key={ats} value={ats}>{ats}</option>)}
                </select>
                <div style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: '9px', color: '#10b981' }}>▼</div>
              </div>

              {job.postedCompensation && (
                <span className="expand-badge meta" style={{ background: 'rgba(52, 211, 153, 0.1)', color: '#34d399', borderColor: 'transparent' }}>
                  💰 {job.postedCompensation}
                </span>
              )}
              {job.postedTravel && (
                <span className="expand-badge meta" style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', borderColor: 'transparent' }}>
                  ✈️ {job.postedTravel} travel
                </span>
              )}

              {job.source && job.source.toLowerCase() === 'careerforce' && (
                <span 
                  className="expand-badge meta" 
                  style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6', fontWeight: 600, cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (job.url) window.open(job.url, '_blank', 'noreferrer');
                  }}
                  title="Open CareerForce posting"
                >
                  🦅 CareerForce
                </span>
              )}

            </div>
          </div>
        </div>
        <button className="expand-close" onClick={onClose} aria-label="Close job details">✕</button>
      </div>

      {isHiddenRepeat && (
        <div className="repeat-notice" role="status">
          <div>
            <strong>Hidden as a repeat of a job you applied to</strong>
            <span>{job.passReason?.replace(/^Duplicate of a job already \w+: /, '')}</span>
          </div>
          <button className="expand-btn" onClick={() => void handleNotARepeat()} disabled={restoringRepeat}>
            {restoringRepeat ? <Loader2 size={14} className="animate-spin" /> : 'Not a repeat'}
          </button>
        </div>
      )}
      {isCombinedCopy && (
        <div className="repeat-notice" role="status">
          <div>
            <strong>Combined into another card as the same job</strong>
            <span>This listing came from another source. Its scores are kept; the other card is the one you see.</span>
          </div>
          <button className="expand-btn" onClick={() => void handleSeparate(job.id)} disabled={separatingId !== null}>
            {separatingId === job.id ? <Loader2 size={14} className="animate-spin" /> : 'Not the same job'}
          </button>
        </div>
      )}
      {combinedCopies.length > 0 && (
        <details className="repeat-notice repeat-list combined-list">
          <summary>
            {combinedCopies.length === 1
              ? '1 copy of this job from another source was combined into this card'
              : `${combinedCopies.length} copies of this job from other sources were combined into this card`}
          </summary>
          <ul>
            {combinedCopies.map((copy) => (
              <li key={copy.id}>
                <span className="combined-copy-label">
                  {copy.title} · {copy.company}{copy.location ? ` · ${copy.location}` : ''}{copy.source ? ` · via ${copy.source}` : ''}
                </span>
                {copy.automatic && (
                  <button className="expand-btn" onClick={() => void handleSeparate(copy.id)} disabled={separatingId !== null}>
                    {separatingId === copy.id ? <Loader2 size={14} className="animate-spin" /> : 'Not the same job'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {mergeCompleted && <div className="repeat-notice merge-complete-notice" role="status"><strong>{mergeCompleted}</strong></div>}
      {isApplicationCard && hiddenRepeats.length > 0 && (
        <details className="repeat-notice repeat-list">
          <summary>
            {hiddenRepeats.length === 1 ? '1 repeat of this job was hidden' : `${hiddenRepeats.length} repeats of this job were hidden`}
          </summary>
          <ul>
            {hiddenRepeats.map((repeat) => (
              <li key={repeat.id}>
                {repeat.title} · {repeat.company}{repeat.location ? ` · ${repeat.location}` : ''}{repeat.source ? ` · via ${repeat.source}` : ''}
              </li>
            ))}
          </ul>
          <span>Open one from Dismissed and choose “Not a repeat” if it is a different job.</span>
        </details>
      )}

      <div className="expand-body">
        <div className="expand-col left-col">
          <div className="expand-section-title">{primaryScore === 'experience' ? 'Experience Fit' : 'Aim Fit'}</div>
          <div className="expand-scores">
            {primaryScore === 'experience' ? [expBarRow, resumeBarRow, travelBarRow] : [resumeBarRow, expBarRow, travelBarRow]}
          </div>
          {primaryScore === 'experience' ? [expRationaleSection, resumeRationaleSection] : [resumeRationaleSection, expRationaleSection]}
          {primaryScore === 'experience' ? [experienceCriteriaSection, aimComponentsSection] : [aimComponentsSection, experienceCriteriaSection]}
          {scoreAuditSection}
        </div>

        <div className="expand-col" style={{ flex: 1.5 }}>
          <div className="expand-section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              About the Role
              {job.description && job.description.length < 400 && !isEditingJD && (
                <span style={{ fontSize: '12px', color: '#f5a623', background: 'rgba(245, 166, 35, 0.1)', padding: '2px 8px', borderRadius: '4px', fontWeight: 'normal', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <AlertTriangle size={14} /> Truncated
                </span>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              {!isEditingJD && (job.description || manualJD) && (
                <button 
                  type="button"
                  onClick={() => void handleCopy(job.description || manualJD || '', 'Job description copied to clipboard!')}
                  className="expand-btn" 
                  style={{ padding: '2px 8px', fontSize: '12px' }}
                >
                  <Copy size={12} style={{ marginRight: '4px' }}/> Copy JD
                </button>
              )}
              {!isEditingJD ? (
                <button onClick={() => setIsEditingJD(true)} className="expand-btn" style={{ padding: '2px 8px', fontSize: '12px' }}>
                  <Edit2 size={12} style={{ marginRight: '4px' }}/> Edit JD
                </button>
              ) : (
                <button onClick={handleUpdateJD} className="expand-btn" style={{ padding: '2px 8px', fontSize: '12px', background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' }}>
                  <Save size={12} style={{ marginRight: '4px' }}/> Save JD
                </button>
              )}
            </div>
          </div>
          
          {isLoadingJD ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '1.5rem 0', color: 'var(--muted)', fontSize: '14px' }}>
              <Loader2 size={16} className="animate-spin" /> Loading job description...
            </div>
          ) : isEditingJD ? (
            <textarea 
              value={manualJD}
              onChange={(e) => setManualJD(e.target.value)}
              style={{ width: '100%', height: '300px', background: 'var(--bg-card)', color: 'var(--text-main)', border: '1px solid var(--border)', padding: '10px', borderRadius: '8px', fontFamily: 'inherit', fontSize: '14px', resize: 'vertical' }}
              placeholder="Paste full job description here..."
            />
          ) : loadError ? (
            <div className="expand-desc" style={{ whiteSpace: 'pre-wrap', color: 'red', fontStyle: 'italic', padding: '1rem', border: '1px solid red', borderRadius: '8px' }}>
              Error loading job description:<br/>
              {loadError}
            </div>
          ) : (
            <div className="expand-desc" style={{ whiteSpace: 'pre-wrap' }}>
              {job.description || manualJD || (
                <span style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
                  No job description available for this role.
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="expand-footer">
        <div className="expand-footer-left">
          {/* Scrape / URL */}
          <div className="scrape-input-group" style={{ display: 'flex', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.5)', height: '36px' }}>
            <input type="text" className="scrape-url-input" placeholder="Paste Direct URL..." value={directUrl} onChange={(e) => setDirectUrl(e.target.value)} style={{ background: 'transparent', border: 'none', color: 'var(--text)', padding: '0 12px', outline: 'none', fontSize: '13px' }} />
            <button onClick={handleScrape} disabled={isScraping} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', borderLeft: '1px solid var(--border)', padding: '0 16px', color: 'var(--text)', cursor: 'pointer', fontWeight: 600, fontSize: '12px', display: 'flex', alignItems: 'center', transition: 'background 0.2s' }}>
              {isScraping ? <Loader2 size={14} className="animate-spin" /> : 'Scrape'}
            </button>
          </div>
          {linkUpdateError && <div className="link-update-error" role="alert">{linkUpdateError}</div>}

          {/* View Posting */}
          <button className="expand-btn" onClick={() => window.open(`/api/jobs/${job.id}/redirect`, '_blank', 'noreferrer')} style={{ height: '36px', padding: '0 16px' }}>
            <ExternalLink size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
            View Posting
          </button>

          {/* Restore to Inbox */}
          {job.status === 'passed' && (
            <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }} style={{ height: '36px', padding: '0 16px' }}>
              Restore to Inbox
            </button>
          )}

          {/* Bookmark toggle (only if not dismissed and not passed) */}
          {job.status !== 'dismissed' && job.status !== 'passed' && (
            job.status === 'bookmarked' ? (
              <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }} style={{ height: '36px', padding: '0 16px' }}>
                <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px', fill: 'currentColor' }} />
                Unbookmark
              </button>
            ) : (
              <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'bookmarked'); onClose(); }} style={{ height: '36px', padding: '0 16px' }}>
                <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                Bookmark
              </button>
            )
          )}
        </div>

        <div className="expand-footer-right">
          {/* Pass Button and Reason Input */}
          {!isDismissedForCurrentMode && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              {showPassInput && (
                <>
                  <select
                    className="feedback-input"
                    style={{ height: '36px', padding: '0 12px', fontSize: '14px', border: '1px solid var(--border)', borderRadius: '4px', background: 'var(--subtle)' }}
                    value={passReasonType}
                    onChange={(e) => setPassReasonType(e.target.value)}
                  >
                    <option value="Not interested">Not interested</option>
                    <option value="Expired">Expired</option>
                    <option value="Location mismatch">Location mismatch</option>
                    <option value="Experience mismatch">Experience mismatch</option>
                    <option value="Already applied">Already applied</option>
                    <option value="Other">Other</option>
                  </select>
                  {passReasonType === 'Other' && (
                    <input 
                      type="text" 
                      className="feedback-input expand-footer-input" 
                      placeholder="Custom reason..." 
                      style={{ height: '36px', margin: 0, minWidth: '150px' }}
                      value={passReason}
                      onChange={(e) => setPassReason(e.target.value)}
                    />
                  )}
                </>
              )}
              <button className="expand-btn" onClick={handlePass} style={{ height: '36px', padding: '0 16px', color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)', background: 'rgba(239, 68, 68, 0.1)' }}>
                <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                {showPassInput ? 'Confirm Dismiss' : 'Dismiss'}
              </button>
            </div>
          )}

          {/* Promote Button (Dismissed only) */}
          {job.status === 'dismissed' && (
            <button className="expand-btn primary" onClick={handlePromote} style={{ height: '36px', padding: '0 16px', background: 'var(--accent)', borderColor: 'var(--accent)', color: '#fff' }}>
              <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
              Promote to Inbox
            </button>
          )}

          {/* I've Applied / Not Applied Flow */}
          {job.status !== 'dismissed' && job.status !== 'passed' ? (
            job.status === 'applied' || job.status === 'interviewing' ? (
              <>
                {job.status === 'applied' && (
                  <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'interviewing'); onClose(); }} style={{ height: '36px', padding: '0 16px', borderColor: '#3b82f6', color: '#3b82f6', background: 'rgba(59, 130, 246, 0.1)' }}>
                    <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Interviewing
                  </button>
                )}
                {job.status === 'interviewing' && (
                  <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'applied'); onClose(); }} style={{ height: '36px', padding: '0 16px', borderColor: '#f59e0b', color: '#f59e0b', background: 'rgba(245, 158, 11, 0.1)' }}>
                    <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                    Back to Applied
                  </button>
                )}
                <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'inbox'); onClose(); }} style={{ height: '36px', padding: '0 16px', color: 'var(--muted)' }}>
                  <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                  Not Applied
                </button>
              </>
            ) : (
              <button className="expand-btn" onClick={() => { onStatusChange(job.id, 'applied'); onClose(); }} style={{ height: '36px', padding: '0 16px', borderColor: '#22c55e', color: '#22c55e', background: 'rgba(34, 197, 94, 0.1)' }}>
                <CheckCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                I&apos;ve Applied
              </button>
            )
          ) : null}

          {/* Tailoring */}
          {onToggleTailoring && (
            job.tailoringStaged ? (
              <button className="expand-btn primary" onClick={() => { onToggleTailoring(job.id, false); onClose(); }} style={{ height: '36px', padding: '0 16px', background: 'var(--subtle)', borderColor: 'var(--border)', color: 'var(--text)' }}>
                <XCircle size={16} style={{ verticalAlign: 'middle', marginRight: '6px' }} />
                Unstage Resume
              </button>
            ) : (
              <button className="expand-btn primary" onClick={() => { onToggleTailoring(job.id, true); onClose(); }} style={{ height: '36px', padding: '0 16px', background: 'var(--text)', borderColor: 'var(--text)', color: '#000' }}>
                <Bookmark size={16} style={{ verticalAlign: 'middle', marginRight: '6px', fill: 'currentColor' }} />
                Stage for Tailoring
              </button>
            )
          )}
        </div>
      </div>
    </div>
  </div>
  );
}
