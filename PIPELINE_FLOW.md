# Career Dashboard Job Pipeline

This diagram maps exactly how a job travels from initial discovery all the way through the various AI and local evaluations to your Inbox. It reflects the true concurrency orchestration, API syncs, and background tasks.

```mermaid
flowchart TD
    %% True Concurrency Orchestrator
    O{"Main Orchestrator<br/>src/app/api/pipeline/run/route.ts<br/>True Concurrency"}

    O -->|Parallel Execution| I
    O -->|Parallel Execution| J
    O -->|Parallel Execution| C
    
    %% Ingestion
    subgraph I ["Ingestion (Every 15m)"]
        I1[Apify Job Sync]
        I2[Apify Profile Sync]
        I3[Reddit Sync]
        I4[Hacker News Sync]
        I5[GitHub Sync]
        I6[Cooldown Processing]
        I7["ATS Search<br/>Primary Queries"]
        I8["Wildcard Search<br/>Secondary Queries"]
        
        I9("Local Triage<br/>Heuristic Reject")
        
        I1 & I2 & I3 & I4 & I5 & I6 & I7 & I8 --> I9
    end
    
    %% Jina Extraction
    subgraph J ["Jina JD Extraction"]
        J1(Missing JD Fetcher)
        J2[Retries & Rate Limits]
        J1 --- J2
    end
    
    %% AGY Agent Evaluation
    subgraph AGY ["Antigravity Agent (Local Desktop)"]
        AGY1(JSON Batch Export)
        AGY2["Job Evaluator Subagents<br/>(Pool of 2)"]
        AGY3(JSON Batch Import)
        AGY1 --- AGY2
        AGY2 --- AGY3
    end

    %% Background processes
    subgraph C ["Stale Lease Cleanup"]
        Z["Zombie Job Sweeper<br/>Resets crashed/orphaned leases every 5m"]
    end

    %% Flow of Data
    DB[(Database)]
    
    I9 -->|Inserts New Jobs| DB
    DB -->|Jobs < 400 chars| J
    J -->|Full Text JDs| DB
    DB -->|Export unscored jobs| AGY
    AGY -->|Import scored fits & wildcards| DB
    C -.->|Monitors Leases| DB
```
