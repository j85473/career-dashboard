# Career Dashboard Pipeline & State Machine

This is the source-backed end-to-end architecture for the current Career Dashboard, verified against the checked-out implementation on 2026-08-21. It separates runtime control, durable discovery, per-job processing, the manual Aim/Experience exchange, lifecycle outcomes, and the PostgreSQL audit plane.

> Solid arrows show control or job flow. Dotted arrows show durable state, audit, or safety bindings. A job advances only when the decision on the connecting arrow is satisfied.

```mermaid
%%{init: {"theme":"base","flowchart":{"curve":"basis","htmlLabels":true,"nodeSpacing":24,"rankSpacing":42},"themeVariables":{"fontFamily":"Inter, ui-sans-serif, system-ui, sans-serif","fontSize":"14px","lineColor":"#64748b","primaryTextColor":"#f8fafc"}}}%%
flowchart TB

    %% ──────────────────────────────────────────────────────────────────────
    %% CONTROL PLANE
    %% ──────────────────────────────────────────────────────────────────────
    subgraph CONTROL["CONTROL PLANE · START, PAUSE, QUIESCE, AND GLOBAL OWNERSHIP"]
        direction LR
        CRON["Pi cron / scheduler<br/>Bearer-authenticated request"]
        MANUAL["Dashboard operator<br/>Run / Resume"]
        DEPLOY["GitHub-driven deployment<br/>requests quiescence"]
        RUN["POST /api/pipeline/run"]
        STOP["POST /api/pipeline/stop"]
        STOPMODE{"Stop mode"}
        TIMED["Default pause<br/>schedulePaused = true<br/>auto-resume after 6h"]
        INDEF["Indefinite pause<br/>manual resume required"]
        QUIESCE["Deployment quiesce<br/>stop active work<br/>leave schedule enabled"]
        LOCK{"Acquire global<br/>PipelineState lock"}
        PAUSED["Scheduled start refused<br/>paused = true<br/>no task lease acquired"]
        BUSY["Start refused<br/>pipeline already owned"]
        SUP["Long-lived supervisor<br/>lock heartbeat + AbortController<br/>warning isolation + bounded backoff"]

        CRON -->|"scheduled start"| RUN
        MANUAL -->|"manual start clears pause"| RUN
        DEPLOY -->|"mode = quiesce"| STOP
        MANUAL -->|"Stop"| STOP
        STOP --> STOPMODE
        STOPMODE -->|"default"| TIMED
        STOPMODE -->|"mode = indefinite"| INDEF
        STOPMODE -->|"mode = quiesce"| QUIESCE
        RUN --> LOCK
        LOCK -->|"scheduled + pause in force"| PAUSED
        LOCK -->|"live owner exists"| BUSY
        LOCK -->|"lock acquired"| SUP
        TIMED -.->|"shared stop signal + local abort"| SUP
        INDEF -.->|"shared stop signal + local abort"| SUP
        QUIESCE -.->|"clean loop shutdown"| SUP
    end

    %% ──────────────────────────────────────────────────────────────────────
    %% FOUR SUPERVISED LOOPS
    %% ──────────────────────────────────────────────────────────────────────
    subgraph RUNTIME["RUNTIME PLANE · FOUR FAILURE-ISOLATED LOOPS"]
        direction TB
        ING_ENTRY["A · Durable ingestion loop"]
        JD_ENTRY["B · JD recovery loop"]
        LOCAL_ENTRY["C · Local deterministic scoring loop"]
        CLEAN_ENTRY["D · Lease and abandoned-run cleanup loop"]
    end

    SUP --> ING_ENTRY
    SUP --> JD_ENTRY
    SUP --> LOCAL_ENTRY
    SUP --> CLEAN_ENTRY

    %% ──────────────────────────────────────────────────────────────────────
    %% DURABLE INGESTION
    %% ──────────────────────────────────────────────────────────────────────
    subgraph INGESTION["A · DURABLE INGESTION SCHEDULER"]
        direction TB
        PROFILE["Daily LinkedIn profile sync<br/>4:00 AM target · separate outreach support"]
        CATALOG["Canonical task catalog<br/>source × query family × geography lane × mode<br/>MSP · Minnesota · Upper Midwest · US remote · source-owned"]
        DUE["Order only due active tasks<br/>completion-based nextRunAt"]
        CLAIM["Atomic IngestionTask claim<br/>lease token + bounded source window"]
        GUARD["Provider protection<br/>per-key cooldowns · provider circuits<br/>request budgets · deterministic jitter"]
        DISPATCH{"Dispatch claimed task"}

        subgraph SOURCES["CURRENT SOURCE PORTFOLIO"]
            direction LR
            ROUTE_FEEDS["Route-backed feeds<br/>LinkedIn via Apify · Dice via Apify<br/>Reddit / HN / GitHub return disabled evidence"]
            CAREERFORCE["CareerForce<br/>16 title families · Minnesota<br/>12-hour cadence"]
            PAID["Paid discovery<br/>SerpApi · JSearch · Indeed<br/>LinkedIn · Glassdoor RapidAPI<br/>title + body-language + travel lanes"]
            ATS["ATS board portfolio<br/>platform-fair turns · 25-board batches · continuations<br/>Workday · Workable · Greenhouse · Lever<br/>Ashby · SmartRecruiters · BambooHR · Breezy<br/>Teamtailor · Pinpoint · Recruitee · Rippling · Personio<br/>Workday description deferral is backlog-gated"]
            FREE["Free / source-owned feeds<br/>TheMuse · Arbeitnow · RemoteOK · Jobicy<br/>We Work Remotely · Himalayas · Remotive<br/>BioSpace · DEJobs"]
            OPTIONAL["Credential-gated sources<br/>CareerOneStop canary · Adzuna<br/>USAJOBS title lanes + high-travel canary"]
        end

        NORMALIZE["Normalize provider records<br/>clean text · canonical URL candidate<br/>source ID · posted date · attribution"]
        IDENTITY{"Existing source observation<br/>or stable posting identity?"}
        DUP["Record duplicate event<br/>attach source observation<br/>do not create another Job"]
        ENRICH["Bounded enrichment when needed<br/>redirect resolution · ATS/details API<br/>authoritative title/company/location<br/>aggregator → direct ATS posting<br/>stored postings first, then one board ping"]
        RECHECK{"Duplicate after<br/>enrichment?"}
        PREFILTER{"Language + deterministic prefilter<br/>title / company / description signals"}
        ARCHIVE["Archived + skipped<br/>prefilter rejection or duplicate shell"]
        JD_GATE{"Shared JD quality gate<br/>usable · incomplete · closed"}
        TASK_DONE["Complete task lease<br/>status + counters + cursor + watermark<br/>next run anchored to completion"]
        RECONCILE["Counter invariant<br/>seen = inserted + duplicates<br/>+ filtered + processing errors<br/>provider errors tracked separately"]
        PORTFOLIO_MAINT["Portfolio maintenance<br/>release expired cooldowns<br/>verify Inbox postings alive<br/>expire the Inbox review window"]

        ING_ENTRY --> PROFILE
        ING_ENTRY --> CATALOG
        CATALOG --> DUE --> CLAIM --> GUARD --> DISPATCH
        DISPATCH --> ROUTE_FEEDS
        DISPATCH --> CAREERFORCE
        DISPATCH --> PAID
        DISPATCH --> ATS
        DISPATCH --> FREE
        DISPATCH --> OPTIONAL
        ROUTE_FEEDS --> NORMALIZE
        CAREERFORCE --> NORMALIZE
        PAID --> NORMALIZE
        ATS --> NORMALIZE
        FREE --> NORMALIZE
        OPTIONAL --> NORMALIZE
        NORMALIZE --> IDENTITY
        IDENTITY -->|"yes"| DUP
        IDENTITY -->|"new candidate"| ENRICH
        ENRICH --> RECHECK
        RECHECK -->|"yes"| DUP
        RECHECK -->|"unique"| PREFILTER
        PREFILTER -->|"reject"| ARCHIVE
        PREFILTER -->|"survive"| JD_GATE
        DISPATCH -.->|"task outcome"| TASK_DONE
        TASK_DONE --> RECONCILE
        ING_ENTRY --> PORTFOLIO_MAINT
    end

    %% ──────────────────────────────────────────────────────────────────────
    %% SHARED JOB QUEUES AND TERMINAL STATES
    %% ──────────────────────────────────────────────────────────────────────
    subgraph JOB_STATES["JOB LIFECYCLE + PROCESSING STATE AXES"]
        direction LR
        NEEDS_JD["Job.status = pending_af<br/>scoringStatus = needs_jd"]
        QUEUED["Job.status = pending_af<br/>scoringStatus = queued"]
        SCORED["Job.status = pending_af<br/>scoringStatus = scored<br/>eligible for Aim export"]
        INBOX["Job.status = inbox<br/>accepted only after Experience Fit"]
        DISMISSED["Dismissed + skipped<br/>closed or deterministic rejection"]
        ACTION["Action Needed<br/>scoringStatus = failed<br/>bounded technical failure"]
        HUMAN["Protected lifecycle or tailoring state<br/>inbox / bookmarked / applied / interviewing / archived / others<br/>background imports record scores but cannot overwrite it"]
    end

    JD_GATE -->|"usable JD"| QUEUED
    JD_GATE -->|"incomplete JD"| NEEDS_JD
    JD_GATE -->|"confirmed closed"| DISMISSED
    INBOX -.-> PORTFOLIO_MAINT

    %% ──────────────────────────────────────────────────────────────────────
    %% JD RECOVERY
    %% ──────────────────────────────────────────────────────────────────────
    subgraph JD_RECOVERY["B · BOUNDED JD RECOVERY · BATCHES OF 10"]
        direction TB
        JD_CLAIM["Claim needs_jd rows<br/>jdBatchId lease · active lifecycle only"]
        JD_EXISTING{"Existing text already usable<br/>or posting already closed?"}
        JD_METADATA["Language-only gate<br/>+ authoritative metadata gate"]
        ATS_FIRST["Structured recovery first<br/>Glassdoor details API or ATS-specific API<br/>Greenhouse · Lever · Workday · Comeet · iCIMS · JSON-LD · others"]
        JINA["Jina Reader fallback<br/>only when structured recovery is unusable<br/>safe URL + 20s timeout"]
        JD_DECISION{"Shared recovery decision"}
        JD_DEDUPE{"Duplicate after full<br/>JD recovery?"}
        JD_RETRY["Release lease + increment attempt<br/>return to needs_jd"]
        JD_TERMINAL["Third failed attempt<br/>release lease + preserve for review"]
        TARGET_LOCAL["Targeted scoreJobs(jobIds)<br/>after successful recovery"]

        JD_ENTRY --> JD_CLAIM
        NEEDS_JD --> JD_CLAIM
        JD_CLAIM --> JD_EXISTING
        JD_EXISTING -->|"ready"| JD_DEDUPE
        JD_EXISTING -->|"closed"| DISMISSED
        JD_EXISTING -->|"still incomplete"| JD_METADATA
        JD_METADATA -->|"affirmative rejection"| DISMISSED
        JD_METADATA -->|"continue"| ATS_FIRST
        ATS_FIRST -->|"usable structured JD"| JD_DECISION
        ATS_FIRST -->|"missing / unusable"| JINA
        JINA --> JD_DECISION
        JD_DECISION -->|"ready"| JD_DEDUPE
        JD_DECISION -->|"closed"| DISMISSED
        JD_DECISION -->|"retry · attempts 1–2"| JD_RETRY
        JD_DECISION -->|"terminal · attempt 3"| JD_TERMINAL
        JD_DEDUPE -->|"duplicate"| ARCHIVE
        JD_DEDUPE -->|"unique"| QUEUED
        JD_RETRY --> NEEDS_JD
        JD_TERMINAL --> ACTION
        QUEUED -.->|"recovered IDs are triggered immediately"| TARGET_LOCAL
    end

    %% ──────────────────────────────────────────────────────────────────────
    %% LOCAL DETERMINISTIC TRIAGE
    %% ──────────────────────────────────────────────────────────────────────
    subgraph LOCAL_TRIAGE["C · LOCAL DETERMINISTIC TRIAGE · NO EXTERNAL MODEL"]
        direction TB
        LOCAL_CLAIM["Atomic local claim<br/>queued → scoring<br/>batchJobId = local UUID"]
        LATEST["Re-read latest Job snapshot<br/>protect concurrent user changes"]
        LOCAL_GATES["Language + authoritative metadata gates"]
        RESOLVE["Resolve canonical description<br/>detect closed / incomplete content"]
        POSTING_FACTS["Extract literal posting facts<br/>posted base salary · posted travel<br/>display metadata only, never fit authority"]
        LOCAL_FILTER{"Deterministic prefilter<br/>and title / motion triage"}
        LOCAL_PASS["Release local lease<br/>scoringStatus = scored"]
        LOCAL_RETRY{"Operational attempt<br/>below retry limit?"}

        LOCAL_ENTRY --> LOCAL_CLAIM
        QUEUED --> LOCAL_CLAIM
        TARGET_LOCAL --> LOCAL_CLAIM
        LOCAL_CLAIM --> LATEST --> LOCAL_GATES
        LOCAL_GATES -->|"reject"| DISMISSED
        LOCAL_GATES -->|"continue"| RESOLVE
        RESOLVE -->|"confirmed closed"| DISMISSED
        RESOLVE -->|"incomplete"| NEEDS_JD
        RESOLVE -->|"usable"| POSTING_FACTS
        POSTING_FACTS --> LOCAL_FILTER
        LOCAL_FILTER -->|"deterministic reject"| DISMISSED
        LOCAL_FILTER -->|"survivor"| LOCAL_PASS
        LOCAL_PASS --> SCORED
        LOCAL_CLAIM -.->|"operational error"| LOCAL_RETRY
        LOCAL_RETRY -->|"attempts 1–2"| QUEUED
        LOCAL_RETRY -->|"attempt 3"| ACTION
    end

    %% ──────────────────────────────────────────────────────────────────────
    %% MANUAL AIM + EXPERIENCE EXCHANGE
    %% ──────────────────────────────────────────────────────────────────────
    subgraph MANUAL_SCORING["STORED DASHBOARD EXCHANGE + DATABASE-FREE EXTERNAL RUNNERS"]
        direction TB

        subgraph AIM["E · AIM FIT V2"]
            direction TB
            AIM_ELIG["Aim eligibility<br/>scored + pending_af + usable JD<br/>no active manual lease"]
            AIM_EXPORT["POST /api/scoring/export<br/>stage = aim · maximum 50 jobs"]
            AIM_BATCH["Stored Aim ScoringBatch + items<br/>canonical original JD + bounded trusted metadata<br/>policy / registry / schema + version / manifest / source hashes"]
            AIM_PREFLIGHT["Runner preflight<br/>model catalog + context bounds + privacy scanner<br/>one isolated job workspace"]
            AIM_LOCAL["Deterministic local-policy checkpoint<br/>input contract + local policy kill<br/>no model call"]
            AIM_STAGE1["Stage 1 factual extraction<br/>7 hard-gate questions<br/>evidence-bound isolated worker + checkpoint"]
            AIM_STAGE2_HOLISTIC["Stage 2 holistic Aim judgment<br/>one complete-original-source call · high effort<br/>separate isolated invocation"]
            AIM_BUILD["Deterministic Python assembly<br/>schema + evidence + membership + hash validation<br/>safe failure instead of invented output"]
            AIM_PREVIEW["Zero-write import preview<br/>rebind batch, membership, hashes,<br/>input versions, identity, and current DB state"]
            AIM_TOKEN["Short-lived approval token<br/>bound to batch + result hash + preview"]
            AIM_APPLY["Serializable atomic apply<br/>persist extraction / failure receipt / JobScoreEvent<br/>complete or release every batch item"]

            AIM_ELIG --> AIM_EXPORT --> AIM_BATCH --> AIM_PREFLIGHT --> AIM_LOCAL
            AIM_LOCAL -->|"local-policy terminal result"| AIM_BUILD
            AIM_LOCAL -->|"continue"| AIM_STAGE1
            AIM_STAGE1 -->|"hard-gate result"| AIM_BUILD
            AIM_STAGE1 -->|"survivor"| AIM_STAGE2_HOLISTIC --> AIM_BUILD
            AIM_BUILD --> AIM_PREVIEW --> AIM_TOKEN --> AIM_APPLY
        end

        subgraph EXPERIENCE["F · EXPERIENCE FIT V2"]
            direction TB
            EXP_ELIG["Experience eligibility<br/>current authoritative Aim survivor ≥ 60<br/>matching JD / input anchors · no active lease"]
            EXP_EXPORT["POST /api/scoring/export<br/>stage = experience · maximum 50 jobs"]
            EXP_BATCH["Stored Experience ScoringBatch + items<br/>bind current Aim event + factual extraction<br/>resume hash + evidence hash + JD hash"]
            EXP_HARD["Pass 1 · mandatory hard-requirement gate<br/>complete JD + bounded evidence inventory<br/>medium effort isolated worker"]
            EXP_HOLISTIC["Pass 2 · holistic expertise fit<br/>0–100 professional judgment<br/>high effort isolated worker"]
            EXP_BUILD["Runner validation + deterministic result<br/>worker receipts · bound source Aim authority<br/>safe failure on invalid or missing output"]
            EXP_PREVIEW["Zero-write import preview<br/>membership + authority + hashes + lifecycle guard"]
            EXP_TOKEN["Short-lived approval token<br/>bound to exact preview"]
            EXP_APPLY["Serializable atomic apply<br/>persist JobScoreEvent<br/>complete or release every batch item"]

            EXP_ELIG --> EXP_EXPORT --> EXP_BATCH --> EXP_HARD
            EXP_HARD -->|"hard mismatch · score 0"| EXP_BUILD
            EXP_HARD -->|"requirements pass"| EXP_HOLISTIC --> EXP_BUILD
            EXP_BUILD --> EXP_PREVIEW --> EXP_TOKEN --> EXP_APPLY
        end
    end

    SCORED --> AIM_ELIG
    AIM_APPLY -->|"safe failure"| ACTION
    AIM_APPLY -->|"hard stop or Aim score below 60"| DISMISSED
    AIM_APPLY -->|"scored survivor ≥ 60"| EXP_ELIG
    AIM_APPLY -.->|"always honor lifecycle guard"| HUMAN
    EXP_APPLY -->|"safe failure"| ACTION
    EXP_APPLY -->|"hard mismatch or score below 70"| DISMISSED
    EXP_APPLY -->|"score ≥ 70"| INBOX
    EXP_APPLY -.->|"always honor lifecycle guard"| HUMAN

    %% ──────────────────────────────────────────────────────────────────────
    %% CLEANUP + DURABLE AUDIT PLANE
    %% ──────────────────────────────────────────────────────────────────────
    subgraph CLEANUP["D · STALE WORK RECOVERY"]
        direction LR
        JOB_LEASES["Expired Job leases<br/>JD + local scoring + legacy evaluation"]
        MANUAL_LEASES["Expired manual-export leases<br/>bounded release, never score invention"]
        SOURCE_RUNS["Abandoned IngestionSourceRun rows<br/>mark failed after the runtime cutoff"]
        CLEAN_RESULT["Return recoverable work to its queue<br/>or preserve terminal failure for review"]

        CLEAN_ENTRY --> JOB_LEASES
        CLEAN_ENTRY --> MANUAL_LEASES
        CLEAN_ENTRY --> SOURCE_RUNS
        JOB_LEASES --> CLEAN_RESULT
        MANUAL_LEASES --> CLEAN_RESULT
        SOURCE_RUNS --> CLEAN_RESULT
    end

    CLEAN_RESULT -.-> NEEDS_JD
    CLEAN_RESULT -.-> QUEUED
    CLEAN_RESULT -.-> ACTION

    subgraph AUDIT["SHARED POSTGRESQL AUTHORITY + IMMUTABLE AUDIT PLANE"]
        direction LR
        PIPE_DB[("PipelineState<br/>PipelineStateEvent<br/>global lock + pause + heartbeat")]
        INGEST_DB[("IngestionTask<br/>IngestionSourceRun<br/>ProviderCircuit / Incident<br/>ApiKeyCooldown")]
        JOB_DB[("Job<br/>JobSourceObservation<br/>JobPipelineEvent<br/>status histories")]
        SCORE_DB[("ScoringBatch / Item<br/>AimFactualExtraction<br/>AimScoringFailureReceipt<br/>JobScoreEvent")]
    end

    LOCK -.-> PIPE_DB
    SUP -.-> PIPE_DB
    STOP -.-> PIPE_DB
    CLAIM -.-> INGEST_DB
    GUARD -.-> INGEST_DB
    TASK_DONE -.-> INGEST_DB
    IDENTITY -.-> JOB_DB
    JD_DECISION -.-> JOB_DB
    LOCAL_FILTER -.-> JOB_DB
    AIM_BATCH -.-> SCORE_DB
    AIM_APPLY -.-> SCORE_DB
    EXP_BATCH -.-> SCORE_DB
    EXP_APPLY -.-> SCORE_DB
    HUMAN -.-> JOB_DB

    %% ──────────────────────────────────────────────────────────────────────
    %% VISUAL SYSTEM
    %% ──────────────────────────────────────────────────────────────────────
    classDef control fill:#0f3b68,stroke:#60a5fa,stroke-width:2px,color:#f8fafc;
    classDef supervisor fill:#312e81,stroke:#a5b4fc,stroke-width:3px,color:#f8fafc;
    classDef scheduler fill:#164e63,stroke:#22d3ee,stroke-width:2px,color:#ecfeff;
    classDef source fill:#075985,stroke:#38bdf8,stroke-width:1.5px,color:#f0f9ff;
    classDef decision fill:#78350f,stroke:#fbbf24,stroke-width:2px,color:#fffbeb;
    classDef queue fill:#581c87,stroke:#c084fc,stroke-width:2px,color:#faf5ff;
    classDef worker fill:#115e59,stroke:#5eead4,stroke-width:2px,color:#f0fdfa;
    classDef manual fill:#4c1d95,stroke:#c4b5fd,stroke-width:2px,color:#faf5ff;
    classDef success fill:#14532d,stroke:#4ade80,stroke-width:2px,color:#f0fdf4;
    classDef reject fill:#7f1d1d,stroke:#f87171,stroke-width:2px,color:#fef2f2;
    classDef failure fill:#7c2d12,stroke:#fb923c,stroke-width:2px,color:#fff7ed;
    classDef maintenance fill:#831843,stroke:#f472b6,stroke-width:2px,color:#fdf2f8;
    classDef storage fill:#1e293b,stroke:#94a3b8,stroke-width:2px,color:#f8fafc;
    classDef muted fill:#334155,stroke:#94a3b8,stroke-width:1.5px,color:#f8fafc,stroke-dasharray:5 4;

    class CRON,MANUAL,DEPLOY,RUN,STOP,STOPMODE,TIMED,INDEF,QUIESCE control;
    class LOCK decision;
    class PAUSED,BUSY muted;
    class SUP supervisor;
    class ING_ENTRY,JD_ENTRY,LOCAL_ENTRY,CLEAN_ENTRY supervisor;
    class PROFILE,CATALOG,DUE,CLAIM,GUARD,DISPATCH,TASK_DONE,RECONCILE scheduler;
    class ROUTE_FEEDS,CAREERFORCE,PAID,ATS,FREE,OPTIONAL,NORMALIZE,ENRICH source;
    class IDENTITY,RECHECK,PREFILTER,JD_GATE,JD_EXISTING,JD_DECISION,JD_DEDUPE,LOCAL_FILTER,LOCAL_RETRY decision;
    class NEEDS_JD,QUEUED,SCORED,AIM_ELIG,EXP_ELIG queue;
    class INBOX,LOCAL_PASS success;
    class DUP,ARCHIVE,DISMISSED reject;
    class ACTION,JD_RETRY,JD_TERMINAL failure;
    class HUMAN muted;
    class JD_CLAIM,JD_METADATA,ATS_FIRST,JINA,TARGET_LOCAL,LOCAL_CLAIM,LATEST,LOCAL_GATES,RESOLVE,POSTING_FACTS worker;
    class AIM_EXPORT,AIM_BATCH,AIM_PREVIEW,AIM_TOKEN,AIM_APPLY,EXP_EXPORT,EXP_BATCH,EXP_PREVIEW,EXP_TOKEN,EXP_APPLY manual;
    class AIM_PREFLIGHT,AIM_LOCAL,AIM_STAGE1,AIM_STAGE2_HOLISTIC,AIM_BUILD,EXP_HARD,EXP_HOLISTIC,EXP_BUILD worker;
    class PORTFOLIO_MAINT,JOB_LEASES,MANUAL_LEASES,SOURCE_RUNS,CLEAN_RESULT maintenance;
    class PIPE_DB,INGEST_DB,JOB_DB,SCORE_DB storage;
```

