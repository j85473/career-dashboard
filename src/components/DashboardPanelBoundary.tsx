'use client';

import { useEffect } from 'react';
import { catchError, type ErrorInfo } from 'next/error';

function PanelFallback({ label }: { label: string }, { error, reset }: ErrorInfo) {
  useEffect(() => {
    console.error('Dashboard panel failed to render', error);
  }, [error]);

  return (
    <div className="inline-error" role="alert">
      <p>{label} could not be displayed. Try again or choose another tab.</p>
      <button type="button" className="btn" onClick={reset}>Try again</button>
    </div>
  );
}

// Reset remounts failed children; panels such as Stats reload their data on mount.
export const DashboardPanelBoundary = catchError(PanelFallback);
