# Commercial discovery: first implementation

Implemented and validated locally on September 6, 2026. Not committed, pushed,
or deployed. The purpose is to bring more territory, distributor, dealer, and
retail-account opportunities into review following the application audit.

## What changes

- Add eight title searches to the primary, paid, and CareerForce portfolios:
  territory account manager, distributor account manager, distributor business
  manager, wholesale account manager, retail account manager, retail business
  manager, manufacturer sales representative, and dealer account manager.
- Add six description searches: assigned accounts with territory; retail partners
  with sales; independent retailers; distributor relationships; product training
  with dealers; and territory growth with existing accounts. These use providers
  that search descriptions; title-only LinkedIn searches do not receive them.
- Give territory, distributor, and retail search families two turns per broader
  search turn when both have work in the same hour-wide due band. Older overdue
  work still goes first. Geography rotation, provider budgets, and task identity
  remain in place. This is an ordering preference, not a guaranteed two-thirds
  share of overall spend or completed requests. CareerForce now uses the same
  due-task ordering as the other scheduled discovery sources.
- Let recognizable commercial titles survive ambiguous roofing, veterinary,
  clinical, dental, and home-health industry words. Explicit care and trades
  occupations remain excluded, including mixed clinical/commercial titles.
- Recognize the newly searched retail/manufacturer titles. Generic sales
  representative titles need description evidence of account work plus an
  existing/assigned territory, account base, or distributor/dealer network.
  Subsequent hunter-heavy, operations-heavy, and location checks still apply.

These changes govern future discovery and early review eligibility. They do not
update stored jobs, restore dismissed jobs, rescore jobs, or change existing Aim
or Experience score authority, application history, or resumes.

## Read-only replay

The fixed replay included six interview-reference job descriptions from the
application audit and 300 dismissed/archived records. The latter were selected
from the 8,000 most recently updated dismissed/archived records, then filtered
for sales/account/distributor/retail/dealer/veterinary/roofing/clinical/wholesale/
manufacturer title vocabulary and bounded to 300. This is a targeted regression
sample, not a random estimate of the entire rejected population.

The comparison ran the prefilter, local heuristic gate, and metadata/location
triage on identical inputs before and after the implementation. Resume and
preference inputs were empty; no Aim or Experience model evaluation ran. No
database writes, rescoring, restoration, or pipeline run occurred.

| Cohort | Before: passes all replay gates | After: passes all replay gates |
| --- | ---: | ---: |
| Six interview-reference jobs | 5 | 6 |
| 300 dismissed/archived sample jobs | 99 | 100 |

The reference set covers Altria, Phillips, IKO, Citi, Tessco, and Bunzl. Bunzl's
Sales Representative - Processor role was previously rejected for lacking a
recognized target title. Its description now supplies the account/territory
evidence needed to reach review. The other five still pass.

The additional sample role is Statlab's Medical/Laboratory Sales Representative:
Northern CA. Its account duties now pass the title gate, but its stored location
is United States and the existing location helper does not recognize Northern
CA in the title. This is a known limit of these early gates: the role needs a
location rejection during Aim review. Passing this replay is not proof of job
suitability or Inbox admission.

Patterson's Territory Sales Representative - Dental in Fargo now survives the
occupation prefilter but remains rejected on geography. No previously passing
replay record becomes rejected. The 99 historical rejected records already
passing these checks may have other or older rejection reasons; this replay
does not authorize restoring them.

## Validation

- Full test suite: 1,375 passed, zero failed.
- TypeScript check and production build passed.
- Lint passed with three existing unused-variable warnings in unrelated files.
- Diff whitespace check passed.
- Added regression coverage for commercial industry exceptions, explicit care
  and trades exclusions, Bunzl-style account evidence, hunter/operations
  safeguards, expanded search catalogs, and weighted task ordering with overdue
  priority, geography coverage, future-task exclusion, and portfolio fallback.

Deployment is still required before production uses these changes. This replay
shows improved recognition of known roles; it does not yet establish improved
search yield or interview conversion. After rollout, compare new discoveries,
review acceptance, applications, and interview responses by search family over
matching application-age windows before deciding whether to increase the bias.
