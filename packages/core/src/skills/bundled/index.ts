/**
 * Bundled skills — shipped with agent-os, always available.
 * Each entry: { name, content } where content is the full .md with frontmatter.
 */

export interface BundledSkill {
  name: string;
  content: string;
}

export const BUNDLED_SKILLS: BundledSkill[] = [
  // ── Productivity ────────────────────────────────────────────────────────────
  {
    name: 'daily-standup',
    content: `---
description: Generate a structured daily standup update from recent work
category: productivity
tags: [daily, standup, scrum]
---
# Daily Standup

Generate a daily standup update for me. Ask me what I worked on yesterday, what I'm working on today, and any blockers. Then format the output as:

**Yesterday:** [summary]
**Today:** [summary]
**Blockers:** [list or "None"]

Keep each section to 2-3 bullet points max. Be concise — this goes in Slack.
{{args}}
`,
  },
  {
    name: 'weekly-review',
    content: `---
description: Structured weekly review — wins, lessons, next week priorities
category: productivity
tags: [weekly, review, planning]
---
# Weekly Review

Help me do a structured weekly review. Walk me through:

1. **Wins this week** — what went well? (ask for 3)
2. **What didn't work** — honest assessment
3. **Key learnings** — what would I do differently?
4. **Next week priorities** — top 3 focus areas
5. **Energy check** — rate energy 1-10, suggest adjustments if below 7

Ask each section as a question, then summarize at the end.
{{args}}
`,
  },
  {
    name: 'task-breakdown',
    content: `---
description: Break a large task into small, actionable subtasks with time estimates
category: productivity
tags: [planning, tasks, breakdown]
---
# Task Breakdown

Break the following task into the smallest actionable subtasks possible. For each subtask:
- Write it as a clear action starting with a verb
- Estimate time in minutes (be realistic, not optimistic)
- Flag any dependencies or blockers

Group into: Quick wins (< 15 min), Main work, and "Do later / delegate".

Task: {{args}}
`,
  },
  {
    name: 'meeting-notes',
    content: `---
description: Structure raw meeting notes into decisions, actions, and follow-ups
category: productivity
tags: [meetings, notes, summary]
---
# Meeting Notes Formatter

I'll paste raw meeting notes. Format them into:

**Meeting:** [title + date]
**Attendees:** [list]

**Key Decisions:**
- [decision 1]

**Action Items:**
- [ ] [action] — [owner] — [due date]

**Follow-up questions:**
- [unresolved questions]

**TL;DR:** One sentence summary.

Notes to format: {{args}}
`,
  },
  {
    name: 'pomodoro-plan',
    content: `---
description: Plan a focused work session using Pomodoro technique
category: productivity
tags: [pomodoro, focus, time-management]
---
# Pomodoro Session Planner

Help me plan a focused work session. Given my task list ({{args}}), create a Pomodoro schedule:

- Each Pomodoro = 25 minutes of focused work
- Short break = 5 minutes between Pomodoros
- Long break = 20 minutes after every 4 Pomodoros

For each Pomodoro, give me:
1. Single specific goal
2. Success criteria (how do I know it's done?)
3. One distraction risk to watch for

Start with the highest-impact, hardest task when energy is fresh.
`,
  },

  // ── Software Development ─────────────────────────────────────────────────────
  {
    name: 'code-review',
    content: `---
description: Thorough code review focused on bugs, security, and maintainability
category: software-development
tags: [code-review, quality, security]
---
# Code Review

Review the following code thoroughly. Structure your feedback as:

**🐛 Bugs / Correctness:**
- [issue] — [why it's a bug] — [suggested fix]

**🔒 Security:**
- [vulnerability] — [risk] — [fix]

**⚡ Performance:**
- [bottleneck] — [impact] — [optimization]

**🧹 Maintainability:**
- [smell] — [why it matters] — [refactor suggestion]

**✓ What's good:**
- [things done well — be specific]

Rate overall: 1-10 with one-sentence justification.

Code to review:
\`\`\`
{{args}}
\`\`\`
`,
  },
  {
    name: 'debug-session',
    content: `---
description: Systematic debugging — root cause analysis without guessing
category: software-development
tags: [debugging, root-cause, troubleshooting]
---
# Debug Session

Systematic root cause analysis. Follow this process strictly:

1. **Reproduce** — confirm the exact conditions that trigger the bug
2. **Isolate** — identify the smallest failing unit
3. **Hypothesize** — list top 3 candidate causes, ranked by likelihood
4. **Test** — for each hypothesis, state what evidence would confirm/deny it
5. **Fix** — once root cause confirmed, propose minimal targeted fix
6. **Prevent** — what test would catch this regression?

Do NOT guess. Do NOT suggest "try X and see." Every step must be verifiable.

Problem / error: {{args}}
`,
  },
  {
    name: 'api-design',
    content: `---
description: Design a clean REST API with routes, schemas, and error contracts
category: software-development
tags: [api, rest, design]
---
# API Design

Design a REST API for the following feature. Produce:

**Endpoints:**
| Method | Path | Description | Auth required? |

**Request/Response schemas** for each endpoint (TypeScript interfaces).

**Error contract:** standard error shape used by all endpoints.

**Edge cases** to handle (validation, conflicts, rate limits).

**Breaking change risk** if extending an existing API.

Feature to design: {{args}}
`,
  },
  {
    name: 'refactor-plan',
    content: `---
description: Plan a safe refactor with rollback strategy and test checkpoints
category: software-development
tags: [refactor, planning, safety]
---
# Refactor Plan

Plan a safe refactor for the following code/module. Include:

1. **Goal** — what improves? (measurable)
2. **Scope** — exact files/functions affected
3. **Approach** — technique (extract method, introduce abstraction, etc.)
4. **Step-by-step** — ordered, independently-committable steps
5. **Test checkpoint** — what tests confirm each step didn't break anything?
6. **Rollback** — how to revert each step if needed?
7. **Risk** — what could go wrong?

Target: {{args}}
`,
  },
  {
    name: 'tech-debt',
    content: `---
description: Audit code for technical debt and prioritize what to fix first
category: software-development
tags: [tech-debt, audit, prioritization]
---
# Tech Debt Audit

Audit the following for technical debt. For each item found:
- **Type:** code smell / missing tests / outdated dependency / architecture issue / security risk
- **Impact:** High / Medium / Low (on reliability, velocity, security)
- **Effort:** Small / Medium / Large (to fix)
- **Fix-now vs defer:** should this be fixed before shipping?

Prioritize by: (Impact × urgency) ÷ Effort.

Output a prioritized list, then a "fix-first" shortlist of top 3.

Code/module to audit: {{args}}
`,
  },

  // ── DevOps ───────────────────────────────────────────────────────────────────
  {
    name: 'docker-debug',
    content: `---
description: Debug Docker container issues — startup failures, networking, resource problems
category: devops
tags: [docker, containers, debugging]
---
# Docker Debug

Diagnose the Docker issue I'm seeing. Walk me through:

1. **Check container state:** \`docker ps -a\`, \`docker inspect <container>\`
2. **Check logs:** \`docker logs <container> --tail 100\`
3. **Resource check:** memory/CPU limits, OOM kills (\`docker stats\`)
4. **Network check:** port bindings, DNS, inter-container connectivity
5. **Volume check:** mount paths, permissions
6. **Image check:** layer history, environment vars

For each likely cause, give me the exact command to diagnose + the fix.

Issue: {{args}}
`,
  },
  {
    name: 'deploy-checklist',
    content: `---
description: Pre-deployment checklist to catch common deployment failures
category: devops
tags: [deployment, checklist, production]
---
# Deployment Checklist

Run through this checklist before deploying to production:

**Code:**
- [ ] All tests pass in CI
- [ ] No TypeScript / linting errors
- [ ] Dependencies updated and lockfile committed
- [ ] No \`.env\` secrets committed

**Database:**
- [ ] Migrations tested on staging
- [ ] Rollback migration written
- [ ] No breaking schema changes without backwards compat

**Config:**
- [ ] Environment variables set in production
- [ ] Feature flags configured correctly
- [ ] API keys rotated if needed

**Monitoring:**
- [ ] Error tracking (Sentry/PostHog) connected
- [ ] Alerts configured for P0 metrics
- [ ] Rollback plan documented

**Communication:**
- [ ] Stakeholders notified of downtime window (if any)
- [ ] On-call engineer aware

What are you deploying? {{args}}
`,
  },
  {
    name: 'incident-runbook',
    content: `---
description: Generate an incident runbook for a given service or failure mode
category: devops
tags: [incident, runbook, on-call]
---
# Incident Runbook Generator

Generate a runbook for the following service/scenario. Include:

**Detection:** What alert fires? What metrics spike?

**Initial triage (first 5 minutes):**
1. Check [specific dashboard/log]
2. Run [specific command]
3. Determine severity: P1 (down) / P2 (degraded) / P3 (at-risk)

**Mitigation options (ordered by speed):**
1. [fastest fix, even if temporary]
2. [second option]
3. [nuclear option — rollback]

**Root cause investigation:**
- Commands to run
- Logs to check
- Metrics to correlate

**Communication template:** Slack message for stakeholders.

**Post-incident:** what to add to the retrospective.

Service/failure: {{args}}
`,
  },
  {
    name: 'k8s-troubleshoot',
    content: `---
description: Troubleshoot Kubernetes pod failures, OOMKills, and service issues
category: devops
tags: [kubernetes, k8s, debugging]
---
# Kubernetes Troubleshooting

Systematic K8s diagnosis. Walk through:

1. **Pod status:** \`kubectl get pods -n <namespace>\`
2. **Describe:** \`kubectl describe pod <pod> -n <namespace>\`
3. **Logs:** \`kubectl logs <pod> --previous --tail=100\`
4. **Events:** \`kubectl get events -n <namespace> --sort-by='.lastTimestamp'\`
5. **Resource pressure:** \`kubectl top nodes\`, \`kubectl top pods\`
6. **Service connectivity:** \`kubectl exec -it <pod> -- curl <service>:<port>\`

Common causes:
- CrashLoopBackOff: app crash — check logs
- OOMKilled: memory limit — check requests/limits
- ImagePullBackOff: image not found — check registry auth
- Pending: no nodes available — check node capacity

Issue: {{args}}
`,
  },

  // ── GitHub ───────────────────────────────────────────────────────────────────
  {
    name: 'pr-review',
    content: `---
description: Structured PR review with actionable feedback by severity
category: github
tags: [pr, review, github]
---
# Pull Request Review

Review this PR. Structure feedback by severity:

🔴 **Must fix (blocking):**
- Bugs, security issues, missing tests for critical paths

🟡 **Should fix (non-blocking):**
- Code style, naming, redundant logic, performance

🟢 **Nice to have:**
- Suggestions, alternatives worth considering

For each item: file:line — what to change — why.

End with:
- **Overall verdict:** Approve / Request changes / Needs discussion
- **Test coverage:** adequate / missing [specific cases]

PR diff / description: {{args}}
`,
  },
  {
    name: 'release-notes',
    content: `---
description: Generate user-facing release notes from commits or a PR list
category: github
tags: [release, changelog, github]
---
# Release Notes Generator

Generate user-facing release notes. Format:

## v[version] — [date]

### ✨ New Features
- [Feature name]: [what it does, why users care] (#PR)

### 🐛 Bug Fixes
- [What was broken → now fixed] (#PR)

### ⚡ Improvements
- [Performance / UX / DX improvement] (#PR)

### 🔧 Breaking Changes
- [What changed] — [migration path]

Keep language non-technical (for end users). Skip internal/infra-only commits.

Commits/PRs: {{args}}
`,
  },
  {
    name: 'changelog',
    content: `---
description: Generate a CHANGELOG.md entry following Keep a Changelog format
category: github
tags: [changelog, release, versioning]
---
# Changelog Entry

Generate a CHANGELOG.md entry following Keep a Changelog (keepachangelog.com) format.

## [version] — YYYY-MM-DD

### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security

Rules:
- Newest first
- Each entry: what changed (user perspective), not how it was implemented
- Link to PR or issue where relevant
- Separate entries for each change

Input (commits, PR titles, or descriptions): {{args}}
`,
  },
  {
    name: 'issue-triage',
    content: `---
description: Triage a GitHub issue — reproduce, categorize, and assign priority
category: github
tags: [github, issues, triage]
---
# Issue Triage

Triage the following GitHub issue. Produce:

**Category:** bug / feature request / question / documentation / performance

**Priority:** P0 (critical, data loss/security) / P1 (blocking users) / P2 (workaround exists) / P3 (nice to have)

**Reproducibility:** confirmed / likely / cannot reproduce / need more info

**Missing info checklist:**
- [ ] Reproduction steps
- [ ] Expected vs actual behavior
- [ ] Environment (OS, version, browser)
- [ ] Error logs / screenshots

**Labels to add:** [list]

**Suggested response:** Template reply to ask for missing info or acknowledge.

Issue: {{args}}
`,
  },

  // ── Research ─────────────────────────────────────────────────────────────────
  {
    name: 'competitive-analysis',
    content: `---
description: Structured competitive analysis comparing products or companies
category: research
tags: [research, competitive, strategy]
---
# Competitive Analysis

Analyze the competitive landscape for: {{args}}

Structure:

**Market overview:** size, growth rate, key trends

**Competitors matrix:**
| Competitor | Strengths | Weaknesses | Target customer | Pricing |

**Differentiation opportunities:**
- Where are the gaps?
- What do users complain about in reviews?

**Positioning recommendation:**
- What angle should we own?
- Who are we NOT trying to serve?

**Sources to verify:** (note which claims need verification)
`,
  },
  {
    name: 'fact-check',
    content: `---
description: Fact-check a claim by breaking it into verifiable sub-claims
category: research
tags: [fact-check, research, verification]
---
# Fact Check

Fact-check the following claim by breaking it into sub-claims. For each:

1. **Sub-claim** — the specific assertion
2. **Verifiability** — can this be checked? How?
3. **Verdict** — True / False / Misleading / Unverifiable / Context-dependent
4. **Evidence** — what supports or refutes this? (note if speculative)
5. **Nuance** — what important context is missing?

Overall verdict with confidence: High / Medium / Low

Claim to check: {{args}}
`,
  },
  {
    name: 'literature-review',
    content: `---
description: Summarize and synthesize research papers or articles on a topic
category: research
tags: [research, literature, academic]
---
# Literature Review

Synthesize research on the following topic into a structured review:

**Overview:** current state of knowledge

**Key findings:**
- [Finding 1] — [evidence strength: strong/moderate/weak] — [source]
- [Finding 2] ...

**Consensus:** what does most evidence agree on?

**Controversies:** where do researchers disagree and why?

**Gaps:** what's not yet known / poorly studied?

**Implications:** what does this mean in practice?

**Further reading:** most important papers/sources to go deeper

Topic: {{args}}
`,
  },

  // ── Writing ───────────────────────────────────────────────────────────────────
  {
    name: 'email-draft',
    content: `---
description: Draft a professional email — clear, concise, with a specific ask
category: writing
tags: [email, writing, communication]
---
# Email Draft

Draft a professional email for the following situation. Guidelines:
- Subject line: specific and action-oriented
- Opening: one sentence context (not "Hope you're well")
- Body: max 3 short paragraphs
- Single clear ask in bold
- Closing: no "Let me know if you have any questions" — instead state next step

Tone: professional but human. No corporate jargon.

Situation / context: {{args}}
`,
  },
  {
    name: 'documentation',
    content: `---
description: Write clear technical documentation for code, APIs, or features
category: writing
tags: [documentation, technical-writing, api]
---
# Technical Documentation

Write documentation for the following. Include:

**Overview:** what is this? Why does it exist?

**Quick start:** minimal working example (copy-paste ready)

**Usage / API reference:**
- Parameters / props / options (name, type, description, default, required?)
- Return value / output
- Common patterns

**Examples:**
- Basic usage
- Advanced usage
- Error handling

**Troubleshooting:** top 3 common issues + fixes

Keep it scannable. Use tables for parameters. Code blocks for all code.

What to document: {{args}}
`,
  },
  {
    name: 'blog-post',
    content: `---
description: Outline and draft a technical blog post with SEO-friendly structure
category: writing
tags: [blog, writing, content]
---
# Blog Post

Write a technical blog post on: {{args}}

Structure:
1. **Hook** (first 2 sentences) — surprising fact, bold claim, or relatable problem
2. **Problem statement** — what pain does this solve? Who has it?
3. **Main content** — practical, example-heavy, scannable with H2/H3 headers
4. **Code examples** — working, copy-paste ready snippets
5. **Conclusion** — key takeaway in one sentence + call to action

Tone: conversational, confident, no fluff. Assume technical reader who's busy.
Target length: 800-1200 words.
SEO: include target keyword naturally 3-4 times.
`,
  },
  {
    name: 'proofreading',
    content: `---
description: Proofread text for grammar, clarity, conciseness, and tone
category: writing
tags: [writing, proofreading, editing]
---
# Proofreading

Proofread the following text. Flag:

🔴 **Errors:** grammar, spelling, punctuation
🟡 **Clarity:** sentences that are confusing or ambiguous
🟡 **Conciseness:** phrases that can be cut or shortened
🟢 **Tone:** anything that sounds off for the context

For each issue: quote the original → suggest the fix → explain why (briefly).

At the end, provide the fully corrected version.

Text to proofread:
{{args}}
`,
  },

  // ── Learning ──────────────────────────────────────────────────────────────────
  {
    name: 'explain-concept',
    content: `---
description: Explain a technical concept at multiple levels of depth
category: learning
tags: [learning, explanation, education]
---
# Explain Concept

Explain the following concept at three levels:

**ELI5 (30 seconds):** Use an analogy. No jargon.

**Intermediate (2 minutes):** How it actually works. Key terms defined. One concrete example.

**Deep dive:** Edge cases, tradeoffs, when NOT to use it, common misconceptions.

Also: what should I learn next to fully understand this?

Concept: {{args}}
`,
  },
  {
    name: 'quiz-me',
    content: `---
description: Generate a quiz to test understanding of a topic
category: learning
tags: [learning, quiz, testing]
---
# Quiz Generator

Generate a quiz to test my understanding of: {{args}}

Format:
- 5 questions, mix of: multiple choice (4 options), true/false, short answer
- Difficulty: 2 easy, 2 medium, 1 hard
- For each question after I answer: reveal answer + explain why wrong answers are wrong

Start with Q1 and wait for my answer before showing the next question.
`,
  },
  {
    name: 'study-plan',
    content: `---
description: Create a structured study plan to learn a topic in a given timeframe
category: learning
tags: [learning, study, planning]
---
# Study Plan

Create a structured study plan for: {{args}}

Include:
- **Prerequisites:** what to know before starting
- **Week-by-week breakdown:** specific topics, resources, exercises
- **Resources:** books, courses, docs (free first, paid if significantly better)
- **Projects:** 2-3 hands-on projects to reinforce learning
- **Milestones:** how to know you've mastered each section
- **Common pitfalls:** what most learners get stuck on

Optimize for practical ability, not just theoretical knowledge.
`,
  },

  // ── Security ──────────────────────────────────────────────────────────────────
  {
    name: 'threat-model',
    content: `---
description: Create a threat model for a system using STRIDE methodology
category: security
tags: [security, threat-model, STRIDE]
---
# Threat Model

Create a threat model for: {{args}}

Use STRIDE methodology:

**Spoofing:** who could impersonate legitimate users/systems?
**Tampering:** what data/code could be modified maliciously?
**Repudiation:** what actions could be denied later?
**Information Disclosure:** what sensitive data could leak?
**Denial of Service:** what could make the system unavailable?
**Elevation of Privilege:** how could an attacker gain higher access?

For each threat:
- **Likelihood:** High / Medium / Low
- **Impact:** High / Medium / Low
- **Mitigation:** specific technical control

**Priority matrix:** sort by (Likelihood × Impact) descending.
`,
  },
  {
    name: 'security-audit',
    content: `---
description: Security audit checklist for web apps — OWASP Top 10 focused
category: security
tags: [security, audit, OWASP, web]
---
# Security Audit

Audit the following for the OWASP Top 10 vulnerabilities:

**A01 Broken Access Control:** auth checks on all routes? IDOR risks?
**A02 Crypto Failures:** is sensitive data encrypted? Weak algorithms?
**A03 Injection:** SQL, command, LDAP injection — parameterized queries used?
**A04 Insecure Design:** auth flows, password reset, session management
**A05 Security Misconfiguration:** default creds, verbose errors, directory listing
**A06 Vulnerable Components:** outdated deps with known CVEs?
**A07 Auth Failures:** session fixation, credential stuffing protection?
**A08 Software Integrity:** dependency confusion, supply chain risks
**A09 Logging Failures:** are security events logged? PII in logs?
**A10 SSRF:** untrusted URLs fetched without validation?

For each finding: risk level + specific fix.

Code/system to audit: {{args}}
`,
  },

  // ── Data Science ─────────────────────────────────────────────────────────────
  {
    name: 'eda',
    content: `---
description: Exploratory Data Analysis plan — what to check first in a new dataset
category: data-science
tags: [data, EDA, analysis, pandas]
---
# Exploratory Data Analysis

Generate an EDA plan and code for the following dataset/problem:

**Step 1 — Shape and types:**
\`\`\`python
df.shape, df.dtypes, df.head()
\`\`\`

**Step 2 — Missing values:**
\`\`\`python
df.isnull().sum().sort_values(ascending=False)
\`\`\`

**Step 3 — Distributions:** histograms for numerical, value_counts for categorical

**Step 4 — Correlations:** heatmap for numerical features

**Step 5 — Outliers:** IQR method, box plots

**Step 6 — Target analysis:** distribution of target variable, class balance

**Step 7 — Feature relationships:** key features vs target

For each step, give me runnable pandas/matplotlib code.

Dataset/problem: {{args}}
`,
  },
  {
    name: 'model-eval',
    content: `---
description: Evaluate a ML model — metrics selection, bias detection, reporting
category: data-science
tags: [ml, model-evaluation, metrics]
---
# Model Evaluation

Help me evaluate my ML model for: {{args}}

**Metric selection:**
- Classification: accuracy, precision, recall, F1, AUC-ROC, confusion matrix
- Regression: MAE, MSE, RMSE, R², MAPE
- Ranking: NDCG, MAP, MRR

**Which metrics matter most** for this use case and why?

**Bias & fairness checks:**
- Performance by demographic subgroup
- Calibration: predicted probabilities vs actual rates

**Error analysis:**
- Where does the model fail? Look at worst predictions
- Common error patterns?

**Production readiness:**
- Latency acceptable?
- Performance on recent data (data drift)?

Give me runnable sklearn/python code for each evaluation step.
`,
  },

  // ── Creative ──────────────────────────────────────────────────────────────────
  {
    name: 'brainstorm',
    content: `---
description: Divergent brainstorming — generate 20 ideas without filtering
category: creative
tags: [creative, brainstorming, ideation]
---
# Brainstorm

Generate 20 ideas for: {{args}}

Rules for this brainstorm:
- No filtering — include wild, obvious, and impractical ideas
- Vary the angle: conventional, contrarian, technology-first, human-first, cost-no-object, near-zero-budget
- One sentence per idea
- Number them

After the list, pick the 3 most interesting (not necessarily most practical) and briefly explain why.
`,
  },
  {
    name: 'story-outline',
    content: `---
description: Generate a story outline using the 3-act structure
category: creative
tags: [creative, writing, storytelling]
---
# Story Outline

Generate a story outline using the 3-act structure for: {{args}}

**Act 1 — Setup:**
- Opening scene (hook in 1 sentence)
- Protagonist introduced + their ordinary world
- Inciting incident — what disrupts the ordinary world?

**Act 2 — Confrontation:**
- Rising action (3-4 obstacles/complications)
- Midpoint — things seem to turn around, then get worse
- Dark night of the soul — all seems lost

**Act 3 — Resolution:**
- Climax — protagonist faces the central conflict
- Resolution — the aftermath
- Thematic statement — what does the story say?

**Characters:** protagonist, antagonist, key supporting roles (one sentence each)
`,
  },

  // ── ML-Ops ────────────────────────────────────────────────────────────────────
  {
    name: 'experiment-tracking',
    content: `---
description: Set up ML experiment tracking with clear metrics and reproducibility
category: ml-ops
tags: [ml, mlops, experiments, tracking]
---
# Experiment Tracking Setup

Set up proper experiment tracking for: {{args}}

**What to track per experiment:**
- Hyperparameters (all of them — use a config dict)
- Metrics at each epoch/step: train loss, val loss, target metric
- Dataset version / hash
- Code version (git commit)
- Environment (Python version, key package versions)
- Training time + hardware

**MLflow setup (free, self-hosted):**
\`\`\`python
import mlflow
mlflow.set_experiment("my-experiment")
with mlflow.start_run():
    mlflow.log_params(config)
    mlflow.log_metrics({"val_loss": val_loss, "accuracy": acc})
    mlflow.sklearn.log_model(model, "model")
\`\`\`

**Naming convention:** [model]-[dataset]-[date]-[brief-description]

**Baseline run:** always run a simple baseline first for comparison.
`,
  },
  {
    name: 'model-deploy',
    content: `---
description: Deployment plan for an ML model — API, monitoring, rollback
category: ml-ops
tags: [ml, deployment, production, monitoring]
---
# ML Model Deployment Plan

Plan the deployment of: {{args}}

**Serving options (pick one):**
1. FastAPI wrapper — simple, full control, host anywhere
2. BentoML — packaging + serving + versioning
3. Hugging Face Inference API — zero infra, pay per call
4. SageMaker / Vertex AI — managed, auto-scale

**API contract:**
\`\`\`python
POST /predict
{ "input": [...] }
→ { "prediction": ..., "confidence": ..., "model_version": "v1.2" }
\`\`\`

**Monitoring:**
- Input distribution drift (compare to training set)
- Output distribution (alert if predictions shift)
- Latency P50/P95/P99
- Error rate

**Rollback:** shadow mode → canary (5%) → full rollout

**Model versioning:** never overwrite — always version (v1, v2...) + keep last 3
`,
  },

  // ── Diagramming ───────────────────────────────────────────────────────────────
  {
    name: 'architecture-diagram',
    content: `---
description: Generate a system architecture description and Mermaid diagram
category: diagramming
tags: [architecture, diagram, mermaid, systems]
---
# Architecture Diagram

Generate an architecture description and Mermaid diagram for: {{args}}

**Components to identify:**
- User-facing layer (clients, CDN, load balancer)
- Application layer (services, APIs)
- Data layer (databases, caches, queues)
- External services (third-party APIs, auth, email)
- Async workers / background jobs

**Output:**
1. Plain English description of data flow (numbered steps)
2. Mermaid flowchart (copy-paste ready):

\`\`\`mermaid
graph TD
    Client --> LB[Load Balancer]
    LB --> API[API Server]
    API --> DB[(Database)]
    API --> Cache[(Redis)]
\`\`\`

3. Key design decisions and tradeoffs
`,
  },
  {
    name: 'erd',
    content: `---
description: Generate an Entity Relationship Diagram from a data model description
category: diagramming
tags: [database, ERD, schema, diagram]
---
# Entity Relationship Diagram

Generate a database ERD for: {{args}}

Output:
1. **Entities** — list with their key attributes
2. **Relationships** — one-to-many, many-to-many, one-to-one (with cardinality notation)
3. **Mermaid ER diagram:**

\`\`\`mermaid
erDiagram
    USER {
        string id PK
        string email
        datetime createdAt
    }
    POST {
        string id PK
        string userId FK
        string title
    }
    USER ||--o{ POST : "writes"
\`\`\`

4. **Indexes to add** — FKs, frequently queried columns
5. **Soft-delete pattern** — if applicable
`,
  },

  // ── Social Media ──────────────────────────────────────────────────────────────
  {
    name: 'twitter-thread',
    content: `---
description: Write a Twitter/X thread that builds a following and drives engagement
category: social-media
tags: [twitter, thread, content, social]
---
# Twitter Thread Writer

Write a Twitter/X thread about: {{args}}

Format:
- Tweet 1 (hook): bold claim or surprising stat. No "A thread 🧵" opener.
- Tweets 2-8: build the argument with one key point each
- Each tweet: max 250 chars, ends with a hook to the next
- Last tweet: strong takeaway + call to action

Rules:
- Concrete > abstract. Numbers beat adjectives.
- No corporate speak or "excited to share"
- Each tweet should be shareable standalone
- Use line breaks for readability in longer tweets
`,
  },
  {
    name: 'linkedin-post',
    content: `---
description: Write a LinkedIn post that's authentic and drives professional engagement
category: social-media
tags: [linkedin, content, social, professional]
---
# LinkedIn Post

Write a LinkedIn post about: {{args}}

Format:
- Line 1: hook (question, bold statement, or surprising fact)
- Lines 2-5: story or key insight (personal experience preferred)
- Lines 6-8: practical takeaway for the reader
- Call to action: one specific question

Rules:
- No buzzwords (passionate, excited, humbled, journey, learnings)
- Short paragraphs — max 3 lines each
- Use blank lines liberally (LinkedIn cuts off at 3 lines)
- First person, conversational tone
- 150-300 words optimal
`,
  },

  // ── Note-taking ───────────────────────────────────────────────────────────────
  {
    name: 'second-brain',
    content: `---
description: Process raw notes into structured, linked knowledge base entries
category: note-taking
tags: [notes, PKM, second-brain, zettelkasten]
---
# Second Brain Note Processor

Process the following raw notes into structured knowledge base entries.

For each distinct idea/concept:

**Title:** [Concept Name]
**Summary:** 1-2 sentences — what is this?
**Key insight:** the non-obvious thing worth remembering
**Evidence/examples:** concrete cases that illustrate this
**Connections:** what other concepts does this relate to?
**Questions:** what this raises that I don't know yet
**Source:** [where this came from]
**Tags:** #[relevant] #[tags]

Raw notes to process: {{args}}
`,
  },
  {
    name: 'book-summary',
    content: `---
description: Summarize a book into key insights, quotes, and action items
category: note-taking
tags: [reading, summary, books, learning]
---
# Book Summary

Summarize the key insights from: {{args}}

Structure:
**One-paragraph overview:** what the book is about and the central argument

**Core ideas (top 5-7):**
- [Idea]: [explanation in 2-3 sentences] [best supporting quote if known]

**Mental models introduced:**

**What the author gets right:**

**Where I'd push back:**

**Action items — what to do differently:**
1.
2.
3.

**Best quote:**

**Who should read this + why:**

**Who should skip it + why:**
`,
  },
];
