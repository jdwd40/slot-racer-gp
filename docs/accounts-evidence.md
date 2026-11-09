# Accounts and driver profiles: evidence (#24)

Taken on 9 November 2026 on the build host (Node 26 locally; the release targets Node 22.12+, and CI runs Node from
`.nvmrc`). Design: [accounts.md](accounts.md).

**What these results are.**

- Browser runs used Playwright Chromium 156 on **SwiftShader** (the host has no GPU), and touch is Chromium's **touch
  emulation**. The "on-screen keyboard" is simulated by shrinking the layout viewport by 42% while a field has focus, as
  Android Chrome does. **These are functional diagnostics only**, not evidence of how the forms feel on a real phone.
- **No physical phone, tablet or real on-screen keyboard was tested.** iOS Safari's overlay keyboard (visual viewport
  only) was not exercised.
- **Production was not touched**: no host, DNS, Nginx, systemd unit, database or third-party service was used or changed,
  and no provider account was created. Everything ran against a private PostgreSQL 18 cluster under `.local-pg/`
  (`scripts/local-pg.mjs`; no 18-only syntax is used, and CI runs the same tests on `postgres:17`).
- The checkout started at `1141e45` on `ship/24`, equal to `origin/main`. Dependencies #22 and #23 are squash-merged
  there (`c902ef6`, `1141e45`); their branch tips `ship/22` and `ship/23` have trees identical to those commits.

## What #22/#23 already provided, and what #24 added

Already present and re-verified: username/password registration and sign-in (Argon2id via `argon2`), `express-session`
sessions on PostgreSQL, logout, session ID regeneration, WebSocket sign-in bound to its session, account-bound seats,
`accountId` in result envelopes, owner `admin reset-password`, migrations with checksums.

Added here: driver profiles (migration `002_driver_profiles`), `GET/POST /api/profile`, display-name rules shared by browser
and server, profile-named account seats, `session: 'expired'` answers that clear a dead cookie, per-address registration,
per-username failed sign-in and per-account rename limits, the browser sign-in/create/profile screens, account-scoped
client state clean-up, the `accounts` browser scenario and the backup/restore drill.

## Commands and results

| Command | Result |
| --- | --- |
| `npm run typecheck` | pass |
| `npm test` | **515 passed**, 17 skipped (the database files without `SLOTRUSH_TEST_DATABASE_URL`), 24 files |
| `npm run build` | pass (static build; online off by default) |
| `npm run test:db` (`db.test.ts` + new `profiles.db.test.ts`, local PostgreSQL) | **17 passed**, 0 skipped |
| `node scripts/local-pg.mjs backup-check` | **PASS**: dump → restore into a new database → accounts/profiles/sessions and migrations identical → `migrate` "schema already current" → `status` current → `reset-password` on the copy revokes its sessions |
| `npm run build:server && npm run pack:server`, then the packed release in `NODE_ENV=production` against the migrated local database, `server-smoke.mjs` | all 9 smoke checks PASS; health `{"accounts":true,"profiles":true,"db":"ok","schema":"002_driver_profiles","rssMb":74,"heapMb":11}` |
| Production-mode cookie check (curl to the packed release) | login with `X-Forwarded-Proto: http` sets **no** cookie; with `https` (what Nginx sends) it sets `srsid=…; HttpOnly; Secure; SameSite=Strict`, 30 days. The password never appears in the service log |
| Bundle scan (`dist/`, `dist-online/`) for `password_hash`, `SESSION_SECRET`, `DATABASE_URL`, `argon2`, `express-session`, `srsid`, the test DB password | 0 matches. The bundle only contains the relative `/api/...` paths |
| `SLOTRUSH_TEST_DATABASE_URL=$(node scripts/local-pg.mjs env) node scripts/online-check.mjs accounts` (SwiftShader, diagnostics) | **25 passed, 0 failed**, 672 s (run `2026-11-09T11-45-52`) |
| `node scripts/online-check.mjs gate` (online-enabled build, service down) | 6 passed, 0 failed |
| `node scripts/browser-check.mjs online` (default build gate) | 3 passed, 1 n/a (the round trip needs `VITE_ONLINE`): online off, **no request to `/api` or `/ws`** |

## Results by acceptance item

