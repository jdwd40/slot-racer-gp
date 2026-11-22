# Restore drill: Postgres dump and restore, release rebuild, rollback (#144)

The live game, every in-memory room and the PostgreSQL 17 database share one 256 MB-unit VPS (`app-vps`), with no second host. A process or host death drops every race in progress; accounts, careers and personal bests survive only as well as the database and its backups do. This page is the drill that proves they can be brought back: about 30 minutes, run by the owner on the host, when he chooses.

**Nothing here was run against production for #144.** The pull request added this page and a dump/restore wrapper, [`scripts/pg-backup.mjs`](../scripts/pg-backup.mjs), which is tested against a real PostgreSQL in `npm run test:db` and in CI's PostgreSQL 17 `server` job (`test/server/pgbackup.db.test.ts`). CI never logs in to the VPS.

The drill never touches the live process or the live `slotrush` database except to read it: the dump is a read-only snapshot, the restore goes into a throwaway database, and the release is unpacked into a separate directory. It needs no maintenance window. If you ever go beyond it and restart the live unit (a real rollback), do that with `/api/health` `"racing": 0`.

At the time of writing the live server runs protocol `2`, rules `race-core-2026.11.8` and schema `004_setup_bests` (the last migration in `server/migrations.ts`). Read the real values from `/api/version` in step 0; a restored copy must hold that schema.

