'use client';

import { useState } from 'react';
import { companyLogoInitials, companyLogoUrl } from '@/lib/companyLogo';

function LogoImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', background: 'white' }}
      onError={() => setFailed(true)}
    />
  );
}

/** Decorative content for the existing company mark or navigation button. */
export function CompanyLogo({ company, url, canonicalUrl, jobId }: {
  company: string | null | undefined; url?: string | null; canonicalUrl?: string | null; jobId?: string;
}) {
  // The route loads saved evidence by id. These display values only bust the
  // browser cache after an employer correction or posting-link edit.
  const query = new URLSearchParams(jobId
    ? { jobId, company: company || '', posting: canonicalUrl || url || '' }
    : { company: company || '' });
  const src = companyLogoUrl({ company, url, canonicalUrl })
    || (company ? `/api/company-logo?${query}` : null);
  return (
    <>
      <span aria-hidden="true" style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', margin: 0 }}>
        {companyLogoInitials(company)}
      </span>
      {/* Reset failure state when the resolved logo changes. */}
      {src && <LogoImage key={src} src={src} />}
    </>
  );
}
