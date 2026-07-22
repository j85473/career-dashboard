export function passesPreFilter(job: { title: string, description: string, location: string, url: string, company: string }): { passes: boolean, reason: string } {
  if (!job.title || !job.company) return { passes: false, reason: 'Missing title or company' };

  // Explicit location string rejection (Outstate MN rule)
  // We only reject based on the specific job board's metadata location string,
  // NOT the title or description, to avoid rejecting remote jobs whose territory includes these.
  if (job.location) {
    const exactLocLower = job.location.toLowerCase();
    const outstateMn = /\b(rochester|duluth|st\.?\s*cloud|saint\s*cloud|mankato|moorhead|bemidji|brainerd)\b/;
    if (outstateMn.test(exactLocLower)) {
      return { passes: false, reason: 'Outstate MN location rejected' };
    }
  }
  
  // Explicit international location rejection
  // We want to reject jobs that are explicitly based in international countries,
  // even if they mention "remote" in the description, as they usually don't hire US-based remote workers.
  if (job.location) {
    const exactLocLower = job.location.toLowerCase();
    const international = /\b(uk|united kingdom|london|england|ireland|dublin|india|chennai|bengaluru|bangalore|hyderabad|pune|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|italy|rome|milan|sweden|stockholm|poland|warsaw|australia|sydney|melbourne|singapore|japan|tokyo|china|beijing|shanghai|brazil|sao paulo|mexico|canada|toronto|vancouver|montreal|emea|apac|latam)\b/i;
    // Allow if it explicitly says US/United States alongside it (e.g. "London, UK or Remote US")
    const hasUSFallback = /\b(us|usa|united states|remote us|us remote)\b/i.test(exactLocLower);
    if (international.test(exactLocLower) && !hasUSFallback) {
      return { passes: false, reason: 'International location rejected' };
    }
  }

  const titleLower = job.title.toLowerCase();
  const descLower = job.description ? job.description.toLowerCase() : '';

  // Location feeds are inconsistent: many remote jobs say only "United States"
  // in the location field and put the remote signal in the title/JD. Reject only
  // when we have a clear, non-target location; unknown locations stay eligible.
  const locationLower = job.location ? job.location.toLowerCase() : '';
  const targetLocation = /\b(mn|minnesota|minneapolis|st\.?\s*paul|saint paul|remote|flexible|worldwide|anywhere|nationwide)\b/;
  const locationUnknown = !locationLower || /^(unknown|n\/a|not specified|multiple locations?|united states|us|usa)$/i.test(locationLower.trim());
  
  // Strip common negative remote phrases before testing for remote evidence
  const negativeRemote = /\b(?:not|no|non|cannot\s+be)(?:\s+\w+){0,3}\s+remote\b|remote:\s*no|100%\s+on-?site|\bnon-remote\b/ig;
  const searchableText = `${titleLower} ${descLower}`.replace(negativeRemote, '');
  
  const remoteEvidence = /\b(remote|work from home|work[- ]from[- ]anywhere|distributed team|nationwide)\b/;
  
  if (!locationUnknown && !targetLocation.test(locationLower) && !remoteEvidence.test(searchableText)) {
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
  if (/\b(maintenance|facilities|property management|leasing consultant|mechanic|hvac|electrician|plumber|carpenter|welder|quality assurance technician)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Maintenance/Facilities role rejected' };
  }

  // Reject Accounting/Actuarial/Finance roles
  if (/\b(accounting|accountant|actuarial|tax consultant|auditor|payroll|finance|financial analyst)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Accounting/Finance role rejected' };
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
  if (/\b(software engineer|software enginer|sofware engineer|software developer|fullstack|frontend|backend|full stack|front end|back end|ios developer|android developer|devops|rust|integration engineer|solutions? architect|cloud data engineer|ruby|java developer|python developer)\b/i.test(titleLower) || /\bc\+\+(?!\w)/i.test(titleLower)) {
    return { passes: false, reason: 'Software Engineering role rejected' };
  }


  // Reject Research & Analyst roles
  if (/\b(business analyst|research analyst|researcher|technical writer|director of research|research director|market research|ux research|user research)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Research & Analyst role rejected' };
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
  if (/\b(data engineer|database engineer|database administrator|dba|it support|help desk|network engineer|systems? administrator|sys\s?admin|infrastructure engineer|security engineer|information security|site reliability|sre|cloud engineer|site director|data center)\b/i.test(titleLower)) {
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

  // Insurance / Financial Representatives (non-tech)
  if (/\b(insurance agency owner|insurance agent\b|insurance producer|personal financial representative|exclusive life specialist|p&c licensed|financial services representative|financial advisor|financial planner|private wealth|private wealth management|SBA underwriter|underwriting professional|proprietary trader|WM affluent banker|claims adjuster|claims examiner|claims specialist|claims supervisor|claims representative|workers.compensation claims|liability claims|captive consultant|insurance placement|enrollment processor)\b/i.test(titleLower)) {
    return { passes: false, reason: 'Insurance/Financial Rep role rejected' };
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
