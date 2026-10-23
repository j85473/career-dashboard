import { after } from 'next/server';
import type { LogoSubject } from './companyLogo';
import { companyLogoCache } from './companyLogoCache';

/** Release the browser's connection before doing any external logo recovery. */
export const companyLogoBackground = {
  schedule(subjects: readonly LogoSubject[]) {
    after(async () => {
      for (const subject of subjects) {
        try {
          const saved = await companyLogoCache.readSaved(subject);
          if (saved) {
            if (companyLogoCache.needsRefresh(saved)) await companyLogoCache.refresh(subject);
          } else if (await companyLogoCache.get(subject)) {
            break;
          }
        } catch { /* A logo failure leaves initials and the rest of the Dashboard available. */ }
      }
    });
  },
};
