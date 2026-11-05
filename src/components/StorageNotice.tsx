'use client';

import { useEffect, useState } from 'react';
import type { StoragePressure } from '@/lib/storagePressure';

export function StorageNotice() {
  const [state, setState] = useState<StoragePressure | null>(null);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const response = await fetch('/api/storage', { cache: 'no-store' });
        if (response.ok && active) setState(await response.json());
      } catch { /* Keep the last capacity warning during a connection failure. */ }
    };
    void update();
    const timer = setInterval(() => { void update(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  if (!state || ['disabled', 'normal'].includes(state.level)) return null;
  return <aside role="status" style={{ padding: '12px 20px', background: '#422c0b', color: '#fff0ce', borderBottom: '1px solid #b47b29', fontSize: 14 }}>
    <strong>{state.backgroundPaused ? 'Background work paused. ' : state.collectionPaused ? 'Collection paused. ' : 'Storage warning. '}</strong>
    {state.message}
    {state.freeBytes !== null && <span> {(state.freeBytes / 1024 ** 3).toFixed(1)} GiB available.</span>}
  </aside>;
}
