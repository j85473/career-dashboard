# Aim Scoring Stability Design Scratchpad

**Started:** 2026-08-12  
**Status:** Design discussion only  
**Implementation authorization:** None

## Purpose and control boundary

This scratchpad preserves Joe's design decisions while Aim scoring is redesigned for repeatability. It is deliberately separate from an implementation plan.

- Do not implement from this scratchpad.
- Do not edit scoring policy, prompts, schemas, runners, imports, the database, or production from these notes.
- Do not run a scoring batch from these notes.
- Do not commit, push, or deploy from these notes.
- When the design is complete, create a separate implementation plan that cites only decisions Joe explicitly approved here.
- Unresolved, proposed, or rejected wording must not silently become an implementation requirement.

## Confirmed architecture direction

1. Remove semantic JD cleaning and coverage-review steps from the future Aim design.
2. Give the semantic evaluator the complete original JD plus trusted job metadata needed for the question, such as company, title, and location.
3. The deterministic controller uses two private phases:
   - a firm factual-question batch;
   - a separate preference-question batch dispatched only when controller policy allows it.
4. Batch the questions within each stage rather than asking the model to produce a free-form overall judgment.
5. Constrain semantic answers to a small closed answer set.
6. Require exact supporting JD text when support is available; do not accept invented or paraphrased evidence.
7. The semantic evaluator does not calculate points, apply weights, make the final score, or format the final exchange artifact.
8. A deterministic script validates answers and evidence, applies hard-stop logic, applies the versioned scoring table, and compiles the final score.
9. An unchanged evaluation identity should reuse an accepted result. The identity is derived from the JD, trusted metadata, question policy, and scoring-table versions. This is the production guarantee that unchanged inputs receive the same result.
10. A forced fresh model rerun is a calibration exercise, not the normal production path.

## Blind evaluator boundary

The LLM is an answer provider, not a decision-maker. It must not know the ramifications of its answers.

The model-facing request must also be opaque and self-contained. The model must have no indication that it is participating in a larger system, workflow, evaluation, scoring process, or sequence of calls.

The conceptual model-facing request is only:

```text
Here is a job description:

<complete original JD and only the source context needed to understand it>

Answer these questions using yes, no, or unsupported. Include the supporting text when available.

1. <question>
2. <question>
3. <question>
4. <question>
...
```

The final wording should be this sparse. It must not introduce the model as an evaluator, reviewer, worker, agent, scorer, or component.

The final answer instruction must be stronger and unambiguous while remaining plain language:

```text
Answer each question with yes, no, or unsupported.
After every yes or no, copy the exact words from the job description that support the answer.
For unsupported, include no supporting text.
Do not explain your answers.
```

The questions do not enforce source grounding by themselves. This short instruction requests the exact quote; the script enforces it. A `yes` or `no` is not valid unless its supporting text is an exact substring of the supplied original JD or an explicitly allowed item of trusted metadata for that question. The script rejects a missing, altered, paraphrased, fabricated, or source-mismatched quote. It must not silently convert an invalid `yes` or `no` into `unsupported`.

This validation is private application behavior. The LLM is told only to copy the exact supporting words; it is not told about substring validation, retries, schemas, hashes, artifacts, or downstream consequences.

The LLM receives only:

- the complete original JD;
- the minimum trusted metadata required to answer the neutral factual questions;
- the questions;
- the plain allowed answer vocabulary;
- the exact-quote requirement.

Model-facing questions and source packets must not contain Joe's name or any other personal identifier. They must use neutral terms such as `a candidate`, `the candidate`, `the person`, or `the role` only when a subject is necessary.

The model-facing request must not include or reference Joe's resume, candidate evidence, preferences, conversation context, memory, prior decisions, application history, or any personal profile. Aim questions describe only observable facts about the job and employer. Personal context and preference consequences remain entirely outside the LLM request.

The LLM must not receive or be told:

- that any question is a hard stop or screening gate;
- that `yes`, `no`, or `unsupported` causes a job to pass, fail, continue, or stop;
- that another question stage exists;
- that this is `Stage 1`, a first pass, an initial batch, a screening batch, or one step in a workflow;
- that more questions, another invocation, another model, downstream processing, or a later decision may follow;
- that the answers will be consumed by a script or application;
- any score, weight, threshold, point schedule, preference consequence, or lifecycle action;
- which answer Joe wants or considers favorable.

The LLM also must not receive or be told anything about transport, persistence, or exchange mechanics, including:

- JSON Schema or any other application schema;
- result or exchange formatting requirements;
- input hashes, result hashes, file hashes, or hash matching;
- batch IDs, job IDs, manifests, fingerprints, or evaluation identities unless a neutral source label is strictly necessary to answer a question;
- policy versions, prompt versions, runner versions, or schema versions;
- canonical ordering or serialization;
- import, preview, approval-token, database, checkpoint, or lifecycle mechanics;
- downstream validators, rejection messages, repair logic, or artifact assembly.

The script owns all of that. It receives the plain answers, maps them to the application-owned data structure, validates exact quotes against the original JD, canonicalizes and orders fields, attaches trusted identities and versions, computes every hash, validates the completed exchange artifact, and decides what to do next.

If the invocation runtime uses a machine-readable output constraint for reliable transport, that constraint is applied out of band by the wrapper. The prompt must not ask the LLM to understand, explain, satisfy, hash, or assemble the application's schema. The LLM's conceptual task remains only: answer each neutral question using the allowed word and provide the supporting text when available.

The model-facing prompt must describe the questions neutrally. Terms such as `hard stop`, `screening`, `evaluation`, `workflow`, `system`, `reject`, `kill`, `pass`, `survivor`, `Stage 1`, and `Stage 2` belong only to deterministic orchestration and must not appear in the model-facing request. Neither may application schema, hashing, import, or artifact terminology.

The deterministic script privately owns the consequence mapping. After validating the returned answers and quotes, it checks the configured screening rules. If a configured rejecting answer is present, the script fails the job and does not dispatch the separate preference-question batch. The LLM is not informed that this happened or why.

## Model-facing factual answer contract

Each factual question returns exactly one answer:

- `yes`
- `no`
- `unsupported`

Evidence rules:

- `yes` requires exact supporting text.
- `no` requires exact supporting text explicitly establishing the opposite.
- `unsupported` means the supplied sources do not establish either answer and carries no invented negative proof.
- The evaluator reports only the answer and evidence. It does not interpret downstream consequences.

## Deterministic screening policy — hidden from the LLM

For the approved factual screening questions below, the script treats a validated `yes` as a rejecting condition. If any such answer is present, the script fails the job and does not dispatch the separate preference-question batch. `no` and `unsupported` do not trigger rejection.

This consequence mapping is application policy and must never be included in the LLM's instructions, question text, answer schema descriptions, or source packet.

## Stage 1 questions

### Accepted question 1 — employment type

> Does the JD explicitly make this position part-time, temporary, contract, contract-to-hire, freelance, or 1099?

### Accepted question 2 — inside sales

> Does the JD explicitly establish inside sales as the role's primary work, rather than merely mentioning remote selling, phone calls, or an inside-sales partner?

### Accepted question 3 — required work base outside the Minneapolis–St. Paul metro

> Does this job require a candidate to live outside of the Minneapolis–St. Paul metro?

Answer only `yes`, `no`, or `unsupported`, with exact supporting text when available.

The eventual question contract must distinguish a required work base, residence, commute, onsite presence, or hybrid presence outside the Minneapolis–St. Paul metro from a travel territory. Regional, national, or international travel does not by itself make the answer `yes` when a candidate can remain based in the Minneapolis–St. Paul metro.

### Accepted question 4 — primary direct hunting/new-logo work

> Is this role primarily responsible for personally sourcing and winning net-new customers through direct prospecting or outbound sales?

Answer only `yes`, `no`, or `unsupported`, with exact supporting text when available.

- `yes`: The JD explicitly makes direct personal hunting the role's primary or majority work, such as building one's own pipeline, cold outbound prospecting, winning new logos, or serving as the primary hunter.
- `no`: The JD explicitly centers existing-account growth, renewals, retention, Customer Success, channel or partner development, distributor growth, or another non-hunter motion.
- `unsupported`: The JD mentions prospecting or new business but does not establish that direct personal hunting is the role's primary work.

Interpretation boundaries:

- Some prospecting does not make the answer `yes`.
- Carrying a quota does not automatically make the answer `yes`.
- Owning new revenue does not automatically make the answer `yes`.
- New-logo growth through partners, distributors, alliances, or channel recruitment does not make the answer `yes`.
- A balanced farming and hunting role does not make the answer `yes` unless the JD clearly establishes that direct personal hunting is primary.
- The evaluator cannot estimate a workload percentage from a list of duties. It needs explicit primary or majority language, or unmistakably hunter-centered responsibilities.

### Accepted question 5 — consumer store sales

> Is the role primarily consumer-facing store sales or store management?

Working with retailers, distributors, retail corporate accounts, or store networks does not by itself make the answer `yes`.

### Accepted question 6 — local insurance agency

> Is this employment in a local insurance agency or local insurance sales office?

Enterprise insurance technology, national accounts, benefits technology, and insurer partnerships do not by themselves make the answer `yes`.

### Accepted question 7 — religious organization

> Is the direct employer explicitly a religious organization?

The evaluator may use trusted direct-employer metadata supplied with the complete JD. It must not infer `yes` from vague mission or values language.

### Removed model-facing question — compensation below the floor

The following previously accepted question is superseded and must not be sent to the LLM:

> Does the JD explicitly establish that the maximum comparable annual total compensation is below $60,000 USD?

This wording exposes a private threshold and can require the LLM to distinguish base from total compensation, interpret ranges and currencies, convert pay periods, annualize amounts, or otherwise perform consequential reasoning and math.

Compensation remains required, but it moves to its own internal core-question family. The LLM receives only atomic factual questions about which compensation statements are explicitly present and returns their exact supporting text. It is never asked whether compensation meets a requirement, crosses a threshold, passes, or fails.

Internal compensation-family core question:

> What compensation does the JD explicitly state?

The script exclusively owns compensation extraction validation, numeric parsing, currency and pay-period normalization, base-versus-variable-versus-total classification, range comparison, annualization, and the private compensation-floor consequence. Missing, undisclosed, or non-comparable compensation continues to fail open under private script policy.

## Deterministic exclusions outside the semantic questions

- PepsiCo should not be an Aim semantic question because local scoring owns that exclusion.
- Direct AT&T employment should not be an Aim semantic question because local scoring owns that exclusion.
- Obvious title exclusions already owned by local filtering should not be duplicated as semantic questions.
- Direct-employer alias matching should be deterministic.
- Compensation arithmetic and range comparison should be deterministic.

## Open Stage 1 decisions

1. Confirm whether every accepted question's exact wording is final. Current acceptance establishes the substance, not necessarily an immutable prompt string unless Joe explicitly locks it.

## Stage 2 review control

Joe approved the complete Stage 2 atomic question bank and delegated the evidence semantics for all of its questions to Codex. Joe does not need to review hundreds of repetitive `yes` / `no` / `unsupported` definitions one at a time. The delegated rules must be explicit, conservative, source-grounded, and uniform across the complete question bank.

