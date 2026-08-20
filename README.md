# 📷 CAREER DASHBOARD
**Instruction Manual & Reference Memory Bank (Model 2026)**

*Congratulations on your acquisition of the Career Dashboard.*

Much like an advanced 35mm reflex camera captures light and memory in perfect clarity, the Career Dashboard is precision-engineered to capture your perfect professional future. You are no longer merely "looking for a job"; you are the Director of Photography for your own career arc. This apparatus will not simply automate your tasks—it will clarify your philosophy of the hunt.

In the fast-paced modern era, a professional cannot rely on sheer volume alone, nor solely on handcrafted precision. One must marry the two. The Career Dashboard bridges this gap, balancing high-speed outreach with perfectly focused, bespoke framing.

This manual serves two purposes:
1. **The Operator's Guide:** To teach the philosophy of the hunt.
2. **The Memory Bank:** A permanent, highly detailed technical reference for future AI agents and system maintainers to understand the internal circuitry.

Please read this manual carefully before operating your Dashboard.

---

## SYSTEM ARCHITECTURE OVERVIEW

```mermaid
flowchart TD
    %% Modern Deep-Tech Styling Classes
    classDef orchestrator fill:#0f172a,stroke:#3b82f6,stroke-width:2px,color:#e2e8f0,rx:8px,ry:8px
    classDef source fill:#1e293b,stroke:#10b981,stroke-width:2px,color:#e2e8f0,rx:8px,ry:8px
    classDef subagent fill:#3b0764,stroke:#a855f7,stroke-width:2px,color:#e2e8f0,rx:8px,ry:8px
    classDef database fill:#022c22,stroke:#34d399,stroke-width:2px,color:#e2e8f0,rx:8px,ry:8px
    classDef maintenance fill:#7f1d1d,stroke:#f87171,stroke-width:2px,color:#fee2e2,rx:8px,ry:8px
    classDef highlight fill:#172554,stroke:#60a5fa,stroke-width:3px,color:#bfdbfe,rx:8px,ry:8px

    %% Core Orchestrator
    O{"fa:fa-network-wired Main Pipeline Orchestrator<br/>True Concurrency"}
    class O orchestrator

    O ===|Parallel Thread| I
    O ===|Parallel Thread| ATS
    O ===|Parallel Thread| J
    O ===|Parallel Thread| C
    
    %% Ingestion Engine
    subgraph I ["fa:fa-satellite-dish Ingestion Engine (Every 15m)"]
        direction TB
        subgraph Sources ["Data Harvesting"]
            direction LR
            I1[Apify Job] --- I2[Apify Profile] --- I3[Reddit]
            I4[Hacker News] --- I5[GitHub] --- I6[Dice]
            I8["ATS Search<br/>(Primary)"] --- I9["Precise Role Queries"]
        end
        
        I10("fa:fa-filter Local Triage<br/>(Heuristic Hard Reject)")
        
        Sources --> I10
    end
    class I,Sources,I1,I2,I3,I4,I5,I6,I8,I9,I10 source
    
    %% ATS Discovery
    subgraph ATS ["fa:fa-globe ATS Discovery Engine"]
        A1(fa:fa-search Domain Scanning)
        A2[fa:fa-fingerprint ATS Fingerprinting]
        A1 --- A2
    end
    class ATS,A1,A2 source
    
    %% Jina Extraction
    subgraph J ["fa:fa-file-text Full-Text JD Extraction"]
        J1(fa:fa-cloud-download Jina Reader API)
        J2[fa:fa-shield Rate Limit Controller]
        J1 --- J2
    end
    class J,J1,J2 source
    
    %% Manual two-stage scoring exchange
    subgraph AGY ["fa:fa-robot Manual Aim / Experience Exchange"]
        direction TB
        AGY1("fa:fa-download Exact Dashboard JSON Export")
        AGY4("fa:fa-file-lines Source / Policy / Evidence Binding")
        AGY2{{"fa:fa-laptop External Codex Runner<br/>(One Job per Worker)"}}
        AGY5("fa:fa-check-circle Preview + Explicit Approval + Atomic Import")
        
        subgraph Subagents ["fa:fa-microchip Isolated Semantic Workers"]
            direction LR
            E1("fa:fa-eye Aim Fit Workers")
            E2("fa:fa-eye Experience Fit Workers")
        end
        
        AGY1 --> AGY4
        AGY4 --> AGY2
        AGY2 --> E1 & E2
        E1 & E2 --> AGY5
    end
    class AGY,AGY2,AGY4,AGY5,E1,E2,Subagents subagent
    class AGY1 highlight

    %% Maintenance & Cleanup
    subgraph C ["fa:fa-broom Maintenance Subroutines"]
        Z["fa:fa-biohazard Zombie Job Sweeper<br/>(Resets orphaned leases)"]
    end
    class C,Z maintenance

    %% Master Database
    DB[("fa:fa-server Production Database<br/>(PostgreSQL on Pi)")]
    class DB database
    
    %% Data Flow Routing
    I10 -->|Inserts 'pending_af' Jobs| DB
    ATS -.->|Updates Job ATS Data| DB
    DB -->|Jobs < 400 chars| J
    J -->|Extracted JDs| DB
    DB ===|Explicit Stage Export| AGY
    AGY ===|Approved Complete Result| DB
    C -.->|Monitors Leases| DB
```

