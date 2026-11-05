/** Two public collectors can write concurrently: HTTP and the shared browser
 * lane (including Gusto). Keep their bounded turns inside the existing ceiling. */
export const ATS_PUBLIC_TURN_JOBS = 50;
export const ATS_PUBLIC_CAPACITY_RESERVE = ATS_PUBLIC_TURN_JOBS * 2;

export function atsPersistenceAllocation(lowWatermark: number, highWatermark: number) {
  const ceiling = Math.max(100, Math.floor(highWatermark));
  const publicReserve = Math.min(ATS_PUBLIC_CAPACITY_RESERVE, Math.floor(ceiling / 2));
  const publicationHigh = ceiling - publicReserve;
  return {
    ceiling, publicReserve, publicationHigh,
    publicationLow: Math.max(0, Math.min(Math.floor(lowWatermark), publicationHigh - 1)),
  };
}
