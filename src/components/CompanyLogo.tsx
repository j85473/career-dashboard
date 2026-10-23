'use client';

import { useEffect, useRef, useState } from 'react';
import { companyLogoInitials } from '@/lib/companyLogo';
import { loadCompanyLogo } from '@/lib/companyLogoClient';

function LogoImage({ src }: { src: string }) {
  const target = useRef<HTMLSpanElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    let idle: number | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const load = () => {
      void loadCompanyLogo(src, controller.signal).then(image => {
        if (!image || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(image);
        setImageUrl(objectUrl);
      }).catch(() => {});
    };
    const visible = () => {
      if (started) return;
      started = true;
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(load, { timeout: 1000 });
      else fallback = setTimeout(load, 100);
    };
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); visible(); }
    }, { rootMargin: '400px' });
    if (target.current) observer.observe(target.current);
    return () => {
      controller.abort();
      observer.disconnect();
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (fallback !== undefined) clearTimeout(fallback);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src]);
  return (
    <span ref={target} style={{ position: 'absolute', inset: 0 }}>
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt="" referrerPolicy="no-referrer"
          style={{ width: '100%', height: '100%', objectFit: 'contain', background: 'white' }}
          onError={() => setImageUrl(null)} />
      )}
    </span>
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
  query.set('v', '4');
  const src = company ? `/api/company-logo?${query}` : null;
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