Related runbooks: the server's [activation, upgrade and rollback](online-server.md#production-activation-runbook-owner), the database [backup and restore](accounts.md#backup-and-restore), and the static site's [rollback](deployment.md#rollback-and-roll-forward-no-build-or-reload).

## What a failure loses and what it keeps

| What | Where it lives | Service crash or restart | Host reboot (disk intact) | Host lost (disk gone) |
| --- | --- | --- | --- | --- |
| Open rooms, lobbies, seats, races in progress | Server memory | **Lost** (a restart sends aborted envelopes, never results) | **Lost** | **Lost** |
| A finished result the database could not take and the spool could not hold (`unsavedResults` in `/api/health`) | Server memory | **Lost** | **Lost** | **Lost** |
| A finished result waiting for the database (`pendingResults`) | Spool files in `/var/lib/slotrush-server/spool` | Kept; drained at the next start | Kept | **Lost**, unless the database already took it |
| Accounts, profiles, sessions, stored results, career awards, personal bests, `schema_migrations` | PostgreSQL 17, database `slotrush` | Kept | Kept | Only as of the last dump **copied off the host** |
| Server configuration: database password, session secret | `/etc/slotrush-server/env` (`root:slotrush-server` 0640) | Kept | Kept | **Lost**, unless kept elsewhere (a password manager). A new session secret signs every player out; the database password must match the role |
| Server releases | `/srv/slotrush-server/releases/` (`current` symlink) | Kept | Kept | The checked `slotrush-server-<sha>` CI artifact (tarball and SHA-256) is kept on GitHub Actions for **30 days**; older commits can be rebuilt from git (`npm ci && npm run build:server && npm run pack:server`, linux-x64, Node 22) |
| Static site, its `current` and `previous` releases | `/srv/www/slotrush.jdwd40.com/releases/` | Untouched | Kept | Lost; the static CI artifact is kept 30 days and the next green push to `main` deploys a new one once the host and its deploy identity exist again ([deployment.md](deployment.md)) |
| Unit file, env template, Nginx site files | The repository (`deploy/server/`, `deploy/nginx/`); the unit and env template are also inside every server tarball | Kept | Kept | Kept (in git) |
| Players' local records, ghosts and championships | Each browser's `localStorage` | Untouched | Untouched | Untouched |

So the copy that matters most after a total host loss is a recent dump **off the host**, plus the env file's two secrets. Step 1 makes one.

## The drill (about 30 minutes)

Run on the host (`ssh app-vps`) as the administrator. Define the helpers once per shell. `asgame` runs a command as the service user with the env file loaded, plus `DRILL_URL`: the same server and role, database `slotrush_restore_drill`.

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
asgame() { sudo -u slotrush-server sh -c 'cd / && set -a && . /etc/slotrush-server/env && set +a && export DRILL_URL="${DATABASE_URL%/*}/slotrush_restore_drill" && exec "$@"' sh "$@"; }
PGB=/srv/slotrush-server/current/scripts/pg-backup.mjs
```

`scripts/pg-backup.mjs` ships in every server release built after #144. If the live release predates it (`ls "$PGB"` fails), install the repository's copy once; it has no dependencies: `sudo install -D -o root -g root -m 0644 pg-backup.mjs /usr/local/lib/slotrush/pg-backup.mjs` (after `scp scripts/pg-backup.mjs app-vps:` from a checkout of `main`), and set `PGB=/usr/local/lib/slotrush/pg-backup.mjs`.

### 0. Record the live state (1 minute, read-only)

```bash
curl -fsS http://127.0.0.1:8787/api/version   # version, protocol, rules, schema
curl -fsS http://127.0.0.1:8787/api/health    # "ok":true, "db":"ok", racing, pendingResults, unsavedResults
readlink /srv/slotrush-server/current         # releases/slotrush-server-<sha>
```

Note `version`, `protocol`, `rules` and `schema`. `/api/health` and `/api/version` report the schema the **running code** expects (`SCHEMA_VERSION`), not what a database holds; step 2 checks the database itself.

### 1. Dump the live database (5 minutes)

The backup directory, once (as in [accounts.md](accounts.md#backup-and-restore)):

```bash
sudo install -d -o slotrush-server -g slotrush-server -m 0700 /var/backups/slotrush
```

Dump, with `pg_dump --format=custom` through the wrapper (a consistent snapshot; the service keeps running):

```bash
asgame node "$PGB" dump --url-env DATABASE_URL --out /var/backups/slotrush/slotrush-$TS.dump
sudo ls -l /var/backups/slotrush/            # -rw------- slotrush-server slotrush-server
sudo sha256sum /var/backups/slotrush/slotrush-$TS.dump
```

The wrapper reads the URL from the named variable (never from the command line, where `ps` shows it), passes the password in `PGPASSWORD`, creates the file 0600 and refuses to overwrite one. It stops first with a plain message if `pg_dump` is older than the server (install `postgresql-client-17`). The plain-`pg_dump` equivalent is in [accounts.md](accounts.md#backup-and-restore).

The dump holds password hashes and live sessions. Keep it private. For the "host lost" column above, copy it off the host (for example `ssh app-vps sudo cat /var/backups/slotrush/slotrush-$TS.dump > slotrush-$TS.dump` to a private, encrypted disk), check its SHA-256 there, and delete old copies.

### 2. Restore into a throwaway database and check it (10 minutes)

Create an empty database owned by the game's role, never the live one:

```bash
sudo -u postgres createdb --owner=slotrush --template=template0 slotrush_restore_drill
sudo -u postgres psql -c 'REVOKE ALL ON DATABASE slotrush_restore_drill FROM PUBLIC'
asgame node "$PGB" restore --url-env DRILL_URL --in /var/backups/slotrush/slotrush-$TS.dump
```

The restore refuses (exit 3) unless the target database's name looks throwaway (`restore`, `drill`, `scratch`, `throwaway` or `test`), and always refuses a target whose schema already holds tables. It runs as one transaction, so it applies completely or not at all. It then prints every table's row count and the schema version found in `schema_migrations`. Compare with the live database:

```bash
asgame node "$PGB" check --url-env DATABASE_URL   # live, read-only
asgame node "$PGB" check --url-env DRILL_URL      # the copy
```

Tables and the schema version must be identical (`004_setup_bests` today); counts may differ only by what changed since the dump (sessions, races finished meanwhile). Then check one account you know, with its career row, on both:

```bash
cat > /tmp/drill-row.sql <<'SQL'
SELECT a.username, p.display_name, count(c.race_id) AS awards, coalesce(sum(c.points), 0) AS points
FROM accounts a LEFT JOIN profiles p ON p.account_id = a.id LEFT JOIN career_awards c ON c.account_id = a.id
WHERE a.username_key = lower(:'who') GROUP BY a.username, p.display_name;
SELECT id, applied_at FROM schema_migrations ORDER BY id;
SQL
chmod 0644 /tmp/drill-row.sql
asgame sh -c 'psql -X "$DATABASE_URL" -v who=<your username> -f /tmp/drill-row.sql'   # live
asgame sh -c 'psql -X "$DRILL_URL" -v who=<your username> -f /tmp/drill-row.sql'      # the copy: the same rows
```

Finally, the service's own start-up check, on the copy (exit 0 and `"current":true`):

```bash
asgame sh -c 'cd /srv/slotrush-server/current && DATABASE_URL="$DRILL_URL" exec node server-dist/admin.mjs status'
```

The role has `CONNECTION LIMIT 6` and the live pool uses up to 3, so run these one at a time.

### 3. Unpack a checked release into a clean directory (10 minutes)

The rebuild path after a host loss, rehearsed beside the live release. Take the `slotrush-server-<sha>` artifact of a green `main` run (the live `version` from step 0, or a newer one) on a machine with `gh`:

```bash
gh run list -R jdwd40/slot-racer-gp --branch main --commit <sha>     # the run id; all jobs green
gh run download <run id> -R jdwd40/slot-racer-gp -n slotrush-server-<sha> -D slotrush-server-<sha>
scp slotrush-server-<sha>/* app-vps:
```

On the host, into a directory the live unit never reads:

```bash
sha256sum -c slotrush-server-<sha>.tar.gz.sha256
sudo install -d -o root -g root -m 0755 /srv/slotrush-drill /srv/slotrush-drill/releases
sudo tar -C /srv/slotrush-drill/releases -xzf slotrush-server-<sha>.tar.gz
sudo chown -R root:root /srv/slotrush-drill/releases/slotrush-server-<sha>
cd /srv/slotrush-drill/releases/slotrush-server-<sha>
cat server-dist/VERSION server-dist/protocol.json RELEASE     # <sha>; protocol and rules; the Node it was packed with
node --version                                                 # the same major (v22)
grep -E '^(MemoryMax|MemoryHigh|MemorySwapMax|CPUQuota|ExecStart|EnvironmentFile)=' deploy/server/slotrush-server.service
diff deploy/server/slotrush-server.service /etc/systemd/system/slotrush-server.service && echo unit unchanged
systemctl show slotrush-server -p MemoryMax -p MemoryHigh -p CPUQuotaPerSecUSec   # 268435456, 209715200, 600ms
sudo stat -c '%U:%G %a %n' /etc/slotrush-server/env                                # root:slotrush-server 640
```

The unit must say `MemoryMax=256M` and `EnvironmentFile=/etc/slotrush-server/env`. On a rebuilt host, this directory would be `/srv/slotrush-server/releases` and the rest is the [activation runbook](online-server.md#production-activation-runbook-owner) steps 2–10.

**Optional: start the unpacked release against the copy**, on port 8788, under the unit's memory limits, never over the live process (port 8787 and the live database are not used):

```bash
sudo systemd-run --unit=slotrush-drill --uid=slotrush-server --gid=slotrush-server \
  -p MemoryMax=256M -p MemorySwapMax=0 -p CPUQuota=60% -p PrivateTmp=yes \
  --working-directory=/srv/slotrush-drill/releases/slotrush-server-<sha> -E NODE_ENV=production -E UV_THREADPOOL_SIZE=2 \
  /bin/sh -c 'set -a && . /etc/slotrush-server/env && set +a && export DATABASE_URL="${DATABASE_URL%/*}/slotrush_restore_drill" SLOTRUSH_PORT=8788 SLOTRUSH_DB_POOL_MAX=1 SLOTRUSH_SPOOL_DIR=/tmp/drill-spool && exec /usr/bin/node --max-old-space-size=96 --max-semi-space-size=2 server-dist/main.mjs'
curl -fsS http://127.0.0.1:8788/api/health        # "ok":true, "db":"ok", version <sha>
journalctl -u slotrush-drill -n 20 --no-pager
sudo systemctl stop slotrush-drill
```

`SLOTRUSH_DB_POOL_MAX=1` keeps the live pool and the drill within the role's 6 connections. The overrides are exported inside the shell after the env file is read, so they win over its values. If the drill unit fails to start, read its journal, then `sudo systemctl reset-failed slotrush-drill`.

### 4. Server rollback: the exact commands (read them, run them only when needed)

The server has no `previous` link. Find the release that ran before from the record of the last upgrade ([Release procedure](online-server.md#release-procedure-owner) step 4) or from each release's build record:

```bash
readlink /srv/slotrush-server/current
for r in /srv/slotrush-server/releases/*/; do echo "$r $(cat "$r/RELEASE")"; done
```

When a rollback is needed (wait for `"racing": 0` in `/api/health` if you can; a restart aborts races in progress):

```bash
cd /srv/slotrush-server
sudo ln -sfn releases/slotrush-server-<previous sha> current.new && sudo mv -T current.new current
sudo systemctl restart slotrush-server
systemctl status slotrush-server --no-pager
curl -fsS http://127.0.0.1:8787/api/health        # "ok":true, "db":"ok", version <previous sha>
cd /srv/slotrush-server/current && node scripts/server-smoke.mjs http://127.0.0.1:8787 --origin https://slotrush.jdwd40.com --expect server-dist/protocol.json
curl -fsS https://slotrush.jdwd40.com/api/health  # the same through Nginx
```

Migrations are additive: an older release starts on a newer schema (it checks only the migrations it knows), so no database step is needed. What open pages see across a protocol or rules difference is in the [rollback matrix](online-server.md#rollback). Rolling forward is the same commands with the newer release.

### 5. Static rollback (pointer)

The static site keeps `current` and `previous` and rolls back without a build or a reload: [deployment.md, *Rollback and roll-forward*](deployment.md#rollback-and-roll-forward-no-build-or-reload). For the drill, the read-only `status` is enough:

```bash
sudo -u slotrush-deploy /usr/local/bin/slotrush-receive status   # current, previous, revision, releases
```

### 6. Clean up and record (2 minutes)

```bash
sudo -u postgres dropdb slotrush_restore_drill
sudo rm -rf /srv/slotrush-drill
rm -f /tmp/drill-row.sql slotrush-server-<sha>.tar.gz slotrush-server-<sha>.tar.gz.sha256
```

Keep the dump if it is your newest backup (and its off-host copy); delete older ones. Record in the issue: the UTC time, the step-0 values, the dump's size and SHA-256, the live and restored `check` output, the known-row result, `admin status` on the copy, and what you skipped.

## Restoring for real

The same commands, with two differences. After a host loss, first rebuild the host with the [activation runbook](online-server.md#production-activation-runbook-owner) steps 1–5 (with the env file's saved secrets, or new ones; a new session secret signs everyone out), and create the role and an empty `slotrush` database (step 3). Then, with the service stopped:

```bash
asgame node "$PGB" restore --url-env DATABASE_URL --in /var/backups/slotrush/<file>.dump --force
asgame sh -c 'cd /srv/slotrush-server/current && node server-dist/admin.mjs migrate && node server-dist/admin.mjs status'
asgame sh -c 'cd /srv/slotrush-server/current && node server-dist/admin.mjs prune-sessions'
```

`--force` lifts only the name check; a target that already holds tables is refused even then. To replace a damaged live database on a surviving host, restore into a fresh database as in step 2 and swap names with `ALTER DATABASE ... RENAME` while the service is stopped ([accounts.md](accounts.md#backup-and-restore)). An older dump brings back sessions valid then: `prune-sessions` drops the expired ones, or `DELETE FROM sessions` signs everybody out. Then start the service and continue with activation steps 7–10.

## The wrapper

```text
node scripts/pg-backup.mjs dump    (--url <postgres-url> | --url-env <VAR>) --out <file> [--schema <name>]
node scripts/pg-backup.mjs restore (--url <postgres-url> | --url-env <VAR>) --in <file> [--force] [--json]
node scripts/pg-backup.mjs check   (--url <postgres-url> | --url-env <VAR>) [--schema <name>] [--json]
```

- There is no default database; `DATABASE_URL` is read only when named with `--url-env`.
- Exit codes: 0 done, 1 failed (a tool error, or client tools older than the server), 2 usage, 3 refused by a safety check.
- Client tools: `PG_BIN`, else the newest `/usr/lib/postgresql/<n>/bin`, else `PATH`. `pg_dump` and `pg_restore` must be at least the server's major version; CI installs `postgresql-client-17` for its PostgreSQL 17 service.
- Tested by `test/server/pgbackup.db.test.ts`: a migrated schema with an account, profile, stored race and career award is dumped, restored into a fresh schema, and must match table for table, row for row, with the same migrations and career row; restoring over it is refused, with or without `--force`. Where the role may create databases (CI), a whole migrated database is also dumped and restored into a fresh database, the drill's own shape. The name and overwrite refusals run without a database in `npm test`. `node scripts/local-pg.mjs backup-check` remains the plain-`pg_dump` account drill from #23.

## Not covered yet

A cold standby (a second process or host, how DNS and the health check would fail over, and the fact that in-memory rooms would still not transfer) is step 4 of #144, left for a follow-up design note. Nothing here provisions a second host.