This delegation covers evidence interpretation only. It does not authorize Codex to choose Joe's preferences, answer weights, compensation floor, travel tolerance, score thresholds, or any implementation behavior beyond documenting the approved design.

### Confirmed Stage 2 answer architecture

Stage 2 will not ask the LLM to place the job into one mutually exclusive sales family or choose one broad preference band. Sales and commercial role families overlap too much for that classification to be reliably stable.

Instead, Stage 2 will use independent, atomic factual questions with the same answer vocabulary:

- `yes`
- `no`
- `unsupported`

Each question asks whether one observable characteristic is established by the complete JD. The LLM provides the answer and supporting text when available. A job may correctly receive `yes` for several different characteristics; those answers are not mutually exclusive and the LLM is not asked to combine or rank them.

The deterministic script privately combines the validated answers, applies all weights, and calculates the score. The LLM is not told that the answers are weighted or compiled into a score.

Stage 2 will require substantially more than six questions. There is no artificial question-count cap. The move from broad subjective classifications to atomic factual questions deliberately trades a small question count for greater coverage, auditability, and repeatability. Do not collapse distinct characteristics into a vague umbrella question merely to shorten the batch.

The final question bank must cover the complete approved Aim preference model, including all relevant sales motions, account scope, commercial responsibility, building and autonomy, product and industry characteristics, and travel characteristics. Question count will be determined by the approved factual distinctions, not selected in advance.

### Internal question families

Stage 2 questions will be designed and reviewed in families. Each family has:

1. one core design question describing what Joe ultimately wants to know;
2. however many atomic `yes` / `no` / `unsupported` questions are needed to establish the facts required to answer that core question;
3. script-owned weights for the validated answers to those atomic questions.

The core question exists only to help Joe organize and design a coherent family of atomic questions. It is not handed to the LLM, and it does not become a separate production answer, classification, field, or model judgment.

The LLM receives only the flat atomic factual questions. The script ingests the resulting `yes` / `no` / `unsupported` answers, validates the supporting text, and applies the configured weight associated with each answer. There is no intermediate step where either the LLM or the script must produce one combined answer to the core question.

Most atomics are ordinary boolean atomics. Compensation and travel also require value-bearing atomics. A value-bearing atomic still returns only `yes`, `no`, or `unsupported`; a validated `yes` must carry the exact supporting source text. The LLM does not normalize or separately return a number. The script deterministically extracts literal amounts, percentages, currencies, periods, ranges, and qualifiers from the exact quote associated with the known question.

The LLM never calculates, annualizes, converts, compares, estimates, or infers a missing value. If a JD states only a qualitative fact such as `frequent travel`, the script preserves the qualitative fact and must not invent a percentage. If deterministic parsing cannot safely extract a literal value, the value remains unknown rather than being supplied by the LLM.

This avoids asking the LLM to classify an overlapping commercial role directly while preserving a coherent human design question for each family. A family may contain as many atomic questions as required; there is no fixed or preferred count.

The LLM must not see the core questions, family names, family headings, family weights, family subtotals, or explanations of why questions are grouped. Its request remains one flat numbered list of neutral atomic questions. Internally, each question may carry a family identifier and answer weights that the script attaches after receiving the plain answer.

The approved internal families are:

1. **Commercial and go-to-market activities**
2. **Managed relationships**
3. **Customer lifecycle**
4. **Account, market, territory, and geographic scope**
5. **Measurable commercial outcomes**
6. **Technical, product, and solution involvement**
7. **Building, creation, improvement, and autonomy**
8. **Leadership, decision-making, and organizational influence**
9. **Product, problem, and industry characteristics**
10. **Compensation explicitly stated by the JD**
11. **Travel and field-engagement characteristics**

The family membership, internal core questions, and atomic question wording are approved design structure. Answer weights and score consequences remain unapproved.

### Approved Stage 2 family 1 — commercial and go-to-market activities

Internal core question, hidden from the LLM:

> What commercial and go-to-market activities does the role involve?

Approved atomic questions:

1. Does the role sell products or services directly to end customers?
2. Does the role acquire net-new end customers?
3. Does the role manage or grow existing customer accounts?
4. Does the role manage or grow channel partners or resellers?
5. Does the role recruit new channel partners or resellers?
6. Does the role onboard or enable channel partners or resellers?
7. Does the role co-sell with channel partners or resellers?
8. Does the role manage distributors, dealers, or an indirect-sales network?
9. Does the role develop or manage strategic alliances or ecosystem partnerships?
10. Does the role own customer success, adoption, or value-realization activities?
11. Does the role own customer retention or renewals?
12. Does the role own upselling, cross-selling, or account expansion?
13. Does the role perform technical discovery, demonstrations, solution design, or proof-of-concept work before a sale?
14. Does the role develop or manage marketing partnerships, sponsorships, influencer programs, or other brand partnerships?
15. Does the role perform demand-generation, lead-generation, or campaign activities?
16. Does the role perform sales operations, revenue operations, forecasting, or sales-process work?
17. Does the role provide sales, partner, or customer enablement or training?
18. Does the role perform customer onboarding, implementation, or deployment work?
19. Does the role provide ongoing customer support, service, or issue-resolution work?
20. Does the role negotiate pricing, contracts, or other commercial terms?

All 20 questions are approved for retention. No additional Core 1 question is currently required. No answer weights have been discussed or approved.

### Approved Stage 2 family 2 — managed relationships

Internal core question, hidden from the LLM:

> What types of customer, account, partner, or stakeholder relationships does the role manage?

Approved atomic questions:

1. Does the role serve as the primary ongoing relationship owner for customer accounts?
2. Does the role manage a portfolio or book of customer accounts?
3. Does the role build relationships with prospective customers before a sale?
4. Does the role maintain customer relationships after a sale?
5. Does the role manage relationships with executives or C-suite stakeholders?
6. Does the role manage relationships with business or operational stakeholders?
7. Does the role manage relationships with technical, IT, security, or engineering stakeholders?
8. Does the role manage relationships with procurement, legal, finance, or commercial stakeholders?
9. Does the role manage relationships with channel partners or resellers?
10. Does the role manage relationships with distributors, dealers, or agents?
11. Does the role manage strategic-alliance or ecosystem-partner relationships?
12. Does the role manage relationships with technology, integration, implementation, or service partners?
13. Does the role coordinate multiple stakeholder groups within the same customer account?
14. Does the role act as an ongoing trusted advisor to customers or partners?
15. Does the role handle customer- or partner-relationship escalations?
16. Does the role represent the voice of the customer or partner internally?
17. Does the role coordinate customer relationships with internal sales or account teams?
18. Does the role coordinate customer relationships across product, engineering, support, implementation, or service teams?
19. Does the role manage relationships with creators, influencers, sponsors, or brand partners?
20. Does the role manage recurring relationships primarily with internal cross-functional stakeholders?

All 20 questions are approved for retention. No additional Core 2 question is currently required. No answer weights have been discussed or approved.

### Approved Stage 2 family 3 — customer lifecycle

Internal core question, hidden from the LLM:

> Which parts of the customer lifecycle does the role own or support?

Approved atomic questions:

1. Does the role have direct responsibility for market segmentation or account planning?
2. Does the role have direct responsibility for generating leads or customer demand?
3. Does the role have direct responsibility for outbound prospecting?
4. Does the role have direct responsibility for qualifying leads or sales opportunities?
5. Does the role have direct responsibility for customer discovery or needs assessment?
6. Does the role have direct responsibility for product demonstrations, solution evaluations, pilots, or proofs of concept?
7. Does the role have direct responsibility for developing proposals, business cases, or recommended solutions?
8. Does the role have direct responsibility for pricing or commercial-package development?
9. Does the role have direct responsibility for contract negotiation or closing business?
10. Does the role have direct responsibility for the handoff between sales and post-sale teams?
11. Does the role have direct responsibility for customer onboarding?
12. Does the role have direct responsibility for implementation, deployment, or launch?
13. Does the role have direct responsibility for customer training or education?
14. Does the role have direct responsibility for driving product or service adoption?
15. Does the role have direct responsibility for customer value realization or business outcomes?
16. Does the role have direct responsibility for monitoring customer health, satisfaction, or engagement?
17. Does the role have direct responsibility for identifying or reducing churn risk?
18. Does the role have direct responsibility for customer support, issue resolution, or escalations?
19. Does the role have direct responsibility for customer business reviews, account reviews, or success-plan reviews?
20. Does the role have direct responsibility for customer renewals?
21. Does the role have direct responsibility for upselling or cross-selling?
22. Does the role have direct responsibility for broader account expansion?
23. Does the role have direct responsibility for customer advocacy, references, testimonials, or referrals?
24. Does the role have direct responsibility for collecting and communicating customer feedback?
25. Does the role have direct responsibility for influencing product or service improvements from customer feedback?
26. Does the role have direct responsibility for customer offboarding, transition, or account closure?
27. Does the role have direct responsibility across the customer lifecycle from initial acquisition through post-sale growth or renewal?

All 27 questions are approved for retention. No additional Core 3 question is currently required. No answer weights have been discussed or approved.

### Approved Stage 2 family 4 — account, market, territory, and geographic scope

Internal core question, hidden from the LLM:

> What is the role's account, market, territory, or geographic scope?

Approved atomic questions:

1. Does the role own or manage a defined geographic territory?
2. Is the role responsible for all relevant accounts or opportunities within an assigned geographic territory?
3. Is the role's geographic scope limited to a local or metropolitan area?
4. Does the role cover an entire state?
5. Does the role cover multiple states or a defined region?
6. Does the role cover the United States nationally?
7. Does the role cover the United States and Canada or another North American territory?
8. Does the role cover multiple countries?
9. Does the role have international account or market responsibility?
10. Does the role have global account or market responsibility?
11. Does the role coordinate responsibility across multiple geographic regions?
12. Does the role own or manage specifically named customer accounts?
13. Does the role own or manage key accounts?
14. Does the role own or manage strategic accounts?
15. Does the role own or manage national accounts?
16. Does the role own or manage global accounts?
17. Does the role own or manage enterprise accounts?
18. Does the role own or manage mid-market accounts?
19. Does the role own or manage small-business or SMB accounts?
20. Does the role own or manage public-sector or government accounts?
21. Does the role own or manage accounts within a specific industry or vertical market?
22. Does the role manage a defined portfolio or book of accounts?
23. Does the role manage a small number of high-value or complex accounts?
24. Does the role manage a large or high-volume portfolio of accounts?
25. Does the role manage customers with multiple locations, business units, or operating sites?
26. Does the role manage a franchise, dealer, reseller, distributor, or other multi-location commercial network?
27. Does the role own a new, greenfield, or whitespace territory or market?
28. Does the role inherit an established territory, account portfolio, or book of business?
29. Does the role have responsibility for entering or expanding into a new geographic market?
30. Does the role serve as an overlay across accounts, sellers, territories, or regions without owning the underlying accounts?

All 30 questions are approved for retention. No additional Core 4 question is currently required. No answer weights have been discussed or approved.

### Approved Stage 2 family 5

Internal core question: **What measurable commercial outcomes is the role responsible for?**

Approved atomic factual questions:

