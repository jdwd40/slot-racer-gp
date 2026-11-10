# Player accounts and driver profiles (#24)

Players can create an account, sign in on any device and keep a chosen driver name. The account gives the statistics task
(fastest times, podium points) a stable owner: the **account ID**, never the editable name. An account is optional: local
play and guest online play work exactly as before, and nothing here runs when the server is off or has no database.

Builds on the room server (#22, [online-server.md](online-server.md)) and the browser lobbies (#23,
[online-client.md](online-client.md)). Evidence: [accounts-evidence.md](accounts-evidence.md).

## Choice of authentication

The owner's decision (2026-11-08): **username and password, no email**, recovery by an owner-run admin command, on the
existing host. Nothing is invented: maintained libraries do the security-critical parts.

| Concern | Implementation |
| --- | --- |
| Password hashing and verification | [`argon2`](https://www.npmjs.com/package/argon2) 0.45.2, Argon2id m=19 MiB t=2 p=1 (OWASP minimum), transparent rehash on sign-in if the parameters change |
| Sessions | [`express-session`](https://www.npmjs.com/package/express-session) 1.19.0 with the game's PostgreSQL store (`server/sessionStore.ts`): signed cookie, server-side session rows, ID regenerated on every sign-in, `destroy` on sign-out |
| Recovery | `node server-dist/admin.mjs reset-password <username>` on the host (sets a new hash, revokes every session of the account in one transaction) |

No third-party identity provider, mail service or paid service is used or needed. No provider account was created.

## Flows

| Flow | Endpoint | Notes |
| --- | --- | --- |
| Register | `POST /api/auth/register` `{ username, password, displayName? }` | 201 and signed in. `409 username_taken` (case-insensitive, settled by a unique key, so simultaneous attempts make one account) |
| Sign in | `POST /api/auth/login` `{ username, password }` | New session ID; the browser's previous session (and its sockets' sign-in) ends. `401 invalid_credentials` for any wrong part |
| Restore | `GET /api/auth/me` | `{ account, profile, session: 'active' }`, or `{ account: null, session: 'none' \| 'expired' }`. `expired` means the browser sent a session cookie the server no longer accepts (expired, signed out elsewhere, owner reset); the reply also clears that cookie |
| Profile | `GET /api/profile`, `POST /api/profile` `{ displayName, expectAccount? }` | The session's own profile only. `401 signed_out` / `session_expired`; `409 identity_changed` when `expectAccount` (the account the form was opened for) is not the session's |
| Sign out | `POST /api/auth/logout` | Deletes the session row and clears the cookie; sockets opened with it are signed out at once (`bye expired`, close 4003). If the store cannot delete the row: `503 unavailable`, cookie kept |
| Store unreadable | any of the above, a WebSocket upgrade | When the session store cannot be read (database down or timing out), every request that carries a session cookie gets `503 unavailable` (a socket upgrade: HTTP 503), and the cookie is kept. Nobody knows the session ended, so it is never reported as `expired` and the browser does not clear its sign-in |
| Recover | admin `reset-password` (above) | No email. The owner verifies the player out of band, then gives them the new password privately |

**Session lifetime:** 30 days absolute from sign-in (`rolling: false`); there is no "remember me" variant. Expired rows are
pruned every 15 minutes and by `admin prune-sessions`. Every signed-in WebSocket re-checks its session every 10 s and on
every room entry, so a sign-out, expiry or reset elsewhere also ends a socket's sign-in.

## Identity and the driver name

- **Account ID** (`accounts.id`, a bigint identity) is the identity. It is never chosen by a client and never changes.
- **Username** is the login name: 3–20 of `A-Z a-z 0-9 _ -`, stored lower-case, unique without regard to case. It is
  private: the API returns it only to its own signed-in browser; rooms, snapshots, results and logs never contain it.
- **Driver name** (`profiles.display_name`) is public race information, edited at any time without touching the ID.
  Rules, identical in the browser and on the server (`checkDisplayName` in `src/net/protocol.ts`):
  1. Unicode NFC.
  2. Control, zero-width, bidirectional-override and BOM characters removed.
  3. Runs of whitespace collapsed to one space; leading and trailing space trimmed.
  4. Then 1–16 characters counted as code points. Blank is refused (`blank`), longer is refused (`too_long`), never cut.
  5. Names ending in `(AI)` are refused (`reserved`), so nobody poses as the AI field.
  6. Anything else is allowed, including HTML-like text (`<b>x</b>`). It is stored verbatim and always rendered as text
     (`textContent`, or `escHtml` in the HUD, lobby and result tables). Names are not unique: two drivers may both be
     "Sam"; the lobby marks each seat with its car number, and identity is the account ID.
  The database also refuses blank, padded, over-long or control-character names (`profiles_display_name_shape`).
- **Default name:** the username (first 16 characters) unless one is given at registration.
- **A rename never makes a new identity:** the profile row is keyed by the account ID; result envelopes store the
  `accountId` for every signed-in seat, so statistics follow the account through any number of renames.
- **In a room:** a signed-in seat is named from the saved profile when it joins (the name the client sends is ignored).
  That name is frozen into the participant record and the race roster; renaming later affects rooms joined after that.

## Ownership and race participants

- Every profile read and write uses the account in the **authenticated server session**. Request bodies are checked
  against an exact field list: an `accountId`, `account_id`, `id`, `username` or any unknown field is `400 malformed`, so a
  submitted ID can never select another profile (tested).
- **Join/create:** the socket's session is re-checked, then the seat records that account ID. One account holds at most one
  seat in a room (`already_joined`). The browser also sends `expectAccount` (the account it shows, `''` for a guest): a
  socket whose sign-in differs (the cookie expired or was reset before the socket opened, or another tab switched account)
  is refused with `nack expired/session` and the page re-checks who it is, so a driver shown as signed in never silently
  takes a guest seat. `expectAccount` only ever refuses; the identity still comes from the session alone.
- **Start:** the roster, with each seat's account ID, is frozen. The result envelope uses that frozen roster.
- **Reconnect:** `resume` needs the seat's private token **and**, for an account seat, a live session of the same account
  (`forbidden` otherwise). The participant ID, car, number and pit bay are unchanged.
- **Sign-out, account switch, sign-in mid-race:** the socket bound to the old session is signed out and closed; the seat
  waits out its grace like a dropped link and can only be resumed by the same account. Signing in as someone else at the
  finish cannot claim the result: the result belongs to the frozen account ID.
- **Guests stay guests:** a guest seat has no account ID. Resuming it from a signed-in browser does not attach the account.
  Guests and account drivers share rooms (`guest: true/false` is public; nothing else about the account is).

## Browser

- Offered only when the online gate passes **and** `/api/health` reports `accounts: true, profiles: true` (a database is
  attached). The default static build never contacts `/api` (unchanged). Session restore runs once after that check.
- **Title:** an Account button (`Sign in`, or `👤 <driver name>`). **Account screen:** sign-in and create-account tabs,
  or the profile (private username, editable driver name, Sign out). Real `<form>`s with `autocomplete` hints
  (`username`, `current-password`/`new-password`, `nickname`), 16 px+ inputs (no iOS focus zoom), 44–48 px targets, the
  existing on-screen-keyboard handling (`fitKeyboard`) and a `role=status` message line with loading (`aria-busy`,
  disabled buttons), error (`aria-invalid` on the field) and success states.
- **Online menu:** a signed-in driver's name field shows the profile name, read-only.
- The session cookie is `HttpOnly`; no script can read it, and the client stores **no** credential.
- **Account-scoped client state** (`src/net/account.ts`): every `srgp.acct.*` key (reserved for account-owned data such
  as the statistics task's pending submissions: use `accountKey(accountId, name)`), and this tab's online seat
  (`srgp.seat`, `srgp.netResults`). It is removed on sign-out (even if the server is unreachable), on a session the server
  reports expired, and whenever the signed-in identity differs from the one that state belongs to (`srgp.acct.owner`:
  another account, or guest ↔ account). **Local records, ghosts, championships, settings and the guest online name are
  never touched** (tested).
- **Tabs follow each other.** A sign-in, sign-out or switch in one tab rewrites `srgp.acct.owner`; the other tabs see the
  `storage` event, ask `GET /api/auth/me` who they are now, drop their own seat if the identity changed, and redraw. A
  profile save always carries `expectAccount`, so a form left open from before the switch renames nobody (`409`, and the
  tab then shows the current account), even where storage events do not arrive. A `/me` answer that arrives after this
  tab signed in, out or renamed is dropped: it was sent before the change, so it may show the old identity.
- **Sign-out is confirmed by the server.** Only the server can revoke the `HttpOnly` session, so the browser becomes a
  guest only after `POST /api/auth/logout` answers `200 {ok:true}`. If the request fails (offline, a store error, a proxy
  error page), the account screen says the device is **still signed in** and offers Sign out again; account-scoped
  client state is kept until the server confirms (or reports the session already ended), because the session still owns it.
- **A failed cross-tab refresh keeps the identity.** If another tab changes the sign-in and this tab's `/me` check
  cannot reach the server, the tab keeps the last confirmed identity and its state rather than dropping to unavailable.

## Abuse and failure handling

| Protection | Setting |
| --- | --- |
| CSRF | `SameSite=Strict` cookie; every POST needs an allowed `Origin` (exact match) and `application/json`; no CORS |
| Failed sign-ins per address | 20 per minute (shared with room-code guessing) |
| Failed sign-ins per username | 10 per 15 minutes, from any address (a lock against distributed guessing; it also briefly blocks the owner, which is the documented trade-off) |
| Registrations per address | 10 per hour |
| Renames per account | 10 per minute |
| Hash flood | one Argon2id hash at a time, 16 queued, then `503 busy` |
| Bodies | 4 KB, exact fields |
| Errors | fixed codes (`invalid_credentials`, `username_taken`, `rate`...); unknown users cost the same hash work; internal errors are `500 internal` with no detail |
| Secrets | passwords, hashes, cookies, session IDs and tokens are never logged (`redact()` plus tests on every log line) and never sent to the bundle or a room |
| Backend down | the title shows local play only; with the server up but the database down, health is 503 (`db: down`) and online is off for new sessions, while races already running carry on and their results are spooled ([online-server.md](online-server.md#production-design)); guest/local play never waits on it |

Limits are per process, in memory: a restart resets them (acceptable for one small process).

## Stored data and migrations

Minimal by design; no email, phone or other contact column exists (tested).

| Table | Columns | Purpose |
| --- | --- | --- |
| `accounts` | `id`, `username`, `username_key` (unique), `password_hash` (Argon2id), `created_at`, `password_changed_at` | sign-in |
| `profiles` (migration `002_driver_profiles`) | `account_id` (PK, FK, cascade), `display_name`, `created_at`, `updated_at` | public driver name |
| `sessions` | `sid`, `account_id`, `sess` (cookie metadata and `{ id, username }`), `expires_at` | server-side sessions |
| `race_results` | immutable envelopes with `accountId` per seat | ownership for statistics |

- Migrations are explicit (`admin migrate`), checksummed, applied in order under an advisory lock, each in a transaction.
  `002` is additive: it creates `profiles` and backfills one row per existing account from its username. A release that
  predates it ignores the table; an account created by such a release reads as its username (`LEFT JOIN` fallback), so a
  rollback of the server release needs no database rollback.
- The service refuses to start on a schema older than it needs (exit 78), and `/api/health` reports `503 outdated`.

### Backup and restore

On the host (as the owner, from the env file):

```bash
# backup (before every migration, and on a schedule)
sudo -u slotrush-server sh -c 'set -a; . /etc/slotrush-server/env; set +a; pg_dump --format=custom --file=/var/backups/slotrush/slotrush-$(date -u +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"'
# restore into a fresh database owned by the same role (service stopped), then check the schema
sudo -u postgres createdb --owner=slotrush --template=template0 slotrush_restore
sudo -u slotrush-server sh -c 'set -a; . /etc/slotrush-server/env; set +a; pg_restore --no-owner --role=slotrush --exit-on-error --dbname="${DATABASE_URL%/*}/slotrush_restore" /var/backups/slotrush/<file>.dump'
# point DATABASE_URL at slotrush_restore (or swap names with ALTER DATABASE ... RENAME while the service is stopped), then:
node server-dist/admin.mjs migrate && node server-dist/admin.mjs status
```

`/var/backups/slotrush` must exist, owned by `slotrush-server`, mode 0700 (`sudo install -d -o slotrush-server -g slotrush-server -m 0700 /var/backups/slotrush`);
the unit's `ProtectSystem=strict` does not apply to these manual commands. The dump holds password hashes and live
sessions: keep it private and delete old ones. Restoring an older dump brings back sessions that were valid then; run
`admin prune-sessions`, or `DELETE FROM sessions` to sign everybody out, after a restore. The drill is automated locally
by `node scripts/local-pg.mjs backup-check` (dump, restore into a new database, compare accounts/profiles/sessions,
migrate and status on the copy, admin reset on the copy).

## Configuration

No new variables. Accounts need the existing `DATABASE_URL` and `SLOTRUSH_SESSION_SECRET` (32+ characters), with
`SLOTRUSH_COOKIE_SECURE=1` in production ([env example](../deploy/server/slotrush-server.env.example)). Without
`DATABASE_URL` the server is guests-only and the browser offers no sign-in.

## Production activation (owner)

Nothing here was run against production; no host, DNS, Nginx, systemd or provider was touched. The accounts feature
ships inside the room server release and is activated by the existing runbook in
[online-server.md](online-server.md#production-activation-runbook-owner), with these additions:

1. Before step 6 (migrate) on an existing database, take the `pg_dump` backup above.
2. Step 6 applies `002_driver_profiles`; `admin status` must list it.
3. Step 8: `curl -fsS http://127.0.0.1:8787/api/health` must show `"accounts":true,"profiles":true,"db":"ok"`.
4. After step 11 (client enabled), from a phone and a desktop browser: create an account, sign in on the second
   browser, rename, check the name in a lobby with a guest, sign out, and confirm local records are still listed.
5. Recovery drill once: `admin reset-password <a test account>` and sign in with the new password.

Still missing for real production use, by design of this task: the owner has to run the runbook; there is no
self-service password change or account deletion (an owner can delete an account with
`DELETE FROM accounts WHERE username_key = '<name>'`, which cascades to its profile and sessions; result envelopes keep
the bare ID).
