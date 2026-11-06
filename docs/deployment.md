# Static deployment: slotrush.jdwd40.com

## Scope and verified target

This is a **static browser game**. No production Node process, multiplayer backend,
database or Docker stack is required. No `src/`, save keys or save formats are changed.

The inspected SSH alias `app-vps` resolves to user `jd`, tailnet address
`100.103.129.22`, port `4020`. The host reports hostname `my-vps` and public IPv4
`213.165.91.221`, matching `jdwd40.com`. The bare historical alias `my-vps` is not a
configured local SSH alias. Use `app-vps` for administration, not root SSH.

Dedicated site: `/srv/www/slotrush.jdwd40.com`:

- `releases/<UTC timestamp>-<commit prefix>/` — complete static releases
- `current` — atomically replaced relative symlink used by Nginx
- `previous` — the immediately preceding live release (also toggles forward)
- `REVISION` and `ARTIFACT_SHA256` within each new release identify source/artifact
- `.deploy.lock` — exclusive server-side lock shared by deploy/rollback/status
- `deploy.log` — pre-publication switch intents, no credentials; an intent is not
  proof that publication succeeded (consult `status`)

Releases are retained, not automatically deleted. An administrator may remove old
inactive releases **only after checking both current and previous**, keeping at
least those two and any desired recovery releases. Watch disk usage during routine
maintenance.

## Trust boundary and one-time provisioning

`slotrush-deploy` is dedicated to this site. It has no sudo requirement. The
root-owned executable `/usr/local/bin/slotrush-receive` is installed from
`deploy/slotrush_receive.py`, mode 0755. Its forced-command key permits only:

```text
deploy <40-lowercase-hex commit> <64-lowercase-hex archive SHA256> [candidate-release-name]
rollback [release-directory-name]
rollback-if <expected-current-release-name> <target-release-name>
status
```

No eval, arbitrary shell, rsync, SFTP or remote builds are accepted. The public-key
entry in `/home/slotrush-deploy/.ssh/authorized_keys` uses:

```text
restrict,command="/usr/local/bin/slotrush-receive" ssh-ed25519 <public key> <label>
```

`restrict` disables PTY, port/agent/X11 forwarding and user rc. The account's home
and SSH configuration are private. The receiver bounds compressed/uncompressed
sizes and entry count. It fully decompresses gzip into a bounded staging `.tar`
**before parsing any tar headers**, counting all bytes including PAX/GNU extension
metadata, headers and padding, then applies bounded member validation. It rejects
traversal/links/special files/duplicate names, validates page assets, stages fully,
then switches with `os.replace` on the same filesystem. Archive validation and
switch-log write/flush/close failures leave `current` untouched. Switch logging
and `previous` preparation happen before publishing `current`; no fallible logging
follows that publication.

CI preassigns a timestamp/microsecond candidate name ending in the checked commit
prefix. The receiver validates its format/suffix and refuses an existing name.
`rollback-if` compares the exact candidate name and switches to the explicitly
captured old release under the **same exclusive lock**, so another publisher's
current release cannot be rolled back by a stale recovery decision. `status`
includes `current`, `previous`, current `revision`, `artifact_sha256` (null for
legacy releases without those metadata files), and retained `releases`. Install
this receiver version before using the updated CI script; the older forced
command does not support candidate names or guarded rollback.

The installed Bash receiver was backed up and replaced with this Python receiver
on 2026-11-06. Backup directory:
`/etc/nginx/config-backups/slotrush-20261106T192907Z/` contains
`slotrush-receive.before`, `slotrush.jdwd40.com.before`, and `current-target.txt`.
A fresh SSH readback confirmed root ownership, mode 0755, and the installed
receiver SHA256 matched the repository file. The new restricted key successfully
deployed a versioned build, rejected arbitrary shell/checksum-negative controls,
rolled back to the retained old release, and rolled forward; public HTTP override
probes verified all four built files and their content types/checksums.
This does **not** establish public DNS or HTTPS readiness.

