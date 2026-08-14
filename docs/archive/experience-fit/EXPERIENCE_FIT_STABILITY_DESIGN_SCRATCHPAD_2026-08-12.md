# Experience Fit Stability Design Scratchpad

**Started:** 2026-08-12  
**Status:** Archived and superseded by the two-pass Experience Fit v2 implementation on 2026-08-13  
**Implementation authorization:** None

## Purpose and control boundary

This scratchpad preserves Joe's Experience Fit design direction while the
scoring method is reconsidered. It is deliberately separate from the Aim
scratchpad and the implementation plan.

- Do not implement from this scratchpad.
- Do not edit scoring policy, prompts, schemas, runners, imports, the database,
  the current Core Evidence Inventory, or production from these notes.
- Do not run an Experience scoring batch from these notes.
- Do not commit, push, or deploy from these notes.
- Ultra is concurrently working on Aim. Avoid changing Ultra's active Aim files
  or the shared implementation plan while that work is in progress.
- Confirmed, proposed, unresolved, and rejected ideas must remain visibly
  distinct. A proposal in this file is not an approved implementation decision.

## Confirmed direction from Joe — 2026-08-12

1. Remove the current Experience evidence evaluator as a decision-maker, in the
   same spirit as the Aim redesign.
2. The model must not know or apply the consequences of its answers.
3. Model work should be reduced to simple, bounded questions and source supply.
4. Deterministic code compiles the answers, applies weights, calculates the
   score, and owns every downstream consequence.
5. The current Core Evidence Inventory remains valuable for historical record,
   evidence provenance, and resume building. It should not be weakened or
   replaced merely to make Experience scoring easier.
6. Experience Fit likely needs its own smaller, more general evidence view
   derived from the Core Evidence Inventory.
7. The E-Fit evidence view should reflect general experience and transferable
   capabilities because a JD is itself an incomplete and generalized account of
   a job, not a complete specification of everything a person will do.
8. JD requirements should be preserved in their source order for provenance.
   The first calibration version does not infer importance from position;
   repeated substantive mentions within that specific JD provide the initial
   emphasis signal instead.
9. The current evaluator-assigned `direct` hard gate and preferred-only 80–100
   calculation do not survive this redesign. They are replaced by catalog-scoped
   binary evidence answers, an `80:20` required-to-preferred score, and the
   separately defined explicit-required-item hard-failure rule.
10. `Functional equivalent` is rejected as a model-facing answer category. It
    asks the model to make a broad transferability judgment and recreates the
    evaluator role the redesign is intended to remove.
11. The approved working direction for the evidence-link call is one bounded,
    catalog-scoped question per requirement: does the supplied E-Fit catalog
    explicitly describe experience that answers this requested qualification?
    The first calibration version uses only `yes` or `no`; a `yes` supplies
    record IDs. Exact wording remains provisional until the complete question
    contract is reviewed.
12. The E-Fit Evidence Inventory, or EFEI, should provide a concise
    job-description-language projection of approved candidate evidence organized
    around general, reusable capabilities. It need not reproduce or exhaustively
    condense the complete Core Evidence Inventory. The Core inventory remains the
    detailed factual authority.
13. The requirement-supplier question must distinguish substantive E-Fit
    evidence items, such as `3 years of sales experience`, from administrative
    or eligibility items, such as `valid driver's license`. This classification
    is an either/or decision for each extracted item, not for the whole source
    block, because one block may contain both kinds.
14. Every EFEI record and every model-facing EFEI packet must be de-identified.
    It may refer to the person only as `the candidate` or another neutral term.
    It must never contain `Joe`, `Joseph`, `Joseph Lamb`, first-person wording,
    or gendered pronouns referring to the candidate. Subject-free capability
    language is preferred when it reads naturally.
15. The model-facing EFEI must not group skills by employer, job, or historical
    role. It is one flat consolidated list with one record per normalized skill
    and one reviewed total in months. Job-level associations remain private
    authoring and provenance data only.
16. The EFEI must include ordinary workplace software and tool skills, not only
    distinctive or impressive capabilities. Common requirements such as Word,
    Excel, PowerPoint, Outlook, Salesforce, CRM platforms, and similar tools need
    explicit records when supported so routine JD checkboxes are matchable.
17. Retain the approved three-field model-facing EFEI record. The current
    catalog boundary is sufficient; do not add a model-facing boundary,
    explanation, employer, role, or provenance field merely to qualify tool
    scope.
18. The semantic requirement-supplier receives the complete canonical original
    JD. There is no cleaner, heuristic requirement extractor, summary, or
    qualification-section-only preselection before the model reads it. Stable
    blocks may be used for addressing and exact-quote validation, but together
    they must reproduce the entire JD without substantive omission.
19. Start the evidence linker with binary `yes` or `no` answers only. Do not add
    `unclear` to the first calibration version. The purpose is to observe where
    the simple system's scores land before adding another outcome.
20. The candidate has no professional licenses or certifications. An explicitly
    required role-defining professional license or certification is therefore a
    deterministic hard failure under the broader explicit-required-item rule.
    The model supplies the exact requirement and cue but never sees or applies
    that consequence. Ordinary administrative licenses such as a driver's
    license remain excluded and score-neutral.
21. Prefer job-specific emphasis over a universal position curve. When a
    capability is independently requested or discussed multiple times in the
    complete JD, each validated source occurrence may participate as its own
    scored line item. Repetition therefore increases influence naturally. The
    model does not assign importance; Python counts validated occurrences.
22. Completing the EFEI source policy and remaining inventory additions is
    explicitly deferred. Preserve the pending list and do not let it disappear,
    but do not expand that work in the middle of the scoring-design discussion.
23. Do not create the implementation plan in this thread. This context is the
    design scratchpad only. Once the design notes are sufficiently complete,
    hand the pad to a fresh Sol Ultra chat to build the implementation plan.
    The scratchpad is an approved general framework, not an infallible or closed
    specification. Sol Ultra must audit it thoroughly against the current
    repository, product goal, evidence-safety rules, and internal consistency;
    identify contradictions, missing contracts, unstable assumptions, and
    implementation hazards; and recommend explicit corrections where warranted.
    It must not silently discard Joe's intent, but it also must not treat prior
    conversational approval as proof that every detail is correct.
24. Compound requested items may retain one exact parent excerpt while exposing
    independently testable child facets. A shared duration or cue remains bound
    to each applicable child. Python never adds the months of separate EFEI
    skills together to manufacture satisfaction of a compound tenure minimum.
