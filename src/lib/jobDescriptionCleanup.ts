/**
 * Keep the authored posting from known full-page reader responses. This is
 * extraction, not rewriting: no duties or requirements are inferred. Unknown
 * layouts stay intact so quality validation can reject them for recovery.
 */
export function cleanJobDescriptionPage(value: string): string {
  if (!/https?:\/\/(?:[a-z]{2}\.)?trabajo\.org(?:\/|\b)/i.test(value)) return value;
  const heading = /^# [^\n]+\r?$/m.exec(value);
  if (!heading) return value;
  const afterHeading = value.slice(heading.index + heading[0].length);
  const end = /^\s*This job listing is provided by a partner site\b[^\n]*$/mi.exec(afterHeading);
  if (!end) return value;
  let body = afterHeading.slice(0, end.index);
  // The first rule separates the title/date/apply button from job metadata.
  const divider = /^\s*\* \* \*\s*$/m.exec(body);
  if (!divider) return value;
  body = body.slice(divider.index + divider[0].length).trim();
  // The metadata is one line (location, employer, employment type). Require
  // that observed boundary rather than guessing where the prose begins.
  const metadata = /^[^\n]+?\b(?:Full-time|Part-time|Contract|Temporary|Internship)([^\n]*)\r?\n/i.exec(body);
  if (!metadata) return value;
  body = body.slice(metadata[0].length).trim();
  if (/^Free with email or Google\b/i.test(body)) {
    const accountPanel = /^Free with email or Google\s+## Save this job and keep your search organized\s+Create a free account to save jobs, create alerts and return to this listing from your dashboard\.\s+Save jobSave and create alert\s+Free with email or Google\s+/i.exec(body);
    if (!accountPanel) return value;
    body = body.slice(accountPanel[0].length).trim();
    body = body.replace(/^By continuing, you agree to our Terms\s*&\s*Privacy Policy\.\s*/i, '').trim();
  }
  body = body.replace(/\s*(?:#J-[\w-]+\s*)?(?:\* \* \*\s*)?$/, '').trim();
  if (!body) return value;
  // Some listings put salary next to the employment type instead of in the
  // prose. Retain that exact text without inventing a currency or pay period.
  const metadataDetail = metadata[1].trim();
  if (metadataDetail) body += `\n\n${metadataDetail}`;
  // Keep the reader's own missing-target evidence; removing page furniture
  // must not turn a confirmed HTTP 404/410 into an ordinary short summary.
  const missingTarget = /^Warning: Target URL returned error (?:404|410)[^\n]*$/mi.exec(value.slice(0, 1_000));
  return missingTarget ? `${missingTarget[0]}\n\nMarkdown Content:\n${body}` : body;
}

/** A changed layout must not pass the length gate on navigation alone. */
export function looksLikeTrabajoPageChrome(value: string): boolean {
  return /This job listing is provided by a partner site/i.test(value)
    && /Save this job and keep your search organized/i.test(value)
    && /(?:Why are you reporting this listing|Search jobsSalariesProfessional Career Guides)/i.test(value);
}
