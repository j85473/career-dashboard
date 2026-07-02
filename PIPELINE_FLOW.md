# Career Dashboard Job Pipeline

This diagram maps exactly how a job travels from initial discovery all the way through the various AI and local evaluations to your Inbox, updated with the scheduled cron timeline.

```mermaid
flowchart TD
    %% Context DB Update
    subgraph ContextDB ["00:00 - Context DB Update"]
        CTX(Update Context Profile)
    end

    %% ATS Discovery
    subgraph Discovery ["00:30 - Discovery Batch"]
        DISC(Discover ATS Portals)
    end

    %% Ingestion Sources
    subgraph Ingestion ["01:00 - Job Discovery (ingestJobs)"]
        S1(Google Jobs & SerpApi)
        S2(Direct ATS Scrapers)
        S3(BioSpace, Muse, Himalayas, etc.)
        S4(JSearch & Job Boards)
        
        A[Insert DB & Normalize]
        
        S1 & S2 & S3 & S4 --> A
    end
    
    %% JD Batch
    subgraph JDBatch ["01:30 - Needs JD (batch-jd-submit)"]
        NJD[Missing JD] -->|Background Job| G[Gemini API / Fallback Scrapers]
    end

    %% Local Engine
    subgraph LocalScoring ["02:30 - Local Engine (scoreJobs)"]
        Q[Queued] --> C[Local Heuristic]
        C -->|Hard Reject| D[Dismissed]
        C -->|Passed| E[Scored]
    end

    %% Aim Fit / Context Profile
    subgraph AimFit ["03:30 - Context Profile (batch-af)"]
        E -->|Pending AF| H[Gemini Context Evaluator]
    end

    %% LinkedIn Drafts
    subgraph LinkedIn ["04:30 - LinkedIn Posts (linkedin/batch)"]
        LI1(News API Search) --> LI2[Gemini Analysis]
        LI2 --> LI3[DB Drafts Created]
    end

    %% Experience Fit
    subgraph ExperienceFit ["05:30 - Deep Dive AI (gemini-batch-submit)"]
        J_PENDING[Pending EF] -->|EF Queue| K[Resume Evaluator]
    end

    %% Reconciliation
    subgraph Reconciliation ["06:15 - Reconcile Jobs"]
        REC[Reset Stuck Batches & Auto-Archive Old]
    end

    %% Morning Inbox & Polling
    subgraph Inbox ["07:00 / 12:00 - Pollers & Morning Inbox"]
        POLL[batch-af-status / batch-context-status]
        H --> POLL
        POLL -->|Failed Fit| I[Dismissed]
        POLL -->|Passed Fit| J[Inbox / Needs EF]
        K -->|Score Generated| L[reqFitScore Available]
        
        L --> N{Choose Step}
        J --> N
        N -->|Manual Review| M(Pass / Apply / Archive)
    end

    %% Connections
    ContextDB --> Discovery
    Discovery --> Ingestion
    A -->|Truncated / < 400 chars| NJD
    A -->|Full Text / >= 400 chars| Q
    G -->|Extracted JD| Q
    C -.->|Edge Case: Missing JD| NJD
    H -.-> J_PENDING
    Ingestion -.->|Stuck Jobs| REC
    JDBatch -.->|Stuck Jobs| REC
    AimFit -.->|Stuck Jobs| REC
    ExperienceFit -.->|Stuck Jobs| REC
```