25. The current LinkedIn-derived catalog, supplemented by the ordinary tools
    Joe directly confirmed, is sufficient for the first calibration. LinkedIn
    produces a useful fit signal with less candidate information than this
    catalog already contains, so do not pursue exhaustive Core-Evidence
    expansion now. Add records later only when observed scoring results expose a
    meaningful missing capability or tool. This is a deliberate first-version
    stopping rule, not a claim that the EFEI is a complete biography.
26. Keep the Dashboard score name `E Fit`. There is no demonstrated reason to
    rename it.
27. Preserve the settled `80:20` required-to-preferred score split. An extracted
    substantive occurrence is in the preferred bucket only when the JD
    explicitly marks it preferred, desired, a bonus, or nice to have; all other
    requested substantive occurrences enter the required bucket for the initial
    version.
28. Any substantive item that the JD explicitly establishes as required,
    mandatory, or a minimum causes a deterministic E Fit hard-failure flag when
    its validated evidence answer is `no` or when a linked record does not meet
    its explicit tenure minimum. This includes required tenure, people-management
    experience, industry experience, degree level, named tools, and professional
    licenses or certifications. Preferred items never cause this hard failure.
    An uncued occurrence may enter the required 80-percent scoring bucket but
    does not hard-fail solely because the JD supplied no explicit required cue.
29. Exact repeated-occurrence validation is delegated to the implementation
    design rather than requiring another policy choice from Joe. Use canonical
    source spans: duplicate or overlapping extraction of the same requested
    facet counts once; separately stated non-overlapping requests count
    separately; and a compound parent is not scored in addition to its scored
    child facets.

## The decision Experience Fit should support

Working definition:

> How much of the experience requested by this JD can be connected to Joe's
> verified general capabilities, using only approved evidence and without
> pretending that a JD or evidence inventory is a complete biography?

This is an evidence-supported match signal. It is not a claim that the employer
will accept or reject Joe, and it is not proof that Joe lacks experience when a
matching record is not found.

## Why Experience cannot copy Aim literally

Aim can ask a fixed bank of questions because Joe's preferences are known in
advance. Experience is different: the questions are created by each JD. One
posting may ask for channel management, another enterprise Customer Success,
and another a specialized credential.

The Experience pipeline therefore needs to discover the JD's questions before
it can ask whether the supplied evidence contains corresponding experience.
That makes two distinct semantic source tasks difficult to avoid:

1. identify what experience or qualifications the JD explicitly requests;
2. identify which supplied E-Fit evidence records, if any, correspond to each
   requested item.

The important correction is that neither task is an overall evaluation. Both
are blind source-selection tasks. The script alone interprets their combined
output.

## Blind model boundary

The model is an answer and text supplier, not an evaluator or scorer.

The model must not receive or be told:

- Joe's preferences or desired outcome;
- whether a requirement is important to a score;
- requirement weights or positional weights;
- what answer is favorable;
- whether an answer will advance, hold, dismiss, rank, or rescore a job;
- score formulas, score thresholds, hard gates, lifecycle states, or database
  behavior;
- batch, import, approval, hash, checkpoint, or application mechanics;
- prior model answers except the exact source material required by the next
  blind question.

The script privately owns:

- stable source-block IDs and exact offsets;
- exact-quote validation;
- requirement IDs and source order;
- duplicate handling;
- required, preferred, and uncued-requirement consequences;
- evidence-link normalization;
- occurrence counting and any later-approved deterministic weights;
- arithmetic, rounding, score bands, and any eventual lifecycle mapping;
- the final exchange artifact, provenance, validation, and hashes.

## Approved working architecture — blind requirement supplier plus blind evidence linker

Joe approved this as the direction to continue developing. It refines his
initial two-call idea without giving either model call evaluator authority.
This approval covers the semantic boundary, not the final prompt wording,
production schemas, validators, calibration-batch selection, numeric dismissal
thresholds, or later Dashboard lifecycle mapping. Binary evidence answers,
canonical occurrence counting, the `80:20` split, and the explicit-required-item
hard-failure rule are confirmed for the first calibration version.

### Deterministic preparation

Python divides the complete canonical original JD into stable, source-ordered
blocks solely for addressing and exact-quote validation. It does not clean,
shorten, paraphrase, summarize, pre-extract, or limit the input to a designated
qualifications section. The complete ordered block set reproduces the entire JD
and is supplied to the semantic requirement worker.

### Semantic call 1 — requirement supplier

The first call receives only the JD blocks and neutral instructions. It does
not receive the resume, Core Evidence Inventory, E-Fit evidence view, weights,
or any candidate identity.

Conceptual request:

```text
Here are source-ordered blocks from a job description.

For every block, identify every item requested of a candidate and copy its exact
words.

For each copied item, choose one label:

- evidence item: experience, education, job knowledge, job skill, named tool or
  technology, or a role-defining professional credential;
- administrative item: an ordinary driver's license, driving record, vehicle,
  work authorization, sponsorship, background or drug screen, travel or
  relocation logistics, generic physical condition, or onboarding condition.

Also copy the words that state whether the item is required, preferred, or not
specified. If a block contains no requested item, answer none. A block may
contain more than one item and may contain both labels.

Do not explain the answers.
```

Candidate item labels:

- `efit_evidence_item`
- `administrative_or_eligibility_item`

Candidate block answer when no item exists:

- `none`

For every extracted item, the model supplies only:

- the block ID;
- one exact source excerpt;
- one of the two item labels;
- the exact cue text, when present.

The model does not create a score, decide whether the qualification is fair or
important, infer a requirement from an ordinary duty, or determine whether Joe
meets it.

The item-level either/or is necessary. For example:

```text
Requires 3 years of sales experience and a valid driver's license.
```

must produce two exact items:

- `3 years of sales experience` -> `efit_evidence_item`;
- `a valid driver's license` -> `administrative_or_eligibility_item`.

For a compound substantive request, retain the complete exact parent excerpt
and the exact child facets that can be answered independently. For example,
`5 years of SaaS account management and team leadership experience` may expose
`SaaS account management` and `team leadership` as separate child questions,
both bound to the same five-year minimum and source cue. Each child is compared
with a responsive EFEI record's own reviewed duration. Separate catalog months
are never summed to create five years of the compound experience.

The model is not told that one label enters a score and the other does not.
Python privately applies that policy after validating the answer.

Python then:

