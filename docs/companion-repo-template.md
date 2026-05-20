# Companion Repo Template (`robin-personal`)

Per the design doc §15, personal Robin configuration + extensions live in a **private git repo** that mirrors a `user-data/` tree. The Robin daemon points at this repo via `ROBIN_USER_DATA_DIR`.

This document is the template + setup steps.

## Why a separate repo

- Keeps personal data (secrets, integration tokens, captured memory snippets) out of the public npm package
- Enables multi-machine sync via plain `git push` / `git pull`
- Version-controls your config, extensions, jobs, skills, and artifacts
- Companion to the npm package: the *system code* is installed via `pnpm add -g robin-assistant`; the *user data* is checked out from your private repo

## Quick start

```bash
# 1. Create the repo on GitHub (or any private git host).
#    Name: <yourname>/robin-personal — keep it private.

# 2. Clone to your dev machine
git clone git@github.com:<you>/robin-personal.git ~/robin-personal
cd ~/robin-personal

# 3. Seed it with the template structure
mkdir -p user-data/{config/{secrets,templates},extensions/{integrations,skills,jobs,triggers,scripts},content/{artifacts,sources},observability/{logs,eval}}

# 4. Add the recommended .gitignore (see below)
cat > .gitignore <<'GITIGNORE'
# State is per-machine; regenerable from the source-of-truth db
user-data/state/db/
user-data/state/kuzu/
user-data/state/runtime/
user-data/state/migrations/
user-data/observability/logs/
user-data/observability/eval/
# Per-machine config
user-data/config/hardware.yaml
# Decrypted secrets — only the encrypted file is committed
user-data/config/secrets/.env
GITIGNORE

# 5. Set up age encryption for secrets
brew install age          # or apt install age
age-keygen -o ~/.config/age/robin-personal.key
chmod 0600 ~/.config/age/robin-personal.key
# Save the public key (echoed by age-keygen) somewhere safe — you'll use it to encrypt

# 6. Create your secrets file (gitignored) + age-encrypted form (committed)
cat > user-data/config/secrets/.env <<'EOF'
GMAIL_REFRESH_TOKEN=<paste-from-google-oauth-playground>
GMAIL_CLIENT_ID=<your-oauth-client-id>
GMAIL_CLIENT_SECRET=<your-oauth-client-secret>
GITHUB_TOKEN=<your-personal-access-token>
LINEAR_API_KEY=<from-linear-settings-api>
DEEPSEEK_API_KEY=<your-deepseek-key>
GROQ_API_KEY=<your-groq-key>
EOF

age -R <(grep '^public:' ~/.config/age/robin-personal.key | cut -d' ' -f2) \
    -o user-data/config/secrets/secrets.age \
    user-data/config/secrets/.env

# 7. Add starter configs (or write them via `robin init`)
cat > user-data/config/policies.yaml <<'EOF'
power:
  state: active
  auto:
    on_low_power_mode: paused
    on_battery_below_pct: 25
    auto_resume_on_ac: true
    quiet_hours:
      start: "23:00"
      end: "07:00"
      mode: local-only
capture:
  enabled: true
network:
  mode: online
EOF

cat > user-data/config/models.yaml <<'EOF'
roles:
  interactive: { provider: claude-code }
  agentic:     { provider: ollama, model: qwen3.6:35b-a3b-mlx-q4 }
  reasoning:   { provider: deepseek, model: deepseek-chat, apiKeyEnv: DEEPSEEK_API_KEY }
  summarize:   { provider: ollama, model: qwen3.6:35b-a3b-mlx-q4 }
  classify:    { provider: groq,    model: llama-3.3-70b-versatile, apiKeyEnv: GROQ_API_KEY }
  embed:       { provider: ollama,  model: qwen3-embedding-4b-mlx-q4 }
EOF

# 8. First commit
git add .
git commit -m "init: companion repo skeleton"
git push -u origin main

# 9. Point Robin at it
export ROBIN_USER_DATA_DIR=~/robin-personal/user-data
# Add to your ~/.zshrc / ~/.bashrc so it persists

# 10. Run init to apply schema + register MCP + register launchd
robin init --yes
robin mcp install
robin doctor   # verify all checks pass
```