1. Does the role own an individual revenue target or sales quota?
2. Does the role share responsibility for a team revenue target or sales quota?
3. Does the role own a bookings target?
4. Does the role own an annual recurring revenue or monthly recurring revenue target?
5. Does the role own a net-new customer or new-logo target?
6. Does the role own a net-new revenue target?
7. Does the role own an account-expansion revenue target?
8. Does the role own an upsell or cross-sell target?
9. Does the role own a customer-renewal target?
10. Does the role own a customer-retention target?
11. Does the role own a churn-reduction target?
12. Does the role own a net revenue retention or gross revenue retention target?
13. Does the role own a customer-adoption or product-usage target?
14. Does the role own a customer-health or customer-satisfaction target?
15. Does the role own a lead-generation or demand-generation target?
16. Does the role own a qualified-opportunity target?
17. Does the role own a sales-pipeline creation target?
18. Does the role own a pipeline-coverage target?
19. Does the role own sales forecasting accuracy or forecast delivery?
20. Does the role own sales-cycle progression or velocity?
21. Does the role own opportunity conversion or win-rate improvement?
22. Does the role own average contract value, deal size, or transaction-value growth?
23. Does the role own pricing, margin, profitability, or discount outcomes?
24. Does the role own partner-sourced or partner-influenced revenue?
25. Does the role own channel, reseller, dealer, or distributor sales performance?
26. Does the role own partner recruitment, activation, productivity, or engagement targets?
27. Does the role own market-share growth?
28. Does the role own growth within a geographic territory?
29. Does the role own growth within a customer segment, vertical, or market?
30. Does the role own product-launch or go-to-market performance?
31. Does the role own customer onboarding completion or time-to-value outcomes?
32. Does the role own implementation, deployment, or launch success outcomes?
33. Does the role own customer-reference, advocacy, or referral outcomes?
34. Does the role have direct responsibility for reporting commercial performance against defined metrics?
35. Does the JD explicitly identify measurable performance indicators for this role?

All 35 questions are approved for retention. No answer weights have been discussed or approved.

### Approved Stage 2 family 6

Internal core question: **How much technical, product, or solution involvement does the role include?**

Approved atomic factual questions:

1. Does the role conduct technical discovery with prospective or existing customers?
2. Does the role gather or document technical requirements?
3. Does the role translate business requirements into technical requirements?
4. Does the role translate technical capabilities into business value?
5. Does the role deliver product demonstrations?
6. Does the role build or customize product demonstrations?
7. Does the role design customer-specific solutions?
8. Does the role create solution architectures or reference architectures?
9. Does the role conduct whiteboard sessions or technical workshops?
10. Does the role scope pilots, trials, evaluations, or proofs of concept?
11. Does the role build or execute pilots, trials, evaluations, or proofs of concept?
12. Does the role define technical success criteria for customer evaluations?
13. Does the role validate whether a solution fits the customer’s technical environment?
14. Does the role work directly with APIs?
15. Does the role work directly with customer integrations?
16. Does the role work directly with data migration or data transformation?
17. Does the role configure or deploy software for customers?
18. Does the role troubleshoot technical issues during the sales process?
19. Does the role troubleshoot technical issues after the sale?
20. Does the role conduct architecture reviews or technical-design reviews?
21. Does the role conduct security, privacy, compliance, or risk reviews?
22. Does the role answer technical questionnaires, requests for information, or requests for proposals?
23. Does the role create technical documentation for customers or partners?
24. Does the role create technical sales collateral, reference materials, or reusable solution assets?
25. Does the role train customers or partners on technical product capabilities?
26. Does the role present technical information to executives or business stakeholders?
27. Does the role present technical information to engineers, architects, IT teams, or security teams?
28. Does the role act as the technical authority during a sales cycle?
29. Does the role act as a technical advisor after the sale?
30. Does the role coordinate technical work across sales, product, engineering, implementation, or support teams?
31. Does the role provide customer or field feedback directly to product or engineering teams?
32. Does the role influence the product roadmap based on customer requirements?
33. Does the role require hands-on coding or software development?
34. Does the role require hands-on infrastructure, networking, cloud, or systems-administration work?
35. Does the role require hands-on expertise with artificial intelligence or machine-learning systems?

All 35 questions are approved for retention. No answer weights have been discussed or approved.

### Approved Stage 2 family 7

Internal core question: **How much opportunity does the role provide to build, create, improve, or shape how the work is done?**

Approved atomic factual questions:

1. Is this described as a founding role?
2. Is this described as the first person hired for this function, specialty, territory, or team?
3. Does the role build a new function, team, program, or capability from the ground up?
4. Does the role create a new territory, market, segment, or book of business?
5. Does the role enter or develop a greenfield or whitespace market?
6. Does the role launch a new product, service, program, channel, or go-to-market motion?
7. Does the role establish a new channel, partner, reseller, alliance, dealer, or distributor program?
8. Does the role build or redesign a customer-success program?
9. Does the role build or redesign an account-management program?
10. Does the role build or redesign a technical-sales or solutions-engineering program?
11. Does the role create playbooks, frameworks, methodologies, or operating standards?
12. Does the role create processes or workflows used by other employees or teams?
13. Does the role create tools, templates, systems, or reusable assets used by other employees or teams?
14. Does the role define how the function or program should operate?
15. Does the role establish goals, priorities, or strategy for its area of responsibility?
16. Does the role have authority to choose the approach used to achieve its objectives?
17. Does the role have authority to change existing processes or operating methods?
18. Does the role have authority to design or improve the customer journey?
19. Does the role have authority to design or improve the sales process?
20. Does the role have authority to design or improve the partner experience?
21. Does the role have authority to influence go-to-market strategy?
22. Does the role have authority to influence product strategy or roadmap decisions?
23. Does the role own a substantial transformation, turnaround, or restructuring effort?
24. Does the role scale an existing function, program, territory, or operating model?
25. Does the role expand an existing program into new markets, regions, products, or customer segments?
26. Does the role identify problems and independently create solutions?
27. Does the role operate with limited day-to-day direction?
28. Does the role make independent decisions within its area of responsibility?
29. Does the role work directly with founders or company executives to shape the approach?
30. Does the role have authority to allocate resources, budget, or investments?
31. Does the role have authority to select or manage external partners, vendors, or agencies?
32. Does the role inherit a mature program with established processes and limited authority to change them?
33. Does the role primarily execute a prescribed playbook or standardized process?
34. Does the role primarily maintain an existing book of business without a stated building or transformation mandate?
35. Does the JD explicitly emphasize experimentation, iteration, or testing new approaches?

All 35 questions are approved for retention. No answer weights have been discussed or approved.

### Approved Stage 2 family 8

Internal core question: **What leadership, decision-making, and organizational influence does the role provide?**

Approved atomic factual questions:

1. Does the role directly manage employees?
2. Does the role directly manage managers?
3. Does the role hire or build a team?
4. Does the role coach, mentor, or develop employees?
5. Does the role lead work performed by people who do not report directly to it?
6. Does the role lead a cross-functional team or initiative?
7. Does the role lead customer-facing account teams?
8. Does the role lead partner-facing or channel-facing teams?
9. Does the role lead external agencies, contractors, vendors, or service providers?
10. Does the role own decisions for a territory, market, account portfolio, program, or function?
11. Does the role make pricing, discounting, contracting, or commercial decisions?
12. Does the role make customer or account-prioritization decisions?
13. Does the role make partner-selection or partner-investment decisions?
14. Does the role make product, solution, or implementation decisions?
15. Does the role influence executive-level decisions within the company?
16. Does the role regularly advise company executives?
17. Does the role regularly advise customer executives?
18. Does the role present business performance, recommendations, or strategy to company leadership?
19. Does the role present business performance, recommendations, or strategy to customer leadership?
20. Does the role coordinate decisions across sales, marketing, product, engineering, finance, legal, implementation, or support teams?
21. Does the role resolve conflicts or competing priorities across internal teams?
22. Does the role resolve conflicts or competing priorities across customer or partner stakeholders?
23. Does the role represent the customer’s interests in internal decisions?
24. Does the role represent the partner’s interests in internal decisions?
25. Does the role influence product priorities based on customer, market, or partner evidence?
26. Does the role influence go-to-market priorities?
27. Does the role influence company-wide processes or operating standards?
28. Does the role influence work across multiple business units?
29. Does the role influence work across multiple geographic regions?
30. Does the role have global organizational influence?
31. Does the role serve as a subject-matter expert for other employees or teams?
32. Does the role train or enable internal employees?
33. Does the role create materials or practices adopted by other employees or teams?
34. Does the role have budget ownership?
35. Does the role have responsibility for executive sponsorship or executive alignment?

All 35 questions are approved for retention. No answer weights have been discussed or approved.

### Approved Stage 2 family 9

Internal core question: **What product, problem, and industry characteristics does the role involve?**

Approved atomic factual questions:

1. Is artificial intelligence central to the product or service being sold or supported?
2. Is machine learning central to the product or service being sold or supported?
3. Is generative AI central to the product or service being sold or supported?
4. Is agentic automation central to the product or service being sold or supported?
5. Is cybersecurity central to the product or service being sold or supported?
6. Is identity, authentication, authorization, or access management central to the product or service?
7. Is physical AI, robotics, autonomous technology, or intelligent hardware central to the product or service?
8. Is data infrastructure, analytics, observability, or data management central to the product or service?
9. Is cloud infrastructure or enterprise infrastructure central to the product or service?
10. Is developer tooling or a developer platform central to the product or service?
11. Is enterprise workflow automation central to the product or service?
12. Is the product or service sold primarily as business-to-business software?
13. Is the product or service sold primarily as software as a service?
14. Is the product or service primarily enterprise hardware or a combined hardware-and-software solution?
15. Is the product or service primarily professional, consulting, implementation, or managed services?
16. Is the product or service primarily marketing, advertising, media, or agency services?
17. Is the product or service primarily consumer packaged goods?
18. Is the product or service primarily retail technology?
19. Is the product or service primarily point-of-sale or payment technology?
20. Is the product or service primarily human-resources, payroll, workforce, or benefits technology?
21. Is the product or service primarily finance, accounting, banking, or financial technology?
22. Is the product or service primarily enterprise-resource-planning or operational business software?
23. Is the product or service primarily healthcare technology?
24. Is the product or service primarily pharmaceutical or biotechnology products?
25. Is the product or service primarily medical devices, diagnostics, or clinical equipment?
26. Is the product or service primarily security, alarm-monitoring, or physical-security technology?
27. Is the product or service primarily telecommunications or connectivity technology?
28. Is the product or service primarily industrial, manufacturing, logistics, or supply-chain technology?
29. Is the product or service primarily energy, utilities, climate, or environmental technology?
30. Is the product or service primarily education technology?
31. Is the product or service primarily government or public-sector technology?
32. Is the product or service primarily insurance technology?
33. Is the product or service primarily legal technology?
34. Is the product or service primarily real-estate or property technology?
35. Is the role centered on solving a newly emerging or rapidly changing problem?
36. Is the role centered on a technically complex product or service?
37. Is the role centered on a product or service requiring substantial customer education?
38. Is the role centered on a mission-critical product or service?
39. Is the role centered on a regulated customer environment?
40. Does the JD explicitly identify the primary product or service the role sells or supports?