- requires one answer for every supplied block;
- validates every excerpt as exact source text within that block;
- restores the original global source order;
- de-duplicates overlapping excerpts without changing meaning;
- assigns stable item IDs;
- stores the original cue and block provenance;
- excludes approved administrative or eligibility categories from the E-Fit
  denominator;
- sends only validated E-Fit evidence items to the evidence-link call;
- applies any approved cue classification privately.

This produces complete answer membership at the block level and explicit type
membership for every extracted item. It cannot prove semantic perfection, but
it avoids a free-form extractor silently returning an unverifiable rewritten
list or allowing administrative conditions to enter Experience scoring.

### Semantic call 2 — evidence linker

The second call receives:

- one job's source-ordered requirement list;
- the smaller E-Fit evidence view only;
- neutral matching questions.

It does not receive weights, scores, thresholds, preferred consequences, or
lifecycle rules.

Conceptual request:

```text
Here are requested qualifications from a job description and a catalog of
experience records.

For each requested qualification, answer this question:

Does the supplied catalog explicitly describe experience that answers this
requested qualification?

Answer yes or no. For yes, list the applicable catalog record IDs. For no, list
no record IDs. Do not explain the answers.
```

Candidate answer vocabulary:

- `yes`
- `no`

`No` is strictly scoped to the supplied catalog. It means only `no matching
record was found in the supplied E-Fit catalog`. It must never be rendered as
`candidate lacks`, `does not meet`, or another biographical claim.

For every `yes`, the model supplies only E-Fit record IDs. Python verifies that
each ID exists in the exact exported E-Fit evidence view. The model does not
grade a match, distinguish direct from transferable experience, choose partial
credit, or explain why the record is good enough. The only bounded semantic
question is whether the catalog record describes experience that answers the
requested qualification.

Some semantic reading is unavoidable: JD wording and evidence wording will not
always be identical. The boundary is that the model may locate a responsive
record, but it may not classify the degree of similarity or decide how much
credit that record deserves.

### Deterministic compilation

After both calls validate, Python joins:

- requirement source order and cue;
- the model's validated `yes` or `no` answer and supplied record IDs;
- private weight configuration;
- any separately approved deterministic exclusions.

Python calculates the score and produces the auditable line items. The model
never sees the compiled result.

## Why the two blind calls should remain separate

The initial two-call structure is not inherently a flaw. It protects against a
more serious bias.

If one call sees both the JD and Joe's evidence while deciding which
requirements exist, it can preferentially notice requirements that the evidence
can satisfy and omit requirements that it cannot. That would make the candidate
evidence influence the supposed reading of the JD.

Separation creates a useful firewall:

- Call 1 can only report what the JD requests.
- Call 2 cannot change or omit that approved requirement membership.
- Python can verify that every requirement receives exactly one catalog-answer
  answer.

The calls may be batched once per job. This design does not require one model
invocation per requirement.

## Candidate architecture B — one combined requirement-and-evidence call

One call receives the complete JD and the E-Fit evidence view, then returns each
requirement and matching evidence records together.

Advantages:

- fewer invocations;
- simpler orchestration;
- less repeated input.

Risks:

- evidence availability can bias requirement extraction;
- omitted requirements cannot be distinguished from unmatched requirements;
- the model performs a larger, more consequential composite task;
- exact membership and repair are harder to isolate.

Current disposition: not recommended unless calibration shows that the separate
blind calls are materially worse or too expensive.

## Candidate architecture C — fixed E-Fit question bank

A fixed bank could ask whether the JD requests each known Joe capability, using
the Aim-style atomic pattern. This would be very stable for common experience
families.

The unresolved problem is denominator coverage: a candidate-specific question
bank cannot safely establish every material JD requirement that falls outside
Joe's known capabilities. A catch-all extraction step would still be needed.

Current disposition: potentially useful as a retrieval aid or calibration
cross-check, but insufficient as the complete Experience design.

## E-Fit-specific evidence view

### Authority relationship

The current Core Evidence Inventory remains the factual authority. The proposed
E-Fit evidence view is a smaller, versioned, candidate-specific projection for
matching generalized JD language.

The E-Fit evidence view must:

- derive every statement from one or more approved Core evidence IDs;
- add no new candidate fact;
- retain scope and ownership boundaries;
- contain no candidate name, first-person language, or gendered candidate
  pronouns;
- use `the candidate` only when a grammatical subject is necessary and prefer
  neutral capability statements such as `6+ years of channel partner management
  experience`;
- fail deterministic EFEI validation when a record contains a candidate name,
  first-person candidate wording, or a gendered pronoun referring to the
  candidate; invalid records may not enter a model-facing packet;
- expose no employer grouping, job grouping, role title, or separate per-role
  contribution in the model-facing catalog;
- contain each normalized skill exactly once with its reviewed consolidated
  associated-experience months;
- be hash-bound to the exact Core Evidence version used to create it;
- be regenerated and re-reviewed when its source evidence changes;
- never become an independent resume or historical authority;
- never be edited by a scoring result or semantic worker.

### Why a separate view is needed

The Core Evidence Inventory is intentionally detailed because it supports
historical truth, precise resume claims, provenance, and claim-level boundaries.
That detail is valuable for resume tailoring but creates poor matching ergonomics
for generalized JD language:

- the same broad capability may appear across many detailed records;
- long anecdotes and metrics can distract from the underlying function;
- duplicate tags and adjacent records increase retrieval noise;
- exact historical context can make transferable experience look narrower than
  the generalized qualification actually is;
- sending the entire inventory consumes context and increases inconsistent
  evidence selection.

### Condensation into job-description language

The EFEI is not a shorter resume and not a list of accomplishments. It is a
compact catalog of the kinds of experience employers commonly request.

The EFEI is also identity-blind. Model-facing records must not contain `Joe`,
`Joseph`, `Joseph Lamb`, `I`, `my`, `he`, `him`, or other identity-bearing
references to the candidate. Use `the candidate` where a subject is required,
but prefer concise subject-free JD language. Employer and product context may be
retained only when it is substantively necessary to describe or bound the
experience; internal Core Evidence IDs preserve the complete provenance.

Core Evidence may record a detailed story, metric, employer, historical scope,
and resume-safe wording. The corresponding EFEI record should state the broader
verified capability in language that can reasonably appear in a JD, while
retaining any boundary needed to prevent an inflated match.

Examples of the intended transformation shape:

