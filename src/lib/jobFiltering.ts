export function passesPreFilter(job: { title: string, description: string, location: string, url: string, company: string }): { passes: boolean, reason: string } {
  if (!job.title || !job.company) return { passes: false, reason: 'Missing title or company' };

  const titleLower = job.title.toLowerCase();
  const descLower = job.description ? job.description.toLowerCase() : '';

  // Location feeds are inconsistent: many remote jobs say only "United States"
  // in the location field and put the remote signal in the title/JD. Reject only
  // when we have a clear, non-target location; unknown locations stay eligible.
  const locationLower = job.location ? job.location.toLowerCase() : '';
  const targetLocation = /\b(mn|minnesota|minneapolis|st\.?\s*paul|saint paul|remote|flexible|worldwide|anywhere|nationwide|united states|u\.?s\.?)\b/;
  const remoteEvidence = /\b(remote|work from home|work[- ]from[- ]anywhere|distributed|nationwide)\b/;
  const locationUnknown = !locationLower || /^(unknown|n\/a|not specified|multiple locations?)$/i.test(locationLower.trim());
  if (!locationUnknown && !targetLocation.test(locationLower) && !remoteEvidence.test(`${titleLower} ${descLower}`)) {
    return { passes: false, reason: `Location rejected (${job.location})` };
  }

  // Explicit employment-type exclusions are deterministic enough to handle
  // locally. Ambiguous mentions in the body are left for the scorer.
  if (/\bpart[-\s]?time\b/.test(titleLower) || /\bPT\b/.test(job.title) || /\(PT\)/i.test(job.title) || /(?:employment|job)\s*type\s*:?\s*part[-\s]?time/i.test(descLower)) {
    return { passes: false, reason: 'Part-time role rejected' };
  }

  // Check for 1099 / Contract
  if (/\b1099\b/.test(titleLower) || /\bcontract\b/.test(titleLower) || /\bcontractor\b/.test(titleLower) || /(?:employment|job)\s*type\s*:?\s*(?:1099|contract(?:or)?)/i.test(descLower)) {
    return { passes: false, reason: 'Contract/1099 role rejected' };
  }

  // Check for Inside Sales
  if (/\binside sales\b/.test(titleLower)) {
    return { passes: false, reason: 'Inside Sales role rejected' };
  }

  // Reject test/demo/sandbox roles
  if (/\b(test|demo|sandbox|autofill)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Test/demo role rejected' };
  }

  // Check for Retail Specific / Entry Level
  if (/\b(retail|store|shop|boutique|merchandiser|stocker|cashier|sales associate)\b/.test(titleLower) && !/\b(corporate|regional|district|director|vp|head|president)\b/.test(titleLower)) {
    return { passes: false, reason: 'Retail role rejected' };
  }
  if (/\bentry[-\s]?level\b/.test(titleLower)) {
    return { passes: false, reason: 'Entry Level role rejected' };
  }

  // Reject basic administrative roles
  if (/\b(administrative assistant|admin assistant|receptionist|office manager|executive assistant|secretary|data entry|clerk|bookkeeper|front desk|administrative coordinator|office assistant|file clerk|mailroom|office administrator)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Administrative role rejected' };
  }

  // Reject hourly/service roles
  if (/\b(warehouse|driver|delivery|cashier|customer service|call center|barista|bartender|server|waiter|waitress|janitor|cleaner|housekeeper|housekeeping|laborer|stocker|merchandiser|teller|dispatcher|retail associate|sales associate|student worker|food service|cook|chef|hostess|busser|dishwasher|security guard|valet|baggage handler|factory|assembly|production worker|technician)\b/i.test(titleLower) && !/\b(manager|director|vp|head|lead|supervisor)\b/.test(titleLower)) {
    return { passes: false, reason: 'Hourly/Service role rejected' };
  }
  
  // Reject Human Resources roles
  if (/\b(human resources|hr partner|hr business partner|talent acquisition|recruiter)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Human Resources role rejected' };
  }

  // Reject Healthcare/Clinical roles
  if (/\b(clinical|nurse|nursing|physician|therapist|medical assistant|phlebotomist|dentist|dental|pharmacist|paramedic|home health)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Healthcare/Clinical role rejected' };
  }

  // Reject Maintenance/Facilities/Property roles
  if (/\b(maintenance|facilities|property management|leasing consultant|mechanic|hvac|electrician|plumber|carpenter|welder|quality assurance technician)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Maintenance/Facilities role rejected' };
  }

  // Reject Accounting/Actuarial roles
  if (/\b(accounting|accountant|actuarial|tax consultant|auditor|payroll)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Accounting/Actuarial role rejected' };
  }

  // Reject Logistics/Supply Chain roles
  if (/\b(dispatch|logistics|supply chain|inventory|materials planner)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Logistics/Supply Chain role rejected' };
  }

  // Reject interns/co-ops
  if (/\b(intern|internship|co-op|volunteer|trainee|apprentice)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Internship role rejected' };
  }

  // Reject Software Engineering roles (per user request)
  if (/\b(software engineer|software developer|fullstack|frontend|backend|full stack|front end|back end|ios developer|android developer)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Software Engineering role rejected' };
  }

  return { passes: true, reason: 'Passed regex pre-filter' };
}
