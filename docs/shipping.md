# Shipping: when a PR waits for John (#143)

Most work ships without asking John: herdr opens a `ship/<issue>` branch, an independent reviewer posts `VERDICT: SHIP`, the PR is squash-merged, and the static client deploys itself. That path is unchanged for everything except **two cases**, where automated shipping could quietly change how the game is played or undo the hub split (#141). Those PRs stop and wait for John.

## The two cases

1. **Rules or protocol change.** Any change to `RULES_VERSION` or `PROTOCOL_VERSION` in `src/net/protocol.ts` (a removed or renamed constant counts). John signs off with a line `JOHN-OK: rules` in the PR description. This is in addition to the `SERVER-DEPLOY: required` line the server-deploy reminder asks for ([deployment.md](deployment.md)); one does not stand in for the other.
2. **Hub growth.** A PR that grows `src/race.ts` or `src/main.ts` by **more than 20 net lines** (the file's line count at the PR minus its line count on `main`; a rewrite that adds 300 and removes 290 is +10). John signs off with a line `JOHN-OK: hubs`. **Exemption:** a dedicated extract PR that also **lowers that same hub's ceiling** in `test/hubSize.test.ts` (README, "Where new code goes") needs no sign-off. Lowering the other hub's ceiling does not exempt growth in this one.

Everything else follows the normal ship / `VERDICT: SHIP` path: features in a new module (for example `src/fuelLaps.ts`) with a few lines of wiring in a hub, client-only HUD fixes, docs, tests, CI. Do not ask John about those.

## How the gate works

- **CI.** The `john` job in `.github/workflows/server-deploy.yml` (*Rules change or hub growth needs JOHN-OK in the PR description*) runs `scripts/john-gate-check.mjs` on the PR's merge commit against its base. It fails when a case triggers and the description lacks the matching tag; it passes every other PR. It runs on pull requests only, including description edits (`edited`), so adding the tag re-runs just this workflow, not the full CI. It reads the description from the event payload; it needs no write access and holds no secrets. A missing description fails closed whenever a case triggers.
- **Tags.** Only the **PR description** counts, not commit messages. Each tag goes on a line of its own: `JOHN-OK: rules` or `JOHN-OK: hubs` (case-insensitive; a list bullet or `>` quote in front is fine; a mention inside a sentence is not). A PR that triggers both cases needs both lines. CI cannot tell who edited the description: the tags are John's to add, never the ship agent's or the reviewer's.
- **Label.** `needs-john` marks a PR (and its issue) that is waiting for John. The pipeline adds it; John takes it off once he has added the tag. CI does not read or set labels.

## What the ship agent and the reviewer do

When the `john` check fails on a PR (or the reviewer sees that a PR will trip it): **park it.** Add the `needs-john` label to the PR and its issue (with `ship-parked` if the pipeline uses it), and post one comment that says which case is waiting (`rules`: the old and new version; `hubs`: which hub and by how many net lines) and what John needs to add. Then **stop**: do not post `VERDICT: SHIP`, do not squash-merge, do not deploy, and do not count the issue as shipped and move on as if it were done while the tag is missing. Do not add a `JOHN-OK` line yourself, and do not route around the check (no second merge path, no lowering a ceiling just to get the exemption). For hub growth, moving the new code into a module so the hub grows by 20 lines or fewer is the preferred fix and needs no John. Once the tag is in the description, the check is green and `needs-john` is off, the PR continues on the normal path (review, `VERDICT: SHIP`, merge). Do not ask John about PRs the check passes.

## Tuning

The 20-line slack is `HUB_SLACK` in `scripts/john-gate-check.mjs` (with its boundary test in `test/johnGateCheck.test.ts`). John can change it, or drop the hubs half entirely and leave file size to the ceilings in `test/hubSize.test.ts` alone: remove the hub loop from `check()` and its tests, and the hubs case from this page.