| Detailed Core Evidence emphasis | EFEI job-description-language emphasis |
|---|---|
| individual territory metrics and distributor accomplishments | multi-year channel partner and distributor management experience |
| a specific Sara+ rollout and adoption history | platform implementation, user onboarding, adoption, enablement, reporting, and troubleshooting experience |
| individual operating-review and CEO-alignment records | executive stakeholder management, business reviews, corrective-action planning, and cross-functional influence |
| a specific federal healthcare-staffing contract win | B2B business development, commercial negotiation, contract progression, and full-lifecycle account ownership |

These examples describe the condensation method, not final approved EFEI
wording. Every final record must still cite the exact Core Evidence IDs that
support it.

### Proposed simpler construction — LinkedIn job-attached skills

Joe identified a substantially simpler candidate source for the EFEI: copy the
relevant LinkedIn skills attached to each historical job. Those skill names are
already concise, generalized, and close to the language employers use in job
descriptions. During EFEI authoring, Joe and Codex can review each associated
role timeframe once and store the approved duration directly on the skill
record. The production scoring script then reads the reviewed duration; it does
not calculate or estimate tenure.

This may eliminate the need to author prose capability summaries for most EFEI
records. The model-facing EFEI can instead be a compact, identity-blind skill
catalog.

Private authoring-ledger shape:

```json
{
  "skill": "Channel Partner Management",
  "roleContributions": [
    {
      "sourceRole": "private role reference",
      "reviewedDurationMonths": 80
    }
  ],
  "reviewedConsolidatedMonths": 80,
  "sourceEvidenceIds": ["DSI-001", "DSI-002", "DSI-019"],
  "boundaries": ["partner personnel were not direct reports"]
}
```

This richer record is private provenance and is never sent to the model. The
model-facing record contains only the stable EFEI ID, skill label, and reviewed
consolidated months.

EFEI duration rules should:

- be reviewed and fixed during EFEI creation rather than calculated during a
  scoring run;
- derive only from the dates of roles to which the skill is attached;
- use inclusive named calendar months when a role is recorded only at month
  precision;
- avoid double-counting overlapping calendar months when several roles support
  the same skill;
- preserve the reviewed integer month value as part of the versioned EFEI;
- describe the result as role-associated experience duration, not an audited
  claim that the skill was exercised continuously every day of the role.

The relevant-skills filter should retain employer-requestable capabilities such
as sales motions, account or partner management, Customer Success, onboarding,
implementation, tools, industries, negotiation, reporting, and leadership. It
should exclude administrative eligibility, generic personality adjectives,
endorsement counts, and irrelevant or duplicate skills.

This source also separates semantic matching from tenure arithmetic cleanly. If
a JD requests `3 years of sales experience`, the evidence-link call answers only
whether a catalog record describes sales experience and supplies that record ID.
Python parses the explicit three-year minimum from the validated JD excerpt,
converts it to 36 months, and compares it with the already reviewed duration on
the linked EFEI record. The model does not calculate duration, decide whether the
minimum is met, or know the consequence of the comparison.

LinkedIn supplies the generalized skill vocabulary and role association. Core
Evidence remains the authority for detailed facts, scale, ownership, and claim
boundaries. Before production use, each retained skill needs either:

- a crosswalk to supporting Core Evidence IDs; or
- an explicit decision that the candidate-controlled LinkedIn role-skill export
  is an approved EFEI evidence source for that skill and associated duration.

The system must not silently treat public endorsements, recommendations, or an
unreviewed LinkedIn inference as candidate evidence.

### Model-facing EFEI presentation

The screenshots and role-specific tables below are private construction notes.
They document how the consolidated values were reviewed, but they are not the
shape sent to the evidence-link model.

The model receives one flat list, preferably in stable alphabetical order:

```json
[
  {
    "efitEvidenceId": "EFIT-001",
    "skill": "Account Management",
    "associatedExperienceMonths": 108
  },
  {
    "efitEvidenceId": "EFIT-002",
    "skill": "Business-to-Business (B2B)",
    "associatedExperienceMonths": 108
  }
]
```

It does not receive:

- employer names;
- role titles;
- job-group headings;
- separate DSI, Rockstar, T-Mobile, or other role contributions;
- role dates;
- the arithmetic used to consolidate months;
- LinkedIn endorsement counts or profile identity.

The private EFEI source ledger retains the role associations, supplied
screenshots or exports, date or duration decisions, Core Evidence crosswalks,
and overlap review needed to audit each consolidated number.

### Private common-tools completeness checklist

The model-facing EFEI remains one flat list and does not label anything as a
`boring skill`. Internally, EFEI authoring maintains a common-tools checklist so
ordinary software requirements are not omitted while attention is focused on
larger commercial capabilities.

Joe explicitly identified the following starting examples:

| Tool or common skill | Current EFEI status |
|---|---|
| Microsoft Word | Confirmed throughout DSI; 80 reviewed months |
| Microsoft Excel | Confirmed throughout DSI; 80 reviewed months |
| Salesforce.com | Confirmed throughout DSI; 80 reviewed months |
| Microsoft PowerPoint | Confirmed throughout DSI; 80 reviewed months |
| Microsoft Outlook | Confirmed throughout DSI; 80 reviewed months |
| Microsoft Office / Microsoft 365 | Confirmed throughout DSI; 80 reviewed months |
| Customer Relationship Management (CRM) Software | Confirmed throughout DSI; 80 reviewed months |
| Domo | Confirmed throughout DSI; 80 reviewed months |
| Zendesk | Confirmed throughout DSI; 80 reviewed months |
| Repsly | Confirmed throughout DSI; 80 reviewed months |
| Scintilla / Volt | Confirmed throughout DSI; 80 reviewed months; Scintilla was formerly Volt |
| Report Manager | Confirmed throughout DSI; 80 reviewed months |
| ChatGPT | Candidate-confirmed 24 reviewed months |
| Claude | Candidate-confirmed 24 reviewed months |
| Adobe Acrobat | Confirmed throughout DSI; 80 reviewed months |
| Adobe Creative Cloud | Candidate-approved conservative duration; 80 reviewed months |
| Cisco Webex | Confirmed throughout DSI; 80 reviewed months |
| Dropbox | Confirmed throughout DSI; 80 reviewed months |
| Gemini | Candidate-confirmed 24 reviewed months |
| Google Calendar | Confirmed throughout DSI; 80 reviewed months |
| Google Chat | Confirmed throughout DSI; 80 reviewed months |
| Google Docs | Confirmed throughout DSI; 80 reviewed months |
| Google Drive | Confirmed throughout DSI; 80 reviewed months |
| Google Forms | Confirmed throughout DSI; 80 reviewed months |
| Gmail | Confirmed throughout DSI; 80 reviewed months |
| Google Keep | Confirmed throughout DSI; 80 reviewed months |
| Google Meet | Confirmed throughout DSI; 80 reviewed months |
| Google Sheets | Confirmed throughout DSI; 80 reviewed months |
| Google Sites | Confirmed throughout DSI; 80 reviewed months |
| Google Slides | Confirmed throughout DSI; 80 reviewed months |
| Google Tasks | Confirmed throughout DSI; 80 reviewed months |
| Google Workspace | Confirmed throughout DSI; 80 reviewed months |
| Microsoft OneDrive | Confirmed throughout DSI; 80 reviewed months |
| Microsoft Teams | Confirmed throughout DSI; 80 reviewed months |
| Slack | Confirmed throughout DSI; 80 reviewed months |
| Tableau | Confirmed throughout DSI; 80 reviewed months |
| Zoom | Confirmed throughout DSI; 80 reviewed months |

