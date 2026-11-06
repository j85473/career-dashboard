// Presentation only: keep the stored evidence intact for search and scoring.
// Commas belong to addresses, so only explicit list separators split locations.
export function jobLocationPresentation(location: string | null | undefined) {
  const locations = (location || '').split(/;|\r?\n/).map(value => value.trim()).filter(Boolean);
  const fullText = locations.join('; ');
  const multiple = locations.length > 1;
  const summary = multiple
    ? `${locations.length} listed locations${/\bremote\b/i.test(fullText) ? ' · includes remote' : ''}`
    : fullText.length > 96 ? `${fullText.slice(0, 93).trimEnd()}…` : fullText || 'Location not provided';
  return { locations, summary, expandable: multiple || fullText.length > 96 };
}