All 40 questions are approved for retention. No answer weights have been discussed or approved.

### Approved Stage 2 family 10

Internal core question: **What compensation does the JD explicitly state?**

Approved atomic factual questions:

1. Does the job description explicitly state a base-salary amount or range?
2. Does the job description explicitly state an hourly-pay amount or range?
3. Does the job description explicitly state a weekly-pay amount or range?
4. Does the job description explicitly state a monthly-pay amount or range?
5. Does the job description explicitly state an annual-pay amount or range without identifying whether it is base or total compensation?
6. Does the job description explicitly state an on-target earnings amount or range?
7. Does the job description explicitly state a total-cash-compensation amount or range?
8. Does the job description explicitly state another total-compensation amount or range?
9. Does the job description explicitly state a commission amount, rate, or range?
10. Does the job description explicitly state a variable-compensation amount, percentage, or range?
11. Does the job description explicitly state a bonus amount, percentage, or range?
12. Does the job description explicitly state commission eligibility without stating an amount, rate, or range?
13. Does the job description explicitly state bonus eligibility without stating an amount, percentage, or range?
14. Does the job description explicitly state a base-to-variable compensation split?
15. Does the job description explicitly state that commission or variable compensation is uncapped?
16. Does the job description explicitly state a guaranteed draw, recoverable draw, guaranteed commission, or guaranteed variable-payment period?
17. Does the job description explicitly state a sign-on bonus?
18. Does the job description explicitly state equity, stock options, restricted stock, or another ownership award?
19. Does the job description explicitly state profit sharing?
20. Does the job description explicitly identify the currency used for compensation?
21. Does the job description explicitly identify the pay period used for compensation?
22. Does the job description explicitly state a compensation range applicable to Minnesota?
23. Does the job description explicitly state compensation that varies by location?
24. Does the job description explicitly provide multiple compensation ranges for different locations?
25. Does the job description explicitly state that a listed amount or range excludes commission, bonus, variable pay, equity, or other compensation?
26. Does the job description explicitly state that a listed amount or range includes commission, bonus, variable pay, or other compensation?
27. Does the job description explicitly state that actual earnings may exceed a listed target or range?
28. Does the job description explicitly distinguish base compensation from on-target earnings or total compensation?
29. Does the job description contain more than one distinct compensation amount or range?
30. Does the job description explicitly state that compensation information is unavailable or undisclosed?

All 30 questions are approved for retention. Every `yes` answer must include the exact supporting text from the JD. The LLM does not separately extract, normalize, calculate, annualize, convert, compare, or estimate compensation. The script validates the quote and deterministically extracts literal amounts, percentages, ranges, currencies, and pay periods from that cited text. No answer weights or compensation thresholds have been discussed or approved.

### Approved Stage 2 family 11

Internal core question: **What travel and field-engagement characteristics does the role involve?**

Approved atomic factual questions:

1. Does the job description explicitly state a travel percentage or percentage range?
2. Does the job description explicitly state a maximum travel percentage, such as “up to” a stated percentage?
3. Does the job description explicitly state a minimum travel percentage, such as “at least” a stated percentage?
4. Does the job description explicitly require travel without stating a percentage?
5. Does the job description explicitly state that no travel is required?
6. Does the job description describe travel as occasional?
7. Does the job description describe travel as periodic?
8. Does the job description describe travel as “as needed”?
9. Does the job description describe travel as frequent?
10. Does the job description require local travel within a city or metropolitan area?
11. Does the job description require travel within an assigned geographic territory?
12. Does the job description require regional travel?
13. Does the job description require travel across multiple states?
14. Does the job description require national travel within the United States?
15. Does the job description require travel within the United States and Canada?
16. Does the job description require international travel?
17. Does the job description require global travel?
18. Does the job description require overnight travel?
19. Does the job description require air travel?
20. Does the job description require driving between customer, partner, dealer, distributor, or work locations?
21. Does the job description require customer-site visits?
22. Does the job description require partner, reseller, dealer, or distributor-site visits?
23. Does the job description require attendance at conferences, trade shows, industry events, or company events?
24. Does the job description require travel for customer meetings, presentations, or business reviews?
25. Does the job description require travel for implementations, deployments, training, or technical work?
26. Does the job description require travel for internal company meetings or team gatherings?
27. Does the job description describe the role as field-based?
28. Does the job description describe the role as remote with travel?
29. Does the job description describe the role as home-based with travel?
30. Does the job description require recurring in-person engagement with customers or partners?
31. Does the job description require recurring in-person engagement with employees or internal teams?
32. Does the job description require travel but leave the travel geography or mode unspecified?

All 32 questions are approved for retention. Every `yes` answer must include the exact supporting text from the JD. The LLM does not separately extract, normalize, calculate, compare, or estimate travel. The script validates the quote and deterministically extracts literal percentages or percentage ranges from that cited text. Qualitative travel descriptions remain qualitative and must never be converted into invented percentages. No answer weights or travel thresholds have been discussed or approved.

## Delegated Stage 2 evidence semantics

Joe delegated the evidence interpretation for the complete approved Stage 2 question bank to Codex. The rules in this section apply to every atomic question. They replace question-by-question semantic review and are intended to keep equivalent evidence classified the same way throughout the bank.

These rules define the internal meaning of the questions and the expected answers used for calibration and acceptance testing. They must not be appended to the model-facing prompt. The model-facing request remains the complete JD, minimal trusted metadata, the flat numbered questions, the three allowed answers, and the short exact-quotation instruction. If an atomic question cannot work under that sparse contract, the question must be rewritten; the prompt must not be expanded into an explanation of the scoring system.

### Universal answer rules

1. `yes` means the supplied JD or question-authorized trusted metadata explicitly entails the complete proposition in the atomic question.
2. `no` means the supplied source explicitly entails the opposite of the complete proposition. Omission, silence, or failure to find positive evidence is never a `no`.
3. `unsupported` means neither the proposition nor its opposite is explicitly established, the wording is too ambiguous, a required modifier is missing, or equally applicable source statements conflict.
4. Every `yes` or `no` requires one or more exact source excerpts sufficient to support the complete answer. `unsupported` carries no excerpt.
5. Evidence must describe this role. Duties assigned only to the company, department, customer, partner, or team do not establish that the role performs or owns them.
6. Company-level text may establish the nature of the employer, product, service, market, or industry for questions that ask about those facts. It may not establish the role's activities, ownership, authority, relationships, or outcomes.
7. A job title alone does not establish duties, ownership, scope, seniority, or authority. Unambiguous title language may support a question that asks only whether the role is explicitly described by that label, but it cannot substitute for missing responsibility text.
8. Required qualifications establish a candidate requirement. They do not automatically establish a current job duty unless the JD also connects the qualification to the work the role performs.
9. Preferred qualifications, desired experience, possible exposure, optional opportunities, and statements using only `may`, `can`, or `could` do not establish a required duty or responsibility.
10. Future-tense role responsibilities such as `you will build`, `you will own`, or `the role will lead` are current role requirements and may support `yes`.
11. Statements about the performance of the broader team do not establish individual ownership. `Own`, `be accountable for`, `be responsible for`, `carry`, `manage`, or a direct assignment to the role may establish ownership. `Assist`, `support`, `contribute to`, `participate in`, `gain exposure to`, or `work alongside` do not establish ownership.
12. Collaboration may establish participation only when the atomic asks about collaboration, coordination, or involvement. It does not establish decision authority, individual ownership, direct management, or hands-on execution.
13. Modifiers are binding. Words such as `primary`, `primarily`, `central`, `direct`, `individual`, `ongoing`, `recurring`, `global`, `national`, `exclusive`, `first`, `founding`, `new`, `small`, `large`, and `multiple` must be explicitly stated or unavoidably entailed by concrete source facts. They cannot be inferred from title, bullet order, the number of listed duties, or common industry practice.
14. For a question joined by `and`, every required element must be established for `yes`. If one element is established and another is unknown, the answer is `unsupported`. For alternatives joined by `or`, any one listed alternative may establish `yes` unless the question explicitly requires more than one.
15. Closely related concepts remain separate. Evidence for one lifecycle stage, relationship type, market segment, sales motion, authority level, outcome, product category, compensation component, or travel characteristic does not automatically establish an adjacent one.
16. Atomics are independent and not mutually exclusive unless their wording makes them logically incompatible. The same exact source text may support multiple `yes` answers when it genuinely entails each proposition.
17. When a source contains both positive and negative statements, the narrower role-specific and current statement controls over general company language, examples, boilerplate, or aspirational text. If equally specific applicable statements still conflict, the answer is `unsupported`.
18. The evaluator must not use outside knowledge, memory, assumptions about a company or title, inferred workload percentages, inferred hierarchy, inferred compensation, inferred travel, or typical industry practices.
19. The evaluator answers only the factual proposition. It does not consider whether an answer is favorable, how it is weighted, whether another atomic already covers the fact, or what downstream action may occur.
20. Exact quotation is necessary but not sufficient: the excerpt must actually entail the answer under these rules. The deterministic script can enforce exact source matching; calibration fixtures and audits enforce semantic entailment.

### Rules by atomic-question type

**Activity or involvement atomics**

- `yes` requires an explicit role responsibility to perform, deliver, conduct, create, manage, provide, or directly participate in the named activity.
- Merely interacting with a person involved in the activity, receiving its output, or supporting the team that owns it is insufficient.
- `no` requires an explicit exclusion, such as a statement that the role does not perform the activity or that another party exclusively performs it.

**Ownership, accountability, and measurable-outcome atomics**

- `yes` requires direct accountability assigned to the role for the named target, decision, process, portfolio, or outcome.
- Being measured on a team result may establish shared responsibility only when the JD explicitly assigns that shared responsibility to the role.
- Influencing, supporting, reporting, or contributing to an outcome does not establish ownership of it.
- A metric mentioned in company or team context is not a role-owned target.

**Relationship-management atomics**

- `yes` requires an ongoing role responsibility to own, manage, maintain, develop, advise, or coordinate the named relationship.
- A single presentation, transaction, handoff, meeting, or contact does not establish ongoing relationship management.
- Communicating with a stakeholder does not by itself establish ownership of that relationship.

**Requirement atomics**

- `yes` requires mandatory or expected language tied to the role, such as `must`, `required`, `will`, or an unqualified responsibility statement.
- `no` requires an explicit statement that the item is not required, is optional, or does not apply.
- A preference, possibility, benefit, or candidate capability is `unsupported` unless the atomic asks specifically about a preference or capability.

**Primary, central, and primarily-sold atomics**

- `yes` requires explicit primary, central, core, main, predominant, exclusive, or equivalent language. The evaluator may not estimate primacy from the ordering or volume of duties.
- A different explicitly identified primary activity or offering supports `no` only when it is incompatible with the questioned proposition. Otherwise the answer remains `unsupported` because a role or offering may have more than one central characteristic.

**Authority, influence, and leadership atomics**

- Direct people management requires explicit reporting-line, supervisory, hiring-manager, performance-management, or direct-report evidence.
- Leading a project, account team, initiative, or cross-functional process does not establish direct people management.
- Decision authority requires language assigning approval, selection, allocation, prioritization, or final decision rights. Recommending or advising does not establish final authority.
- Influence requires explicit responsibility to shape, advise, advocate, recommend, align, or affect the named decision or audience. Mere attendance or information sharing is insufficient.