The completeness review should continue checking for other supported records
such as:

- other named productivity, reporting, communication, or collaboration tools
  appearing in candidate-controlled LinkedIn skills or approved Core Evidence.

#### Expanded common-tools review backlog — 2026-08-13

This is a private authoring checklist, not model-facing evidence. A product's
presence in this list means only `ask whether the candidate used it and, if so,
review the associated months`. It does not authorize an EFEI record.

The first review priority is the following set already named in approved Core
Evidence but not yet present in the flat EFEI preview:

| Candidate review item | Existing support | Decision still needed |
|---|---|---|
| Quick Quote | Named in DSI training content | Confirm whether it merits its own record and whether to store 80 DSI months |
| SAP | Direct T-Mobile user-level operational exposure | Confirm 16 T-Mobile months; never represent administration or implementation |
| Sara Plus | Direct DSI use, training, manuals, and knowledge management | Confirm whether to store 80 DSI months |
| Trello | Direct DSI workflow-design use | Confirm whether to store 80 DSI months |

The broader discovery list below is deliberately more complete than the likely
final catalog. Review it by recognition; skip anything that was merely adjacent
to the work, used by somebody else, or never personally used.

| Tool family | Names to review |
|---|---|
| Generic productivity classes | Word processing software; spreadsheet software; presentation software; email and calendar software; cloud file storage and sharing; online forms and surveys; video-conferencing software |
| Microsoft productivity | Microsoft Teams; OneDrive; SharePoint; Forms; Planner; Project; Visio; OneNote; Access; Lists; Power BI; Windows |
| Google productivity | Google Docs; Sheets; Slides; Gmail; Calendar; Meet; Chat; Sites; Tasks; Keep; Google Workspace |
| Documents and signatures | Adobe Acrobat; Adobe Creative Cloud; DocuSign; Dropbox; Box |
| CRM and account management | HubSpot CRM; Microsoft Dynamics 365; Zoho CRM; Pipedrive; Oracle CRM; SugarCRM |
| Customer support and success | Freshdesk; Intercom; ServiceNow; Gainsight; ChurnZero; Totango |
| Reporting, BI, and visualization | Tableau; Looker / Looker Studio; Qlik / QlikView; Microsoft Power BI; Google Analytics |
| Project and workflow management | Asana; Monday.com; Jira; Confluence; Smartsheet; Notion; Airtable |
| Communication and meetings | Zoom; Cisco Webex; Google Meet; Microsoft Teams; Slack |
| Prospecting and sales intelligence | LinkedIn Sales Navigator; ZoomInfo; Apollo.io; Dun & Bradstreet; Seamless.AI |
| Sales engagement and conversation intelligence | Salesloft; Outreach; Gong; Chorus; Clari |
| Sales enablement and learning | Highspot; Seismic; Lessonly / Seismic Learning; learning-management systems (LMS); Canva |
| Channel and partner management | Impartner; ZiftONE; Allbound; PartnerStack; Salesforce Partner Relationship Management |
| Field sales and territory execution | Salesforce Maps; Badger Maps; SPOTIO; SalesRabbit; field-sales execution software |
| ERP, inventory, and order systems | Oracle; NetSuite; Microsoft Dynamics 365 ERP; QuickBooks; point-of-sale systems; inventory-management software; order-management software |
| Marketing automation | Marketo; Salesforce Account Engagement / Pardot; Mailchimp; HubSpot Marketing Hub |
| CPG and retail intelligence | NielsenIQ; Circana; SPINS; retailer portals; distributor portals; planogram software |
| Generative AI | Microsoft Copilot; Google Gemini; Perplexity; NotebookLM; generative-AI assistants |

The categories are useful in addition to exact product names because JDs may
say `CRM software`, `business-intelligence tools`, or `project-management
software` without naming a vendor. Any umbrella record still needs direct
support; familiarity with one product does not automatically prove the entire
category. Exact and umbrella records may coexist, with Python preventing double
credit for one requirement.

This discovery pass used current O*NET employer-posting data for Sales Managers,
Wholesale and Manufacturing Sales Representatives, and Service Sales
Representatives. O*NET's 2025-posting data repeatedly names Microsoft Office,
Excel, Salesforce, PowerPoint, Outlook, Word, HubSpot, Zoom, and—in the broader
sales lists—SAP, Teams, SharePoint, Slack, Tableau, Project, Visio, and Adobe
Acrobat. Official Microsoft 365 and Google Workspace product catalogs were used
to expand the ordinary productivity-suite checklist. These sources establish
what is reasonable to ask about, never what the candidate has used:

- https://www.onetonline.org/link/hot_tech/11-2022.00
- https://www.onetonline.org/link/hot_tech/41-4012.00
- https://www.onetonline.org/link/hot_tech/41-3091.00
- https://www.microsoft.com/en-us/microsoft-365/products-apps-services
- https://workspace.google.com/products/

The approved Core Evidence currently states that Gong, Outreach, Clari,
Highspot, and Seismic are not claimed. They remain visible above only so the
review is genuinely comprehensive. Do not add them unless the candidate
explicitly corrects that evidence boundary. Likewise, never turn SAP user-level
exposure into SAP administration, implementation, or configuration.

Other tools remain review candidates rather than automatic EFEI records. Each
requires factual support and a reviewed consolidated month total before entering
the model-facing catalog. Endorsement counts and vague claims of general computer
proficiency do not substitute for support.

