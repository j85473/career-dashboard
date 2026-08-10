export const NATIVE_SCORING_PACKET_MAX_CHARACTERS = 12_000;

export const NATIVE_SCORING_PACKET_HEADINGS = [
  'ROLE',
  'WORK LOCATION AND TRAVEL',
  'CORE RESPONSIBILITIES',
  'REQUIRED EXPERIENCE',
  'PREFERRED EXPERIENCE',
  'ROLE-DEFINING QUALIFICATIONS',
  'COMPENSATION',
] as const;

type PacketSection = typeof NATIVE_SCORING_PACKET_HEADINGS[number];

export type NativeScoringPacketInput = {
  title: string;
  company: string;
  location: string;
  description: string;
};

const ADMINISTRATIVE_FACT = /\b(?:valid\s+(?:[a-z]\s+)?driver(?:'|’)?s?\s+licen[cs]e|driver(?:'|’)?s?\s+licen[cs]e|driving\s+record|motor\s+vehicle\s+(?:record|check)|mvr|reliable\s+(?:transportation|vehicle|car|automobile)|(?:personal|own)\s+(?:vehicle|car|automobile|transportation)|(?:auto|automobile|vehicle)\s+insurance|work\s+authori[sz]ation|authori[sz]ation\s+to\s+work|authori[sz]ed\s+to\s+work|eligible\s+to\s+work|right\s+to\s+work|visa\s+sponsorship|immigration\s+sponsorship|sponsor(?:ship)?\s+(?:for\s+)?(?:an?\s+)?(?:employment\s+)?visa|background\s+(?:check|screen|screening|investigation)|criminal\s+history\s+(?:check|screen|screening)|drug\s+(?:test|testing|screen|screening)|security\s+clearance|minimum\s+age|(?:18|21)\s+years?\s+(?:old|of\s+age)|immunization|vaccination|health\s+screen(?:ing)?|ability\s+to\s+meet.{0,40}credentialing|ability\s+to\s+work\s+(?:full-time|part-time)|availability\s+to\s+work.{0,50}(?:weekends?|holidays?|shifts?)|schedule\s+shifts?\s+required|ability\s+to\s+(?:utilize|acquire).{0,40}(?:cellular|mobile)\s+device)\b/i;
const PHYSICAL_BOILERPLATE = /\b(?:lift(?:ing)?\s+(?:(?:up\s+to|at\s+least)\s+)?\d+\s*(?:lbs?|pounds?)|stand(?:ing)?\s+for\s+extended\s+periods?|physical(?:ly)?\s+(?:ability|capable)|with or without reasonable accommodation)\b/i;
const PROFESSIONAL_CREDENTIAL = /\b(?:registered\s+nurse|rn\s+(?:licen[cs]e|licensure)|active\s+rn|certified\s+public\s+accountant|cpa\s+(?:licen[cs]e|certification)?|(?:property\s*(?:&|and)\s*casualty|p\s*&\s*c)\s+(?:licen[cs]e|licensure)|(?:clinical|insurance|nursing|medical|legal|engineering)\s+(?:licen[cs]e|licensure|certification|credential)|licen[cs]ed\s+(?:nurse|clinician|therapist|pharmacist|attorney|engineer|insurance\s+(?:agent|producer)))\b/i;