---

## TABLE OF CONTENTS
1. [The Philosophy of the Hunt](#1-the-philosophy-of-the-hunt)
2. [Loading the Film: Automated Job Scraping](#2-loading-the-film-automated-job-scraping)
3. [The Darkroom: Your Context DB](#3-the-darkroom-your-context-db)
4. [The Dual-Lens System: Manual Aim and Experience Scoring](#4-the-dual-lens-system-manual-aim-and-experience-scoring)
5. [Developing the Picture: Auto-Tailoring & ATS Discovery](#5-developing-the-picture-auto-tailoring--ats-discovery)
6. [The Slide Projector: Outreach Syncing via Apify](#6-the-slide-projector-outreach-syncing-via-apify)
7. [The Internal Optics: System Architecture & State Machine](#7-the-internal-optics-system-architecture--state-machine)
8. [Setup & Maintenance (Installation)](#8-setup--maintenance-installation)

---

## 1. THE PHILOSOPHY OF THE HUNT
To capture the perfect frame, a photographer must understand light, subject, and timing. To capture the perfect role, you must understand your value, the market's noise, and the algorithmic gatekeepers. 

Do not fall into the trap of blindly scattering identical resumes into the wind—that is like firing a flash into a mirror. Instead, use the Career Dashboard to **focus**. 

- **Volume vs. Precision:** The age-old debate. With this apparatus, you do not need to choose. You will achieve *Precision at Volume*.

> [!TIP]
> **Pro-Tip on Context Rules:** The machine only knows what you tell it. Writing a good context rule is like choosing the right film stock. If your Context DB is blurry, your output will be out of focus.

---

## 2. LOADING THE FILM: Automated Job Scraping
Before you can develop a picture, you must expose the film. The Career Dashboard’s **Automated Job Discovery** mechanism runs silently in the background, continuously spooling in fresh opportunities from the open market.

**Operator Philosophy:**
Set your search parameters (the "aperture") wide enough to catch interesting crossover roles, but narrow enough to avoid overexposing yourself to irrelevant noise. 

> [!WARNING]
> **Overexposure Warning:** Do not let the scraper run indefinitely without reviewing the spool. Calibrate your search terms weekly to ensure the light meter is reading the correct industry trends.

**Memory Bank (Under the Hood):**
The ingestion engine bypasses walled gardens, pulling natively from platforms like Reddit (`r/forhire`), Hacker News, Google Jobs, SerpApi, Dice, and direct ATS portals. We employ a hardened, automated Chromium instance (`CloakBrowser`) to reliably extract fully rendered job descriptions. 

To guarantee continuous operation, the mechanism features:
- **Ingestion State Resumption:** Should a power loss or operator interruption occur, the mechanism possesses a failsafe memory demonstrating how it safely remembers its place if stopped and restarted within 24 hours without double-exposing the film.
- **API Fallbacks:** Our light meters never fail. The system employs automatic key rotation, seamlessly swapping primary API keys if rate limits are exhausted, ensuring an uninterrupted exposure cycle.

New entries enter the database in a `pending_af` state. Truncated descriptions (< 400 chars) are routed to a background job utilizing the Jina Reader API to extract the full JD before proceeding.

---

## 3. THE DARKROOM: Your Context DB
The **Context DB** is a negative-preference memory: it records patterns in jobs you intentionally reject so A/E aim scoring can avoid repeating them. Candidate accomplishments and qualifications remain in the trusted resume/evidence inventory, not in Context DB.

**Operator Philosophy:**
Be explicit about why you rejected a role. "Primary duty is cold calling" is a useful negative signal; "not for me" is too blurry to generalize safely.

> [!CAUTION]
> **Expired Chemicals:** Update your Context DB as you grow. A master photographer does not use expired developer fluid. Keep your history sharp and factual, or the AI will have nothing to develop.

**Memory Bank (Under the Hood):**
The historical Context DB (`ContextProfile`) maintains a versioned, negative-only `DO REJECT:` profile. Only an intentional `passed` decision with a non-Expired reason may enter its queue. Applied, interviewing, expired, and archived jobs are deliberately excluded. Manual scoring v1 does not read this mutable profile; Aim policy and any employer overrides are versioned repository inputs bound directly into each exchange.

---

## 4. THE DUAL-LENS SYSTEM: Manual Aim and Experience Scoring
Jobs first pass a bounded structural triage. The Dashboard then owns two separate manual stages: Aim Fit followed by Experience Fit. The Dashboard exports an exact leased JSON batch; Codex runs outside the application; and the Dashboard previews, independently recomputes, and atomically imports only a complete explicitly approved result.

**Operator Philosophy:**
The stages answer different questions:
- **Lens A (Aim Fit):** Is the role worth continuing to evaluate? A closed hard-stop list gates the stage; its numeric score is calibration-only in v1.
- **Lens E (Experience Fit):** Are there any clear hard-requirement mismatches, and if not, how strongly does Joe's actual expertise match the role on a holistic 0–100 scale?

If Lens A is low but Lens E is high, you have the skills but not the desire. If both are low, do not waste your flash. Move on.

> [!NOTE]
> **Ownership boundary:** The deployed Dashboard makes no model calls. The external runner has no database or Dashboard-import capability.

**Memory Bank (Under the Hood):**
Use the Aim or Experience queue’s independent **Export Batch** control to lease up to 30 eligible jobs from that stage. Aim downloads are named `START-AIM-FIT-<batch-id>.json`; Experience downloads are named `START-E-FIT-<batch-id>.json`. Attaching or referencing one of those files in Codex is the instruction for `$career-dashboard-scoring-protocol` to run that matching stage; merely downloading the file does not execute anything. Upload the completed Desktop copy with **Import Batch**. The runner preserves its canonical validated result under `data/scoring/results/` and places a byte-identical `career-dashboard-<stage>-upload-<batch-id>.json` copy directly on the Desktop for easy upload. Apply is a separate confirmation bound to the exact batch and payload. Each stage may have one nonterminal batch at a time; an Aim batch does not disable Experience export, and an Experience batch does not disable Aim export.

If either stage cannot produce a score for a job, import releases that job's batch lease and routes the job to **Action Needed**. Unscored jobs do not return to the Aim Fit or Experience Fit queue, and Aim failures are not shown in a separate suppression panel.

- **Isolation:** Every semantic worker receives exactly one job in a fresh Terra invocation.
- **Aim:** Closed hard stops; otherwise fail open. Travel points remain distinct from disclosed travel percentage.
- **Experience:** Terra Medium performs one plain-text hard-requirement check. Survivors receive one holistic Terra High score. The runner harvests the substance, not model-authored JSON, and the Dashboard admits scores of 70 or higher.
- **State transition:** The importer repeats validation under row locks and applies the entire batch in one transaction without overwriting protected human lifecycle actions.

---

## 5. DEVELOPING THE PICTURE: Auto-Tailoring & ATS Discovery
Once a high-yield target is locked in your Human-in-the-Loop Review Dashboard, the system moves to the development phase. 

**Operator Philosophy:**
Using the precise data from your Context DB, the system auto-tailors a bespoke resume for the specific job description, outputting a review-ready draft that is optimized to pass through modern Applicant Tracking Systems (ATS).

**Memory Bank (Under the Hood):**
- **Tailoring:** Gemini 2.5 Pro surfaces the most relevant past experiences, rewrites bullet points, and populates `recommendedResume` in the database.
- **ATS Discovery & Routing:** The `identifyAts(job)` function in `atsUtils.ts` determines the underlying ATS system. It scans `source` tags (e.g., `ats-greenhouse`) or parses the `canonicalUrl` (e.g., matching `myworkdayjobs.com` -> `Workday`, `lever.co` -> `Lever`). This ensures our tailored document adheres to the specific parsing quirks (e.g., PDF vs DOCX, structural hierarchies) of 18 supported platforms (including ADP, BambooHR, Avature).

---

## 6. THE SLIDE PROJECTOR: Outreach Syncing via Apify
A beautiful photograph is useless if left in a drawer. The **Apify Outreach Sync** is your slide projector, displaying your perfectly tailored profile directly to hiring managers.

**Operator Philosophy:**
By syncing your tailored applications with automated, polite, and persistent outreach protocols, you ensure that your portfolio is placed directly on the desk of the decision-makers. Always maintain a human touch in your automated follow-ups. A completely robotic message feels like a cheap, faded polaroid.

**Memory Bank (Under the Hood):**
The outreach module triggers `harvestapi~linkedin-profile-search` via the Apify API (`https://api.apify.com/v2/acts/harvestapi~linkedin-profile-search/runs/last/dataset/items`). This validates and pulls direct LinkedIn targets (Recruiters/Hiring Managers) related to the company, syncing their `publicIdentifier` and generating specialized pitch notes in the `OutreachTarget` table for immediate deployment.

---

## 7. THE INTERNAL OPTICS: System Architecture & State Machine

The heart of the Career Dashboard is powered by a master synchronization dial, coordinating multiple internal processes simultaneously without risking overlapping exposures.

- **True Concurrency:** With the pipeline orchestrator running phases in parallel, the motor drive never waits for the shutter to close before advancing the film. 
- **The Zombie Job Sweeper:** A silent, internal maintenance subroutine providing background cleanup for orphaned leases—like a precision brush clearing dust off the mirror—ensuring no stuck jobs hold up the pipeline.

For future AI agents modifying this codebase, refer to this precise lifecycle:

1. **New Job Inserted:** `status = "pending_af"`, `scoringStatus = "queued"`
2. **Missing JD:** Background `Jina Reader API` executes if description < 400 chars.
3. **Local Heuristic:** Tokenizes for hard-rejects -> sets `status = "dismissed"` if failed.
4. **Aim Manual Exchange:** Dashboard export → external runner → zero-write preview → explicit approval → atomic import.
5. **Experience Manual Exchange:** Current Aim survivors repeat the exchange against the approved evidence snapshot and canonical resume binding.
6. **Strict Atomic Import:** Exact schemas, hashes, leases, parent events, artifacts, and job versions are revalidated before writes. Qualified Experience survivors enter `inbox`; hard-stop or hard-requirement failures are dismissed with immutable provenance.
7. **Manual Review:** User moves from `inbox` to `applied` or intentionally rejects it with `passed`. Only the latter can feed negative Context DB learning.

> **Feedback Loop:** Intentional `passed` reasons calibrate future aim scoring. Applications and interviews never become preference rules.

---

## 8. SETUP & MAINTENANCE (INSTALLATION)
Before you can begin your journey, you must assemble the apparatus. Follow these exact instructions to ensure optimal functionality.

1. **Unpack the Apparatus (Clone the Repository)**
   ```bash
   git clone https://github.com/j85473/career-dashboard.git
   cd career-dashboard
   ```

2. **Set the Runtime and Lubricate the Gears (Install Dependencies)**
   Node 24 LTS is the single supported runtime on the Mac, in CI, and on the Pi.
   The repository's `.nvmrc` is the authority. With `nvm` installed:
   ```bash
   nvm install
   nvm use
   node --version
   npm install
   ```
   The version output must begin with `v24`. Deployment fails before contacting
   production when the selected Node major does not match `.nvmrc`.

3. **Install the Batteries (Configure Environment Variables)**
   Rename the provided `.env.example` file to `.env` and carefully input your API keys (`APIFY_API_TOKEN`, etc.). Without these, the flash will not fire.
   ```bash
   cp .env.example .env
   ```

   Keep every RapidAPI subscription in the single comma-separated
   `RAPIDAPI_KEYS` value. The Mac `.env` is the editable authority. After any
   addition, removal, or rotation, synchronize its canonical list to the
   repository secret and Pi without exposing values:
   ```bash
   npm run keys:sync
   ```
   Use `npm run keys:check` for a hash-only Mac/Pi comparison, or
   `npm run keys:sync:restart` when the running Pi service must load the new
   list immediately.

4. **Initialize the Memory Bank (Database Setup)**
   ```bash
   npx prisma generate
   npx prisma db push
   ```

5. **Power On (Start the Application)**
   ```bash
   npm run dev
   ```

Proceed to the viewing screen at [http://localhost:3000](http://localhost:3000) to access your new command center.

*Thank you for choosing the Career Dashboard. May your exposures be perfect, your focus sharp, and your career long and prosperous.*
