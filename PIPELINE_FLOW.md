# Career Dashboard Job Pipeline

This diagram maps exactly how a job travels from initial discovery all the way through the various AI and local evaluations to your Inbox, updated with the scheduled cron timeline.

```mermaid
flowchart TD
    %% True Concurrency Orchestrator
    O{Main Orchestrator<br/>src/app/api/pipeline/run/route.ts<br/>True Concurrency}

    O -->|Parallel Execution| I
    O -->|Parallel Execution| J
    O -->|Parallel Execution| D
    O -->|Parallel Execution| W
    
    %% Ingestion
    subgraph I ["Ingestion"]
        I1(Ingestion Engine)
        I2[State Resumption<br/>Perfect pause & resume]
        I3[API Fallbacks<br/>SerpAPI Key Rotation]
        I1 --- I2 --- I3
    end
    
    %% Jina Extraction
    subgraph J ["Jina JD Extraction"]
        J1(Missing JD Fetcher)
        J2[API Fallbacks<br/>Jina Key Rotation]
        J1 --- J2
    end
    
    %% DeepSeek Scoring
    subgraph D ["DeepSeek Scoring"]
        D1(Dual-Lens A/E Fit Scoring)
        D2[Staggered Batching<br/>Up to 3x5 batches<br/>1.5s offset avoids DB locks]
        D1 --- D2
    end
    
    %% Wildcard Scoring
    subgraph W ["Wildcard Scoring"]
        W1(Wildcard Evaluator)
        W2[Finds Hidden Gems]
        W1 --- W2
    end

    %% Background processes
    subgraph B ["Background Loop"]
        Z[Zombie Job Sweeper<br/>Sweeps & resets crashed/orphaned leases]
    end

    %% Flow of Data
    DB[(Database)]
    I -->|Inserts New Jobs| DB
    DB -->|Pending JDs| J
    J -->|Updated JDs| DB
    DB -->|Pending Scoring| D
    D -->|Evaluated Scores| DB
    DB -->|Failed Fits| W
    W -->|Wildcard Gems| DB
    B -.->|Monitors| DB
```