Joe also confirmed that Report Manager had a later successor, but the successor
product name is not present in the currently reviewed evidence or supplied text.
Maintain a private `Report Manager successor name needed` item. Do not send a
placeholder, guessed name, or `whatever the new version is called` to the model.
Once Joe supplies the exact name, add it as its own reviewed flat skill record.

Exact and umbrella tool labels may coexist when separately supported—for
example, `Salesforce.com` and `customer relationship management (CRM) software`.
The evidence-link model may return more than one applicable record ID, but
Python scores the JD requirement once; multiple matching tool records cannot
multiply its weight or credit.

### Reviewed DSI LinkedIn skill set — 2026-08-12

Joe supplied three screenshots of the LinkedIn skills associated with the DSI
role. The role timeframe is September 2019 through April 2026. At month
precision, counting both named endpoint months, that is exactly `80` calendar
months:

```text
(2026 - 2019) * 12 + (April - September) + 1 = 80
```

For the initial EFEI draft, every skill below therefore receives
`associatedExperienceMonths = 80`. This is a reviewed stored value; the future
production scoring script does not recompute it.

The screenshots contain 24 unique skills. Repeated entries visible across the
second and third screenshots are de-duplicated:

| LinkedIn skill | Reviewed associated experience |
|---|---:|
| Channel Sales | 80 months |
| Channel Partners | 80 months |
| Partner Relationship Management | 80 months |
| Distributor Management | 80 months |
| Territory Account Management | 80 months |
| Business-to-Business (B2B) | 80 months |
| Account Management | 80 months |
| Business Planning | 80 months |
| Customer Retention | 80 months |
| Sales Operations | 80 months |
| Sales Process Optimization | 80 months |
| Data Analysis | 80 months |
| Salesforce.com | 80 months |
| Partner Engagement | 80 months |
| Key Account Management | 80 months |
| Sales Enablement | 80 months |
| Distribution | 80 months |
| Indirect Channel Sales | 80 months |
| Territory Management | 80 months |
| Field Sales Management | 80 months |
| Go-to-Market Strategy | 80 months |
| Cross-functional Team Leadership | 80 months |
| Telecommunications | 80 months |
| Software as a Service (SaaS) | 80 months |

These are candidate-controlled LinkedIn skill associations supplied directly by
Joe. The eventual EFEI artifact must remain identity-neutral and may use these
exact skill labels without including the LinkedIn display title or candidate
name. Detailed scale, achievements, ownership, and boundary claims continue to
come from Core Evidence rather than the skill labels alone.

### Reviewed Rockstar LinkedIn skill set — 2026-08-12

Joe supplied two screenshots of the LinkedIn skills associated with the
Rockstar Beverage Corporation Territory Sales Manager role and confirmed the
role lasted exactly 51 weeks. Joe approved rounding that role-associated skill
duration to `12 months` for EFEI use. This is a candidate-reviewed stored value;
the production scoring script does not derive it from dates or weeks.

The screenshots show 15 complete, unique skill labels. Text obscured below the
bottom navigation bar is not inferred or included:

| LinkedIn skill | Reviewed Rockstar-associated experience |
|---|---:|
| Distributor Management | 12 months |
| Channel Sales | 12 months |
| Indirect Channel Sales | 12 months |
| Distribution | 12 months |
| Territory Account Management | 12 months |
| Field Sales Management | 12 months |
| Negotiation | 12 months |
| Key Account Management | 12 months |
| Account Management | 12 months |
| Consumer Packaged Goods (CPG) | 12 months |
| Business-to-Business (B2B) | 12 months |
| Business Planning | 12 months |
| Sales Operations | 12 months |
| Go-to-Market Strategy | 12 months |
| New Business Development | 12 months |

Twelve of these skill labels also appear in the reviewed DSI list. Because the
Rockstar and DSI periods do not overlap, their reviewed role contributions may
be added once during EFEI authoring. The following shared skills therefore have
a currently reviewed consolidated duration of `92 months`:

- Distributor Management;
- Channel Sales;
- Indirect Channel Sales;
- Distribution;
- Territory Account Management;
- Field Sales Management;
- Key Account Management;
- Account Management;
- Business-to-Business (B2B);
- Business Planning;
- Sales Operations;
- Go-to-Market Strategy.

The three Rockstar skills not present in the supplied DSI screenshots currently
have `12 months` of reviewed associated experience:

- Negotiation;
- Consumer Packaged Goods (CPG);
- New Business Development.

These totals remain provisional until the remaining historical LinkedIn roles
are transcribed. A later role may add another non-overlapping reviewed
contribution to the same skill. The final versioned EFEI stores the reviewed
consolidated duration so the production scoring script only reads it.

### Reviewed T-Mobile LinkedIn skill set — 2026-08-12

Joe supplied two screenshots of the LinkedIn skills associated with the
T-Mobile General Manager role and specified a timeframe of May 2016 through
August 2017. At month precision, counting both named endpoint months, this is
`16 months`:

```text
(2017 - 2016) * 12 + (August - May) + 1 = 16
```

The second screenshot reaches LinkedIn's end-of-list information panel, so the
12 complete, unique skill labels below are treated as the complete supplied
T-Mobile set. Repeated entries between screenshots are de-duplicated:

| LinkedIn skill | Reviewed T-Mobile-associated experience |
|---|---:|
| Business-to-Business (B2B) | 16 months |
| New Business Development | 16 months |
| Sales Management | 16 months |
| Operations Management | 16 months |
| Account Management | 16 months |
| Team Leadership | 16 months |
| Sales Coaching | 16 months |
| P&L Management | 16 months |
| Telecommunications | 16 months |
| Operations Process Improvement | 16 months |
| Sales Prospecting | 16 months |
| SMB Sales | 16 months |

Four labels also appear in the previously reviewed DSI or Rockstar lists. With
the currently reviewed role contributions, their provisional consolidated EFEI
durations are:

| Skill | Reviewed contributions | Provisional consolidated duration |
|---|---|---:|
| Business-to-Business (B2B) | DSI 80 + Rockstar 12 + T-Mobile 16 | 108 months |
| Account Management | DSI 80 + Rockstar 12 + T-Mobile 16 | 108 months |
| New Business Development | Rockstar 12 + T-Mobile 16 | 28 months |
| Telecommunications | DSI 80 + T-Mobile 16 | 96 months |

