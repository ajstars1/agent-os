# Getting Started with AgentOS

This guide walks from zero to a running agent, first skill, and first agent profile.

---

## Prerequisites

| Requirement | Minimum version | Check |
|---|---|---|
| Node.js | 20 | `node --version` |
| npm | 10 | `npm --version` |
| git | any | `git --version` |

**At least one API key** (you can start with either):
- **Anthropic (Claude)** → [console.anthropic.com](https://console.anthropic.com/)
- **Google (Gemini)** → [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)

Having both enables auto-routing, full HAM compression, and L4 self-learning.

---

## Option A — One-step curl install (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/ajstars1/agent-os/main/install.sh | bash
```

The installer will:
1. Check Node.js ≥ 20, git, and npm
2. Clone the repository into `~/.agent-os-src` (or `git pull` if already present)
3. Run `npm install && npm run build`
4. Create `~/.agent-os/` and write a `.env` template
5. Symlink `~/.local/bin/aos` to the CLI entry point
6. Offer to accept your API key interactively
7. Print a PATH hint if `~/.local/bin` is not in your shell's PATH

After install, add `~/.local/bin` to your PATH if prompted:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PATH="$HOME/.local/bin:$PATH"
source ~/.bashrc   # or source ~/.zshrc
```

Then run:

```bash
aos
```

---

## Option B — Manual install

```bash
# 1. Clone
git clone https://github.com/ajstars1/agent-os.git
cd agent-os

# 2. Install dependencies
npm install

# 3. Configure
cp .env.example .env
# Edit .env — at minimum, set ANTHROPIC_API_KEY

# 4. Build all packages
npm run build

# 5. (Optional) Seed default knowledge into HAM
npm run seed-memory

# 6. Run
npm run cli
```

---

## First run

```
  AgentOS  ─ claude · 0 skills · 0 topics

  ❯ 
```

The top line shows:
- Active model (`claude`, `gemini`, or `auto`)
- Number of loaded skill files
- Number of HAM memory topics

Try:

```
❯ hello
```

The agent responds. Token usage is shown at the bottom of each reply.

---

## Configuring your API key

If you didn't set the key during install, you have three options:

**Option 1 — In-CLI command:**

```
❯ /config set ANTHROPIC_API_KEY sk-ant-...
```

The key is written to `~/.agent-os/.env` and hot-reloaded immediately.

**Option 2 — Browser UI:**

```
❯ /config web
  Config UI started at http://localhost:7877
  Open in browser — changes sync to terminal in real-time.
```

Open the URL, fill in your key, click Save. Done.

**Option 3 — Direct file edit:**

```bash
nano ~/.agent-os/.env
# Set ANTHROPIC_API_KEY=sk-ant-...
```

Restart `aos` after editing the file directly.

---

## Your first skill

Skills are Markdown files that teach the agent domain knowledge. They are compressed via HAM and injected as system context.

1. Create the skills directory:

```bash
mkdir -p ~/.claude/skills
```

2. Write a skill file:

```bash
cat > ~/.claude/skills/my-project.md << 'EOF'
# Skill: My Project

My project is a SaaS app for managing restaurant reservations.

Tech stack: Next.js 14, Supabase, Stripe, TypeScript.

Key commands:
- npm run dev — start dev server on port 3000
- npm run db:migrate — run Prisma migrations
- npm run test — run Vitest tests
EOF
```

3. Restart `aos`. The skill appears immediately:

```
❯ /skills
  Loaded skills:
    • My Project
```

4. The agent now knows about your project:

```
❯ how do I run migrations?
  Run npm run db:migrate — this runs Prisma migrations against your Supabase database.
```

---

## Your first agent profile

Agent profiles customize the agent's name, system prompt, and default model.

1. Create the agents directory:

```bash
mkdir -p ~/.agent-os/agents
```

2. Write a profile:

```bash
cat > ~/.agent-os/agents/cto.json << 'EOF'
{
  "name": "cto",
  "description": "Technical advisor focused on architecture decisions",
  "systemPrompt": "You are a senior CTO advising on architecture, scaling, and engineering decisions. Be direct and opinionated. Prefer proven solutions over novel ones.",
  "defaultModel": "claude",
  "skills": []
}
EOF
```

3. List profiles:

```
❯ /agents
  Agent profiles (1):
    • cto — Technical advisor focused on architecture decisions
```

4. Load the profile at startup:

```bash
aos --agent cto
```

---

## Switching models

```
❯ /model gemini          # switch to Gemini Flash for this session
❯ /model auto            # let AgentOS decide per message
❯ /model gemini:pro      # Gemini 1.5 Pro specifically
```

Per-message override (without switching sessions):

```
❯ cc: explain this algorithm   → always Claude
❯ g: summarise this file       → always Gemini
```

---

## Checking memory

```
❯ /memory list           # all topics with one-line L0 headlines
❯ /memory stats          # access counts and last-accessed dates
```

---

## Exporting a conversation

```
❯ /export                           # saves to agent-os-export-YYYYMMDD-HHMMSS.md
❯ /export my-session.md             # saves to my-session.md in cwd
```

---

## Troubleshooting

**`aos: command not found`** — `~/.local/bin` is not in PATH. Add the export line to your shell profile and reload.

**`No API key configured`** — Run `/config set ANTHROPIC_API_KEY sk-ant-...` (or `GOOGLE_API_KEY AIza...`) or use `/config web` to set it in the browser.

**HAM compression not working** — HAM multi-level compression requires `GOOGLE_API_KEY`. Without it, knowledge is stored as plain text (L3 only). Set the key to enable full compression.

**Build fails after update** — Run `aos update` which handles `git pull + npm install + npm run build` in one step.
