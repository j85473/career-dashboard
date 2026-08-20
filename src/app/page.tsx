import { Suspense } from 'react';
import Dashboard from '@/components/Dashboard';

export default function Home() {
  return (
    <main>
      <Suspense fallback={<div className="dashboard-route-loading">Loading Dashboard…</div>}>
        <Dashboard />
      </Suspense>
    </main>
  );
}
