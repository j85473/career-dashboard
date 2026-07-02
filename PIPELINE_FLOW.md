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
        S1(Google Jobs)
        S2(Direct ATS)
        S3(CareerForce)
        S4(JSearch)
        
        A[Insert DB]
        
        S1 & S2 & S3 & S4 --> A
    end
    
    %% JD Batch
    subgraph JDBatch ["01:30 - Needs JD (batch-jd-submit)"]
        NJD[Missing JD] -->|Background Job| G[Search Agent]
    end

    %% Local Engine
    subgraph LocalScoring ["02:30 - Local Engine (scoreJobs)"]
        Q[Queued] --> C[Local Heuristic]
        C -->|Hard Reject| D[Dismissed]
        C -->|Passed| E[Scored]
    end

    %% Aim Fit
    subgraph AimFit ["03:30 - Context Profile (batch-af)"]
        E -->|Pending AF| H[Context Evaluator]
        H -->|Failed| I[Dismissed]
        H -->|Passed| J[Inbox]
    end

    %% LinkedIn Drafts
    subgraph LinkedIn ["04:30 - LinkedIn Posts (linkedin/batch)"]
        LI1(News API Search) --> LI2[Gemini Analysis]
        LI2 --> LI3[DB Drafts Created]
    end

    %% Experience Fit
    subgraph ExperienceFit ["05:30 - Deep Dive AI (gemini-batch-submit)"]
        J -->|EF Queue| K[Resume Evaluator]
        K -->|Score Generated| L[reqFitScore]
    end

    %% Resume First Scoring
    subgraph ResumeFirst ["06:00 - Resume First (job-dashboard)"]
        RF[Python Pipeline] --> RFS[SQLite Scored]
    end

    %% Inbox / User Options
    subgraph Inbox ["07:00 - Morning Inbox"]
        L --> N{Choose Step}
        RFS --> N
        N -->|Manual Review| M(Pass / Apply / Archive)
    end

    %% Connections
    ContextDB --> Discovery
    Discovery --> Ingestion
    A -->|Truncated| NJD
    A -->|Full Text| Q
    G -->|Found JD| Q
    C -.->|Edge Case: Missing JD| NJD
    ExperienceFit --> ResumeFirst
```