const EXCLUDED_HEADING = /^(?:about(?:\s+us|\s+the\s+company)?|our\s+(?:mission|company|culture|values|story)|culture(?:\s*&\s*values)?|why\s+(?:join|work\s+with)\s+us|benefits?(?:\s*&\s*perks|\s+and\s+perks)?|perks|equal\s+(?:employment\s+)?opportunity|affirmative\s+action|diversity(?:\s*&\s*inclusion)?|accommodations?|applicant\s+rights|privacy(?:\s+notice|\s+policy)?|cookie(?:\s+preferences|\s+notice)?|application\s+instructions?|agency\s*&\s*candidate\s+safety\s+notice|ai\s*&\s*hiring\s+integrity|legal(?:\s+notice)?|related\s+jobs?|your\s+application|stats\s+for\s+this\s+job|salary\s+comparison|similar\s+jobs?|popular\s+(?:searches|jobs)|jobseekers|recruiters|country\s+selection)\s*:?$/i;
const EXCLUDED_CONTENT = /\b(?:equal\s+opportunity|affirmative\s+action|protected\s+veteran|race,?\s+religion|sexual\s+orientation|gender\s+identity|reasonable\s+accommodation|disability\s+accommodation|applicant\s+rights|cookie\s+(?:preferences|settings|notice)|privacy\s+(?:notice|policy)|personal\s+data|apply\s+(?:now|online)|application\s+process|sign\s+in|log\s+in|candidate\s+portal|enable\s+javascript|browser\s+warning|related\s+jobs?|search\s+jobs|job\s+alerts?|create\s+alert|seo|401\s*\(k\)|health\s+insurance|medical,?\s+dental|dental\s+and\s+vision|paid\s+time\s+off|pto|parental\s+leave|wellness|tuition\s+reimbursement|employee\s+assistance\s+program|comprehensive\s+benefits?\s+program|e-?verify|background\s+(?:check|screen)|drug\s+(?:screen|test)|work\s+authori[sz]ation|authori[sz]ed\s+to\s+work|visa\s+sponsorship|best\s+place\s+to\s+work|excellent\s+opportunities\s+available\s+to\s+individuals|our\s+mission|mission-driven|our\s+culture|core\s+values|make\s+a\s+difference|build\s+your\s+future|internal\s+equity|hiring\s+at\s+or\s+near\s+the\s+maximum|final\s+base\s+(?:salary|hourly\s+rate).{0,80}factors|salary\s+range\s+is\s+merely\s+an\s+estimate|salary\s+offered\s+depends|range\s+listed\s+is\s+just\s+one\s+component|ai\s+tools?.{0,80}(?:interview|hiring|recruit)|audio-record\s+and\s+transcribe\s+interviews|technology-enabled\s+tools?.{0,80}recruitment|let\s+us\s+know\s+if\s+you\s+(?:require|need).{0,40}support)\b/i;

