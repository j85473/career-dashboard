function bounded(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export const ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK = bounded(
  process.env.ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK, 100_000, 1_000, 10_000_000,
);
export const ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK = BigInt(bounded(
  process.env.ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK, 1_500_000_000, 10_000_000, 20_000_000_000,
));
// Stop opening boards well before the hard safety limit. Continuation still
// runs: only finishing the listing can make those observations drainable.
export const ATS_V2_MAX_UNFINISHED_LISTINGS = bounded(
  process.env.ATS_V2_MAX_UNFINISHED_LISTINGS, 32, 8, 256,
);

export function evaluateAtsAcquisitionPressure(input: {
  items: number;
  bytes: bigint;
  unfinishedListings: number;
}) {
  const itemAdmissionLimit = Math.floor(ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK / 2);
  const byteAdmissionLimit = ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK / BigInt(2);
  const blocked = input.items >= ATS_LEDGER_STAGING_ITEM_HIGH_WATERMARK
    || input.bytes >= ATS_LEDGER_STAGING_BYTE_HIGH_WATERMARK;
  const admissionReason = blocked ? 'capacity'
    : input.items >= itemAdmissionLimit || input.bytes >= byteAdmissionLimit ? 'staging'
      : input.unfinishedListings >= ATS_V2_MAX_UNFINISHED_LISTINGS ? 'unfinished_listings' : 'open';
  return {
    ...input, blocked, admissionBlocked: admissionReason !== 'open', admissionReason,
    itemAdmissionLimit, byteAdmissionLimit,
    unfinishedListingLimit: ATS_V2_MAX_UNFINISHED_LISTINGS,
  };
}
