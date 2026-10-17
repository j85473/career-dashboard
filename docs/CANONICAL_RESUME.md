# Canonical resume authority

Joseph explicitly designated the completed **Channel Business Manager resume** as canonical on September 23, 2026. On October 15, 2026, he approved three refinements to that canon: partner onboarding/training ownership, B2B launch/coaching, and Sara+ retention/platform ownership. That revision contained only those three wording changes; the additional national-partner pilot was excluded. It supersedes the previous Dashboard resume and the September 8 Channel Account Management working derivative for future resume, tailoring, application-answer, and Experience Fit work.

On October 17, 2026, Joe designated the newly supplied resume as canon and requested the previous DOCX/PDF pair be archived. This version changes only the two DSI introduction lines: the company line adds “AT&T Channel Sales & Partner Enablement,” and the role line reads “Channel Account Management (official title: Field Sales Representative) | MN / WI / IA / SD.” All twelve bullets and the scope paragraph are unchanged from the October 15 canon.

## Controlling files

- Dashboard machine copy: `data/resumes/JosephLamb_Resume.docx`. Keep this stable filename; its contents are the new one-page resume.
- Human-facing DOCX: `/Users/JosephLamb/Desktop/Quick access job/Joseph Lamb Channel Business Manager Resume.docx`.
- Matching PDF: `/Users/JosephLamb/Desktop/Quick access job/Joseph Lamb Channel Business Manager Resume.pdf`.
- DOCX SHA-256: `59e93946815686f11f40bbe9c44382f87a43afec36f4f1ffa8384f78cef95e5c`.
- PDF SHA-256: `6dfaf6f558b1207c5840896fb0e3a2fb3079d8ba3701eb2bcded96533e427c17`.
- Canonical factual inventory remains `docs/Candidate_Evidence_Inventory_-_Core_v1.md`. This promotion does not modify its claims or hash.

The DOCX has one page, a single column, the normally capitalized name **Joseph Lamb**, and twelve separate native unordered bullets. Its approved wording, reading order, PDF extraction, and final rendered page were verified before promotion. This is document-level verification, not a live Workday parsing result.

## Approval record and supersession

The original 22-entry implemented approval register, the three October 15 refinement approvals, and October 17 promotion receipt are in:

- `/Users/JosephLamb/Desktop/Quick access job/Resume Rewrite Notes/Canonical_Resume_Channel_Build_and_Scale_Tailoring_Scratchpad.md`
- `/Users/JosephLamb/Desktop/Quick access job/Resume Rewrite Notes/Canonical_Resume_Channel_Build_and_Scale_Evidence_Scratchpad.md`

Joseph's promotion instruction was: “add the docx and pdf version to the quick job access folder ... update the dashboard and whatever else needs the canon resume ... set in the notes ... that this is the canon resume.” This explicitly supersedes earlier derivative-only designations and assembly-only restrictions. Older decisions, artifacts, prior applications, and scoring exports remain historical records; do not rewrite them as though they used this version.

## Claim boundaries

- **Field Sales Representative** is the official DSI title. “Channel Account Management” is the functional descriptor; “Channel Business Manager” is the resume positioning headline.
- The approximate **~$26M annualized AT&T subscriber revenue** is a derived subscriber-service run rate across national retail, D2D, and B2B. It is not recognized DSI revenue, SaaS ARR, a direct accounting total, or P&L ownership. The 156% net-add growth remains national-retail-only.
- **$3.1M+ annualized commissions** describes recovery for one distributor; the follow-up process subsequently scaled across the distributor portfolio.
- **100% account retention** concerns Sara+ distributor accounts; it does not mean revenue retention or retention of every individual user.
- The broad ten-year sales/partner-development summary includes earlier Target Mobile experience confirmed in the approval record. No invented dates or extra role should be added.
- Partner leadership does not establish direct reports, partner recruiting/signing, cybersecurity implementation, or formal SaaS renewal ownership.

## Prospective scoring use

The repository and deployed machine copy must be byte-identical to the approved DOCX. `currentScoringInputVersions()` and Experience export assembly read this file; the canonical artifact check is pinned to its approved SHA-256. The application resume cache refreshes on release activation.

This change applies to future work. Existing scores, score events, rationales, lifecycle decisions, submitted resumes, and completed scoring artifacts retain their authority. Do not invalidate or rescore them because the resume hash changed. Old exported batches retain their original evidence binding; obtain a fresh export if a future run needs the new resume rather than altering an old batch's hash.

## October 15 refinement and local synchronization

The DOCX and matching PDF were rendered and visually inspected as one page. Exact-text checks confirm only the three approved paragraphs changed; the other 26 paragraphs, including the general headline/summary/competencies and partner-accountability story, remain unchanged. All twelve native bullets, fonts and page geometry are preserved. Small paragraph-spacing adjustments keep the revised text on one page. Prior DOCX/PDF versions are preserved under `/Users/JosephLamb/Desktop/Quick access job/Expired Resumes/Canonical before 2026-10-15/`.

At that delivery, local copies were synchronized: Quick access DOCX/PDF, Desktop DOCX/PDF, Tailored Resumes general DOCX, Claude handoff DOCX, standalone-runtime canonical DOCX, and the repository machine copy. This paragraph records the October 15 delivery; current copies and hashes are described above and below.

## October 17 introduction update and local synchronization

The supplied DOCX was moved from Desktop into Quick access job under the stable human-facing filename. Its bytes are preserved. The previous canonical DOCX and PDF are archived in `/Users/JosephLamb/Desktop/Quick access job/Expired Resumes/Canonical before 2026-10-17/`; their hashes remain `4a1c767b29a5647dcf02c0ad0c9b6dbfd34b57b1cb74b642733103703ee9b264` and `825223f48e8e05517ca31d6c56e59bd6f42aca2e0888899f9f02c087bd0273fb`, respectively.

A matching PDF was generated from the supplied DOCX. The rendered page was visually inspected and the PDF text matches the DOCX after whitespace and bullet normalization. Both are one page. The other 27 paragraphs, including all twelve native bullets, are unchanged; only the two DSI introduction paragraphs differ from the previous canon.

Current local copies are synchronized: Quick access DOCX/PDF, Tailored Resumes general DOCX, Claude handoff DOCX, standalone-runtime canonical DOCX, and the repository machine copy. The Dashboard's approved-byte assertion and regression expectation match the new DOCX. Its formal-title check accepts the explicit parenthetical title in the approved layout. Core Evidence, scoring policies, historical application artifacts, role-family manifests and completed exports remain unchanged. No database writes or rescoring are part of this promotion. Validation passed 29 focused resume-binding, evidence, export-contract, score-authority and prospective-change checks; current Experience input versions read the new resume hash. Git diff whitespace check passed.

Release scope: this change records the approved local refinement and prepares it for deployment. Local synchronization or a Git commit does not establish production activation; M70 uses its previously deployed resume until a release containing this change is activated. Existing scores retain their authority throughout that transition.