const RESPONSIBILITY_SIGNAL = /\b(?:own|manage|lead|develop|build|drive|execute|grow|partner|coordinate|deliver|oversee|maintain|support|enable|negotiate|recruit|onboard|forecast|analy[sz]e|represent|collaborate|create|identify|source|qualify|sell|retain|renew)\b/i;
const SOURCE_BOILERPLATE_HEADING = /^(?:who\s+are\s+we\??|culture(?:\s*&\s*total\s+rewards|\s+and\s+total\s+rewards)?|cool\s+things\s+to\s+know|the\s+important\s+stuff|what\s+success\s+looks\s+like|pay\s+transparency)\s*:?$/i;
const SOURCE_BOILERPLATE_CONTENT = /\b(?:pay\s+transparency|pay\s+equity\s+laws?|top\s+workplace|outside\s+recruiting\s+firms?|non-company\s+email\s+addresses?|recruit(?:ment|ing)\s+(?:fraud|scam)|salary\s+may\s+vary\s+based\s+on)\b/i;
const COMPENSATION_DISCLAIMER = /\b(?:compensation\s+(?:at\s+.{1,80}\s+)?varies\s+depending\s+on|compensation\s+(?:offer|offered|for\s+this\s+role).{0,100}(?:based\s+on|may\s+vary|determined\s+by)|compensation\s+will\s+be\s+determined\s+commensurate\s+with|compensation,?\s+.{1,80}\s+takes\s+into\s+consideration\s+factors|(?:specific\s+office\s+)?location,?\s+role,?\s+skill\s+set,?\s+and\s+level\s+of\s+experience|experience,?\s+skills,?\s+job\s+duties,?\s+and\s+business\s+need)\b/i;
const HIRING_AND_CAREER_BOILERPLATE = /\b(?:accessible\s+and\s+inclusive\s+hiring\s+experience|fully\s+demonstrate\s+their\s+skills|opportunities\s+to\s+keep\s+skills\s+relevant\s+through\s+certifications|deepen\s+connections,?\s+maintain\s+a\s+strong\s+community,?\s+and\s+do\s+their\s+best\s+work|equivalent\s+amounts\s+of\s+relevant\s+experience\s+may\s+be\s+considered\s+in\s+lieu)\b/i;
const EXPERIENCE_SIGNAL = /\b(?:\d+(?:\.\d+)?\+?\s*years?|experience|track\s+record|background\s+in|knowledge\s+of|proficien(?:cy|t)|fluency|degree|bachelor|master|skills?|ability\s+to|comfort\s+with|familiarity)\b/i;
const EXPERIENCE_BEARING_SIGNAL = /\b(?:\d+(?:\.\d+)?\+?\s*years?|(?:sales|management|leadership|customer|account|technical|clinical|business)\s+experience|experience\s+(?:in|with|managing|selling|leading|supporting)|degree|education|knowledge\s+of|proficien(?:cy|t)|fluency|track\s+record)\b/i;
const QUALIFICATION_SIGNAL = /\b(?:\d+(?:\.\d+)?\+?\s*years?|experience|track\s+record|background\s+in|knowledge\s+of|understanding\s+of|proficien(?:cy|t)|fluency|degree|diploma|education|bachelor|master|certifications?|skills?|tech\s+savvy|ability\s+to|comfort(?:able)?(?:\s+with|\s+engaging)?|familiarity|communicat(?:e|ion)|relationships?|consultative|crm\s+discipline|commercial\s+vertical\s+exposure|prior\s+employment|fit\s+the\s+profile|strong|excellent|successful|superior|demonstrated|proven|effective|exceptional|outstanding|independent|self-motivated|past\s+success|engaging\s+in)\b/i;
const REQUIRED_SIGNAL = /\b(?:required|must|minimum|at\s+least|need(?:ed)?|requires?)\b/i;
const PREFERRED_SIGNAL = /\b(?:preferred|desirable|ideally|nice\s+to\s+have|bonus|a\s+plus|accelerator|fit\s+the\s+profile)\b/i;
const TRAVEL_SIGNAL = /\b(?:travel|overnight)\b/i;
const EXPLICIT_WORK_LOCATION_SIGNAL = /\b(?:position|role|candidate|employee|applicant)s?\b.{0,55}\b(?:located|based|resid(?:e|ency)|domicil(?:e|ed)|relocat(?:e|ion)|commut(?:e|ing)|remote|hybrid|on-?site)\b|\b(?:must|should|required\s+to)\s+(?:be\s+)?(?:located|based|resid(?:e|ency)|domicil(?:e|ed)|relocat(?:e|ion)|commut(?:e|ing))\b|^location\s*:/i;
const COMPENSATION_SIGNAL = /(?:[$€£]\s*\d|\b(?:base\s+salary|salary\s+range|compensation\s+range|on-target\s+earnings|ote|per\s+hour|hourly)\b|\d[\d,.]*\s*(?:[-–—]|to)\s*\d[\d,.]*\s+USD\s+Annual)/i;
const WORK_ARRANGEMENT_ONLY_SIGNAL = /^(?:ability|willingness)\s+to\s+work\b.{0,80}\b(?:on-?site|in\s+an?\s+office|office\s+setting|hybrid|remotely?|work\s+from\s+home)\b/i;

function compact(value: string | null | undefined): string {
  return (value || '').normalize('NFKC').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/^[\s+\-–—*•‣▪◦]+/, '').replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim();
}