**Scope, quantity, and geography atomics**

- `yes` requires the exact named scope or concrete facts that unavoidably satisfy it. Two or more explicitly named states, countries, regions, accounts, or business units may establish `multiple` even if the word itself is absent.
- Company operating footprint does not establish the role's assigned footprint.
- Customer locations, travel destinations, remote-work eligibility, and candidate residence do not establish account or territory ownership.
- `Global`, `international`, `national`, `North American`, state, regional, and local scopes are not interchangeable.
- `Small number`, `large portfolio`, `high-volume`, `high-value`, and `complex` require explicit descriptors or concrete counts paired with an approved deterministic boundary. No such numeric size boundaries are approved yet, so counts without an explicit descriptor remain `unsupported` for `small` or `large`.

**Newness, building, autonomy, and transformation atomics**

- `yes` requires the role itself to create, launch, establish, redesign, transform, scale, or materially shape the named function, market, program, process, or asset.
- A young company, startup environment, new product, or broad `entrepreneurial` language does not establish that this role is founding, first, greenfield, or authorized to redesign how work is done.
- Independent execution does not establish authority to change policy, allocate resources, or set strategy.

**Explicit-description and category atomics**

- `yes` requires the JD to explicitly identify the employer, role, product, service, customer environment, or category named in the question.
- A customer industry does not automatically identify the product's industry, and a product used by an industry is not automatically an industry-specific product.
- Related categories may each be `yes` when the JD explicitly establishes each one. One category does not create an inferred `no` for every other category.

**Numeric and value-bearing atomics**

- `yes` requires a literal number, range, percentage, rate, currency, pay period, or qualifier in the cited source text when the question asks for that value.
- The LLM never calculates, annualizes, converts, normalizes, compares, estimates, or supplies a number separately from the quote.
- The script extracts only literal values from validated excerpts and leaves a value unknown when parsing is unsafe.
- Questions asking whether more than one distinct value is present require exact excerpts for each distinct value; the script performs the deterministic distinct-value count.

**Absence-qualified atomics**

- The normal rule remains that silence produces `unsupported`, not `no`.
- A small number of approved atomics explicitly combine a positive fact with the absence of a qualifier: an unlabeled annual compensation amount, eligibility without an amount, required travel without a percentage, or required travel with unspecified geography or mode.
- For these atomics, `yes` requires an exact quote establishing the positive fact, plus a deterministic whole-source check confirming that the missing qualifier is not supplied elsewhere in the applicable compensation or travel text.
- This exception does not allow the LLM to treat ordinary missing information as a supported negative.

### Family-specific collision boundaries

**Family 1 — commercial and go-to-market activities**

- Direct end-customer selling is distinct from partner, reseller, distributor, dealer, alliance, or other indirect selling.
- Acquiring net-new customers is distinct from expanding existing accounts. Prospecting alone does not establish acquisition or closing.
- Managing, recruiting, onboarding, enabling, and co-selling with partners are separate activities; evidence for one does not establish the others.
- Customer success, onboarding, implementation, support, retention, renewal, expansion, enablement, marketing, operations, and technical pre-sales remain separate even when one role performs several.
- A quota does not by itself establish direct selling, prospecting, account management, negotiation, or closing.

**Family 2 — managed relationships**

- A primary ongoing relationship owner must be explicitly identified as the account owner, primary contact, relationship lead, or equivalent.
- A portfolio or book requires responsibility for a defined set of recurring accounts; a list of prospects or one named account is not automatically a portfolio.
- Executive, business, technical, procurement, legal, finance, partner, distributor, alliance, service-partner, creator, and internal relationships are distinct stakeholder types.
- Coordinating multiple stakeholders does not establish ownership of every underlying stakeholder relationship.
- `Trusted advisor`, escalation ownership, and voice-of-customer representation each require explicit role responsibilities and are not inferred from ordinary account contact.

**Family 3 — customer lifecycle**

- Each lifecycle stage is classified independently. Discovery does not establish qualification; closing does not establish negotiation; handoff does not establish onboarding; onboarding does not establish implementation; adoption does not establish value realization; retention does not establish renewal; and renewal does not establish expansion.
- `Direct responsibility` requires the role to perform or own the activity, not merely coordinate with the team that does it.
- Customer feedback collection is distinct from authority or responsibility to influence product improvements from that feedback.
- End-to-end lifecycle responsibility requires explicit span from acquisition or pre-sale work through post-sale growth, retention, or renewal. Several isolated lifecycle duties do not automatically establish end-to-end ownership.

**Family 4 — account, market, territory, and geographic scope**

- Owning a defined territory is distinct from traveling through it, residing in it, supporting sellers in it, or serving as an overlay.
- `All accounts or opportunities` requires comprehensive territory language, not simply an assigned territory.
- Named, key, strategic, national, global, enterprise, mid-market, SMB, public-sector, and vertical accounts are separate labels and must be supported independently.
- National responsibility does not establish global or international responsibility. Multiple countries may establish international scope but not global scope.
- New or whitespace territory, inherited territory, market entry, market expansion, and overlay responsibility are separate conditions.
- Multi-location customers are distinct from managing a dealer, reseller, distributor, franchise, or other commercial network.

**Family 5 — measurable commercial outcomes**

- Individual and team targets are separate. A team target does not establish an individual quota, and an individual quota does not establish shared team accountability.
- Revenue, bookings, recurring revenue, new-logo count, net-new revenue, expansion, upsell, renewal, retention, churn, revenue retention, adoption, customer health, pipeline, forecast, conversion, deal size, pricing, margin, partner revenue, partner productivity, market share, and launch outcomes are separate metrics.
- Reporting a metric does not establish ownership of the metric. Owning forecast delivery does not establish ownership of every underlying opportunity outcome.
- Partner-sourced revenue is distinct from managing channel performance, and both are distinct from partner recruitment or activation targets.
- A generic quota or KPI reference supports only the generic target or KPI atomic unless the JD explicitly identifies the metric type.

**Family 6 — technical, product, and solution involvement**

- Business discovery is not technical discovery unless technical requirements, systems, architecture, integration, security, data, infrastructure, or comparable technical substance is explicit.
- Delivering a standard demonstration is distinct from building or customizing one. Scoping a proof of concept is distinct from executing it.
- Requirements gathering, solution design, architecture, validation, implementation, configuration, migration, integration, troubleshooting, and documentation are separate activities.
- Coordinating technical teams does not establish hands-on coding, systems administration, infrastructure work, deployment, or troubleshooting.
- Presenting to technical stakeholders does not establish technical authority; technical authority requires explicit ownership of the technical evaluation or decision.
- Product feedback is distinct from roadmap influence. Roadmap influence requires an explicit responsibility to shape priorities or decisions.

**Family 7 — building, creation, improvement, and autonomy**

- Founding, first hire, from-scratch building, greenfield market development, launching, redesigning, transforming, scaling, and expanding are distinct claims.
- Creating a personal work product does not establish creation of an organizational playbook, process, system, framework, or reusable asset.
- Freedom to choose an execution method does not establish authority to change company processes, strategy, product direction, budget, or resourcing.
- Working with founders or executives does not by itself establish authority to shape the approach.
- An established program is not automatically low-autonomy; low authority or prescribed execution must be explicit.
- Maintaining an existing book is not automatically the role's primary work and does not exclude simultaneous building responsibilities unless primacy or limitation is explicit.

**Family 8 — leadership, decision-making, and organizational influence**

- Direct management, management of managers, hiring, coaching, project leadership, account-team leadership, partner-team leadership, and vendor leadership are distinct.
- Cross-functional leadership does not establish direct reports. Subject-matter expertise and training do not establish management.
- Making a decision is distinct from influencing, recommending, advising, presenting, coordinating, or escalating it.
- Internal executive advice and customer executive advice are separate. Presentation to executives does not automatically establish advisory responsibility.
- Multi-business-unit, multi-region, and global influence require explicit organizational reach; company size or footprint is insufficient.
- Budget ownership requires explicit control or accountability for a budget, not merely recommending investments or negotiating customer pricing.

**Family 9 — product, problem, and industry characteristics**

- Product and industry categories are based on what the role sells or supports, not isolated tools the employee uses or industries in which customers happen to operate.
- AI, machine learning, generative AI, agentic automation, cybersecurity, identity, physical AI, data, cloud, developer tools, and workflow automation are separate characteristics, although explicit evidence may support more than one.
- B2B software, SaaS, hardware-plus-software, and services describe delivery or commercial form and may coexist with a product-domain category.
- Industry categories such as healthcare, financial technology, telecommunications, retail technology, and insurance technology require that the offering itself be centered on that domain.
- `Newly emerging`, `rapidly changing`, `technically complex`, `substantial customer education`, `mission-critical`, and `regulated customer environment` require explicit descriptions or unavoidable concrete requirements. Marketing superlatives alone are insufficient.
- Mentioning a regulation, integration, security review, or technical buyer does not by itself make the product regulated, mission-critical, or technically complex.

**Family 10 — compensation explicitly stated by the JD**

- Base salary, unlabeled annual pay, OTE, total cash, other total compensation, commission, variable compensation, bonus, sign-on bonus, equity, and profit sharing are distinct components.
- A compensation amount supports a component only when the surrounding exact text labels that component. An annual amount not labeled as base or total belongs only to the approved unlabeled-annual-pay atomic.
- Commission or bonus eligibility without an amount requires explicit eligibility language and a deterministic check that no amount, rate, percentage, or range for that component appears elsewhere in the applicable compensation text.
- A base-to-variable split requires both components or an explicit split. `Uncapped`, draw terms, inclusion, exclusion, and ability to exceed target each require their literal qualifier.
- Currency requires an explicit currency code or name. A bare `$` does not distinguish USD from another dollar currency.
- Pay period requires literal period language such as hourly, weekly, monthly, annually, per hour, or per year.
- Minnesota applicability, location variation, and multiple location ranges require explicit geographic compensation text. The job location alone does not prove that a listed range is Minnesota-specific.
- The script, never the LLM, distinguishes values, parses ranges, counts distinct amounts, annualizes periods, converts currencies, and compares compensation with Joe's private threshold.
- `Competitive compensation`, `market rate`, or silence does not establish that compensation is explicitly unavailable or undisclosed. That atomic requires literal unavailable, not provided, not disclosed, or equivalent wording.

**Family 11 — travel and field-engagement characteristics**

- A travel percentage requires a literal percentage or percentage range. `Occasional`, `periodic`, `as needed`, and `frequent` remain qualitative and never produce a numeric percentage.
- `Up to` establishes a maximum, not a minimum. `At least` establishes a minimum, not a maximum. A bounded percentage range establishes both endpoints only through deterministic parsing of the literal range.
- Travel required without a percentage requires affirmative travel language and a deterministic check that no applicable percentage appears elsewhere in the JD.
- Local, territory, regional, multistate, national, United States and Canada, international, and global travel are separate scopes. One does not automatically establish another except where explicitly named places unavoidably satisfy `multiple`.
- Overnight, air, and driving travel require explicit mode or overnight language. Distance alone does not establish the mode.
- Customer-site, partner-site, event, customer-meeting, implementation, and internal-meeting travel are separate purposes.
- Field-based, remote-with-travel, and home-based-with-travel require those explicit arrangements. Field-based does not by itself prove a travel percentage or overnight travel.
- Recurring in-person engagement requires explicit recurrence such as regular, ongoing, weekly, monthly, or periodic in-person activity. One event or occasional meeting does not establish recurrence.
- Travel with unspecified geography or mode requires affirmative travel language and a deterministic whole-source check that neither geography nor mode is supplied elsewhere in the applicable travel text.
- Travel territory never establishes that a candidate must reside outside the Minneapolis–St. Paul metro; the residence and work-base screen remains a separate Stage 1 question.

