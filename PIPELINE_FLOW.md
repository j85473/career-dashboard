# Career Dashboard Job Pipeline

This diagram maps exactly how a job travels from initial discovery all the way through the various AI and local evaluations to your Inbox. It reflects the true concurrency orchestration, API syncs, and background tasks.

```mermaid
flowchart TD
    %% Styling Classes
    classDef primary fill:#1f2937,stroke:#3b82f6,stroke-width:2px,color:#fff
    classDef secondary fill:#374151,stroke:#10b981,stroke-width:2px,color:#fff
    classDef agent fill:#4c1d95,stroke:#a855f7,stroke-width:2px,color:#fff
    classDef database fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#fff
    classDef alert fill:#991b1b,stroke:#f87171,stroke-width:2px,color:#fff

    %% True Concurrency Orchestrator
    O{"Main Orchestrator<br/>src/app/api/pipeline/run/route.ts<br/>True Concurrency"}
    class O primary

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
    class I1,I2,I3,I4,I5,I6,I7,I8,I9 secondary
    
    %% Jina Extraction
    subgraph J ["Jina JD Extraction"]
        J1(Missing JD Fetcher)
        J2[Retries & Rate Limits]
        J1 --- J2
    end
    class J1,J2 secondary
    
    %% AGY Agent Evaluation
    subgraph AGY ["Antigravity Agent Orchestration (Local Desktop)"]
        AGY1(JSON Batch Export)
        AGY2{{"Subagent Concurrency Pool"}}
        AGY3("JSON Batch Import")
        
        subgraph Subagents ["Concurrent Evaluators"]
            E1("Job Evaluator 1<br/>(Dual-Lens A/E Fit)")
            E2("Job Evaluator 2<br/>(Dual-Lens A/E Fit)")
            W1("Wildcard Evaluator<br/>(Hidden Gem Detection)")
        end
        
        AGY1 --> AGY2
        AGY2 --> E1
        AGY2 --> E2
        AGY2 --> W1
        E1 & E2 & W1 --> AGY3
    end
    class AGY1,AGY2,AGY3,E1,E2,W1 agent

    %% Background processes
    subgraph C ["Stale Lease Cleanup"]
        Z["Zombie Job Sweeper<br/>Resets crashed/orphaned leases every 5m"]
    end
    class Z alert

    %% Flow of Data
    DB[(Database)]
    class DB database
    
    I9 -->|Inserts New Jobs| DB
    DB -->|Jobs < 400 chars| J
    J -->|Full Text JDs| DB
    DB -->|Export unscored jobs| AGY
    AGY -->|Import scored fits & wildcards| DB
    C -.->|Monitors Leases| DB
```
