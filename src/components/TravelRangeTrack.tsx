'use client';

import type { TravelRange } from '@/types/job';

export function TravelRangeTrack({ range, expanded = false }: { range: TravelRange; expanded?: boolean }) {
  const className = expanded ? 'expand-travel-range-track' : 'travel-range-track';
  const fillStyle = range.kind === 'point' || range.kind === 'none' || range.kind === 'qualitative'
    ? undefined
    : { left: `${range.minimumPercent}%`, width: `${range.maximumPercent - range.minimumPercent}%` };
  const accessible = `Travel stated in job description: ${range.label}${range.sourceText && range.sourceText !== range.label ? `. ${range.sourceText}` : ''}`;
  return (
    <div className={className} role="img" aria-label={accessible}>
      <span className="travel-range-scale" aria-hidden="true">0%</span>
      <div className="travel-range-rail" aria-hidden="true">
        {fillStyle && <span className="travel-range-segment" style={fillStyle} />}
        {range.kind === 'point' && <span className="travel-range-point" style={{ left: `${range.minimumPercent}%` }} />}
        {range.kind === 'qualitative' && <span className="travel-range-qualitative" />}
      </div>
      <span className="travel-range-scale" aria-hidden="true">100%</span>
    </div>
  );
}
