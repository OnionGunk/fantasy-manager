# Handoff notes

The README explains how the app works. This explains how the *project* works:
the operational knowledge, and the things that were learned the hard way.

Written so that a fresh start - a new session, or coming back in a month -
does not have to rediscover any of it.

**Nothing secret is in this file, and neither is any account detail.** Those
are deliberately kept out of the repo. See "Secrets" below for where they
actually live.

## The three pieces

| Piece | Where it lives | How it deploys |
| --- | --- | --- |
| The web app | GitHub Pages, from `main` | `git push` - live in ~1 min |
| The alert job | Cloudflare Workers, `fantasy-alerts` | manual, see below |
| The data | Sleeper's public API | nothing to deploy |

Live site: <https://oniongunk.github.io/fantasy-manager/>
Worker: `https://fantasy-alerts.<subdomain>.workers.dev` (the exact URL is in
`PUSH_WORKER` at the top of the alerts section in `app.js`)

The app is installed on an iPhone home screen. On iOS, notifications only work
for a home-screen install - a Safari tab has no access to the Push API at all.

## Secrets, and where they are

Two secrets exist. Neither is in git, and both are gitignored.

| Secret | Local file | Also stored in |
| --- | --- | --- |
| Push signing key | `vapid-private-key.txt` | Worker setting `VAPID_PRIVATE` |
| Test-alert key | `test-key.txt` | Worker setting `TEST_KEY` |

The matching **public** key is in `app.js` and is meant to be public.

If the push signing key is ever lost, a new pair has to be generated *and*
every device has to re-subscribe - the old subscriptions are bound to the old
key. The generator was a throwaway script using WebCrypto in a headless
browser; regenerating is a few minutes' work, re-subscribing is a tap.

## Sending a test alert

```
curl "https://fantasy-alerts.<subdomain>.workers.dev/test?key=<TEST_KEY>"
```

`{"ok":true,"pushStatus":201}` means Apple accepted it. 201 is success, not an
error. A 403 means the key is wrong; 404 means no phone is subscribed.

## Checking the alert job is alive

```
curl "https://fantasy-alerts.<subdomain>.workers.dev/health"
```

`lastRun` should be within the last five minutes. If it is null or hours old,
the scheduler is not running - see the first gotcha below. The app shows this
on screen too, in the Alerts section.

## Deploying the worker

There is no automated path yet, and setting one up is the top open item.
The current method is to upload the file through the Cloudflare API:

- `PUT /accounts/<id>/workers/scripts/fantasy-alerts/content` with a
  multipart body, `main_module: "worker.js"`
- Use the `/content` endpoint, **not** the plain script endpoint. `/content`
  updates only the code; the plain one can wipe the KV binding and secrets.
- Always assert the byte length matches `worker/worker.js` before uploading.
  That check has already caught one bad deploy.

Bindings that must survive any deploy:

```
kv_namespace  STORE           -> namespace "fantasy-store"
secret_text   VAPID_PRIVATE
secret_text   TEST_KEY
plain_text    VAPID_PUBLIC
plain_text    VAPID_SUBJECT
```

## Gotchas, all found the hard way

**The cron trigger can silently fail to save.** It was set in the dashboard,
looked fine, and was simply not there - `schedules` came back as an empty
array. Every alert would have failed silently. After touching the schedule,
always verify:

```
GET /accounts/<id>/workers/scripts/fantasy-alerts/schedules
```

It should contain `*/5 * * * *`.

**Cloudflare wraps module workers in a multipart envelope.** Downloading the
script returns the code inside `--boundary` / `Content-Disposition` headers,
about 184 bytes larger than the source. Patching that text and re-uploading it
embeds the envelope into the worker. Strip it first: take everything between
the first `\r\n\r\n` and the last `\r\n--`.

**Deletes count as KV writes.** The free plan allows 1,000 writes a day. An
early version deleted a key on every run after the draft - 288 wasted writes a
day. Guard every delete behind a read; reads have a 100,000/day allowance.

**Workers free plan gives 10ms of CPU per run.** That is why the job fetches
players one at a time (~1 KB each) instead of touching the 15 MB player file
or the 2 MB projections feed. Anything that parses megabytes belongs in the
browser, not the worker.

**A rank of zero is falsy.** `PROBLEM_ORDER[kind] || 9` scored the most urgent
category as the least urgent. Empty lineup slots were being buried under
"plus 2 more". Watch for `|| default` anywhere zero is a legitimate value.

**A player's listed position is not always his fantasy position.** Travis
Hunter is listed `DB` but drafted as a receiver; ranking him at DB subtracted a
replacement value of zero and floated him into the top ten. Use
`rankablePosition()`, which falls back to `fantasy_positions`.

**Sleeper usernames have no spaces.** A display name like "Scuba Horse" is not
the username. `GET /v1/user/<name>` returns `null` rather than an error, which
looks like a broken app.

**PowerShell 5.1 mangles multi-line strings passed to native programs.** It
re-parses them and splits on embedded quotes, so `git commit -m "<<multi-line
here-string>>"` fails with confusing "pathspec did not match" errors. Use short
single-line `-m` messages, or write the message to a file and use `-F`.

**Two of the endpoints are undocumented** - the NFL schedule and the
projections feed. Both are wrapped so a failure degrades the page rather than
breaking it, and the app says on screen when they are unavailable. If opponents
or projections silently vanish, check those first.

## What has been tested, and what has not

Tested against real, live data:

- Every endpoint, and that all of them allow browser CORS
- Value-over-replacement maths, checked against real projections
- A full simulated 14-round draft, which is what exposed the flaw that had the
  engine taking six receivers and leaving replacement-level running backs
- Push encryption round-tripped, and the signed token verified
- Notification wording across every problem type
- Depth-chart and bye-lookahead logic, including the negative cases
- Trade verdicts, including trades that break the lineup
- A real push delivered to a real phone

**Never run against a real roster.** Every in-season rule was written and
tested before the league had drafted, so the first genuine exercise of the
lineup checks, the waiver logic, the depth-chart rule and the trade checker is
the first week of the season. Treat that week's output with suspicion.

## Open items

1. **`/subscribe` and `/unsubscribe` are unauthenticated.** The worker address
   is public, so anyone who reads the repo could unsubscribe the phone, or
   overwrite the subscription with their own - and the app would still report
   "working". The fix is a setup code held only in the worker's settings and
   the phone's local storage. Low real risk, genuine flaw.
2. **No automated worker deploy.** Every change ships the file by hand. Either
   an API token used from the shell, or Cloudflare's git integration.
3. **The timezone is assumed.** `TIMEZONE` in `worker/worker.js` is set to
   `America/Chicago`, inferred from a mention of CDT. It only affects the
   weekly check times, not the draft countdown, which uses absolute time.

## Design decisions worth not re-litigating

- **The recommendations are rules, not AI.** Deterministic, free, and they
  cannot hallucinate. AI enters only through the "Copy for Claude" button,
  which the user triggers deliberately.
- **Notifications are the whole interface.** The user does not open the app
  unprompted, so an alert must say what to do rather than say "open the app".
  Unfixed problems re-alert at each later check.
- **Silence has to mean something.** Alerts fire only for things that cost
  real points. Adding chatter would train the user to swipe them away, which
  would break everything else.
- **Never let the app claim alerts work when they might not.** The heartbeat
  exists so a dead job shows up as a warning rather than as quiet.
