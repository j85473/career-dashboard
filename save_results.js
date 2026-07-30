const fs = require('fs');
const newResults = [
  {
    "id": "efe953f2-035b-481f-b9ee-3c710811f4ef",
    "aimFitScore": 10,
    "aimFitReason": "Requires 1-3 years of experience in client services or consulting and a specific degree. The role leans junior, and candidate's 6+ years of field channel sales is not a direct fit for this specific software implementation role.",
    "experienceFitScore": 10,
    "experienceFitReason": "Candidate's expertise lies in field sales and territory management, not in hands-on real estate software implementation and technical client onboarding.",
    "travelScore": 0,
    "luckyAimFitScore": 10,
    "luckyFitReason": "Routine implementation role lacking the strong autonomy, ambiguity tolerance, or 0-to-1 builder mentality required for a wildcard fit.",
    "luckyFitCategory": "pass"
  },
  {
    "id": "bf4376f1-2693-4e15-9fb9-b3885a49f825",
    "aimFitScore": 30,
    "aimFitReason": "Highly specific domain experience preferred (EPM / FP&A) which the candidate explicitly lacks, lowering the aim fit.",
    "experienceFitScore": 30,
    "experienceFitReason": "Candidate has strong partner enablement experience, but lacks the required SaaS alliance management and financial software domain expertise.",
    "travelScore": 0,
    "luckyAimFitScore": 75,
    "luckyFitReason": "Building a global partner strategy from scratch at an early-stage SaaS startup offers strong autonomy, a 0-to-1 builder mentality, and high ambiguity tolerance.",
    "luckyFitCategory": "wildcard"
  },
  {
    "id": "278bfef6-7983-4a20-ba2c-a95af51db8ba",
    "aimFitScore": 50,
    "aimFitReason": "Role aligns somewhat with candidate's partner enablement background but requires formal B2B SaaS enablement experience that the candidate lacks.",
    "experienceFitScore": 60,
    "experienceFitReason": "Strong overlap with enablement and coaching, but missing formal internal SaaS B2B sales enablement, LMS administration, and methodology rollout experience.",
    "travelScore": 10,
    "luckyAimFitScore": 85,
    "luckyFitReason": "As the first dedicated enablement hire at a fast-growing AI-native startup, this role demands extreme ownership, a 0-to-1 builder mentality, and offers a unique growth trajectory.",
    "luckyFitCategory": "wildcard"
  },
  {
    "id": "50371386-6e0d-4092-81e0-6dd185d92839",
    "aimFitScore": 10,
    "aimFitReason": "Role strongly requires highly specific technical domain experience (SAML, OIDC, SCIM, REST APIs) that the candidate does not possess.",
    "experienceFitScore": 10,
    "experienceFitReason": "Candidate has field sales and territory management experience, lacking the deep technical integration and SaaS architectural troubleshooting required for a Technical Account Manager.",
    "travelScore": 15,
    "luckyAimFitScore": 10,
    "luckyFitReason": "Standard technical account management role lacking the extreme 0-to-1 autonomy and ambiguity of the dreamer archetype.",
    "luckyFitCategory": "pass"
  },
  {
    "id": "d4c5859f-9f81-4ae1-96e6-d152f40c3aff",
    "aimFitScore": 20,
    "aimFitReason": "Requires highly specific experience implementing SaaS GTM tools (Gong, Clari, Highspot) that the candidate does not have.",
    "experienceFitScore": 20,
    "experienceFitReason": "Candidate lacks the progressive formal Revenue Enablement background and enterprise tooling rollout experience required.",
    "travelScore": 10,
    "luckyAimFitScore": 15,
    "luckyFitReason": "Highly structured enterprise transformation role focused on standardizing methodologies rather than ambiguous 0-to-1 building.",
    "luckyFitCategory": "pass"
  }
];

let allResults = [];
if (fs.existsSync('final_evaluations.json')) {
  allResults = JSON.parse(fs.readFileSync('final_evaluations.json', 'utf8'));
}
allResults = allResults.concat(newResults);
fs.writeFileSync('final_evaluations.json', JSON.stringify(allResults, null, 2));
