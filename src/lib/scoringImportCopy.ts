type ScoringStage = 'aim' | 'experience';

type ImportProjection = {
  applicable: boolean;
};

export type ScoringImportCopyPreview = {
  kind?: 'run';
  stage: ScoringStage;
  acceptedCount: number;
  safeFailureCount: number;
  completedBatchCount?: number;
  projections: ImportProjection[];
};

type ImportReceipt = {
  imported: number;
  released: number;
  completedBatches?: number;
};

const formatted = (value: number) => value.toLocaleString('en-US');
const plural = (value: number, singular: string, pluralForm = `${singular}s`) => (
  value === 1 ? singular : pluralForm
);

export const scoringStageLabel = (stage: ScoringStage) => (
  stage === 'aim' ? 'Aim Fit' : 'Experience Fit'
);

export const scoringImportUnitLabel = (preview: Pick<ScoringImportCopyPreview, 'kind'>) => (
  preview.kind === 'run' ? 'run' : 'batch'
);

export function pendingScoringImportCounts(preview: ScoringImportCopyPreview) {
  const resumedRun = preview.kind === 'run' && (preview.completedBatchCount || 0) > 0;
  if (preview.projections.length > 0 || resumedRun) {
    return {
      accepted: preview.projections.filter((projection) => projection.applicable).length,
      unscored: preview.projections.filter((projection) => !projection.applicable).length,
    };
  }
  return { accepted: preview.acceptedCount, unscored: preview.safeFailureCount };
}

export function scoringImportPreviewHeadline(preview: ScoringImportCopyPreview): string {
  const accepted = `${formatted(preview.acceptedCount)} accepted ${scoringStageLabel(preview.stage)} scoring ${plural(preview.acceptedCount, 'result')}`;
  const unscored = preview.safeFailureCount === 0
    ? 'no unscored jobs'
    : `${formatted(preview.safeFailureCount)} unscored ${plural(preview.safeFailureCount, 'job')} assigned to Scoring Failed`;
  return `File check: ${accepted} · ${unscored}`;
}

export function scoringImportConfirmationMessage(
  preview: ScoringImportCopyPreview,
  childBatchSize: number,
): string {
  const stage = scoringStageLabel(preview.stage);
  const unit = scoringImportUnitLabel(preview);
  const pending = pendingScoringImportCounts(preview);
  const lines = [
    `Import this ${stage} ${unit}?`,
    pending.accepted === 0
      ? `No new accepted ${stage} scoring results will be recorded.`
      : `${formatted(pending.accepted)} accepted ${stage} scoring ${plural(pending.accepted, 'result')} will be recorded.`,
    pending.unscored === 0
      ? 'No unscored jobs will be sent to Scoring Failed.'
      : `${formatted(pending.unscored)} unscored ${plural(pending.unscored, 'job')} will be sent to Scoring Failed.`,
  ];

  const completed = preview.completedBatchCount || 0;
  if (preview.kind === 'run' && completed > 0) {
    lines.push(`${formatted(completed)} completed child ${plural(completed, 'batch', 'batches')} will not be applied again.`);
  }
  if (preview.kind === 'run') {
    lines.push(
      `The run is applied one ${childBatchSize}-job child batch at a time. If a later child batch cannot be applied, completed child batches stay in place; upload the same result file after correcting the issue to resume.`,
    );
  }
  return lines.join('\n\n');
}

export function scoringImportCompletionMessage(
  stage: ScoringStage,
  kind: 'run' | 'batch',
  receipt: ImportReceipt,
): string {
  const stageLabel = scoringStageLabel(stage);
  const lines = [
    `${stageLabel} ${kind} import completed.`,
    receipt.imported === 0
      ? `No accepted ${stageLabel} scoring results are recorded for this ${kind}.`
      : `${formatted(receipt.imported)} accepted ${stageLabel} scoring ${plural(receipt.imported, 'result')} ${plural(receipt.imported, 'is', 'are')} recorded for this ${kind}.`,
    receipt.released === 0
      ? `No unscored jobs from this ${kind} were sent to Scoring Failed.`
      : `${formatted(receipt.released)} unscored ${plural(receipt.released, 'job')} from this ${kind} ${plural(receipt.released, 'was', 'were')} sent to Scoring Failed.`,
  ];
  if (kind === 'run' && receipt.completedBatches) {
    lines.push(`${formatted(receipt.completedBatches)} child ${plural(receipt.completedBatches, 'batch', 'batches')} completed.`);
  }
  return lines.join('\n');
}
