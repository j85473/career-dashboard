# ATS acquisition API expansion research

Prepared by Codex for Joe Lamb. Public-endpoint evidence verified October 8, 2026, America/Chicago. Implementation status updated October 9, 2026.

**The October 8 investigation verified 19 additional platform families with public jobs APIs or feeds on employer boards.** All 19 were absent from the schedulable board-adapter map at that research snapshot. Zoho Recruit was already in the map and is excluded from the 19. Seventeen candidates returned JSON; JazzHR and Homerun returned XML. Hireology and Cornerstone required anonymous tokens obtained from their public career pages. Full descriptions were present in the verified feeds or separate public detail responses.

Six of those candidates now have implemented adapters: Gem, JobScore, JazzHR, Manatal, ClearCompany, and HireHive. Their shared first-collection controls with Zoho Recruit were committed in `8c9bdb1` and are included in the M70 release activated October 9 (`abb29c4`, [verified deployment workflow](https://github.com/j85473/career-dashboard/actions/runs/37985647089)). The remaining 13 are research candidates. See the [implemented admission behavior](ATS_FIRST_COLLECTION_ADMISSION.md) for current rollout limits and permission rules. Deployment includes the capability; it does not establish that each provider has passed a production pilot or that waiting tenants have been admitted.

The saved public calls establish observed access on October 8. They were not repeated for this documentation update. API access does not establish how many new employers or suitable jobs an adapter would add.

## Acquisition scope: no additional aggregators

Joe confirmed that expansion must not add aggregators. The 19 verified paths serve employer or recruitment-agency career boards, rather than a general service collecting jobs from unrelated websites. Qualification applies to the specific tenant and endpoint; a vendor can support more than one publishing model.

**Getro is excluded from the expansion plan.** Its automated boards extract postings from company career sites and other job sites, as described in its [job-source explanation](https://help.getro.com/support/solutions/articles/65000170326-what-companies-should-know-about-getrojobs). SmartJobBoard, JobBoard.io, and Niceboard are job-board hosting products, not established employer ATS collection paths in this audit; they are also outside this ATS expansion scope. Hosting a job board does not by itself establish that every board is an aggregator.

**Crelate and Recruit CRM are recruitment ATS/CRM products.** The tested sources publish agency-managed job orders. They are not classified as general job aggregators, but agency attribution can differ from the actual hiring employer. See the vendors' [Crelate product description](https://www.crelate.com/) and [Recruit CRM product description](https://recruitcrm.io/).

**Phenom is an employer career-site layer.** The tested Cigna site displays Cigna's jobs and sends applications to Cigna's Workday tenant. That is an employer-controlled publishing path with source overlap, rather than a general aggregator. [Phenom's integration description](https://www.phenom.com/products/application-performance-monitoring) confirms its ATS synchronization model.

**DigitalRecruiters needs a per-posting provenance check.** All 40 downloaded Decathlon publications had `is_aggregated=false` and `is_external=false`, and identified `joinus.decathlon.fr` as their career domain. The public schema can describe other publication types, so future validation must retain those provenance fields and exclude aggregated records.

## Acquisition coverage: research snapshot and implemented status

The October 8 research snapshot exposed 20 schedulable families: Ashby, BambooHR, Breezy, Greenhouse, Eightfold, Dayforce, Oracle Cloud, UKG, Comeet, SuccessFactors, Lever, Personio, Pinpoint, Recruitee, Rippling, SmartRecruiters, Teamtailor, Workable, Workday, and Zoho Recruit. The current committed mapping contains 26, adding Gem, JobScore, JazzHR, Manatal, ClearCompany, and HireHive. The seven rollout providers remain subject to separate first-collection admission; a mapped adapter does not automatically release its discovered tenants.

The [current discovery mapping](../src/lib/atsBoardDiscovery.ts) determines which board families can enter scheduled acquisition. Detection of an ATS name alone does not provide a collector. For example, the checkout already recognizes Phenom, Paylocity, Avature, BrassRing, and several other labels without scheduling complete board acquisition for them. iCIMS detail retrieval and DEJobs matching are separate capabilities.

Existing separate job-search integrations such as Adzuna, USAJOBS, Himalayas, Remotive, RemoteOK, Arbeitnow, and Jobicy are outside the additional ATS count. This grouping describes the current implementation, not a claim that every one is an aggregator; USAJOBS is the federal government's job board.

## Verified additional collection paths

Counts describe records or totals reported by the public source at verification time. They include general applications where published, can overlap another source, and are not counts of imported jobs or jobs suitable for Joe. A reported total is distinguished from the number downloaded.

| Platform | Verified public source | Access and description path | Pagination evidence and integration consequence |
| --- | --- | --- | --- |
| **Gem** | Sennder, 30 records | Anonymous JSON listing with full HTML and plain descriptions; separate detail also succeeded. [Public API reference](https://api.gem.com/job_board/v0/reference). | The documented board list is unpaginated. Preserve its public job URL and tenant vanity name. |
| **JobScore** | Guidebook, 3; Unified, 3 | Anonymous JSON feed includes descriptions, locations, remote flags, and compensation fields. [Feed guide](https://support.jobscore.com/hc/en-us/articles/202001320-Developers-Guide-to-Job-Feed-APIs). | Whole feeds. Vendor guidance prefers daily polling and prohibits polling more frequently than hourly; enforce a provider-specific budget. |
| **JazzHR** | ExecRecruitment, 5; Bambooworks, 77 | Anonymous XML export includes full descriptions and public URLs. [Verified export](https://app.jazz.co/feeds/export/jobs/sbxgplusllc). | Whole feeds. Parse the XML structure even when the server labels it `text/html`. Retain custom-domain job URLs. |
| **Manatal** | Manatal, 33 across two pages | Anonymous career-page JSON includes full descriptions. [Public listing](https://www.careers-page.com/api/v1.0/c/manatal/jobs/?page_size=20&page=1). | 20 plus 13 records, with continuation metadata. A department value in `organization_name` must not become the employer. |
| **ClearCompany** | ClearCompany, 4 | Anonymous JSON listing and detail both succeeded. [Public client](https://careers-content.clearcompany.com/js/v1/career-site-no-polyfill.js?siteId=adc5441f-f521-a46d-ad4d-ad46a1954fcc). | Separate `pageIndex=0` and `1` requests with page size 1 returned different jobs. Extract the public site UUID from the employer's widget. |
| **Hireology** | Beach Chevrolet, 4 | Public page supplies an anonymous bearer token; JSON includes full job descriptions. [Employer board](https://careers.hireology.com/beachchevrolet). | Response supplies count, page, and page size. Larger-board pagination remains an adapter acceptance check. Refresh the public token when needed. |
| **Cornerstone OnDemand** | Interfor, 52; World Bank, 67 | Anonymous public-page JWT enables JSON search with `externalDescription`. [Public client](https://interfor.csod.com/player-career-site/1.25.6/pages/home.controls.js). | Entire boards verified: 25/25/2 and 25/25/17, with 52 and 67 unique requisition IDs. Tenant, regional API host, and career-site number are required. |
| **HireHive** | Redo, 15; MetroMart, 2 | A separately documented anonymous Jobs API includes full descriptions; exact detail succeeded. [Jobs API specification](https://redo.hirehive.com/openapi/v2.json). | Page 1 and page 2 at size 1 returned different IDs. Use the employer's Jobs API rather than its authenticated dashboard API or global jobboard endpoint. |
| **Phenom** | Cigna, 568 reported; 20 downloaded | Anonymous POST searches returned two distinct pages; POST detail returned the full description. [Employer search](https://jobs.thecignagroup.com/us/en/search-results). | Offset and size control pages. Phenom is a career-site layer; Cigna's application URL points to Workday. Measure overlap before claiming new coverage. |
| **Polymer** | Aboard, 3 | Official unauthenticated Public API; exact detail succeeded. [API reference](https://developer.polymer.co/), [employer API](https://api.polymer.co/v1/hire/organizations/aboard/jobs). | List supplies page metadata. The HTML board returned a challenge while the API worked; HTML access is not required for this collection path. |
| **Softgarden** | Softgarden, 7 | Anonymous Schema.org JSON feed with descriptions. The employer's `llms.txt` explicitly advertises it. [Feed declaration](https://softgarden.career.softgarden.de/llms.txt). | Full feed. This applies to the tested modern career-site family; legacy portals need separate validation. Public Frontend API v3 is another route requiring a public client ID. |
| **Flatchr** | Flatchr, 5 | Documented anonymous published-vacancy JSON contains description, mission, profile, location, and other structured fields. [Published listing API](https://developers.flatchr.io/en/docs/QuickStart/Annonces/Recuperer_les_annonces_actives/). | Full catalogue response. Combine the description sections in their source order and preserve the published public URL. |
| **TalentLyft** | TalentLyft, 1 general application | Anonymous JSON succeeded with `details=true`, including the description, although generated reference documentation marks Bearer authentication as required. [Public API reference](https://developers.talentlyft.com/public-api-reference/jobs). | Response supplies count and page links. Verify a second employer with specific vacancies before launch. Preserve general-application classification. |
| **Traffit** | Traffit, 2 | Official anonymous public integration API includes description sections. [Public API documentation](https://api.traffit.com/). | Header-based pagination verified with two distinct one-record pages. Job IDs are tenant-scoped. |
| **d.vinci** | Elis UK, 45 | Documented public JSON publication API includes introduction, tasks, profile, and benefits sections. [Publication API documentation](https://static.dvinci-easy.com/files/d.vinci%20job-publication-api.html). | Full publication list. Preserve locale and posting URL; publications are not automatically equivalent to unique requisitions. |
| **Homerun** | Homerun, 4 | Public Atom XML contains descriptions; three specific vacancies had about 7,900–8,900 description characters. [XML feed guide](https://help.homerun.co/en/articles/5013627-how-to-generate-an-xml-feed). | Follow the feed link advertised by the career page. The feed slug can differ from the board subdomain. |
| **Crelate** | Strategic Employment, 125 | Anonymous career-portal JSON includes descriptions; exact JSON detail succeeded. [Public client](https://jobs.crelate.com/dist/candidateportal/main.bundle.js?v=357bc699a81abd418f6c10a1fbe418168781e086). | `GetAllJobs` returned the entire observed list. Resolve the organization UUID from the public portal; keep agency and client-employer attribution separate. |
| **Recruit CRM** | Terra Careers, 6 | Anonymous public-career backend POST returned jobs with full text in `jdtext`. [Public board](https://recruitcrm.io/jobs/Terra_Careers). | Offset/limit request shape requires a larger-board test. Some employer names are intentionally hidden; preserve that uncertainty. |
| **DigitalRecruiters** | Decathlon France, 838 reported; 40 downloaded | Anonymous config, paged JSON POST search, and exact JSON detail all succeeded. [Employer board](https://joinus.decathlon.fr/fr/annonces). | Two distinct 20-record pages. Config supplies canonical domain and language; API requests require a regional locale such as `fr_FR`. Distinguish job-ad ID from job/location publication ID. |

## Request recipes for adapter implementation

These routes reproduce the successful checks. Replace only identifiers resolved from a real employer's public page or documented board configuration. Public tokens are obtained afresh and are omitted from the saved evidence.

| Platform | Listing request | Detail or continuation |
| --- | --- | --- |
| Gem | `GET https://api.gem.com/job_board/v0/{vanity}/job_posts/` | Append `{job_post_id}` for detail. |
| JobScore | `GET https://careers.jobscore.com/jobs/{slug}/feed.json` | Description is in the feed. |
| JazzHR | `GET https://app.jazz.co/feeds/export/jobs/{tenant}` | Description is in each XML `job`. |
| Manatal | `GET https://www.careers-page.com/api/v1.0/c/{slug}/jobs/?page_size=20&page=1` | Follow validated `next` pages; descriptions are inline. |
| ClearCompany | `GET https://careers-api.clearcompany.com/v1/{site_uuid}?pageIndex=0&pageSize=50` | Append `/{job_uuid}` for detail. |
| Hireology | `GET https://api.hireology.com/v2/public/careers/{slug}?page=1&page_size=50` | Bearer token from public board; descriptions are inline. |
| Cornerstone | `POST {public_cloud_host}/rec-job-search/external/jobs` | Bearer token from public board; JSON body includes site, page, size, culture, and empty filters. |
| HireHive | `GET https://{employer_host}/api/v2/jobs?page=1&page_size=100` | `GET /api/v2/jobs/{id}`. |
| Phenom | `POST https://{employer_host}/widgets` | Search body uses `ddoKey: refineSearch`; detail uses `ddoKey: jobDetail` and `jobSeqNo`. |
| Polymer | `GET https://api.polymer.co/v1/hire/organizations/{slug}/jobs` | Append `/{id}` for detail; retain list page metadata. |
| Softgarden | `GET https://{career_host}/jobs.feed.json` | Read `dataFeedElement[].item`. |
| Flatchr | `GET https://careers.flatchr.io/company/{slug}.json` | Read each item's `vacancy` sections. |
| TalentLyft | `GET https://api.talentlyft.com/v2/public/{subdomain}/jobs?page=1&perPage=20&details=true` | Follow validated page links. |
| Traffit | `GET https://{tenant}.traffit.com/public/job_posts/published` | Headers `X-Request-Current-Page` and `X-Request-Page-Size`. |
| d.vinci | `GET https://{career_host}/jobPublication/list.json` | Description sections are inline; portals/locales can scope publications. |
| Homerun | `GET {advertised_feed_url}` | Atom entries contain the publication URL and description. |
| Crelate | `GET https://jobs.crelate.com/api/candidateportal/GetAllJobs?requestEnvelope={encoded_json}` | Envelope contains public organization UUID; `GetJob` accepts the posting `JobCode`. |
| Recruit CRM | `POST https://albatross.recruitcrm.io/v1/external-pages/jobs-by-account/get?account={public_account_slug}&batch=true` | Body `{limit, offset, search_data: {}, onlyJobs: true}`; public Origin header. |
| DigitalRecruiters | `POST https://api.digitalrecruiters.com/public/v1/careers-site/job-ads?domainName={domain}&limit=20&page=1&locale={locale}` with `{}` | Resolve config through `/careers/v1/careers-sites/{host}`; GET detail by numeric `job_ad_id`. |

The companion evidence JSON contains the tested URLs, response hashes, timestamps, field checks, and sanitized POST request shapes. Its inventory and counts retain the October 8 research snapshot, including the original 20-family baseline and 19 candidates.

## Additional APIs with remaining conditions

| Platform | Established access | Remaining condition before treating it as a general acquisition adapter |
| --- | --- | --- |
| **Bullhorn** | Official read-only public jobs API; official Career Portal sample configuration returned jobs with descriptions. [Public API guide](https://bullhorn.github.io/Public-API/). | Public REST must be enabled for the customer. Resolve cluster and corporate token from an actual public portal. The tested configuration is a vendor sample, so it is excluded from the 19 employer-verified families. |
| **Jobylon** | Official XML/JSON Feed API and public widget. [Feed API](https://developer.jobylon.com/feed-api). | Feed URL contains a support-issued hash. Discover a published feed/widget and verify completeness rather than inventing the hash. |
| **Kula** | Official browser-callable Jobs API uses a restricted `job_boards` token. [Jobs API guide](https://developers.kula.ai/docs/api-guides/job-boards-api-intro). | Obtain a token explicitly published for the public career page or issued for that integration, then verify a live employer. |
| **INNOMATE** | Official Jobs API explicitly requires no authentication. [Public API reference](https://support.innomate.com/recruitment/jobs-api-reference). | Verify a real company and job-board ID. The list endpoint returns an empty array for nonexistent or archived boards, so an empty 200 cannot validate identity. |
| **Jobsoid** | Official public API specification; vendor demo listing and detail succeeded. [API reference](https://apidocs.jobsoid.com/). | Several real customer slugs returned empty lists. An active employer with genuine vacancies is required before launch. Demo postings are excluded from the 19. |
| **GoHire** | Public widget JSON returned 282 records on the vendor's Testify.ai example; GoHire's own widget returned a valid empty list. [Widget setup](https://help.gohire.io/en/articles/7831515-how-to-set-up-careers-widget). | Verify a real active employer and exact detail response. Preserve case in public widget hashes. The example includes test postings and is excluded from the 19. |

These are actionable leads with different access conditions. They should not be collapsed into either confirmed anonymous acquisition or permanent exclusion.

## Tested routes that remain unresolved

| Platform | Observed result | Consequence |
| --- | --- | --- |
| **Paylocity** | Public Bectran and OpenCape boards loaded. The suggested `/recruiting/api/feed/jobs/{uuid}` returned empty HTTP 500 on both. An alternate route redirected to a job-not-found HTML page. | The claimed feed route is unverified. Inspect the current client or another advertised feed; do not declare the platform unavailable from these failures. |
| **Freshteam** | Locale's public board loaded. Tested administrative job-posting routes returned 403; a guessed embed route redirected to login HTML. | The customer API is not sufficient evidence about a separate public widget. Obtain the current widget request before implementing or excluding it. |

The HireHive global jobboard endpoint returned the same first page despite changed skip/top parameters. Its employer-specific, officially documented Jobs API subsequently passed distinct-page tests and is the verified implementation route.

## Credentialed APIs and job board hosting products

These documented APIs require a customer or board-owner relationship. That limits their immediate usefulness for collecting arbitrary employers' jobs. A separate public website endpoint may still exist; the condition below applies only to the documented API. Getro, SmartJobBoard, JobBoard.io, and Niceboard remain here as research findings and are excluded from the expansion plan under the scope above.

| Platform | Documented condition | Implication for acquisition |
| --- | --- | --- |
| ADP Workforce Now | Customer HCM integration access. [API Central](https://apps.adp.com/en-US/apps/410612/ADP%C2%AE-API-Central-for-ADP-Workforce-Now%C2%AE/features). | Public career-site collection needs independent investigation. ADP's own corporate careers site is not proof of an ADP customer-platform collector. |
| ApplicantStack | Private API key for internal IT or trusted third parties. [Integration guide](https://www.applicantstack.com/workforcehub-university/api-integration-guide/). | Investigate any separately advertised career feed. |
| CATS | Administrator-created v3 key. [API documentation](https://docs.catsone.com/api/v3/). | Public portal feed remains a separate lead. |
| Dover | API key from customer settings. [API guide](https://help.dover.com/en/articles/10089177-dover-api). | Public Dover boards require a separate client/API check. |
| Fountain | OAuth or legacy customer token. [API overview](https://developer.fountain.com/reference/overview). | Public opening-page requests remain unresolved. |
| Jobvite | Customer API key and secret. [Job Feed API](https://careers.jobvite.com/careersite/job_feed_api.html). | Public XML feeds or current hosted-site endpoints require separate proof. The tested legacy Sitecore feed redirected to an error page. |
| Loxo | API token created in customer settings. [API reference](https://loxo.readme.io/reference/loxo-api). | Public career-page backend remains a lead. |
| Recruiterflow | Workspace API key issued by the vendor; official guidance uses server-side calls. [Custom career-page guide](https://help.recruiterflow.com/en/articles/3671870-build-a-custom-careers-page-with-the-recruiterflow-api). | Its word “public” does not establish anonymous access to every employer. |
| TalentNest | Client-scoped Basic authentication key. [API reference](https://api.talentnest.com/). | Public board feed requires separate proof. |
| Getro | Bearer key for the customer's network; documented full sync once per six hours. [API documentation](https://developers.getro.com/). | Excluded: automated aggregation from company sites and other job sites. |
| SmartJobBoard | Enterprise subscription and board-admin key. [API guide](https://help.smartjobboard.com/en/articles/1269675-smartjobboard-api). | Excluded from ATS expansion: general job-board hosting product; individual boards can use different publishing models. |
| JobBoard.io | Enterprise plan and owner-issued API key. [API keys](https://support.jobboard.io/docs/api-keys). | Excluded from ATS expansion: general job-board hosting product; individual boards can use different publishing models. |
| Niceboard | Private API for subscribers with a secret board key. [Private API guide](https://help.niceboard.co/article/51-private-api). | Excluded from ATS expansion: general job-board hosting product; individual boards can use different publishing models. |

## Broader discovery inventory

The discovery universe is much larger than the checkout's adapter list. LinkedIn's [supported ATS and job-distributor catalogue](https://content.linkedin.com/content/dam/help/linkedin/en-us/Automated_Job_Postings_Self_Service_Onboarding_Supported_ATS.pdf), dated March 24, 2026, contains hundreds of systems. That catalogue establishes candidate vendors, not anonymous API access.

The next investigation queue includes **Avature, Infinite BrassRing, Taleo, iCIMS board listing, Paycom, Paycor, PageUp, HiringThing, Trakstar Hire, JobAdder, HiringRoom, Occupop, Recooty, BITE, Vincere, Gupy, Harri, HigherMe, CareerPlug, ApplicantPool, ApplicantPro/isolved, LiveHire, rexx systems, PCRecruiter, Tribepad, Eploy, Ceipal, Oorwin, Factorial, Employment Hero, Emply, Teamdash, Skeeled, Concludis, onlyfy/Prescreen, Sage HR, and Gusto**. Some are already recognized labels or known browser sources. They lack sufficient current evidence here to join the confirmed additional API list.

Classify each future investigation as employer-verified public access, documented access with a setup condition, customer-only documented access, failed route requiring follow-up, or a discovery lead. Preserve the exact route and evidence. A failed route does not settle the whole vendor, and a software directory's “has API” badge does not establish a public jobs feed.

## Original implementation order and current status

This ordering is an engineering judgment based on the verified payloads and identity requirements, not a measured forecast of suitable-job yield.

1. **Gem, JobScore, JazzHR, Manatal, ClearCompany, and HireHive — implemented.** Their feeds or simple paginated APIs expose descriptions and public posting identities without token bootstrap. The committed adapters use the shared first-collection controls; pilot acceptance and further admissions remain separate operating decisions.
2. **Cornerstone and Hireology.** Both passed real employer tests, but adapters must refresh anonymous tokens and bind them to the correct tenant/site. Cornerstone has the strongest whole-board pagination proof in this investigation.
3. **Phenom.** Its search/detail path works, but quantify overlap with existing Workday and other collectors before assigning it a large rotation budget.
4. **Crelate, Recruit CRM, Polymer, Softgarden, d.vinci, Traffit, Flatchr, TalentLyft, Homerun, and DigitalRecruiters.** Add these according to discovered employer inventory, location coverage, and title yield. Agency attribution, regional feeds, and career-site variants require provider-specific checks.

Before activating an adapter, verify at least two independently branded employers where available, complete pagination without repeated pages, an exact full description, canonical public URLs, and stable posting identity scoped to tenant/site/locale. Preserve source language, location, remote restrictions, compensation, and general-application status. Missing employer data must remain missing until verified.

Connect accepted adapters to detection, pasted-link discovery, configured discovery patterns, board validation, scheduled acquisition, detail enrichment where needed, durable source identity, and import mapping. Apply normal pacing and provider/board failure scope. Expansion is prospective and must preserve existing jobs, scores, audit checkpoints, and completed work.

## Correction to the previous JazzHR conclusion

At the research snapshot, the discovery catalogue excluded JazzHR because `/apply/jobs/rss` returned HTTP 200 with error HTML and its administrative API requires a customer key. The separate `/feeds/export/jobs/{tenant}` endpoint returned genuine XML with descriptions for two employer boards. The exclusion's premise was therefore incomplete. JazzHR now has an implemented adapter for the public XML export. Validate the actual XML root and posting fields before scheduling a board; status-only validation remains inadequate.

Similarly, Manatal's administrative API deprecation does not establish that the unrelated public career-page endpoint with `v1.0` in its path is retired. The live public endpoint returned all 33 observed records.

## Evidence and completion scope

The evidence includes **131 saved request receipts**, covering employer pages, public scripts, official specifications, listing/detail requests, pagination checks, and failed controls. This is a request count, not a count of distinct platforms. Payload checks confirmed posting identity and description fields for all 19 candidates; eight page comparisons passed checks for repeated posting IDs. Complete observed boards were verified for Manatal and both Cornerstone employers.

The sanitized companion file is [request receipts and candidate registry](ats-api-research/2026-10-08-evidence.json). It records response hashes, timestamps, request shapes, description-field lengths, page counts, and which candidates are confirmed versus conditional. Public bearer tokens and raw token-bearing pages are excluded.

Vendor documentation and publicly served employer code support the technical conclusions. Community implementations supplied some discovery leads; their claims were not accepted as integration proof. This investigation establishes a substantial expansion backlog and an open vendor inventory. It does not establish that every ATS on the internet has been evaluated or that the remaining providers lack APIs.

The original investigation delivered research documentation and evidence without changing application adapters, discovery configuration, the database, or production services. The six-adapter implementation and deployment described above happened separately. This documentation update preserves the original request evidence and distinguishes that historical research from the implemented rollout.