## Directory layout

```
robin-personal/
├── .gitignore
├── README.md                          # (yours — describe your setup)
├── user-data/
│   ├── config/
│   │   ├── models.yaml                # ✓ committed (no secrets in here)
│   │   ├── policies.yaml              # ✓ committed
│   │   ├── integrations.yaml          # ✓ committed (enable/disable per machine fine to override locally)
│   │   ├── profile.yaml               # ✓ committed (identity hints)
│   │   ├── hardware.yaml              # ✗ gitignored — machine-specific
│   │   ├── secrets/
│   │   │   ├── secrets.age            # ✓ committed (age-encrypted)
│   │   │   └── .env                   # ✗ gitignored (decrypted, mode 0600)
│   │   └── templates/                 # ✓ committed (your prompt + integration templates)
│   ├── extensions/                    # ✓ all committed — your code
│   │   ├── integrations/              # custom integrations: whoop, ebird, letterboxd, etc.
│   │   ├── skills/                    # custom skills
│   │   ├── jobs/                      # custom scheduled jobs
│   │   ├── triggers/                  # custom event triggers
│   │   └── scripts/                   # one-shot scripts
│   ├── content/
│   │   ├── artifacts/                 # ✓ committed (markdown deliverables Robin wrote for you)
│   │   └── sources/                   # mixed — small reference files committed; large binaries gitignored
│   ├── state/                         # ✗ all gitignored — per-machine
│   │   ├── db/                        # SQLite + WAL — sync via restic, not git
│   │   ├── kuzu/                      # regenerable from db/
│   │   ├── runtime/                   # pid, sockets
│   │   └── migrations/                # applied-migration ledger
│   └── observability/                 # ✗ gitignored
│       ├── logs/
│       └── eval/
```

## State sync (the DB doesn't go in git)

SQLite binary diffs poorly. A 2GB DB committed weekly becomes ~8GB of `.git/objects` in a few months. Use `restic` or `rclone` with age encryption for state sync instead:

```bash
# Install restic
brew install restic

# Initialize a repo at any cloud target you control (S3, B2, Storj, Hetzner Object, etc.)
export RESTIC_REPOSITORY=b2:robin-personal-state
export RESTIC_PASSWORD_FILE=~/.config/restic/robin-personal.pwd
restic init

# Daily backup (add to a cron or robin job)
restic backup \
  ~/robin-personal/user-data/state/db \
  ~/robin-personal/user-data/state/kuzu \
  --exclude '*.wal'

# On a new machine: install npm package, clone repo, then
restic restore latest --target ~/robin-personal/user-data
```

Robin can also do this for you via `robin db backup --to <restic-uri>` (see roadmap).

## Multi-account integration example

To run both work and personal Gmail at once, use the `<name>--<instance>` directory pattern (supported by the integration loader):

```
user-data/extensions/integrations/
├── gmail--work/
│   ├── integration.yaml      # name: gmail (the base)
│   └── index.js              # could be a thin re-export of system/integrations/builtin/gmail
└── gmail--personal/
    ├── integration.yaml
    └── index.js
```

Each instance has its own KV namespace (`gmail--work`, `gmail--personal`) and is scheduled + run separately. Configure separate `GMAIL_WORK_*` and `GMAIL_PERSONAL_*` env-var prefixes via the integration's own logic.

## Threat model

- **`robin-personal` is a private git repo** — leaking it leaks your structured memory + encrypted secrets blob
- **The age private key is NEVER in the repo** — it lives in `~/.config/age/` (chmod 0600) and gets synced manually between your machines (1Password, Bitwarden, USB stick, etc.)
- **2FA on the GitHub account hosting the repo is mandatory**
- **Don't put production-critical client data in the captured memory** — use `robin incognito` or `policies.yaml.capture.blocked_paths` to keep sensitive directories out

## Companion-to-companion: keeping the structure synced

When the Robin npm package adds new `user-data/` subdirectories (e.g., a new `extensions/` subfolder), update your `robin-personal` accordingly. `robin doctor` will warn if expected directories are missing.

## License

This template document is part of Robin and is MIT-licensed. The contents of *your* `robin-personal` repo are yours.
