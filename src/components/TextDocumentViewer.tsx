'use client';

import { useEffect, useState } from 'react';

export function TextDocumentViewer({ url, label }: { url: string; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('Document unavailable');
      const content = await response.text();
      if (!controller.signal.aborted) setText(content);
    }).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [url, attempt]);
  return <section className="job-document-text-viewer" aria-label={label}>
    {error ? <div role="alert">
      <p>This document could not be previewed. You can download it or try again.</p>
      <button type="button" onClick={() => { setError(false); setAttempt(value => value + 1); }}>Retry preview</button>
    </div> : text === null ? <p role="status">Loading transcript…</p> : <pre>{text}</pre>}
  </section>;
}