Repository secrets (values must never be logged or committed):

- `SLOTRUSH_SSH_KEY`: repository-specific private Ed25519 key
- `SLOTRUSH_KNOWN_HOSTS`: `[213.165.91.221]:4020` and the public host key retrieved
  through the pre-existing authenticated, strictly verified administration SSH
  connection. Fingerprint: `SHA256:SablVMq3mOwNPITXd6hCafp4k/Ph5O5Ff1da9d/rNPk`.

The workflow requires `StrictHostKeyChecking=yes`, that exact pinned file,
`HostKeyAlgorithms=ssh-ed25519`, `IdentitiesOnly=yes`, and non-root SSH.
Host-key rotation requires independent verification and a deliberate secret update;
never work around a failure with `StrictHostKeyChecking=no` or live `ssh-keyscan`.
An old restricted key existed before this deployment; it is not reused, modified or
removed. Revoke it separately only after identifying its owner/use.

## DNS, Nginx and TLS

DNS required: `A slotrush 213.165.91.221`, TTL 300. Remove conflicting A/AAAA records.
The initial inspection returned NXDOMAIN; DNS completion and TLS must be verified,
not inferred from this runbook.

The isolated enabled file is `/etc/nginx/sites-available/slotrush.jdwd40.com`, linked
from `sites-enabled`. An existing HTTP-only bootstrap was already present. The
production TLS template is `deploy/nginx/slotrush.jdwd40.com.conf`. It serves real
files only: missing assets return 404, not the HTML entrypoint. Hashed assets get
one-year caching; HTML, favicon and release metadata revalidate. HTTP keeps an ACME
webroot at `/var/www/html`, redirecting other requests to HTTPS once TLS is enabled.

After public DNS resolves to this VPS, an administrator can issue just this site's
certificate using the existing ACME account, without editing shared vhosts:

```bash
ssh app-vps 'sudo certbot certonly --webroot -w /var/www/html \
  -d slotrush.jdwd40.com --cert-name slotrush.jdwd40.com --non-interactive \
  --deploy-hook "nginx -t && systemctl reload nginx"'
```

Back up the exact site file and receiver immediately before replacing them, in a
timestamped directory under `/etc/nginx/config-backups/` (not `sites-enabled`).
Copy the TLS template only after the certificate exists. Then:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

If validation fails, restore the backed-up site before any reload. Inspect the
existing certbot renewal timer/hooks; ensure a successful renewal reloads Nginx.
Use a site-specific renewal hook rather than unnecessarily altering global config.
Existing duplicate `jdwd40.com` warnings caused by pre-existing enabled backup files
are outside this site's scope and must not be silently cleaned up.

## CI artifact chain

`.github/workflows/ci.yml` retains the existing successful check job:

1. Node from `.nvmrc` (22; project minimum 22.12), `npm ci` from the lockfile.
2. `npm run typecheck`, all game regression tests, deployment-tool tests.
3. One `npm run build`.
4. Package `dist/` plus a SHA256 file manifest and source commit.
5. Upload the immutable artifact for 30 days; fail if missing.

Only a **push to main** with a successful prerequisite check job can deploy. PRs
never get deployment secrets. The deploy job downloads the exact artifact ID
output by that check job, not a latest artifact or another run. It checks source
commit/archive SHA256, fails before switching if public HTTPS is unavailable,
streams the tarball to the forced command, then checks public REVISION, artifact
identity, hashes/content types of **every built file**, and a missing-asset 404.
The script captures the exact old release and marks its candidate pending **before**
starting deployment SSH. Deployment SSH failure (including exit 255 after a lost
publication acknowledgement), failed verification, and EXIT/INT/TERM while pending
all enter the same recovery path. It queries remote status, leaves an unrelated
current release untouched, and uses `rollback-if` to restore only its own candidate
to that captured old target. It reads status back after rollback even if the
rollback SSH acknowledgement was lost. A failed/unverified deployment always
fails the job, including when recovery succeeds. Success additionally requires
remote current name, revision and artifact checksum to match the verified candidate.