The remaining eight T-Mobile labels currently have `16 months` of reviewed
associated experience:

- Sales Management;
- Operations Management;
- Team Leadership;
- Sales Coaching;
- P&L Management;
- Operations Process Improvement;
- Sales Prospecting;
- SMB Sales.

These totals remain provisional until all historical LinkedIn roles are
transcribed and the reviewed role periods receive one final overlap check. The
production scoring script will read the approved consolidated duration rather
than performing that aggregation itself.

### Current flat consolidated EFEI preview

The role-specific and common-tool sections above are private construction
provenance. The current model-facing content collapses them into the following
flat list. This preview contains no employer or job grouping and no candidate
identity. Values remain provisional until all intended historical roles and
common tools are added:

| Skill | Associated experience |
|---|---:|
| Account Management | 108 months |
| Adobe Acrobat | 80 months |
| Adobe Creative Cloud | 80 months |
| Business Planning | 92 months |
| Business-to-Business (B2B) | 108 months |
| Channel Partners | 80 months |
| Channel Sales | 92 months |
| ChatGPT | 24 months |
| Cisco Webex | 80 months |
| Claude | 24 months |
| Consumer Packaged Goods (CPG) | 12 months |
| Cross-functional Team Leadership | 80 months |
| Customer Relationship Management (CRM) Software | 80 months |
| Customer Retention | 80 months |
| Data Analysis | 80 months |
| Distribution | 92 months |
| Distributor Management | 92 months |
| Domo | 80 months |
| Dropbox | 80 months |
| Field Sales Management | 92 months |
| Gemini | 24 months |
| Gmail | 80 months |
| Google Calendar | 80 months |
| Google Chat | 80 months |
| Google Docs | 80 months |
| Google Drive | 80 months |
| Google Forms | 80 months |
| Google Keep | 80 months |
| Google Meet | 80 months |
| Google Sheets | 80 months |
| Google Sites | 80 months |
| Google Slides | 80 months |
| Google Tasks | 80 months |
| Google Workspace | 80 months |
| Go-to-Market Strategy | 92 months |
| Indirect Channel Sales | 92 months |
| Key Account Management | 92 months |
| Microsoft Excel | 80 months |
| Microsoft Office / Microsoft 365 | 80 months |
| Microsoft OneDrive | 80 months |
| Microsoft Outlook | 80 months |
| Microsoft PowerPoint | 80 months |
| Microsoft Teams | 80 months |
| Microsoft Word | 80 months |
| Negotiation | 12 months |
| New Business Development | 28 months |
| Operations Management | 16 months |
| Operations Process Improvement | 16 months |
| P&L Management | 16 months |
| Partner Engagement | 80 months |
| Partner Relationship Management | 80 months |
| Report Manager | 80 months |
| Repsly | 80 months |
| Sales Coaching | 16 months |
| Sales Enablement | 80 months |
| Sales Management | 16 months |
| Sales Operations | 92 months |
| Sales Process Optimization | 80 months |
| Sales Prospecting | 16 months |
| Salesforce.com | 80 months |
| Scintilla / Volt | 80 months |
| Slack | 80 months |
| SMB Sales | 16 months |
| Software as a Service (SaaS) | 80 months |
| Tableau | 80 months |
| Team Leadership | 16 months |
| Telecommunications | 96 months |
| Territory Account Management | 92 months |
| Territory Management | 80 months |
| Zendesk | 80 months |
| Zoom | 80 months |

Stable `EFIT-*` identifiers will be assigned only when the complete reviewed
list is finalized. The model-facing file will use those identifiers, the skill
label, and the consolidated month total only unless later design proves another
field is necessary.

### Approved model-facing EFEI record shape

Each model-facing record represents one normalized LinkedIn skill. The complete
closed field set is:

- `efitEvidenceId` — stable identifier such as `EFIT-001`;
- `skill` — the consolidated identity-neutral skill label;
- `associatedExperienceMonths` — the reviewed consolidated integer total.

Example:

```json
{
  "efitEvidenceId": "EFIT-001",
  "skill": "Channel Sales",
  "associatedExperienceMonths": 92
}
```

No employer, role, date, source ledger, summary, context, boundary, or candidate
identity field is permitted in the model-facing record. Those details remain in
private provenance used to review and validate the consolidated value.

### Superseded manual capability-family proposal

The earlier idea was to manually author a compact catalog covering areas such
as:

- channel partner and distributor management;
- territory and field sales management;
- strategic account management, retention, and growth;
- Customer Success, onboarding, adoption, and ongoing support;
- partner enablement, training, and certification;
- platform rollout, implementation, troubleshooting, and workflow adoption;
- go-to-market, program, territory, and process building;
- new-business development, pipeline creation, and full-lifecycle account
  ownership;
- commercial negotiation and contract progression;
- executive stakeholder management and operating reviews;
- reporting, CRM, analytics, and performance management;
- people management and operational turnaround;
- technical-product ownership and AI-assisted workflow design;
- verified education, tools, industries, and customer environments.

This manual taxonomy is superseded by the reviewed LinkedIn skill method. It
must not generate additional prose capabilities or parallel EFEI records unless
Joe separately reopens that decision. Relevant LinkedIn skill labels form the
catalog; the private ledger and Core Evidence retain the detail underneath.

## Provisional weighted scoring model

The first calibration version should be simpler than the earlier positional
proposal. It uses binary evidence answers and lets each JD establish emphasis
through its own repeated source occurrences. A capability requested or discussed
in several distinct places naturally influences more scored line items than a
capability mentioned once. This avoids a universal assumption that the first
three requirements are always most important.

### Approved initial catalog-answer values

Initial values:

| Catalog answer | Value |
|---|---:|
| `yes` | 1.00 |
| `no` | 0.00 |

There is no model-assigned partial or equivalence value. If calibration later
shows that binary catalog coverage is too coarse, the design must solve that in
the deterministic question structure or the reviewed E-Fit catalog. It must not
quietly restore a free-form evaluator judgment.

### Initial occurrence weighting

For the simplest first run, every validated substantive source occurrence has a
base weight of `1.00` within its bucket. Python retains its exact cue and source
location for audit. Explicitly preferred, desired, bonus, or nice-to-have
occurrences enter the preferred bucket; every other requested substantive
occurrence enters the required bucket. No source-position multiplier is used.

