import { hasExplicitRemoteExclusion, hasResidencyRequirement, hasRegularPresenceRequirement } from './jobLocationPolicy';
import { US_STATE_LOCATION_PATTERN } from './postingLocation';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const countries = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** The posting address is not a residence restriction when the ATS says remote.
 * Preserve the address alongside the work arrangement and country. This retains
 * the posting for JD eligibility review; it does not establish worldwide access
 * or override explicit residency/office requirements.
 */
export function smartRecruitersLocation(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return text(value) || null;
  const location = value as Record<string, unknown>;
  const code = text(location.country);
  const country = /^[a-z]{2}$/i.test(code) ? countries.of(code.toUpperCase()) || code : code;
  const address = text(location.fullLocation)
    || [text(location.city), text(location.region), country].filter(Boolean).join(', ');
  if (location.hybrid === true) return address ? `Hybrid - ${address}` : 'Hybrid';
  if (location.remote !== true) return address || null;
  // Authored restrictions remain attached to the remote location. A city by
  // itself is only the posting address; "Ohio only" is an actual restriction.
  const restricted = hasResidencyRequirement(address) || hasRegularPresenceRequirement(address)
    || hasExplicitRemoteExclusion(address) || /\b(?:only|residents?|restricted|eligible states?|except|excluding|within \d+)\b/i.test(address)
    || new RegExp(`^(?:Remote\\s*[-,]?\\s*)?${US_STATE_LOCATION_PATTERN}(?:,?\\s*(?:US|USA|United States))?(?:\\s*\\(Remote\\))?$`, 'i').test(address);
  if (restricted) return `Remote - ${address}`;
  const remote = country ? `Remote - ${country}` : 'Remote';
  return address && address !== country ? `${remote}; ${address}` : remote;
}