### Semantic completion status

The universal rules, question-type rules, and family-specific collision boundaries above cover all approved Stage 2 atomics. No additional per-atomic semantic review with Joe is required unless calibration later exposes a concrete ambiguity or recurring misclassification. Any such repair should narrow the affected atomic or add a targeted boundary without weakening the sparse, blind model-facing contract.

Stage 2 evaluator packets must follow the same blind boundary. The LLM receives a flat numbered list of neutral atomic factual questions, not the internal family headings, core questions, family relationships, interpretation rulebook, weights, resulting score, desired answers, or downstream actions. Its answer vocabulary remains `yes`, `no`, or `unsupported`, with exact supporting JD text required after every `yes` or `no` and no supporting text after `unsupported`.

## Confirmed Stage 2 weighting priorities

Joe approved the following directional weighting policy. These are preference and ranking rules owned by the deterministic script. They must never appear in the model-facing questions or instructions.

### Travel priority

- Aim should strongly reward roles with substantial travel.
- International or global travel is the most desirable travel characteristic and belongs at the top of the travel cascade.
- The remaining travel characteristics should cascade downward from international or global travel through national or North American travel, multistate or regional travel, and local or territory travel.
- Within comparable geographic scope, higher or more frequent travel should score above lower, occasional, or unspecified travel.
- Qualitative travel language remains qualitative. The script must not invent percentages for terms such as `frequent`, `periodic`, `occasional`, or `as needed`.
- Closely related travel facts must not create uncontrolled double counting. The eventual numeric policy should use bounded travel dimensions or tier selection so one travel statement cannot receive the full value of every overlapping synonym.

### Commercial-motion priority

- Channel sales and channel-led commercial work are Joe's most preferred commercial motion and belong at the top of the commercial cascade.
- Strongest preference goes to substantive responsibility for building, recruiting, enabling, growing, or owning partners, resellers, distributors, dealers, alliances, ecosystems, or other indirect-sales networks.
- Merely interacting with a partner or working alongside a channel team must not receive the same value as owning or materially growing the channel motion.
- The remaining commercial motions should cascade downward based on their similarity to Joe's preferred channel-led work.
- The eventual numeric policy must avoid counting the same channel responsibility at full value in every overlapping family. Distinct responsibilities may add value, but duplicated descriptions of one responsibility must be bounded.

### Building and autonomy priority

- Aim should strongly reward opportunities to build, create, launch, redesign, transform, or materially shape how work is done.
- The top of this cascade is founding, first-hire, from-scratch, greenfield, or new-function ownership paired with meaningful decision authority.
- Launching, redesigning, transforming, or establishing a program should follow.
- Scaling, expanding, improving, or creating reusable operating systems should follow.
- Independent execution and limited day-to-day direction remain positive but should score below explicit authority to build or change the operating model.
- Prescribed execution, mature processes with explicitly limited authority to change them, or primarily maintaining an existing book without a building mandate belong at the bottom of the cascade and may receive negative weight.

### Compensation priority

- Compensation should have very little influence on the Aim score.
- Once a role clears any separately configured minimum-compensation rule, a higher salary should create only a small score difference.
- Compensation must not outweigh travel, channel motion, or building and autonomy.
- Missing or undisclosed compensation should not receive an invented value and should remain score-neutral unless Joe separately approves another policy.
- The private minimum-compensation rule remains distinct from weighted preference scoring and is confirmed as a rejecting controller rule.
- The script kills the job only when the supplied evidence and deterministic normalization explicitly establish that the maximum comparable annual total compensation is below $60,000 USD.
- Exactly $60,000 does not satisfy `below $60,000` and therefore does not trigger this rule.
- Base salary below $60,000 does not trigger this rule when explicit OTE or other comparable annual total compensation reaches or exceeds $60,000.
- Missing, undisclosed, ambiguous, non-comparable, or unsafely parsed compensation fails open for this rule and remains score-neutral.
- Any currency conversion or pay-period normalization used by the controller must be deterministic and versioned as part of the scoring policy so the same source evidence cannot cross the floor merely because the evaluation runs on a different date.

### Numeric-weight status

Joe approved the following initial 100-point budget as a reasonable starting point:

- **Commercial motion: 30 points**
- **Travel: 30 points**
- **Building and autonomy: 25 points**
- **All other supported Aim characteristics: 13 points**
- **Compensation: 2 points**

This is an initial calibration policy, not an immutable preference judgment. The weights may be tuned after controlled test runs reveal how the score behaves across real JDs. Every adjustment must create a new versioned scoring table; accepted results retain the policy version under which they were produced and must not change invisibly.

The family budgets are caps, not invitations to add every positive atomic at full value. Repeated atomics describing one underlying fact must not dominate a family merely because the question bank is intentionally comprehensive. The within-family policy must use bounded dimensions, tier selection, or capped additive contributions.

The private below-$60,000 compensation rule remains a separate rejecting controller rule and is not part of the 2-point compensation budget.

## Approved 30-point travel cascade

The travel score is the sum of three bounded dimensions. Only the highest supported tier within each dimension counts. Overlapping answers within one dimension do not stack.

| Dimension | Maximum points |
|---|---:|
| Geographic reach | 15 |
| Travel intensity | 10 |
| Field engagement | 5 |
| **Maximum travel score** | **30** |

### Geographic reach — maximum 15 points

| Highest supported travel scope | Points |
|---|---:|
| International or global | 15 |
| United States and Canada or broader North America | 12 |
| National travel within the United States | 10 |
| Multistate or regional | 7 |
| Assigned territory, local, or metropolitan | 4 |
| Travel required, but geography unsupported | 2 |
| No travel required or travel unsupported | 0 |

International and global are the highest tier. A JD supporting both still receives 15 points, not 30.

### Travel intensity — maximum 10 points

When the JD supplies a deterministically usable percentage:

| Supported travel amount | Points |
|---|---:|
| 50% or more | 10 |
| 30–49% | 8 |
| 20–29% | 6 |
| 10–19% | 4 |
| 1–9% | 2 |
| 0% or explicitly no travel | 0 |

When only qualitative language is available:

| Highest supported description | Points |
|---|---:|
| Frequent travel | 8 |
| Periodic travel | 5 |
| Travel as needed | 3 |
| Occasional travel | 2 |
| Travel required with no frequency | 1 |
| No travel or unsupported | 0 |

Deterministic percentage rules:

- A single unqualified percentage uses that percentage.
- `At least X%` uses X as the supported minimum.
- A bounded range uses its lower bound.
- `Up to X%` receives one tier below the tier containing X, with a minimum of 1 point.
- Numeric evidence takes precedence over qualitative wording; numeric and qualitative intensity do not stack.
- The LLM performs none of this math. The script derives the tier from the validated exact source text.

Examples:

- `50% travel` produces 10 intensity points.
- `25–40% travel` produces 6 intensity points.
- `up to 50% travel` produces 8 intensity points.
- `up to 25% travel` produces 4 intensity points.
- `frequent travel` without a percentage produces 8 intensity points.

### Field engagement — maximum 5 points

| Highest supported engagement characteristic | Points |
|---|---:|
| Recurring in-person engagement with customers or partners | 5 |
| Customer- or partner-site travel, external meetings, business reviews, implementations, training, or technical fieldwork | 4 |
| Field-based, remote-with-travel, home-based-with-travel, overnight travel, or air travel | 3 |
| Conferences, trade shows, company events, or internal team travel | 2 |
| Travel required but purpose unsupported | 1 |
| No supported travel or field engagement | 0 |

Only the highest supported engagement tier counts. For example, recurring partner visits that also require air and overnight travel receive 5 engagement points, not 11.

### Travel-score examples

| Supported JD evidence | Reach | Intensity | Engagement | Total |
|---|---:|---:|---:|---:|
| 50% international travel with recurring customer visits | 15 | 10 | 5 | **30** |
| Frequent international travel for customer meetings | 15 | 8 | 4 | **27** |
| 50% national travel to customer sites | 10 | 10 | 4 | **24** |
| 25% regional travel with overnight stays | 7 | 6 | 3 | **16** |
| Occasional local customer visits | 4 | 2 | 4 | **10** |
| Travel required with no supported scope, frequency, or purpose | 2 | 1 | 1 | **4** |
| No travel required | 0 | 0 | 0 | **0** |

The full 30 points are reachable only through substantial international or global travel with recurring external engagement. Heavy national and regional travel remain meaningfully positive without equaling the top international tier.

## Delegated 30-point commercial-motion table

Joe delegated the detailed initial point mapping to Codex with the direction that channel sales and channel-led work must sit at the top and other motions must cascade downward. The commercial score is the sum of four bounded dimensions.

| Dimension | Maximum points |
|---|---:|
| Preferred route-to-market orientation | 12 |
| Channel operating depth | 8 |
| Account and lifecycle alignment | 6 |
| Commercial accountability | 4 |
| **Maximum commercial-motion score** | **30** |

### Preferred route-to-market orientation — maximum 12 points

Only the highest supported tier counts.

| Highest supported commercial orientation | Points |
|---|---:|
| Owns the overall channel function or network, or supports at least four distinct channel domains including explicit channel-performance ownership | 12 |
| Builds, establishes, recruits, launches, or scales a channel, partner, reseller, distributor, dealer, alliance, or ecosystem motion | 10 |
| Manages or materially grows an existing partner, reseller, distributor, dealer, alliance, or ecosystem network | 8 |
| Directly onboards, enables, activates, or co-sells with partners as a substantive role responsibility | 6 |
| Owns or grows strategic, key, named, national, global, or enterprise customer accounts | 5 |
| Owns customer success, adoption, retention, renewals, value realization, or account expansion | 4 |
| Performs technical, solution, or consultative selling | 3 |
| Performs a balanced direct-sales and existing-account motion | 2 |
| Performs generic direct sales, demand generation, marketing partnerships, sales operations, or sales enablement without a more preferred supported motion | 1 |
| No supported commercial motion | 0 |

Primary direct hunting and primary inside sales remain Stage 1 rejecting conditions. They are not rewarded here merely because the role also contains generic commercial language.

### Channel operating depth — maximum 8 points

The script counts distinct supported channel responsibility domains, not synonymous questions or repeated JD wording.

The five domains are:

1. **Build or recruit:** creates the program or recruits partners, resellers, distributors, dealers, or alliances.
2. **Onboard or enable:** activates, trains, equips, certifies, or enables the indirect network.
3. **Co-sell or generate pipeline:** works opportunities jointly or owns partner-sourced or partner-influenced pipeline.
4. **Manage or grow:** owns ongoing partner relationships, productivity, engagement, or network growth.
5. **Own performance:** owns channel revenue, partner-sourced revenue, bookings, sales performance, or another defined channel outcome.

