/** A successful HTTP status alone is not a usable mutation acknowledgement. */
export async function readClientMutationResponse(
  response: Response,
  fallbackError: string,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new Error(fallbackError);
    throw new Error('The server returned an unreadable response. Refresh to verify the result before trying again.');
  }
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  if (!response.ok) {
    throw new Error(typeof record?.error === 'string' && record.error ? record.error : fallbackError);
  }
  if (!record || Object.keys(record).length === 0) {
    throw new Error('The server returned an incomplete response. Refresh to verify the result before trying again.');
  }
  return record;
}