## State interpretation

The diagram deliberately keeps the two Job state axes separate:

- `Job.status` is the lifecycle disposition: `pending_af`, `inbox`, `dismissed`, `archived`, or a protected human-owned state.
- `Job.scoringStatus` is the processing state: `needs_jd`, `queued`, `scoring`, `scored`, `skipped`, or `failed`.

`pending_af` is the machine-processing lifecycle. A job reaches `inbox` only after an authoritative Aim survivor clears the Dashboard-owned 60-point Experience-queue floor and a later Experience result meets the 70-point Inbox threshold.

## Primary implementation owners

| Concern | Source of truth |
| --- | --- |
| Run lock, pause, quiesce, heartbeat, and loop supervision | `src/app/api/pipeline/run/route.ts`, `src/app/api/pipeline/stop/route.ts`, `src/lib/pipelineState.ts` |
| Durable task catalog, claims, counters, cadence, and provider state | `src/lib/ingestionTaskCatalog.ts`, `src/lib/ingestionControl.ts` |
| Source ingestion, identity, dedupe, enrichment, and initial routing | `src/lib/jobIngestion.ts` |
| JD validity, structured recovery, Jina fallback, and retry outcomes | `src/lib/jobDescriptionQuality.ts`, `src/lib/jdRecoveryPolicy.ts`, `src/app/api/jobs/batch-jd-submit/route.ts` |
| Local deterministic triage and posted-fact extraction | `src/lib/jobScoring.ts`, `src/lib/postingFacts.ts` |
| Stored Aim/Experience exports and eligibility | `src/lib/scoringExport.ts`, `src/lib/scoringBatch.ts`, `src/lib/manualScoringEligibility.ts` |
| Database-free runners, validation, preview, approval, and atomic import | `scripts/scoring_protocol/`, `src/lib/scoringImport.ts`, `src/lib/scoringApproval.ts` |
| Immutable operational and scoring audit records | `prisma/schema.prisma`, `src/lib/jobLifecycleEvents.ts`, `src/lib/pipelineState.ts` |
