# Employment agency rule alignment

Date: 2026-10-08

Status: Applied to the live M70 database and verified after the database commit.

## Authorized behavior

Joe explicitly allows employment and staffing agencies as employers. Employer
type alone must not reject a job. Each role still goes through the existing Aim
and Experience requirements.

The existing employment-type exclusion remains in effect for positions explicitly
described as part-time, temporary, contract, contract-to-hire, freelance, or 1099.
A provider's commercial contract with its client does not itself establish that
the employee's position has one of those employment types.

This decision is prospective. It does not reopen previously rejected jobs or
remove, invalidate, hide, requeue, or change existing scores or job statuses.

## Mismatch repaired

The governing Aim policy already allowed agency employers. Its first factual
question still rejects the excluded employment types:

- Policy: `data/scoring/aim-policy-v2.json`, where `S1.Q01` is an unconditional
  rejection when the source explicitly establishes the excluded employment type.
- Source question: `data/scoring/aim-question-registry-v2.json`, question `S1.Q01`.
- Historical policy decision: the August 12 scoring implementation plan explicitly
  removed staffing-company employment as a hard stop.

The Dashboard's older saved Context profile nevertheless retained the rejection
`roles from staffing companies.`, with a corresponding active typed rule.

The repair removed exactly that line from the global saved profile and retired
exactly the corresponding typed rule. The other saved rules and user preferences
were preserved. No scoring policy, prompt, question registry, application code,
or database schema change was needed.

## Durable database audit

The repair and its audit revision were committed in one database transaction at
`2026-10-08T19:18:21.454Z`.

| Evidence | Identity |
| --- | --- |
| Saved profile updated | `ContextProfile`, ID `global` |
| Staffing rejection retired | `ContextRule`, ID `1fd6ca85-32c2-4d6e-8ec9-c7a643d22a4f` |
| Before/after profile revision | `ContextRuleRevision`, ID `5b13d975-f58d-4c61-8cff-b52659f8639a` |
| Unique audit key | `explicit-user-rule-alignment:2026-10-08:employment-agencies-allowed` |

The retired rule retains its original provenance and an additional retirement
record identifying Joe's explicit instruction, employer eligibility, preserved
employment-type exclusions, and prospective scope. The original rejection and
the complete before/after profile remain available in the audit history.

## Verification

The exact repair first passed a transaction that rolled back. The subsequent
apply transaction verified preservation of lifecycle states, displayed scores,
and rationales for 2,539,248 jobs, plus score values and authority fields for
55,855 score events. It also checked that every unrelated typed rule and user
preference was unchanged before committing.

A fresh database connection confirmed that the saved profile no longer contained
the staffing-company ban, the corresponding rule was inactive, and the audit
revision's only text change was removal of that line. A separate read of the
deployed Aim policy confirmed that the employment-type rejection remained enabled
and that the policy contained no staffing-employer ban.

This is a record of an already-applied configuration repair. Reading this file or
deploying this commit does not authorize another database mutation or any job
recovery or rescoring.
