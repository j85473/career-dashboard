/** Scoped customer/partner functions, independent of seniority or staff management. */
export function hasMidLevelCommercialTitle(title: string): boolean {
  const value = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const functionName = '(?:(?:partner|channel|customer|client|dealer) (?:account|success|enablement|onboarding|education|adoption|activation)|(?:channel|partner) sales|(?:sales|revenue|commercial) enablement)';
  return new RegExp(`\\b${functionName} (?:specialist|associate|coordinator)\\b`).test(value)
    || new RegExp(`\\b(?:specialist|associate|coordinator) (?:in |of )?${functionName}\\b`).test(value);
}

/** Occupational evidence for discovery only; never an Aim/Experience override. */
export function hasCommercialOccupationTitle(title: string): boolean {
  const value = title.toLowerCase().replace(/\bmgr\b/g, 'manager');
  return hasMidLevelCommercialTitle(title)
    || /\bsales\s+(?:manager|director|representative|rep|executive|consultant|specialist)\b/.test(value)
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

/**
 * Alternate commercial titles may reach review on explicit external-network
 * duties. A dealer mention or generic stakeholder language is not enough.
 * This supplies discovery evidence only; motion and qualification gates remain.
 */
export function hasDealerDistributorAccountEvidence(title: string, description: string): boolean {
  const value = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  const scopedTitle = hasCommercialOccupationTitle(title)
    || (/\b(?:dealer|distributor|reseller|channel|partner|territory|district|regional|retail|field)\b/.test(value)
      && /\b(?:manager|director|lead|leader|consultant|coach|trainer|specialist|representative|rep|executive|advisor|coordinator|associate)\b/.test(value));
  if (!scopedTitle || /\b(?:warehouse|distribution cent(?:er|re)|logistics|supply chain|inventory|shipping|technician|installer|mechanic|engineer|clerk|casino|table games|store manager)\b/.test(value)) return false;

  return description.split(/[.!?;\n]+/).some((part) => {
    const clause = part.replace(/\s+/g, ' ').trim();
    if (/\b(?:do(?:es)? not|will not|never|not responsible for|no responsibility for)\b/i.test(clause)) return false;
    const network = '\\b(?:dealers?|dealerships?|distributors?|resellers?|wholesalers?|distribution partners?)\\b';
    const accountDuties = new RegExp(`\\b(?:own|lead|manag|grow|expand|develop|retain|visit|train|coach|enabl|advis|educat|cultivat|strengthen|improv|optimiz)\\w*\\b.{0,120}${network}`, 'i');
    const directContact = new RegExp(`\\bwork\\w*\\s+directly\\s+with\\b.{0,100}${network}`, 'i');
    const commercialWork = /\b(?:accounts?|relationships?|sales|revenue|growth|sell[ -]through|train\w*|coach\w*|performance|consultations?|business plans?)\b/i.test(clause);
    return commercialWork && (accountDuties.test(clause) || directContact.test(clause));
  });
}
