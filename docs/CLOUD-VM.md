# Running Robin on a cloud VM

Provider-neutral runbook for the Linux host: the daemon runs as a systemd user
service under a dedicated `robin` user. Names below (`robin`, `/home/robin`,
`example-vm`) are placeholders.

## 1. VM

- Debian 12 or Ubuntu 24.04.
- 4-8 GB RAM, about 80 GB disk.
- Outbound network only. Robin opens no listening ports.

## 2. User and checkout

```bash
# as root (or via the provider's console), once
adduser robin
usermod -aG sudo robin

# then as robin
ssh robin@example-vm
git clone <repo-url> ~/robin-assistant-v3
```

## 3. Bootstrap

```bash
cd ~/robin-assistant-v3
bash system/scripts/vm/bootstrap.sh --dry-run   # review every action
bash system/scripts/vm/bootstrap.sh
```

The script is idempotent, so re-running it is safe. It installs system
packages (bubblewrap, git, build tools, sqlite3, rsync), Node 24 and pnpm
10.33.0 (via corepack), sets the host timezone (`ROBIN_TZ`, else operator.yaml `timezone:`), enables
linger, installs the Claude Code CLI and `cloudflared`, runs
`pnpm install --frozen-lockfile && pnpm build`, creates `daemon.env`, and runs
the systemd unit install (`daemon install`, pointed at the checkout's `user-data/`). `ROBIN_HOME` overrides the checkout path.

If linger was off, the install prints
`Linger is off — the daemon stops at logout. Run: sudo loginctl enable-linger $USER`.
The bootstrap already enables it; log out and back in if you see the line.

## 4. Secrets

Tokens go in `~/robin-assistant-v3/user-data/config/secrets/daemon.env`
(mode `0600`), and nowhere else. It is daemon-only in one sense: it is never
exported in a shell. Fill in by hand:

```
CLAUDE_TOKEN_ROBIN=...        # account 2 (Robin's default), from claude setup-token
CLAUDE_TOKEN_SHARED=...       # account 1 (your interactive account; borrowed when Robin's is limited)
CLAUDE_CREDIT_KEY_ROBIN=...   # API key, Console org linked to account 2 (no auto-reload)
CLAUDE_CREDIT_KEY_SHARED=...  # API key, Console org linked to account 1 (no auto-reload)
```

Fill these, then `systemctl --user restart robin-daemon`. The daemon gets the
file through its systemd unit (`EnvironmentFile=`); every `robin` CLI command and
MCP server reads it itself at startup, so nothing needs exporting. `robin
accounts` shows each credential's limits, expiry and last use; `robin doctor`
warns 30 days before a token lapses.

Never put them in `~/.bashrc` or any shell profile. `CLAUDE_CODE_OAUTH_TOKEN`
outranks a normal `/login`, so a shell-wide export would silently put your own
interactive `claude` sessions on Robin's account.

After editing: `systemctl --user restart robin-daemon`.

## 5. Check the daemon

```bash
systemctl --user status robin-daemon
systemctl --user is-active robin-daemon
journalctl --user -u robin-daemon -f
pnpm robin doctor   # run from the checkout; `robin` is not on PATH
```

## Expected warning

On Linux, `pnpm robin doctor` warns `agent.auto_land_sandbox` (auto-land is enabled
without an OS sandbox). That is expected until a later milestone. To silence it,
set `agent.auto_land: false`.

## Moving Robin

`robin cloud` moves the live instance between the Mac and the VM. Run it on the
Mac, from a terminal (not from a Claude Code session: that session's Robin MCP
servers hold the DB open). `--host` is your ssh alias for the VM
(`example-vm` below).

```bash
robin cloud status   --host example-vm   # roles, both daemons, who is the writer
robin cloud dry-run  --host example-vm   # rehearse: copy to a held VM
robin cloud cutover  --host example-vm   # make the VM the writer
robin cloud rollback --host example-vm   # bring the VM's data home
```

### One writer

At no point do both daemons run against their own copy. Each side carries a
role marker, `user-data/state/runtime/cloud-role.json`, which never moves
between machines:

| Role | Meaning |
|---|---|
| none | an ordinary single-machine Robin |
| `mac-locked` | the Mac copy must not run: the daemon exits at start, the CLI refuses everything but `cloud` |
| `vm-dry-run` | a held VM: it serves `/health`, but runs no job or integration in any process |
| `vm-primary` | the live VM |

Every command reads both roles first and refuses an out-of-order step,
printing both roles and what is allowed:

- `dry-run`: the Mac has no role, and the VM has none or is `vm-dry-run`.
- `cutover`: the VM has none or is `vm-dry-run`, and the Mac has no role or is
  locked to this host (that resumes an unfinished cutover).
- `rollback`: the Mac is locked to this host. If the VM is `vm-primary` (or a
  rollback already started), the VM's data comes home. Otherwise the cutover
  never finished, so rollback only unlocks the Mac and never pulls the VM's DB.

Every step prints `[n/N] <step>`, then `ok` or `FAILED: <reason>`. After a
failure, fix the cause and re-run the same command. Steps are idempotent.

### Before you start

- The VM's checkout must be at the Mac's commit and built (`dist/.build-stamp`).
- GNU rsync 3 or later on the Mac (`brew install rsync`). macOS
  `/usr/bin/rsync` is openrsync and is refused.
- The VM needs free disk of at least twice the transfer size.
- The Mac needs a few GB of temp disk for the DB snapshot. Scrubbing a
  ~1.4 GB snapshot takes about 25–30 s.

### dry-run

The Mac keeps running and stays the writer. The command snapshots the Mac DB
and scrubs the Mac-only rows from the copy (iMessage archive rows, their
content, FTS and vectors; the Mac's own DB is never scrubbed). It then stops
the VM daemon and marks the VM `vm-dry-run` before any data lands. It pushes
user-data (additive rsync, never `--delete`, with the fixed exclude list; the
voice corpus stays on the Mac), installs the snapshot as the VM DB and starts
the VM held. To verify, it checks `/health`, checks that `doctor` reports no
failures (warnings are expected on Linux), and prints the snapshot's `events`
count next to the VM's. Compare against the snapshot, not the live Mac, which
keeps writing.

Dry-run is safe to repeat. A held VM never ticks an integration, so it never
spends the WHOOP token it holds.

### cutover

You confirm with `--yes` or by typing `cutover`. First there is a known-gaps
check. It refuses unless you pass `--accept-gaps`, and lists each gap:

- `~/.claude/settings.json` hooks still post to `127.0.0.1:41273`. Mac session
  capture and recall would fail silently until M5.
- The VM has no backup timer (M5).

Then, in this order:

1. Lock the Mac (`mac-locked`), so nothing can restart it.
2. Pause it (`power.state: paused`).
3. Drain: wait for Robin's agent, cognition and auto-land children to finish.
   This can take up to 50 min; agent runs cap at 30 and cognition at 45.
4. Stop and disable both Mac launchd jobs, `io.robin-assistant.daemon` and
   `io.robin-assistant.mcp-remote`. The claude.ai connector is a writer too.
5. Wait until nothing holds the Mac DB. Close the Claude Code sessions it
   names.
6. Snapshot and scrub.
7. Stop the VM, hold it (`vm-dry-run`) and clear its `state/runtime/`.
8. Push user-data and the snapshot.
9. Mark the VM `vm-primary`, start it and run `robin resume` there.
10. Verify: `/health`, `doctor` without failures, and a job or integration run
    on the VM within 15 min.

If anything fails from step 9 on, the VM is parked: role back to `vm-dry-run`,
daemon stopped. The Mac stays locked. Re-run `cutover`, or `rollback`, which
then only unlocks the Mac.

After cutover, Mac Claude Code sessions have no Robin MCP tools. The CLI
refuses under the lock, and the tools come back when M5 points the sessions at
the VM.

### rollback

You confirm with `--yes` or by typing `rollback`. In order:

1. The Mac records that a rollback is in progress. A re-run after a failure
   then stays a data rollback, even though the VM reads `vm-dry-run` by then.
2. The VM is held (`vm-dry-run`, read live by every VM process) and paused.
3. The daemon's control group is read while the unit is still active, then the
   VM drains (its cgroup children, up to 50 min).
4. The VM is stopped, and the command checks that nothing holds the VM DB.
5. The VM snapshots its DB (`robin db backup` into `user-data/backups/` on the
   VM, kept there). The Mac pulls the snapshot and restores its Mac-only rows
   into it (the embedder re-embeds them), then pulls user-data.
6. The snapshot is installed as the Mac DB. The previous one moves to
   `state/db/pre-rollback-<ts>/` and is never deleted.
7. The Mac resumes, unlocks and restarts both launchd jobs. Verify: `/health`,
   `doctor` without failures.

The VM ends stopped and held. It never restores a pre-cutover snapshot: the DB
that comes home is the one pulled from the VM in that run.

### Rotating tokens

WHOOP's refresh token is single-use and lives in the DB, so it moves with the
DB snapshot, once per cutover or rollback. The side it left is stopped and held
before the copy is taken, so it can never tick with the old token. A re-run of
a parked cutover keeps any newer OAuth token row the VM wrote. One gap
remains: a cutover parked after the VM ran for a while, followed by an
unlock-only rollback, resumes the Mac on its own (possibly spent) token. If
WHOOP then fails, run `robin reauth whoop`.

### If the VM is gone

`rollback` needs ssh to read the VM's role. If the VM is lost for good, unlock
by hand: delete `user-data/state/runtime/cloud-role.json`, run `robin resume`,
then `launchctl enable gui/$(id -u)/io.robin-assistant.daemon` and
`launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.robin-assistant.daemon.plist`.
Robin then runs on the Mac's pre-cutover data.

## Tests on Linux

`pnpm test:linux` runs the build, typecheck and suite in a Docker container
from a clean copy of the repo.