| Number of distinct supported domains | Points |
|---|---:|
| All 5 | 8 |
| 4 | 7 |
| 3 | 5 |
| 2 | 3 |
| 1 | 1 |
| 0 | 0 |

Multiple atomics supported by the same underlying responsibility count as one domain. For example, one sentence about enabling and training resellers contributes one onboard-or-enable domain, not two.

### Account and lifecycle alignment — maximum 6 points

Only the highest supported tier counts.

| Highest supported account or lifecycle motion | Points |
|---|---:|
| Owns ongoing relationships plus expansion, renewal, retention, adoption, or value realization across a substantial portion of the post-sale lifecycle | 6 |
| Owns account growth, upsell, cross-sell, broader expansion, renewals, retention, or churn reduction | 5 |
| Owns ongoing account management, customer success, adoption, customer health, or value realization | 4 |
| Owns onboarding, implementation, deployment, customer training, ongoing support, or post-sale technical advising | 3 |
| Performs consultative pre-sale discovery, demonstrations, solution evaluation, business-case development, or solution design | 2 |
| Performs acquisition, lead generation, qualification, or outbound prospecting without a supported ongoing-account motion | 1 |
| No supported customer or account lifecycle responsibility | 0 |

End-to-end lifecycle ownership requires explicit evidence spanning both acquisition or pre-sale work and post-sale growth, retention, or renewal. Disconnected lifecycle bullets do not receive the top tier unless the role's responsibility across the span is supported.

### Commercial accountability — maximum 4 points

Only the highest supported tier counts.

| Highest supported accountability | Points |
|---|---:|
| Owns channel revenue, partner-sourced revenue, indirect-network performance, or a defined partner productivity outcome | 4 |
| Owns individual revenue, bookings, quota, recurring revenue, account growth, renewal, retention, market-share, territory-growth, or comparable commercial outcomes | 3 |
| Shares a team target or owns pipeline, forecasting, conversion, sales-cycle, launch, or customer-outcome metrics | 2 |
| Reports commercial performance, negotiates commercial terms, or contributes to a defined commercial metric without owning the result | 1 |
| No supported commercial accountability | 0 |

Reporting a metric does not become ownership merely because the metric is commercially important. Channel outcomes receive the top tier because they align with Joe's preferred motion, but repeated channel metrics still produce no more than 4 accountability points.

### Commercial-motion examples

| Supported JD pattern | Orientation | Channel depth | Lifecycle | Accountability | Total |
|---|---:|---:|---:|---:|---:|
| Owns a channel program, recruits and enables partners, co-sells, manages partner growth, owns partner revenue, and supports expansion | 12 | 8 | 5 | 4 | **29** |
| Builds a new reseller network, onboards partners, and owns reseller performance | 10 | 5 | 0 | 4 | **19** |
| Manages strategic partners and co-sells but has no explicit channel target | 8 | 3 | 0 | 0 | **11** |
| Owns strategic enterprise accounts, renewals, expansion, and an individual revenue target | 5 | 0 | 6 | 3 | **14** |
| Owns customer success, adoption, retention, and renewals | 4 | 0 | 6 | 3 | **13** |
| Performs technical discovery and demonstrations with a quota | 3 | 0 | 2 | 3 | **8** |
| Generic direct sales with an individual quota | 1 | 0 | 1 | 3 | **5** |

The commercial table intentionally creates a large separation between a deep channel role and a generic direct-sales role. Distinct channel responsibilities add value, while duplicate descriptions are capped.

## Delegated 25-point building-and-autonomy table

The building-and-autonomy score rewards the magnitude of the building mandate, the role's actual decision authority, and the leverage of what it creates. Explicit prescribed-work constraints reduce the result. The final family score is bounded from 0 through 25.

| Component | Maximum effect |
|---|---:|
| Building magnitude | +12 |
| Decision authority and autonomy | +8 |
| Organizational leverage | +5 |
| Explicit constraint adjustment | 0 to −8 |
| **Allowed building-and-autonomy score** | **0–25** |

Formula:

```text
building_score = max(0, building_magnitude + authority + leverage - highest_constraint)
```

Only the highest tier in each positive dimension counts. Only the single highest supported constraint applies; constraints do not stack.

### Building magnitude — maximum 12 points

| Highest supported building mandate | Points |
|---|---:|
| Founding role, first hire for the function, from-scratch function creation, or greenfield ownership | 12 |
| Builds or establishes a new team, program, capability, territory, market, book, channel, customer-success function, account-management function, or technical-sales function | 10 |
| Launches, redesigns, transforms, turns around, or substantially restructures an existing program, function, motion, or customer journey | 8 |
| Scales or expands an existing function, program, territory, operating model, market, region, product, or customer segment | 6 |
| Creates organizational playbooks, frameworks, methodologies, workflows, operating standards, systems, tools, templates, or reusable assets | 4 |
| Improves an existing process, experiments with new approaches, or independently creates solutions to identified problems | 2 |
| No supported building or improvement mandate | 0 |

A startup, new product, or entrepreneurial culture does not create building points unless the role itself receives the mandate.

### Decision authority and autonomy — maximum 8 points

| Highest supported authority | Points |
|---|---:|
| Sets strategy or the operating model and has explicit authority over budget, resources, investments, vendors, or final decisions | 8 |
| Defines how the function or program operates, establishes goals or priorities, or has authority to change material processes or operating methods | 6 |
| Chooses the approach, makes independent decisions, or has authority to redesign the sales process, customer journey, or partner experience | 4 |
| Operates with limited day-to-day direction or independently executes a defined mandate | 2 |
| Provides recommendations, feedback, or influence without supported decision authority | 1 |
| No supported autonomy or decision authority | 0 |

Working with founders or executives does not increase this dimension unless the JD assigns the role actual influence or authority.

### Organizational leverage — maximum 5 points

| Highest supported reach of the created work | Points |
|---|---:|
| Creates practices, systems, or operating standards adopted company-wide or across multiple business units or geographic regions | 5 |
| Creates reusable assets or processes used by multiple teams or leads a cross-functional transformation | 4 |
| Builds or materially redesigns a team, function, program, channel, or operating model used by others | 3 |
| Builds or scales a territory, market, account portfolio, or customer segment | 2 |
| Improves primarily the role's own execution or local workflow | 1 |
| No supported organizational leverage | 0 |

### Explicit constraint adjustment — maximum deduction 8 points

Only an explicit `yes` to the limiting characteristic activates a deduction. Silence about autonomy creates no deduction.

| Highest supported constraint | Deduction |
|---|---:|
| Primarily executes a prescribed playbook or standardized process with explicitly limited authority to change it | −8 |
| Inherits a mature program with established processes and explicitly limited authority to change them | −6 |
| Primarily maintains an existing book of business without a stated building, transformation, or expansion mandate | −5 |
| No supported limiting condition | 0 |

The constraint adjustment cannot make the family score negative. A role may legitimately contain both a building mandate and mature-process constraints; in that case the supported positive dimensions remain, and the single strongest constraint reduces them.

### Building-and-autonomy examples

| Supported JD pattern | Build | Authority | Leverage | Constraint | Total |
|---|---:|---:|---:|---:|---:|
| Founding function leader sets strategy and budget and creates company-wide standards | 12 | 8 | 5 | 0 | **25** |
| Builds a new channel program, defines its operating model, and creates reusable cross-functional processes | 10 | 6 | 4 | 0 | **20** |
| Transforms an existing customer-success program and independently redesigns the customer journey | 8 | 4 | 3 | 0 | **15** |
| Scales an established territory with limited day-to-day direction | 6 | 2 | 2 | 0 | **10** |
| Creates playbooks but must execute within a mature program with limited change authority | 4 | 0 | 4 | −6 | **2** |
| Primarily maintains an existing book under a prescribed process | 0 | 0 | 0 | −8 | **0** |

## Delegated 13-point supporting-characteristics table

The supporting-characteristics budget recognizes valuable role qualities without allowing them to outweigh channel motion, travel, or building and autonomy. The score is the sum of four bounded dimensions.

| Dimension | Maximum points |
|---|---:|
| Leadership and organizational influence | 4 |
| Technical and solution depth | 4 |
| Account, market, and organizational scale | 3 |
| Product and problem alignment | 2 |
| **Maximum supporting-characteristics score** | **13** |

Only the highest supported tier within each dimension counts.

### Leadership and organizational influence — maximum 4 points

| Highest supported leadership characteristic | Points |
|---|---:|
| Manages managers or employees and has material hiring, budget, strategy, or executive decision responsibility | 4 |
| Leads cross-functional, customer-facing, partner-facing, or external teams and owns material decisions | 3 |
| Regularly advises executives, serves as a subject-matter authority, coaches or trains others, or shapes go-to-market or product priorities | 2 |
| Coordinates stakeholders, represents the customer or partner internally, or influences work without supported leadership authority | 1 |
| No supported leadership or organizational influence | 0 |

Direct people management is not required to score well, but ordinary collaboration alone does not exceed 1 point.

### Technical and solution depth — maximum 4 points

| Highest supported technical involvement | Points |
|---|---:|
| Owns hands-on architecture, APIs, integrations, data migration, configuration, deployment, coding, infrastructure, proofs of concept, security review, or technical authority | 4 |
| Conducts technical discovery, requirements translation, solution design, technical validation, troubleshooting, or architecture review | 3 |
| Delivers or customizes demonstrations, technical workshops, technical training, questionnaires, documentation, or technical presentations | 2 |
| Coordinates technical teams or communicates field feedback to product or engineering without deeper supported technical execution | 1 |
| No supported technical or solution involvement | 0 |

Several atomics describing one implementation or proof of concept still produce no more than 4 points in this dimension.

### Account, market, and organizational scale — maximum 3 points

| Highest supported scale | Points |
|---|---:|
| Global, international, multi-region, global-account, or comparably broad and complex strategic responsibility | 3 |
| National, North American, multistate, regional, enterprise, public-sector, national-account, multi-location, or explicitly high-value complex-account responsibility | 2 |
| Defined territory, vertical, named-account set, portfolio, book, key accounts, strategic accounts, mid-market, SMB, or another explicit bounded scope | 1 |
| No supported account, market, or organizational scope | 0 |

The company's footprint does not establish the role's scope, and travel geography does not create account-scope points.

### Product and problem alignment — maximum 2 points

| Highest supported product or problem characteristic | Points |
|---|---:|
| Artificial intelligence, machine learning, generative AI, agentic automation, cybersecurity, identity or access management, physical AI, robotics, autonomous technology, or intelligent hardware is central to the offering | 2 |
| Data infrastructure, analytics, observability, cloud infrastructure, developer tooling, enterprise workflow automation, or another explicitly mission-critical or technically complex enterprise technology is central to the offering | 1 |
| Other product or industry characteristic, or product alignment unsupported | 0 |

The 0-point tier is neutral, not a rejection. Product categories handled by deterministic local exclusions remain outside this table.

### Supporting-characteristics examples