Do not de-duplicate equivalent requests that appear in genuinely different,
non-overlapping JD source locations. Those repeated occurrences are the
job-specific emphasis signal. Canonical source offsets provide the deterministic
identity rule: duplicate extraction of the same requested facet from the same or
overlapping span counts once, including artifacts caused only by block
boundaries. A compound parent does not score in addition to its scored child
facets. The model supplies source membership; it does not state that repetition
is important or assign a weight.

The initial arithmetic can operate directly on occurrence rows. Grouping
equivalent occurrences for display is optional and must not change the result.
If later grouping is introduced, it must preserve the same total contribution:


```text
grouped_weight = number_of_validated_distinct_source_occurrences
```

Source order is still preserved for provenance and later analysis, but the first
calibration version applies no top-three premium or smooth positional decay.

### Approved initial E Fit formula

Calculate separate binary coverage within the required and preferred buckets:

```text
required_coverage =
  sum(required occurrence answer values)
  / count(required occurrence rows)

preferred_coverage =
  sum(preferred occurrence answer values)
  / count(preferred occurrence rows)

E Fit = round(100 * ((0.80 * required_coverage)
                   + (0.20 * preferred_coverage)))
```

When only one bucket exists, normalize across the bucket that exists so the
maximum remains `100`; a JD with no preferred items is not capped at `80`, and a
JD with no explicitly required or uncued items is not capped at `20`.

E Fit is best understood as weighted coverage by supplied verified evidence,
not a probability of being hired and not proof that an unlinked capability is
absent from Joe's background.

### No initial Dashboard lifecycle consequence

The first calibration version should record scores and line items without a
numeric dismissal threshold or automatically changing a job's Dashboard status.
An explicitly required substantive-item hard failure remains part of the E Fit
result, but the initial calibration records that result without silently
translating it or an ordinary numeric score into a Dashboard advance, review, or
dismissal action. Numeric dismissal thresholds and lifecycle mapping are set
only after the results are stable.

## Administrative and non-experience material

The requirement supplier may identify material that the script later excludes,
but the model must not be told why it is excluded.

Continue to keep outside Experience scoring:

- driver's license, vehicle, insurance, and MVR requirements;
- work authorization or sponsorship;
- background checks and drug screens;
- generic physical and onboarding boilerplate;
- travel willingness and relocation administration;
- vague personality traits without an objectively assessable experience claim.

Travel remains an Aim dimension. Administrative eligibility remains
score-neutral.

The candidate has no professional licenses or certifications, so an explicitly
required role-defining professional license or certification necessarily
triggers the general deterministic required-item hard failure. The same rule
applies to any other substantive item the source explicitly establishes as
required or minimum: a validated `no`, or insufficient reviewed months for an
explicit tenure minimum, sets the E Fit hard-failure flag. Preferred items and
uncued items do not trigger it. Python applies the rule from the validated exact
requirement and cue; neither semantic worker is told the consequence.

## Calibration and guardrails

Before selecting thresholds or lifecycle consequences, the implementation plan
should choose a manageable reviewed corpus of real jobs containing:

- roles Joe considers strong Experience matches;
- credible stretches Joe would still pursue;
- clear Experience mismatches;
- postings with verbose or unusually short requirement lists;
- postings with important requirements listed late;
- postings with `preferred` criteria mixed into a `requirements` section;
- requirements expressed as duties rather than qualification bullets;
- differently worded channel, Customer Success, SaaS, implementation,
  strategic-account, and leadership requirements that the general E-Fit catalog
  may or may not explicitly answer;
- a small number of true role-defining credentials.

Required guardrails:

1. No approved positive anchor is dismissed during calibration.
2. A catalog-scoped `no` is never rendered as a factual candidate deficiency.
3. JD requirement extraction is unaffected by which candidate evidence records
   exist.
4. Every validated requirement receives exactly one catalog answer.
5. Artificially splitting or combining one source occurrence does not change
   the score; genuinely repeated requests in distinct source locations are
   intentionally allowed to increase influence.
6. Verbose JDs are not systematically penalized merely for boilerplate or block
   segmentation; genuine repeated substantive emphasis may affect the score.
7. Reordering low-importance requirements does not cause a large score swing.
8. General E-Fit records preserve title, ownership, tenure, industry, product,
   technical-depth, and people-management boundaries without asking the runtime
   model to grade functional equivalence.
9. The same requirement and E-Fit catalog produce an accepted cached result for
   unchanged versioned inputs.
10. Forced fresh reruns are used only for measured stability calibration.

## Open design questions

There are no further policy decisions required from Joe before the fresh Sol
Ultra implementation-planning pass. That plan must select a representative
calibration batch, formalize schemas and validators, and define test cases for
canonical occurrence de-duplication. Those are implementation-design tasks, not
additional product questions for this scratchpad.

Only observed calibration results should reopen whether the `80:20` split,
binary answers, LinkedIn-sized EFEI, occurrence emphasis, or explicit-required-
item hard-failure policy need adjustment. Numeric dismissal thresholds and
Dashboard lifecycle actions are intentionally postponed until results are
stable.

## Current design status

Confirmed product direction is sufficient for handoff to a fresh implementation-
planning chat as a general framework, not as unquestionable implementation
authority. The planning pass must challenge the design where evidence warrants,
reconcile it with the current repository, and explicitly report contradictions,
omissions, unsafe assumptions, or proposed changes before locking the final
plan. It still must specify exact schemas, prompts, validators, tests,
resumability, and import behavior.

The two-call blind architecture is now the approved working direction because it
keeps JD requirement discovery blind to Joe's evidence and keeps all scoring
consequences outside the model. Both workers operate from the complete canonical
JD path rather than a pre-extracted qualifications subset. The evidence-link
answer is binary `yes` or `no`; distinct substantive occurrences provide the
initial job-specific emphasis; and any explicitly required substantive item
answered `no` or failing an explicit tenure minimum sets a deterministic E Fit
hard-failure flag.

The current 71-record LinkedIn-derived and candidate-confirmed EFEI preview is
sufficient for first calibration; no exhaustive expansion is required before
testing. The score remains named `E Fit`, with binary evidence answers, an
`80:20` required-to-preferred split, and occurrence-based emphasis. Exact
production schemas, prompt wording, occurrence tests, calibration-batch
selection, and later Dashboard lifecycle behavior belong in a fresh
implementation-planning pass. That plan must be created in a new Sol Ultra chat
from this scratchpad, not in the current context. Sol Ultra must preserve the
framework's goals and control boundaries while independently auditing whether
the proposed mechanics actually satisfy them.
