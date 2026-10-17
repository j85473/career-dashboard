import { normalizeJobLocation } from './jobIngestion';
import { isExplicitInternationalLocationOption } from './jobLocationPolicy';

/**
 * Preserve the historical reprint-consolidation policy. Canonical-link lookup
 * can recognize more location formats without expanding which existing cards
 * automatic rediscovery may consolidate and hide.
 */
export function locationsCompatibleForReprint(
  aggregatorLocation: string | null | undefined,
  postingLocation: string | null | undefined,
): boolean {
  const left = normalizeJobLocation(String(aggregatorLocation || ''));
  const right = normalizeJobLocation(String(postingLocation || ''));
  if (left === right) return true;
  if (left === 'unknown' || right === 'unknown') return true;
  if (isWorldwideLocation(left) || isWorldwideLocation(right)) return true;

  const leftForeign = isExplicitInternationalLocationOption(left);
  const rightForeign = isExplicitInternationalLocationOption(right);
  if (leftForeign !== rightForeign) return false;
  if (leftForeign && rightForeign) return left.includes(right) || right.includes(left);
  if (isBroadUsLocation(left) || isBroadUsLocation(right)) return true;
  return primaryPlace(aggregatorLocation) === primaryPlace(postingLocation);
}

function isBroadUsLocation(normalized: string): boolean {
  const withoutRemote = normalized.replace(/\bremote\b/g, ' ').replace(/\s+/g, ' ').trim();
  return withoutRemote === '' || withoutRemote === 'us';
}

function isWorldwideLocation(value: string): boolean {
  return /^(?:remote\s*[/,-]?\s*)?(?:anywhere(?: in the world)?|worldwide|global)(?:\s*[/,-]?\s*remote)?$/i.test(value.trim());
}

function primaryPlace(value: string | null | undefined): string {
  return normalizeJobLocation(String(value || '').split(',')[0] || '');
}