| Supported JD pattern | Leadership | Technical | Scale | Product | Total |
|---|---:|---:|---:|---:|---:|
| Leads a global cross-functional technical program for an AI platform with hands-on architecture responsibility | 3 | 4 | 3 | 2 | **12** |
| Advises executives, conducts technical discovery, and owns national enterprise accounts for cloud software | 2 | 3 | 2 | 1 | **8** |
| Coordinates internal teams for a defined account portfolio with no technical work | 1 | 0 | 1 | 0 | **2** |
| No supported characteristic in these dimensions | 0 | 0 | 0 | 0 | **0** |

## Delegated 2-point compensation table

The compensation budget applies only to jobs that survive the private compensation-floor rule. It is deliberately too small to outweigh any meaningful difference in commercial motion, travel, or building and autonomy.

### Comparable annual compensation selection

The script selects one deterministically comparable annual cash value using this precedence:

1. Explicit annual OTE.
2. Explicit annual total cash compensation.
3. Explicit annual total compensation when the included cash components are deterministically comparable and equity or non-cash value is not being treated as cash.
4. Explicit annual base salary when no comparable total or OTE is available and no unquantified commission, bonus, variable compensation, or uncapped upside prevents the base from establishing maximum comparable annual cash.
5. Deterministically annualized fixed hourly, weekly, or monthly pay under the same condition, when the role is full-time and the source supports that interpretation.

When an applicable range is supplied, the script uses its maximum for both the below-floor rule and this minimal preference table. A Minnesota-specific range controls for a Minnesota-based role. Otherwise, a clearly applicable role-location range controls. Ambiguous multiple-location ranges remain non-comparable.

Versioned annualization constants are:

| Pay period | Annualization rule |
|---|---:|
| Hourly full-time pay | hourly amount × 2,080 |
| Weekly pay | weekly amount × 52 |
| Monthly pay | monthly amount × 12 |
| Annual pay | no conversion |

Overtime, discretionary bonuses, uncapped upside, equity, benefits, and unquantified variable compensation are not invented or added. Any currency conversion must use the fixed conversion table stored in the applicable scoring-policy version, not a live exchange rate.

An explicit base or fixed-pay maximum below $60,000 does not kill the job when the JD also establishes unquantified commission, bonus, variable compensation, or uncapped upside that could bring annual cash compensation to or above the floor. In that case maximum total cash is non-comparable, the floor fails open, and compensation contributes 0 points. Conversely, explicit base or fixed pay at or above $60,000 is sufficient to prove that maximum annual cash is not below the floor even when additional upside is unquantified; the conservative base or fixed-pay value may then be used for the 1- or 2-point preference tier.

### Compensation points

| Maximum comparable annual cash compensation | Points or consequence |
|---|---:|
| Explicitly below $60,000 USD | **Kill job; no Aim score** |
| $60,000–$99,999.99 USD | 1 |
| $100,000 USD or more | 2 |
| Missing, undisclosed, ambiguous, or non-comparable | 0 |

Exactly $60,000 survives and receives 1 point. A base salary below the floor does not kill the job when a higher explicit and comparable OTE or total-cash figure controls under the precedence rules.

## Atomic-to-score routing table

The scoring script works from the validated atomic answer vector and exact evidence. It must not rescan the JD to invent new semantic features. The following table defines which approved atomic families supply each bounded dimension.

| Score dimension | Primary approved atomic sources | Routing rule |
|---|---|---|
| Commercial orientation | Families 1–5 and Family 7's explicit channel-building atomic | Select the highest tier whose required activities, ownership, or combination of channel domains is validated |
| Channel depth | Family 1 partner/channel activities; Family 2 partner relationships; Family 5 partner outcomes; Family 7 channel-program building | Map validated atomics into the five named domains, deduplicate within each domain, then count domains |
| Account and lifecycle alignment | Family 1 account and post-sale activities; Family 2 managed relationships; Family 3 lifecycle; relevant Family 5 outcomes | Select the highest lifecycle tier supported by the combined validated facts; do not infer end-to-end ownership without the explicit end-to-end atomic or equivalent validated span |
| Commercial accountability | Family 5 outcomes, plus Family 1 commercial terms or operations where applicable | Select the highest supported ownership tier; reporting or contribution cannot be promoted to ownership |
| Building magnitude | Family 7 building, launching, redesigning, transforming, scaling, expanding, creation, and experimentation atomics | Select the highest supported magnitude tier |
| Decision authority and autonomy | Family 7 authority and autonomy atomics, supplemented by Family 8 decision-authority atomics | Select the highest supported authority tier; influence without authority remains at its lower tier |
| Organizational leverage | Family 7 reusable-asset, cross-team, program, function, territory, and market atomics; relevant Family 8 organization-wide adoption atomics | Select the highest supported reach of the created work |
| Building constraint | Family 7 mature-program, prescribed-playbook, and maintenance-without-building atomics | Apply only the single highest validated deduction |
| Leadership and influence | Family 8 | Select the highest supported leadership tier |
| Technical and solution depth | Family 6 | Select the highest supported technical tier |
| Account, market, and organizational scale | Family 4, supplemented by Family 8 multi-unit or multi-region influence | Select the highest supported scope tier; travel geography cannot supply this dimension |
| Product and problem alignment | Family 9 | Select the highest supported preferred product/problem tier |
| Compensation | Family 10 | Apply deterministic value selection and normalization, then the floor and 0–2 point table |
| Travel reach, intensity, and engagement | Family 11 | Route each validated travel fact to its one applicable dimension and select the highest tier in that dimension |

An atomic may legitimately inform more than one concept only where the routing table explicitly permits it. Caps prevent cross-family evidence from producing more than the approved component maximum. No point value is attached to the model-facing question itself.

## Delegated result-state and final-score tables

Hard-stop results and weighted scores are different result types. A job killed by controller policy does not receive a numeric zero, because zero would falsely imply that the complete Stage 2 preference score was calculated.

### Result-state precedence

| Precedence | Condition | Result state | Numeric Aim score |
|---:|---|---|---:|
| 1 | Any validated Stage 1 rejecting answer is present | Killed by factual screen | None |
| 2 | Stage 1 passes, but maximum comparable annual compensation is explicitly below $60,000 USD | Killed by compensation floor | None |
| 3 | No rejecting condition is established | Scored survivor | 0–100 |

For a Stage 1 kill, the separate Stage 2 question packet is never dispatched. For a compensation-floor kill, the Stage 2 factual extraction may already exist because compensation is part of that packet, but the controller stops before compiling or presenting a final numeric Aim score.

### Survivor score formula

| Component | Allowed score |
|---|---:|
| Commercial motion | 0–30 |
| Travel | 0–30 |
| Building and autonomy | 0–25 |
| Supporting characteristics | 0–13 |
| Compensation | 0–2 |
| **Final Aim score** | **0–100** |

```text
aim_score = commercial_score
          + travel_score
          + building_score
          + supporting_score
          + compensation_score
```

Every component is calculated by deterministic table lookup from the validated factual vector. The LLM never sees or produces component scores, deductions, totals, bands, or result states.

### Initial survivor score bands

| Final Aim score | Initial band | Meaning |
|---:|---|---|
| 85–100 | Exceptional Aim fit | Strong evidence across all or nearly all dominant preference pillars |
| 70–84 | Strong Aim fit | Strong alignment across multiple dominant pillars with few material gaps |
| 55–69 | Good Aim fit | Meaningful alignment, but one dominant pillar may be weaker or unsupported |
| 40–54 | Mixed Aim fit | Some desirable characteristics, but substantial preference gaps remain |
| 0–39 | Low Aim fit | Limited evidence of the preferred channel, travel, and building profile |

These bands describe the initial weighted result; they are not additional hard stops. Only the separately approved controller rules kill a job. Band boundaries may be tuned after calibration, but any change requires a new scoring-policy version.

## Controlled calibration procedure

The initial weights are intentionally a starting point. Calibration evaluates whether they produce the intended ranking across real JDs without changing the evidence questions or allowing model judgments to become scores.

### Calibration corpus

Use a stable, versioned set of representative JDs that includes at least:

- an international or global channel-building role;
- a high-travel domestic channel-management role;
- a channel-enablement or partner-co-selling role;
- a strategic or national account-growth role;
- a customer-success, renewal, and expansion role;
- a technical or solution-consulting role;
- a generic direct-sales role that survives the factual screen;
- an established-book role with explicitly limited building authority;
- a high-compensation role with little travel, channel work, or autonomy;
- a below-floor role that must be killed;
- a role with missing or ambiguous compensation that must fail open;
- JDs containing overlapping or repeated descriptions of the same underlying responsibility.

The corpus, original JD bytes, trusted metadata, expected factual answers, and policy version must be preserved so later runs are comparable.

### Required ranking invariants

The initial table is behaving directionally only if these controlled comparisons hold when all other facts are equal:

1. A comprehensive channel owner scores above a generic direct-sales role.
2. A channel builder scores above a role that merely interacts with partners.
3. International or global travel scores above national travel at the same intensity and engagement level.
4. National travel scores above regional travel, and regional travel scores above local travel, at the same intensity and engagement level.
5. Higher supported travel intensity scores above lower intensity within the same scope.
6. A founding, greenfield, or new-function builder with decision authority scores above prescribed execution in a mature process.
7. A higher salary changes a surviving job by no more than 2 points.
8. Missing or ambiguous compensation does not kill the job.
9. An explicitly comparable maximum below $60,000 kills the job and produces no numeric Aim score.
10. Repeating synonymous atomics for one underlying fact does not increase a capped dimension.
11. The same accepted factual vector and same scoring-policy version always produce the same component scores, total, band, and result state.

### Fresh-model stability checks

Production repeatability comes from evaluation identity, accepted-result reuse, and deterministic scoring. Forced fresh model reruns are a calibration test rather than the production path.

For calibration:

1. Run at least three independent fresh factual extractions for each corpus JD.
2. Compare atomic answer agreement, exact supporting excerpts, hard-stop decisions, component scores, and final scores.
3. Investigate disagreements at the atomic and evidence level before changing weights.
4. Repair an ambiguous atomic or its boundary only when a concrete recurring failure is demonstrated.
5. Do not average several model-generated scores. Once a factual vector is accepted, the deterministic table produces the only score for that evaluation identity and policy version.

### Weight-tuning controls

- Tune weights from ranking errors across the corpus, not because an isolated number feels aesthetically wrong.
- Change the smallest applicable tier, cap, or band boundary that repairs the demonstrated ranking problem.
- Do not change factual answers to obtain a preferred score.
- Do not let one test company or one unusually written JD dictate a global weight change.
- Re-run the complete fixed corpus after every proposed table change.
- Record the old value, new value, reason, affected invariant, corpus results, and approval for every accepted change.
- Every accepted change creates a new immutable scoring-policy version and a new evaluation identity.
- Historical scored results retain their original policy version. Re-scoring is explicit, never silent.

## Design completion status

The factual screens, Stage 2 question bank, evidence semantics, hard-stop consequences, initial 100-point budget, all bounded scoring tables, result states, score bands, and calibration procedure are now defined in this scratchpad.

This remains design only. No scoring code, prompt, schema, runner, import, database, production state, commit, push, or deployment has been changed. The next artifact, when Joe requests it, should be a separate implementation plan derived from this approved design rather than additional scoring-table discussion.
