type PreFilterResult = { passes: boolean, reason: string };

const MINNEAPOLIS_METRO = /\b(?:minneapolis|st\.?\s*paul|saint paul|twin cities|arden hills|bloomington|brooklyn center|brooklyn park|burnsville|champlin|chanhassen|chaska|circle pines|columbia heights|coon rapids|cottage grove|crystal(?!\s+city)|eagan|eden prairie|edina|falcon heights|fridley|golden valley|hopkins|inver grove heights|lauderdale|lakeville|little canada|maple grove|maplewood|mendota heights|minnetonka|mounds view|new brighton|new hope|north st\.?\s*paul|oakdale|osseo|plymouth|prior lake|richfield|robbinsdale|roseville|savage|shakopee|shoreview|south st\.?\s*paul|spring lake park|st\.?\s*louis park|stillwater|vadnais heights|wayzata|west st\.?\s*paul|white bear lake|woodbury|55405|(?:550|551|553|554)\d{2})\b/i;
const LOCAL_WISCONSIN_METRO = /\b(?:hudson|river falls),?\s*(?:wi|wisconsin)\b/i;
const OUTSTATE_MINNESOTA = /\b(?:rochester|duluth|st\.?\s*cloud|saint cloud|mankato|moorhead|bemidji|brainerd|alexandria|faribault|hibbing|marshall|owatonna|red wing|willmar|winona)\b/i;
const INTERNATIONAL_LOCATION = /\b(?:eu|europe|dach|emea|apac|latam|uk|united kingdom|london|england|ireland|dublin|india|chennai|bengaluru|bangalore|hyderabad|pune|germany|berlin|munich|france|paris|spain|madrid|barcelona|portugal|lisbon|netherlands|amsterdam|belgium|brussels|italy|rome|milan|sweden|stockholm|poland|warsaw|australia|sydney|melbourne|new zealand|auckland|singapore|malaysia|philippines|vietnam|japan|tokyo|china|beijing|shanghai|brazil|brasil|sao paulo|argentina|mexico|canada|toronto|vancouver|montreal|south africa|cape town|saudi arabia|riyadh|united arab emirates|dubai)\b/i;
const NON_MINNESOTA_STATE = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i;
const NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR = /(?:,|\(|\/|-)\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/i;
const NON_MINNESOTA_STATE_CODE_ONLY = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)$/i;
const NONLOCAL_MAJOR_CITY = /\b(?:austin|atlanta|baltimore|boston|charlotte|chicago|cincinnati|cleveland|columbus|dallas|denver|des moines|detroit|houston|indianapolis|kansas city|las vegas|los angeles|madison|memphis|miami|milwaukee|nashville|new york city|nyc|omaha|orlando|philadelphia|phoenix|pittsburgh|portland|raleigh|richmond|sacramento|salt lake city|san antonio|san diego|san francisco|san jose|seattle|st\.?\s*louis|tampa|washington,?\s*d\.?c\.?)\b/i;

function splitLocationOptions(location: string): string[] {
  return location
    .split(/\s+(?:or)\s+|[;/|]/i)
    .map((option) => option.trim().replace(/^[([]+|[)\]]+$/g, '').trim())
    .filter(Boolean);
}

