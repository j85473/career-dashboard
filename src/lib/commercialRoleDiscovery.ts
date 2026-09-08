/** Occupational evidence for discovery only; never an Aim/Experience override. */
export function hasCommercialOccupationTitle(title: string): boolean {
  const value = title.toLowerCase().replace(/\bmgr\b/g, 'manager');
  return /\bsales\s+(?:manager|director|representative|rep|executive|consultant|specialist)\b/.test(value)
    || /\b(?:manager|director)(?:\s+of)?\s+(?:territory\s+|regional\s+)?sales\b/.test(value)
    || /\baccounts?\s+(?:manager|director|executive)\b/.test(value)
    || /\b(?:distributor|dealer|retail|customer)\s+business\s+manager\b/.test(value)
    || /\bbusiness development\s+(?:manager|director|executive)\b/.test(value);
}

/** Newly searched titles that the older channel-title vocabulary missed. */
export function hasAdditionalTerritoryRetailTitle(title: string): boolean {
  return /\bretail business manager\b|\bmanufacturers?\s+sales\s+(?:representative|rep)\b/i.test(title);
}

/**
 * Generic Sales Representative titles need commercial account/territory
 * evidence in the JD. This admits Bunzl-style distributor work without making
 * every generic sales or retail-store title a new target family.
 */
export function hasTerritoryAccountSalesEvidence(title: string, description: string): boolean {
  if (!/\bsales\s+(?:representative|rep)\b/i.test(title)) return false;
  const text = description.replace(/\s+/g, ' ');
  const accountWork = /\b(?:manage|grow|expand|develop|retain|visit|train|coach)\w*\b.{0,120}\b(?:accounts?|customers?|distributors?|dealers?|retailers?|partners?)\b/i.test(text);
  const territoryOrNetwork = /\b(?:existing|assigned|current)\b.{0,60}\b(?:territor(?:y|ies)|accounts?|customers?|clients?)\b|\b(?:distributor|dealer|retailer|wholesale)\s+(?:accounts?|networks?|relationships?|partners?)\b/i.test(text);
  return accountWork && territoryOrNetwork;
}