| # | Item | Evidence |
| --- | --- | --- |
| 1 | Register, sign in, sign out, restore, expired/revoked answers, admin reset, duplicates | `profiles.db.test.ts`: *session lifecycle* (expired row → `session: 'expired'` and the cookie is cleared; logout revokes server-side so a replayed cookie is dead; switching accounts replaces the session), *duplicate usernames* (4 simultaneous registrations of `rae_dup`/`Rae_Dup` → exactly one 201, one account, one profile). `db.test.ts`: owner reset with stdin and generated passwords, every session signed out. Browser: create, wrong password, duplicate, restore on reload, revoked session told "expired" |
| 2 | Stable ID, editable name, rules, HTML-like names as text, rename keeps identity | Unit `account.test.ts` (rules); DB test *display names* (blank, whitespace, zero-width only, 17 chars, `(AI)`, non-strings refused; `<b>x</b>&amp;"'` stored verbatim; DB constraint refuses bad names even bypassing the app). Rename keeps the account ID and the result envelope's `accountId` (*account seat* test). Browser: `<b>Zed</b>&amp;` and `<i>Zed</i> 2` render as text on the title button, profile, online menu, lobby, HUD standings and results (no injected elements) |
| 3 | Second browser, restart, migration, backup/restore | DB tests: *second browser* (fresh login sees the same profile; a rename in one is seen by the other), *restart* (app and pool torn down and rebuilt: cookie still valid, profile kept, migrate no-op), *migration 002 on a 001 database* (backfill from usernames, health 503 until migrated). `backup-check` drill. Browser: clean second context signs in to the same profile |
| 4 | Ownership from the session; spoofing; sign-out/switch clear state, keep saves | DB test *ownership*: no cookie → 401; `accountId`/`account_id`/`id`/`username` in the body → 400 and neither profile changes; forged cookie → 401; cross-origin → 403; form content type → 415. Unit tests: sign-out (even offline), expired rename, account switch (direct and from another tab), guest→account all clear `srgp.acct.*`, `srgp.seat`, `srgp.netResults`, and keep leaderboards, ghosts, championship, initials, car, graphics, guest name. Browser: sign-out cleared seat and pending key, kept the seeded records, ghost and championship |
| 5 | Account + guest in one room; stable reconnect; no transfer | DB test *account seat*: profile name used (submitted "Spoofed Name" ignored), guest shares the room, no username/ID/token in public room data, second seat for the same account refused, reconnect keeps participant/slot/bay, sign-out mid-race closes the socket (4003), a guest and another account both get `forbidden` on resume, a signed-in browser resuming the guest seat leaves it guest, the owner's new session resumes, signing in as another account at the finish ends that socket and cannot resume; stored envelope links only the owner's account. Browser: same room, results stored with account and guest |
| 6 | Libraries, CSRF/origin, rate limits, safe errors, revocation, no secrets | `argon2` + `express-session` (above). DB test *rate limits*: 11th registration per address/hour → 429; 10 failed sign-ins on one username from 10 addresses lock it (even the right password, from a new address) → 429; 11th rename/minute → 429. Log lines checked for passwords, `srsid=` and seat tokens. `/api/auth/me` body has no `sid`/hash/password. Bundle scan above |
| 7 | Phone portrait/landscape with keyboard, loading/error states, no credentials in public data | Browser `accounts`: portrait, keyboard up: focused field in view, no sideways scroll, 18 px inputs; loading (`Creating your account…`, `aria-busy`, disabled buttons) with a held response; errors (invalid username with `aria-invalid`, taken, wrong password with the field cleared, blank name); landscape with an error and the keyboard (see the browser table); controls ≥ 40 px. The guest browser's whole session state has no username or session for the signed-in driver |
| 8 | Local Node/PostgreSQL deployment, runbook, limits, capacity | Local cluster and packed release above. Runbook: [online-server.md](online-server.md#production-activation-runbook-owner) plus [accounts.md § Production activation](accounts.md#production-activation-owner). Unit limits (`MemoryMax=256M`, `CPUQuota=60%`, `SLOTRUSH_ROOM_CAP=6`) and the #22 load measurement are unchanged; accounts add one bounded Argon2id hash at a time (19 MiB) and an idle RSS of 74 MB was measured here |
| 9 | Static deploy and guest/local play without a backend; online off by default | Unchanged gate (`VITE_ONLINE` unset ⇒ no `/api` request; tested in `protocol.test.ts` and the browser gate). Sign-in is offered only when health reports `accounts && profiles`. CI's new DB test file uses the existing throwaway `postgres:17` container; no secret is needed |
| 10 | Checks recorded | This file |

## Browser scenario (`online-check.mjs accounts`)

Four browser contexts: phone portrait (touch, A), desktop (B), phone landscape (touch, guest), phone landscape (touch, layout).
The account server is the repository's server code with the local database (`scripts/qa-server.ts`, schema `t_browser`,
time ×2 for the race). Where a step needs an event the scripted page cannot produce on cue, the harness acts on the server
directly, and the check says so: it **retires both human cars** so the race classifies, and it **deletes all session rows**
to simulate a revocation.

| Check | Result |
| --- | --- |
| Health reports accounts; title offers Sign in; restores as guest | pass |
| Portrait, keyboard up (viewport 390×490): focused password field at y 52–100, no sideways scroll, 18 px text | pass |
| Invalid username: message + `aria-invalid`, nothing sent | pass |
| Loading: "Creating your account…", `aria-busy`, buttons disabled (response held 300 ms by the harness) | pass |
| After creating: private username and `<b>Zed</b>&amp;` shown as text | pass |
| Cookie `HttpOnly`, `SameSite=Strict`, not in `document.cookie` (no `Secure` on local http: production sets it, see above) | pass |
| Second browser: duplicate username (other case) refused; wrong password generic, field cleared | pass |
| Second browser signs in to the same profile; blank name refused; rename | pass |
| Browser A reload restores its session and shows the new name as text | pass |
| Online menu uses the profile name, read-only | pass |
| Lobby: account + guest (`<img src=x>`) share a room; names as text, no injected elements | pass |
| Guest browser state has no username/session of the account driver | pass |
| HUD standings and results (guest view) show `<i>Zed</i> 2` as text | pass |
| Stored result: account ID on the signed-in seat, none on the guest | pass |
| Sign-out: guest, seat and `srgp.acct.*` cleared, records/ghost/championship kept | pass |
| Revoked session: B restores as guest with "Your sign-in has expired" | pass |
| Landscape (844×226 with keyboard) after a wrong password: field at y 11–59, card fits, controls ≥ 40 px | pass |
| Portrait sign-in form fits, controls ≥ 40 px | pass |
| No page errors on any of the four pages | pass |

Earlier runs of this scenario on the same day found two harness faults, both fixed before the passing run: a guest name
longer than the 16-character input limit, and a stall when a fourth software-rendered page opened (finished pages are now
closed first). Screenshots: `.qa/online-check/2026-11-09T11-45-52-802Z/` (not committed).

## Not done / limits

- No physical device or real on-screen keyboard; iOS overlay keyboard not exercised.
- No self-service password change or account deletion (owner SQL, documented). Rate limits are in memory and reset on restart.
- The full browser suites of earlier issues were not re-run; only the scenarios listed above.