function normalizeLocationOption(option: string): string {
  return option.trim().replace(/[()[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

function hasNonMinnesotaStateMarker(text: string): boolean {
  return NON_MINNESOTA_STATE.test(text)
    || NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR.test(text)
    || NON_MINNESOTA_STATE_CODE_ONLY.test(text.trim());
}

function isMinneapolisMetroOption(option: string): boolean {
  if (LOCAL_WISCONSIN_METRO.test(option)) return true;
  return MINNEAPOLIS_METRO.test(option) && !hasNonMinnesotaStateMarker(option);
}

function hasMinneapolisMetroOption(location: string): boolean {
  return splitLocationOptions(location).some(isMinneapolisMetroOption);
}

function isStatewideMinnesotaOption(option: string): boolean {
  return /^(?:(?:remote|virtual)\s*[-,]?\s*)?(?:mn|minnesota)(?:,\s*(?:u\.?s\.?a?|united states))?(?:\s*[-,]?\s*(?:remote|virtual))?$/i.test(normalizeLocationOption(option));
}

function hasStatewideMinnesotaOption(location: string): boolean {
  return splitLocationOptions(location).some(isStatewideMinnesotaOption);
}

function isUnknownOrBroadUSOption(option: string): boolean {
  return /^(?:unknown(?: location)?|n\/a|not specified|multiple locations?|u\.?s\.?a?|united states(?: of america)?|north america)$/i.test(normalizeLocationOption(option));
}

function isGeneralRemoteOption(option: string): boolean {
  const trimmed = normalizeLocationOption(option);
  return /^(?:(?:remote|virtual|home[- ]based|work from home|distributed|flexible)(?:\s*[-,]?\s*(?:u\.?s\.?a?|united states|north america|nationwide|anywhere|worldwide))?|(?:u\.?s\.?a?|united states|north america|nationwide|worldwide)\s*[-,]?\s*(?:remote|virtual|home[- ]based)|anywhere|worldwide|nationwide)$/i.test(trimmed);
}

function hasGeneralRemoteOption(location: string): boolean {
  return splitLocationOptions(location).some(isGeneralRemoteOption);
}

function hasExplicitUSRemoteOption(location: string): boolean {
  return splitLocationOptions(location).some((option) => {
    const trimmed = normalizeLocationOption(option);
    return /^(?:(?:remote|virtual|home[- ]based|work from home|distributed)\s*[-,]?\s*(?:u\.?s\.?a?|united states|north america|nationwide|anywhere|worldwide)|(?:u\.?s\.?a?|united states|north america|nationwide|worldwide)\s*[-,]?\s*(?:remote|virtual|home[- ]based)|worldwide|anywhere)$/i.test(trimmed);
  });
}

function hasExplicitRemoteExclusion(text: string): boolean {
  return /\b(?:this\s+(?:role|position|job)\s+is\s+not|not\s+(?:a\s+)?|cannot\s+be|can't\s+be|non[\s-])remote\b/i.test(text)
    || /\bremote\s+work\s+(?:is\s+)?not\s+(?:available|allowed|offered|permitted)\b/i.test(text)
    || /\bno\s+remote(?:\s+work)?\b/i.test(text)
    || /\bremote[\s-]only candidates?\s+(?:will not|won't|do not|don't|are not)\b/i.test(text)
    || /\b(?:on[\s-]?site|in[\s-]?office|office[\s-]?based)\s+only\b/i.test(text);
}

function hasExplicitNationalRemoteEvidence(text: string): boolean {
  const normalized = text
    .replace(/\bnot\s+(?:a\s+)?remote\s+(?:role|position|job)\b/gi, ' ')
    .replace(/\bremote\s+work\s+(?:is\s+)?not\s+(?:available|allowed|offered|permitted)\b/gi, ' ')
    .replace(/\bno\s+remote(?:\s+work)?\b/gi, ' ');

  return /\b(?:fully|entirely|completely|100\s*%)\s+remote\s+(?:role|position|job|work arrangement)?\b.{0,80}\b(?:u\.?s\.?a?|united states|nationwide)\b/i.test(normalized)
    || /\b(?:u\.?s\.?a?|united states|nationwide)\b.{0,80}\b(?:fully|entirely|completely|100\s*%)\s+remote\b/i.test(normalized)
    || /\b(?:remote|home[- ]based)\s+(?:role|position|job|work arrangement)\b.{0,80}\b(?:across|throughout|anywhere in|open to candidates in)\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\b(?:may|can|could|are free to)\s+(?:live|reside|be based|work)\s+anywhere\s+(?:in|within|across)\s+(?:the\s+)?(?:u\.?s\.?a?|united states)\b/i.test(normalized)
    || /\bwork\s+from\s+anywhere(?:\s+in\s+(?:the\s+)?(?:u\.?s\.?a?|united states))?\b/i.test(normalized)
    || /\b(?:open|available)\s+to\s+candidates?\s+(?:nationwide|across|throughout)\s*(?:the\s+)?(?:u\.?s\.?a?|united states)?\b/i.test(normalized)
    || /\b(?:all\s+50\s+states|u\.?s\.?[- ]wide\s+remote)\b/i.test(normalized);
}

function containsNonlocalGeography(text: string): boolean {
  return OUTSTATE_MINNESOTA.test(text)
    || NON_MINNESOTA_STATE.test(text)
    || NON_MINNESOTA_STATE_CODE_AFTER_SEPARATOR.test(text)
    || NONLOCAL_MAJOR_CITY.test(text);
}

function containsSpecificNonlocalMetadata(location: string): boolean {
  return splitLocationOptions(location).some((option) => {
    if (isMinneapolisMetroOption(option)
      || isStatewideMinnesotaOption(option)
      || isUnknownOrBroadUSOption(option)
      || isGeneralRemoteOption(option)) {
      return false;
    }
    return true;
  });
}

function hasRegularPresenceRequirement(text: string, metadata = false): boolean {
  if (metadata && /\b(?:hybrid|on[- ]?site|in[- ]office|office[- ]based)\b/i.test(text)) return true;

  return /\bhybrid\s+(?:role|position|schedule|work arrangement)\b/i.test(text)
    || /\b(?:role|position|job|schedule|work arrangement)\s+(?:is|will be|operates as)\s+(?:a\s+)?hybrid\b/i.test(text)
    || /\b(?:on[- ]?site|in[- ]office|office[- ]based)\s+(?:role|position|job|schedule|attendance|requirement)\b/i.test(text)
    || /\b(?:must|required|expected)\s+(?:to\s+)?(?:work|report|come|be)\b.{0,60}\b(?:on[- ]?site|in[- ]office|in (?:the|our) office|at (?:the|our) office)\b/i.test(text)
    || /\b(?:one|two|three|four|five|\d+)\s+days?\s+(?:per|a|each)\s+week\b.{0,50}\b(?:office|on[- ]?site)\b/i.test(text)
    || /\b(?:work|working)\s+from\s+(?:the|our|an?)\s+[^.\n]{0,40}\boffice\b/i.test(text);
}

function hasResidencyRequirement(text: string): boolean {
  return /\b(?:candidates?|applicants?|employees?|you)\s+(?:must|need to|are required to)\s+(?:currently\s+)?(?:live|reside|be based|be located|be within commuting distance)\b/i.test(text)
    || /\b(?:must|need to|required to)\s+(?:currently\s+)?(?:live|reside|be based|be located|be within commuting distance)\b/i.test(text)
    || /\bonly\s+(?:available|open)\s+to\s+candidates?\s+who\s+(?:live|reside|are based|are located)\b/i.test(text)
    || /\bremote\s+(?:role|position|job)?\s*(?:is\s+)?(?:limited|restricted)\s+to\b/i.test(text);
}

function descriptionSentences(description: string): string[] {
  return description.split(/[\r\n]+|(?<=[.!?;])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
}

function locationRejection(job: { title: string, description: string, location: string }): PreFilterResult | null {
  const location = job.location?.trim() || '';
  const titleAndDescription = `${job.title || ''} ${job.description || ''}`;
  const sentences = descriptionSentences(job.description || '');
  const nationalRemoteEvidence = hasExplicitNationalRemoteEvidence(titleAndDescription);
  const explicitUSRemoteOption = hasExplicitUSRemoteOption(location);

  if (INTERNATIONAL_LOCATION.test(`${location} ${job.title}`) && !explicitUSRemoteOption && !nationalRemoteEvidence) {
    return { passes: false, reason: 'International location rejected' };
  }

  for (const sentence of sentences) {
    const offersCandidateCompatibleLocation = hasMinneapolisMetroOption(sentence)
      || /\bminnesota\b|\bMN\b/.test(sentence)
      || hasExplicitNationalRemoteEvidence(sentence);

    if (hasResidencyRequirement(sentence)
      && containsNonlocalGeography(sentence)
      && !offersCandidateCompatibleLocation) {
      return { passes: false, reason: 'Non-local residency requirement rejected' };
    }

    if (hasRegularPresenceRequirement(sentence)
      && containsNonlocalGeography(sentence)
      && !offersCandidateCompatibleLocation) {
      return { passes: false, reason: 'Non-local hybrid/onsite requirement rejected' };
    }
  }

  const hasMetroOption = hasMinneapolisMetroOption(location);
  const hasMinnesotaOption = hasStatewideMinnesotaOption(location);
  const hasRemoteOption = hasGeneralRemoteOption(location);
  const hasBroadUSOption = splitLocationOptions(location).some(isUnknownOrBroadUSOption);
  const locationUnknown = !location;
  const containsSpecificNonlocal = containsSpecificNonlocalMetadata(location);
  const metadataPresence = hasRegularPresenceRequirement(`${job.title} ${location}`, true)
    || sentences.some((sentence) => hasRegularPresenceRequirement(sentence));

  if (hasExplicitRemoteExclusion(titleAndDescription) && !hasMetroOption && !hasMinnesotaOption) {
    return { passes: false, reason: 'Role explicitly excludes remote work outside the Minneapolis metro' };
  }

  if (containsSpecificNonlocal && !hasMetroOption && !hasMinnesotaOption && metadataPresence) {
    return { passes: false, reason: `Non-local hybrid/onsite location rejected (${job.location})` };
  }

  if (hasMetroOption || hasMinnesotaOption || hasRemoteOption || hasBroadUSOption || locationUnknown) {
    return null;
  }

  if (containsSpecificNonlocal) {
    if (nationalRemoteEvidence) return null;
    if (OUTSTATE_MINNESOTA.test(location)) {
      return { passes: false, reason: 'Outstate MN location rejected' };
    }
    if (/\b(?:remote|virtual|home[- ]based)\b/i.test(location)) {
      return { passes: false, reason: `Remote role restricted to non-local location (${job.location})` };
    }
    return { passes: false, reason: `Location rejected (${job.location})` };
  }

  return null;
}

export function passesPreFilter(job: { title: string, description: string, location: string, url: string, company: string }): { passes: boolean, reason: string } {
  if (!job.title || !job.company) return { passes: false, reason: 'Missing title or company' };

  // Explicit company exclusions
  const bannedCompanies = [
    'equipmentshare',
    'home depot'
  ];
  const companyLower = job.company.toLowerCase().trim();
  if (bannedCompanies.some(company => companyLower.includes(company))) {
    return { passes: false, reason: `Banned company: ${job.company}` };
  }

  const rejectedLocation = locationRejection(job);
  if (rejectedLocation) return rejectedLocation;

  const titleLower = job.title.toLowerCase();
  const descLower = job.description ? job.description.toLowerCase() : '';

  // Explicit employment-type exclusions are deterministic enough to handle
  // locally. Ambiguous mentions in the body are left for the scorer.
  if (/\bpart[-\s]?time\b/.test(titleLower) || /\bPT\b/.test(job.title) || /\(PT\)/i.test(job.title) || /(?:employment|job)\s*type\s*:?\s*part[-\s]?time/i.test(descLower)) {
    return { passes: false, reason: 'Part-time role rejected' };
  }

  // Check for 1099 / Contract
  if (/\b1099\b/.test(titleLower) || /\bcontract\b/.test(titleLower) || /\bcontractor\b/.test(titleLower) || /(?:employment|job)\s*type\s*:?\s*(?:1099|contract(?:or)?)/i.test(descLower)) {
    return { passes: false, reason: 'Contract/1099 role rejected' };
  }  // Reject Inside Sales
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
  if (/\b(warehouse|driver|delivery|cashier|customer service|call center|barista|bartender|server|waiter|waitress|janitor|cleaner|housekeeper|housekeeping|laborer|stocker|merchandiser|teller|dispatcher|retail associate|sales associate|support associate|safety support|student worker|food service|cook|chef|hostess|busser|dishwasher|security guard|valet|baggage handler|factory|assembly|production worker|technician|hospitality|hotel|motel|resort|casino|bellhop|concierge|guest services)\b/i.test(titleLower) && !/\b(manager|director|vp|head|lead|supervisor)\b/.test(titleLower)) {
    return { passes: false, reason: 'Hourly/Service/Hospitality role rejected' };
  }

  // Reject Human Resources roles
  if (/\b(human resources|hr partner|hr business partner|talent acquisition|recruiter)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Human Resources role rejected' };
  }

  // Reject Healthcare/Clinical roles (base patterns)
  if (/\b(clinical|nurse|nursing|registered nurse|rn|cna|certified nursing assistant|physician|therapist|medical assistant|phlebotomist|dentist|dental|pharmacist|paramedic|home health)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Healthcare/Clinical role rejected' };
  }

  // Reject Maintenance/Facilities/Property roles
  if (/\b(maintenance|facilities|property management|leasing consultant|mechanic|hvac|electrician|plumber|carpenter|welder|quality control|quality assurance)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Maintenance/Facilities role rejected' };
  }

  // Reject Accounting/Actuarial/Finance/Audit roles
  if (/\b(accounting|accountant|actuarial|tax|audit|assurance|auditor|payroll|finance|financial analyst|controllers?)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Accounting/Finance/Audit role rejected' };
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
  if (/\b(software engineering|software engineer|software enginer|sofware engineer|software developer|full[\s-]?stack|frontend|backend|front[\s-]?end|back[\s-]?end|ios developer|android developer|devops|rust|integration engineer|solutions? architect|cloud data engineer|machine learning engineer|ml engineer|data engineer|dataops engineer|platform engineer|site reliability|ui engineer|web developer|mobile developer|forward[\s-]+deployed|ruby|java developer|python developer)\b/i.test(titleLower) || /\bc\+\+(?!\w)/i.test(titleLower)) {
    return { passes: false, reason: 'Software Engineering role rejected' };
  }


  // Reject Research & Analyst roles
  if (/\b(business analyst|research analyst|researcher|scientists?|research scientists?|research fellows?|chemists?|biologists?|laboratory manager|lab manager|technical writer|director of research|research director|market research|ux research|user research)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Research & Analyst role rejected' };
  }

  // Reject Product Management roles
  if (/\b(product manager|product owner)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Product Management role rejected' };
  }

  // Reject Generic/Junk roles
  if (/\b(open application|general application|talent pool|talent community|talent network)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Generic/Junk role rejected' };
  }

  // Reject Design / Creative roles
  if (/\b(designer|creative director|art director|ux\/ui|ui\/ux|user experience|user interface|graphic design|industrial design|visual design|motion design)\b/i.test(titleLower) && !/\b(product manager|program manager)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Design/Creative role rejected' };
  }

  // Reject Hardware / Physical R&D / Firmware
  if (/\b(hardware engineer|switchgear|fpga|asic|soc|r&d engineer|research and development|firmware|embedded engineer|embedded software|optical engineer|acoustics engineer)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Hardware/R&D role rejected' };
  }

  // Reject Data / IT / Infrastructure roles
  if (/\b(data engineer|database engineer|database administrator|dba|it support|it operations|information technology operations|help desk|service desk|technical support|desktop support|end[- ]user support|network support|support engineer|support analyst|network engineer|systems? administrator|sys\s?admin|infrastructure engineer|security engineer|information security|site reliability|sre|cloud engineer|site director|data center)\b/i.test(titleLower)) {
    return { passes: false, reason: 'IT/Data/Infra role rejected' };
  }

  // ── NEW PATTERNS (added from full queue audit) ──────────────────────────────

  // Veterinary / Animal Medicine
  if (/\bveterinar/i.test(titleLower) || /\b(ER DVM|DVM)\b/i.test(titleLower) || /\bnerd program\b/i.test(titleLower.replace(/[()]/g, '')) || /\blead doctor\b/i.test(titleLower)) {
    return { passes: false, reason: 'Veterinary role rejected' };
  }

  // Extended Clinical / Behavioral Health / Mental Health
  if (/\b(psychiatrist|psychologist|psycholoog|psychotherapist|psychosocial|counselor|BCBA|board\.certified behavior|behavior analyst|behavior interventionist|autism specialist|recovery support specialist|certified peer specialist|mobile crisis responder|mental health group facilitator|group facilitator|SUD group facilitator|integrative group facilitator|experiential facilitator|creative arts facilitator)s?\b/i.test(titleLower)) {
    return { passes: false, reason: 'Clinical/Behavioral Health role rejected' };
  }

  // Extended Medical / Clinical Care (non-behavioral)
  if (/\b(RN case manager|memory care|ultrasound technologist|physiatrist|HEDIS abstractor|caregiver|palliative|hospice|patient access specialist|patient finance specialist|revenue cycle|medical biller|medical billing|medical claims|credentialing specialist|credentialing manager|credentialing team lead|care navigator|community health worker|insurance verification specialist|utilization review|crisis intervention specialist|civil commitment|care coordinator|care coach|care admin|care experience specialist|recovery engagement specialist|patient care associate|intake specialist|positive support specialist|independent living specialist|speech language path)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Clinical/Medical Care role rejected' };
  }

  // (Pharma / Medical Device field roles block removed per user request)

  // Insurance / Financial Representatives (non-tech) / Retail Banking
  if (/\b(branch manager|banking center|teller|insurance agency owner|insurance agent\b|insurance producer|personal financial representative|exclusive life specialist|p&c licensed|financial services representative|financial advisor|financial planner|private wealth|private wealth management|SBA underwriter|underwriting professional|proprietary trader|WM affluent banker|claims adjuster|claims adjustor|claims examiner|claims specialist|claims supervisor|claims representative|workers.compensation claims|liability claims|captive consultant|insurance placement|enrollment processor)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Insurance/Financial Rep/Branch Mgr role rejected' };
  }

  // Public relations account titles can resemble commercial sales roles.
  if (/\b(public relations|media relations|medical communications)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Public/Media Relations role rejected' };
  }

  // Legal / Law Firm roles (NOT Legal Operations)
  if (/\b(attorney|paralegal|bankruptcy|legal counsel|general counsel|corporate counsel|commercial counsel|supervising attorney|staff attorney|housing attorney|conflicts counsel|legal affairs)\b/i.test(titleLower) && !/\b(operations|product|privacy)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Legal role rejected' };
  }

  // Civil / Structural / Environmental / Physical Engineering (non-software)
  if (/\b(civil engineer|structural engineer|geotechnical|geoscientist|project geologist|industrial hygienist|water resources engineer|water treatment engineer|traffic engineer|environmental scientist|environmental compliance|power systems engineer|transmission planning engineer|nuclear engineering|capital projects engineer|land development|public works|GNC engineer|carrier aircraft|hardware verification engineer|avionics|CFD engineer|flight sciences engineer|modeling.*simulation.*fea)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Physical Engineering (non-software) role rejected' };
  }

  // Electrical / Mechanical Engineering (non-software)
  if (/\b(electrical engineer|mechanical engineer|electrical assessor|mechanical assessor|electrical estimator|SCADA engineer|commissioning engineer|commissioning lead|MEP estimator|MEP superintendent|fire protection engineer|fire sprinkler|BIM specialist|BIM coordinator|BIM manager|I&C superintendent|coatings chemist|RF antenna|RF hardware|microarchitect|RTL design|EMS power|stator winder|rotor winder|weld engineer|weld lead|pipefitter|process development engineer|manufacturing engineer|supplier quality engineer|continuous improvement quality engineer|quality control inspector|quality inspector|materials engineer|packaging engineer)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Electrical/Mechanical Engineering role rejected' };
  }

  // Construction / Trades / Physical Labor
  if (/\b(construction superintendent|residential construction|construction foreman|commissioning field engineer|fire sprinkler|roofing|preconstruction|estimating administrator|project controls engineer|general labor|machinist|mold maker|winder hookup|robotic painter|material handler|cabinet finisher|manufacturing team lead|lamination stacker|stator winder|pipefitter|fuser|hydrodemolition|drafter|crop applicator|custodian|deduction resolution specialist|distribution manager|driller|drilling crew|survey crew|shipping associate|shipping administrator)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Construction/Trades role rejected' };
  }

  // Retail / Hourly Physical Ops (brands, malls, DashMart, etc.)
  if (/\b(floor leader|manager in training|seasonal ambassador|visual lead|visual manager|dashmart team member|dashmart kitchens|gun vault specialist|linen porter|restroom attendant|machine operator|lead line cook|kitchen manager|food runner|packaging operator|lift truck operator|order selector|stock associate|storage associate|shift lead|team member)\b/i.test(titleLower) && !/\b(software|tech|product|engineering|data|platform|ai|saas)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Retail/Hourly physical ops role rejected' };
  }

  // Real Estate / Leasing / Property Management
  if (/\b(leasing manager|leasing specialist|portfolio leasing|real estate agent|home inspector|home buying specialist|real estate acquisition|assistant community manager|community manager|resident services manager|seasonal property)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Real Estate/Leasing role rejected' };
  }

  // Media / Broadcast (non-tech)
  if (/\b(radio host|radio content leader|brand influencer|photojournalist|broadcast ingest|broadcast hub operator|master control|story desk editor|sports streaming producer|art director|integrated producer|post.producer|video editor|regional editor|videographer|motion designer)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Media/Broadcast role rejected' };
  }

  // Fitness / Recreation
  if (/\b(personal trainer|lifeguard|swim instructor|group exercise instructor|fitness instructor|head lifeguard|kid care associate)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Fitness/Recreation role rejected' };
  }

  // Agriculture / Agronomy
  if (/\b(agronomist|agronomy|crop applicator|aseptic packaging|post harvest supervisor)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Agriculture role rejected' };
  }

  // Military / Defense Contractor (non-PM)
  if (/\b(SOF intelligence|JTAC instructor|AFSOC|SOUTHCOM|military operations analyst|journeyman intelligence|information assurance specialist|cyber range architect|cyber training specialist|SETA\b|TS\/SCI|FPV pilot|naval operations|UAS pilot|lead doctor)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Military/Defense non-PM role rejected' };
  }

  // University Adjunct / Teaching / Non-tech Education
  if (/\b(adjunct|state univ adjunct|lead teacher|special education teacher|college admissions counselor|college readiness advisor|CLASS observation specialist|technical college faculty)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Academic/Teaching role rejected' };
  }

  // Freelance AI Trainer gig jobs (from "agency" company)
  if (/\bfreelance ai trainer project\b/i.test(titleLower) || /\bdialect specialist\b/i.test(titleLower) || /\blanguage alignment.*resource partner\b/i.test(titleLower)) {
    return { passes: false, reason: 'Freelance AI Trainer gig rejected' };
  }

  // SetSales spam
  if (/\bat setsales\b/i.test(titleLower) || /setsales$/i.test(titleLower)) {
    return { passes: false, reason: 'SetSales spam rejected' };
  }

  // Foreign-language postings
  if (/\(m\/w\/d\)/i.test(job.title) || /\(m\/f\/d\)/i.test(job.title) || /\b(Werkstudent|Berater:in|Initiativbewerbung|Verfahrensmechaniker|Technieker|Psycholoog|Buitendienst|Chargée de Comptes)\b/i.test(job.title)) {
    return { passes: false, reason: 'Foreign-language posting rejected' };
  }

  // Placeholder / junk titles
  if (/^unknown title$/i.test(job.title.trim())) {
    return { passes: false, reason: 'Unknown/placeholder title rejected' };
  }
  if (/\b(join our talent community|join the talent community|general interest submission|future .* opportunit|head of fish|send us your resume|substitutes? needed)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Placeholder/junk title rejected' };
  }

  // Turnaround / Restructuring / Bankruptcy consulting (AlixPartners-style)
  if (/\b(turnaround.*restructuring|creditor advisory|ediscovery.*forensics|restructuring summer analyst|restructuring vice president|restructuring director)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Restructuring/Bankruptcy consulting role rejected' };
  }

  return { passes: true, reason: 'Passed regex pre-filter' };
}

export function passesMetadataPrefilter(job: { title?: string, company?: string, location?: string }): { passes: boolean, reason: string } {
  if (!job.title) return { passes: false, reason: 'No title' };
  return { passes: true, reason: 'Passed metadata prefilter' };
}