function normalizedLines(description: string): string[] {
  const withoutExecutableMarkup = description.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<(?:br|\/p|\/li|\/div|\/h[1-6]|\/section)\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<[^>]+>/g, ' ').replace(/\*\*([^*\n]{2,100})\*\*/g, '\n$1\n').replace(/\s+\+\s+(?=[A-Z0-9])/g, '\n+ ').replace(/\s*•\s*/g, '\n• ').replace(/\r\n?/g, '\n').replace(/\u0000/g, ' ');
  const withKnownBoundaries = withoutExecutableMarkup
    .replace(/(?<=[a-z)])\.(?=[A-Z])/g, '.\n')
    .replace(/(?=(?:Select US Metros and States|Other US Locations)\s*:)/g, '\n')
    .replace(/\s+(?=(?:ROLE OVERVIEW|THE ROLE|YOUR OPPORTUNITY|RESPONSIBILITIES(?: INCLUDE)?|YOUR RESPONSIBILITIES|WHAT YOU(?:'|’)LL DO|WHAT YOU WILL DO|REQUIRED EXPERIENCE|REQUIRED QUALIFICATIONS?|MINIMUM QUALIFICATIONS?|YOU MUST HAVE|WHAT YOU(?:'|’)LL NEED|WHAT YOU WILL NEED|PREFERRED EXPERIENCE|PREFERRED QUALIFICATIONS?|COMPENSATION|EQUAL OPPORTUNITY|AI & HIRING INTEGRITY|AGENCY & CANDIDATE SAFETY NOTICE|BENEFITS\s*[–—-])\b)/gi, '\n')
    .replace(/\s+(?=(?:Minimum two to five \(2-5\) years|Previous sales experience and knowledge|Ability to pass a driving record background check|Keep in mind, equivalent amounts|Visa sponsorship and International Relocation)\b)/gi, '\n');
  return withKnownBoundaries.split('\n').flatMap((raw) => {
    const line = compact(raw);
    if (!line) return [];
    if (/^(?:required|preferred) experience\s+(?![:—-])\S/i.test(line)) return [line];
    const leadingHeading = /^((?:why this role matters|key responsibilities|responsibilities include|required experience|required qualifications?|minimum qualifications?|what you(?:'|’)ll need|what you will need|preferred experience|preferred qualifications?|ai\s*&\s*hiring integrity|benefits?\s*&\s*perks|our commitment to diversity|agency\s*&\s*candidate safety notice))\b\s*[:—-]?\s*(.+)$/i.exec(line);
    if (leadingHeading) return [compact(leadingHeading[1]), compact(leadingHeading[2])].filter(Boolean);
    return line.split(/(?<=[.!?])\s+(?=[A-Z0-9#])/).map(compact).filter(Boolean);
  });
}

function headingSection(line: string): PacketSection | 'excluded' | null {
  const normalized = line.replace(/[:\s]+$/g, '').trim();
  if (/^benefits?(?:\s*&\s*perks|\s+and\s+perks)?\b/i.test(normalized)) return 'COMPENSATION';
  if (/^(?:about\b|why\s+join\b|our\s+commitment\s+to\s+diversity\b|along\s+with\s+competitive\s+pay\b)/i.test(normalized)) return 'excluded';
  if (EXCLUDED_HEADING.test(normalized) || SOURCE_BOILERPLATE_HEADING.test(normalized)) return 'excluded';
  if (/^(?:role|role overview|position overview|the role|why this role matters|your opportunity|job description|description)$/i.test(normalized)) return 'ROLE';
  if (/^(?:work location(?: and travel)?|location|work arrangement|travel|travel requirements?|territory)$/i.test(normalized)) return 'WORK LOCATION AND TRAVEL';
  if (/^(?:responsibilities(?: include)?(?:\s*\([^)]*\))?|responsibilities and opportunities of this role\??|key responsibilities|core responsibilities|essential duties\s*&\s*responsibilities|your responsibilities|you will|what you(?:'|’)ll do|what you will do|what you(?:'|’)ll own|what you will own|what you will do at .+|what are the responsibilities and opportunities of this role\??|essential functions|key duties|duties|your impact)$/i.test(normalized) || /^as an? .{1,120}, you will$/i.test(normalized)) return 'CORE RESPONSIBILITIES';
  if (/^(?:required|required experience|required qualifications?|minimum qualifications?|basic qualifications?|minimum requirements?|requirements?|role requirements?|must-have qualifications?|qualifications?|other qualifications?|key qualifications|key competencies\s*&\s*skills|you must have|who are we looking for\??|what you(?:'|’)ll need|what you will need|what you(?:'|’)ll bring|what you will bring|what you will bring to .+|what we(?:'|’)re looking for|what we are looking for|your qualifications?|education and experience|required skills?|knowledge,? skill and ability requirements?|knowledge,? skills,? and abilities|abilities|skills and experience)$/i.test(normalized)) return 'REQUIRED EXPERIENCE';
  if (/^(?:preferred|preferred experience|preferred qualifications?|desired qualifications?|nice to have|bonus points?|accelerators?|ideal candidate|what will our ideal candidate have\??)$/i.test(normalized)) return 'PREFERRED EXPERIENCE';
  if (/^(?:role-defining qualifications?|professional qualifications?|licenses? and certifications?|licensure(?:\s*\/\s*certifications?(?:\s*\/\s*registrations?(?:\s*\/\s*permits?)?)?)?|credentials?)$/i.test(normalized)) return 'ROLE-DEFINING QUALIFICATIONS';
  if (/^(?:compensation(?:\s+overview)?|salary|pay range|compensation range)$/i.test(normalized)) return 'COMPENSATION';
  return null;
}

export function containsProfessionalCredential(value: string): boolean {
  return PROFESSIONAL_CREDENTIAL.test(value) && !/\b(?:software|product|platform|partner|program)\s+(?:licen[cs]e|licensing|certification|credential)/i.test(value);
}

export function containsAdministrativeEligibility(value: string): boolean {
  return ADMINISTRATIVE_FACT.test(value) || PHYSICAL_BOILERPLATE.test(value);
}

export function containsExcludedScoringBoilerplate(value: string): boolean {
  return EXCLUDED_CONTENT.test(value)
    || SOURCE_BOILERPLATE_CONTENT.test(value)
    || COMPENSATION_DISCLAIMER.test(value)
    || HIRING_AND_CAREER_BOILERPLATE.test(value);
}

function splitClauses(value: string): string[] {
  if (!containsAdministrativeEligibility(value) && !containsProfessionalCredential(value) && !PREFERRED_SIGNAL.test(value)) return [value];
  return value.split(/\s*;\s*/).flatMap((part) => {
    if (containsProfessionalCredential(part) && !containsAdministrativeEligibility(part) && !EXPERIENCE_BEARING_SIGNAL.test(part)) return [part];
    if (!containsAdministrativeEligibility(part) && !containsProfessionalCredential(part)) return [part];
    return part.split(/\s*,\s*(?:and\s+)?|\s+and\s+(?=(?:a|an|the|\d|valid|active|current|experience|ability|willingness|background|work|legally|reliable|possession)\b)/i);
  }).map(compact).filter(Boolean);
}

function compensationFacts(value: string): string[] {
  const nonNumeric = value.match(/\b(?:bonus|commission|equity)\s+eligible\b/gi)?.map(compact) || [];
  if (!COMPENSATION_SIGNAL.test(value)) return nonNumeric;
  return [compact(value)];
}

function addUnique(sections: Record<PacketSection, string[]>, section: PacketSection, value: string): void {
  const cleaned = compact(value);
  if (!cleaned) return;
  const normalized = cleaned.toLocaleLowerCase('en-US');
  if (sections[section].some((existing) => existing.toLocaleLowerCase('en-US') === normalized)) return;
  sections[section].push(cleaned);
}

export function buildNativeScoringEvaluationPacket(input: NativeScoringPacketInput): string {
  const sections = Object.fromEntries(NATIVE_SCORING_PACKET_HEADINGS.map((heading) => [heading, [] as string[]])) as Record<PacketSection, string[]>;
  addUnique(sections, 'ROLE', `Title: ${compact(input.title) || '(Untitled role)'}`);
  addUnique(sections, 'ROLE', `Company: ${compact(input.company) || '(Unknown company)'}`);
  addUnique(sections, 'WORK LOCATION AND TRAVEL', `Posted location: ${compact(input.location) || 'Not stated'}`);

  let activeSection: PacketSection | 'excluded' | null = null;
  let priorLineWasTravel = false;
  let pendingCompensationLabel: string | null = null;
  for (const line of normalizedLines(input.description)) {
    if (/^#|^\([^)]*(?:outcomes?|tasks?|impact)[^)]*\)\s*:?$/i.test(line)) continue;
    if (/\bnot required\b/i.test(line)) continue;
    if (/^(?:education\s*&\s*experience|technical skills|professional skills|sales management and strategic planning|relationship management and key account development|sales monitoring and reporting|team leadership and financial management|account management\s*&\s*business development|technical solution design\s*&\s*delivery|client engagement\s*&\s*representation|collaboration\s*&\s*continuous improvement)\s*:?$/i.test(line)) continue;
    const compensationLabel = /^(San Francisco Bay Area|Select US Metros and States|Other US Locations)\s*:?$/i.exec(line);
    if (compensationLabel) {
      pendingCompensationLabel = compensationLabel[1];
      activeSection = 'COMPENSATION';
      continue;
    }
    const heading = headingSection(line);
    if (heading) {
      activeSection = heading;
      continue;
    }
    if (/\b(?:as many of the following as possible|candidates? strong on \w+ of (?:the )?\w+ are competitive)\b/i.test(line)) {
      activeSection = 'PREFERRED EXPERIENCE';
      continue;
    }
    if (/\bon-target earnings\b.{0,100}\bgeographic location\b/i.test(line)) {
      activeSection = 'COMPENSATION';
      continue;
    }
    const contentLine = compact(line.replace(/^Pay Transparency Statement\s*:\s*/i, ''));
    if (containsExcludedScoringBoilerplate(contentLine)) continue;
    const lineCompensationFacts = activeSection !== null && activeSection !== 'excluded'
      ? compensationFacts(contentLine)
      : [];
    for (const fact of lineCompensationFacts) {
      addUnique(sections, 'COMPENSATION', pendingCompensationLabel ? `${pendingCompensationLabel}: ${fact}` : fact);
      pendingCompensationLabel = null;
    }
    if (lineCompensationFacts.length > 0) continue;
    if (activeSection === 'COMPENSATION') continue;
    if (containsAdministrativeEligibility(contentLine) && !EXPERIENCE_BEARING_SIGNAL.test(contentLine) && !TRAVEL_SIGNAL.test(contentLine)) continue;
    const lineIsTravel = TRAVEL_SIGNAL.test(contentLine);
    if (/^(?:roughly|approximately|up to)?\s*\d+\s*%\.?$/i.test(contentLine) && priorLineWasTravel) {
      addUnique(sections, 'WORK LOCATION AND TRAVEL', `Travel: ${contentLine}`);
      priorLineWasTravel = true;
      continue;
    }
    priorLineWasTravel = lineIsTravel;
    for (const clause of splitClauses(contentLine)) {
      if (containsAdministrativeEligibility(clause) || containsExcludedScoringBoilerplate(clause)) continue;
      if (containsProfessionalCredential(clause)) {
        const prefix = activeSection === 'PREFERRED EXPERIENCE' || PREFERRED_SIGNAL.test(clause) ? 'Preferred verification item:' : 'Required verification item:';
        addUnique(sections, 'ROLE-DEFINING QUALIFICATIONS', `${prefix} ${clause}`);
        continue;
      }
      const cleaned = compact(clause).replace(/[;,.\s]+$/g, '').trim();
      if (!cleaned || compensationFacts(cleaned).length > 0) continue;
      if (activeSection === 'excluded') continue;
      if (lineIsTravel || EXPLICIT_WORK_LOCATION_SIGNAL.test(cleaned) || WORK_ARRANGEMENT_ONLY_SIGNAL.test(cleaned)) {
        addUnique(sections, 'WORK LOCATION AND TRAVEL', cleaned);
        if (WORK_ARRANGEMENT_ONLY_SIGNAL.test(cleaned)) continue;
        if (/\b(?:ability|willingness|willing)\s+to\s+travel\b/i.test(cleaned)) continue;
        if (!RESPONSIBILITY_SIGNAL.test(cleaned) && !EXPERIENCE_SIGNAL.test(cleaned)) continue;
      }
      if (activeSection === 'CORE RESPONSIBILITIES') addUnique(sections, 'CORE RESPONSIBILITIES', cleaned);
      else if (PREFERRED_SIGNAL.test(clause) && QUALIFICATION_SIGNAL.test(cleaned)) addUnique(sections, 'PREFERRED EXPERIENCE', cleaned);
      else if (activeSection === 'REQUIRED EXPERIENCE' && QUALIFICATION_SIGNAL.test(cleaned)) addUnique(sections, 'REQUIRED EXPERIENCE', cleaned);
      else if (activeSection === 'PREFERRED EXPERIENCE' && QUALIFICATION_SIGNAL.test(cleaned)) addUnique(sections, 'PREFERRED EXPERIENCE', cleaned);
      else if (activeSection === 'ROLE') {
        if ((/\b(?:responsible for|you will|this role|the role|the position)\b/i.test(cleaned) || /^(?:own|manage|lead|develop|build|drive|execute|grow|partner|coordinate|deliver|oversee|maintain|support|enable|negotiate|recruit|onboard|forecast|analy[sz]e|represent|collaborate|create|identify|source|qualify|sell|retain|renew)\b/i.test(cleaned)) && RESPONSIBILITY_SIGNAL.test(cleaned)) addUnique(sections, 'CORE RESPONSIBILITIES', cleaned);
      } else if (PREFERRED_SIGNAL.test(cleaned) && EXPERIENCE_SIGNAL.test(cleaned)) addUnique(sections, 'PREFERRED EXPERIENCE', cleaned);
      else if (REQUIRED_SIGNAL.test(cleaned) && EXPERIENCE_SIGNAL.test(cleaned)) addUnique(sections, 'REQUIRED EXPERIENCE', cleaned);
      else if ((/\b(?:responsible for|you will|this role|the role|the position)\b/i.test(cleaned) || /^(?:own|manage|lead|develop|build|drive|execute|grow|partner|coordinate|deliver|oversee|maintain|support|enable|negotiate|recruit|onboard|forecast|analy[sz]e|represent|collaborate|create|identify|source|qualify|sell|retain|renew)\b/i.test(cleaned)) && RESPONSIBILITY_SIGNAL.test(cleaned)) addUnique(sections, 'CORE RESPONSIBILITIES', cleaned);
    }
  }

  if (sections['CORE RESPONSIBILITIES'].length === 0) throw new Error('evaluation packet has no reliably identified core responsibilities');
  if (sections['REQUIRED EXPERIENCE'].length === 0 && sections['PREFERRED EXPERIENCE'].length === 0 && sections['ROLE-DEFINING QUALIFICATIONS'].length === 0) throw new Error('evaluation packet has no reliably identified experience or qualifications');

  const packet = NATIVE_SCORING_PACKET_HEADINGS.map((heading) => `${heading}\n${sections[heading].length > 0 ? sections[heading].map((value) => `- ${value}`).join('\n') : '- Not stated'}`).join('\n\n');
  if (packet.length > NATIVE_SCORING_PACKET_MAX_CHARACTERS) throw new Error(`evaluation packet exceeds ${NATIVE_SCORING_PACKET_MAX_CHARACTERS} characters`);
  return packet;
}

export function buildNativeContextFeedbackPacket(input: Omit<NativeScoringPacketInput, 'description'>): string {
  return ['ROLE', `- Title: ${compact(input.title) || '(Untitled role)'}`, `- Company: ${compact(input.company) || '(Unknown company)'}`, '', 'WORK LOCATION AND TRAVEL', `- Posted location: ${compact(input.location) || 'Not stated'}`].join('\n');
}

export function assertNativeScoringEvaluationPacket(value: string): void {
  if (!value || value.length > NATIVE_SCORING_PACKET_MAX_CHARACTERS) {
    throw new Error('evaluation packet is empty or oversized');
  }
  let priorIndex = -1;
  for (const heading of NATIVE_SCORING_PACKET_HEADINGS) {
    const index = value.indexOf(`${heading}\n`);
    if (index < 0 || index <= priorIndex || value.indexOf(`${heading}\n`, index + heading.length + 1) >= 0) {
      throw new Error('evaluation packet headings must appear exactly once in fixed order');
    }
    priorIndex = index;
  }
  if (containsAdministrativeEligibility(value)) {
    throw new Error('evaluation packet contains administrative eligibility text');
  }
  if (containsExcludedScoringBoilerplate(value) || /\b(?:equal opportunity|affirmative action|cookie preferences|privacy notice|related jobs|401\s*\(k\)|health insurance|paid time off|reasonable accommodation)\b/i.test(value)) {
    throw new Error('evaluation packet contains excluded boilerplate');
  }
}

export type TravelRange = {
  kind: 'none' | 'point' | 'range' | 'maximum' | 'minimum' | 'qualitative';
  minimumPercent: number;
  maximumPercent: number;
  label: string;
  sourceText: string | null;
};

export function travelRangeFromScorePayload(value: unknown): TravelRange | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const range = (value as Record<string, unknown>).travelRange;
  if (typeof range !== 'object' || range === null || Array.isArray(range)) return null;
  const record = range as Record<string, unknown>;
  if (
    !['none', 'point', 'range', 'maximum', 'minimum', 'qualitative'].includes(String(record.kind))
    || typeof record.minimumPercent !== 'number'
    || typeof record.maximumPercent !== 'number'
    || record.minimumPercent < 0
    || record.maximumPercent > 100
    || record.minimumPercent > record.maximumPercent
    || typeof record.label !== 'string'
    || (record.sourceText !== null && typeof record.sourceText !== 'string')
  ) return null;
  return record as TravelRange;
}

function packetSection(packet: string, heading: PacketSection): string[] {
  const start = packet.indexOf(`${heading}\n`);
  if (start < 0) return [];
  const bodyStart = start + heading.length + 1;
  const next = NATIVE_SCORING_PACKET_HEADINGS
    .map((candidate) => packet.indexOf(`\n\n${candidate}\n`, bodyStart))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? packet.length;
  return packet.slice(bodyStart, next).split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
}

/** Extracts only explicit JD travel language. Absence is exactly zero. */
export function extractTravelRange(packet: string): TravelRange {
  assertNativeScoringEvaluationPacket(packet);
  const lines = packetSection(packet, 'WORK LOCATION AND TRAVEL');
  const travelLines = lines.filter((line) => TRAVEL_SIGNAL.test(line) && !/^Not stated$/i.test(line));
  // Prefer an explicit percentage over an earlier generic duty such as
  // "travel in-territory". Use qualitative wording only when no quantitative
  // travel statement appears anywhere in the sanitized section.
  const sourceText = travelLines.find((line) => /\b\d{1,3}\s*%/.test(line)) || travelLines[0] || null;
  if (!sourceText) return { kind: 'none', minimumPercent: 0, maximumPercent: 0, label: '0%', sourceText: null };
  const range = /\b(\d{1,3})\s*%?\s*(?:-|–|—|to)\s*(\d{1,3})\s*%/i.exec(sourceText);
  if (range) {
    const minimumPercent = Number(range[1]);
    const maximumPercent = Number(range[2]);
    if (minimumPercent <= maximumPercent && maximumPercent <= 100) {
      return { kind: 'range', minimumPercent, maximumPercent, label: `${minimumPercent}-${maximumPercent}%`, sourceText };
    }
  }
  const percent = /\b(\d{1,3})\s*%/.exec(sourceText);
  if (percent && Number(percent[1]) <= 100) {
    const value = Number(percent[1]);
    if (/\b(?:up to|maximum|max(?:imum)? of|no more than)\b/i.test(sourceText)) {
      return { kind: 'maximum', minimumPercent: 0, maximumPercent: value, label: `Up to ${value}%`, sourceText };
    }
    if (/\b(?:at least|minimum|min(?:imum)? of|no less than)\b/i.test(sourceText)) {
      return { kind: 'minimum', minimumPercent: value, maximumPercent: 100, label: `At least ${value}%`, sourceText };
    }
    return { kind: 'point', minimumPercent: value, maximumPercent: value, label: `${value}%`, sourceText };
  }
  return { kind: 'qualitative', minimumPercent: 0, maximumPercent: 0, label: sourceText, sourceText };
}

/** Compensation is a deterministic projection of the sanitized compensation section. */
export function extractExplicitCompensation(packet: string): string | null {
  assertNativeScoringEvaluationPacket(packet);
  const lines = packetSection(packet, 'COMPENSATION').filter((line) => !/^Not stated$/i.test(line));
  return lines.length === 0 ? null : lines.join('; ');
}