Public verification has one **120-second global deadline**, plus a 5-second
forced-kill grace, regardless of file count or per-request timeouts. Deployment
SSH is also bounded to 120 seconds. Artifact loading and each SSH status/rollback
call have 30-second deadlines plus 5-second kill grace; HTTPS preflight has a
30-second curl deadline. Recovery uses at most three bounded remote operations
(status, guarded rollback, status). This budgets time for recovery inside the
10-minute job rather than allowing a stalled verification to consume the job.
The script's bounded operations conservatively budget about 490 seconds including
kill grace and recovery, leaving about 110 seconds for checkout/download/setup
and local scheduling; this is not a guarantee if runner setup or scheduling stalls.
Long deploy/verify children are waited asynchronously so INT/TERM can stop them
and enter recovery promptly. Short status calls can defer traps until their
bounded command finishes. Repeated INT/TERM are ignored during bounded cleanup.

**Limits:** recovery is runner-side best effort, not a server-side transaction or
watchdog. No service/daemon is installed. SIGKILL, total runner loss, hard job
termination (including exhaustion of the CI cancellation grace), or loss of SSH
connectivity can prevent recovery and leave an unverified candidate live. When
recovery cannot confirm the old release, logs say `RECOVERY UNCONFIRMED` and the
job fails; they do not claim a rollback succeeded. Inspect `status` and perform
manual recovery below once reachable. Another publisher replacing the candidate
is deliberately not undone. Neither flock nor GitHub concurrency protects against
all manual publishers; flock serializes each command, not the entire public
verification window. Recovery does not re-run public verification of the retained
old release. Runner key files are deleted in an always step when the runner still
executes it. GitHub concurrency disables cancellation of an in-flight main deploy.

No source checkout, npm install or rebuild occurs on the VPS. GitHub Actions itself
builds the artifact. All referenced third-party Actions are pinned to verified
commit IDs. Artifact verification uses Python's normal TLS certificate validation.

## Rollback and roll-forward (no build or reload)

Pause/avoid new main pushes during manual recovery. Inspect retained targets:

```bash
ssh app-vps 'sudo -u slotrush-deploy /usr/local/bin/slotrush-receive status'
```

Restore the explicit known-good release from that output (recommended):

```bash
ssh app-vps 'sudo -u slotrush-deploy /usr/local/bin/slotrush-receive rollback RELEASE_NAME'
```

Or `rollback` without a name switches to `previous`. It updates `previous` to the
release being replaced, so another `rollback` can roll forward. Nginx reads the
symlink immediately; no restart/reload is needed. Verify the public `REVISION`,
HTML, referenced JS/CSS, favicon and browser startup after either direction. A
rollback changes static files only and does not delete or transform localStorage.
To make the source branch match a permanent recovery, revert the bad commit and
push main; successful checks will deploy a newly checked build.

Configuration rollback is separate: restore the recorded backup of the site,
`nginx -t`, then reload only Nginx. Do not roll back neighboring files or stop apps.
To revoke this CI identity remove only its exact labeled public-key entry and the
two named repository secrets; preserve all other keys/services.

## Local tooling checks

```bash
npm run typecheck
npm test
npm run build
python3 -m unittest discover -s deploy -p 'test_*.py' -v
bash -n deploy/run.sh
python3 deploy/artifact.py pack dist bundle "$(git rev-parse HEAD)"
# Only after that bundle has been deployed:
python3 deploy/artifact.py verify bundle "$(git rev-parse HEAD)" https://slotrush.jdwd40.com
```

A successful GitHub push, successful check job, HTTP override probe, and fully
working public HTTPS deployment are distinct milestones. Report their actual
states separately if DNS/authentication prevents completion.
