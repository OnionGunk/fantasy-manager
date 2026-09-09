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
the scheduler is not running - see the cron gotchas below. The app shows this
on screen too, in the Alerts section.

**`lastRun` is the only honest signal.** A registered schedule proves nothing,
and neither does a clean invocation log: the fetch handler answers `/health`
and `/advice` and shows up as a successful invocation without the scheduled
handler ever having run. Only `lastRun` moves when the cron actually fires.

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

**A correctly registered cron can still just stop firing.** This is a second,
separate failure from the one above, and it is worse because everything you
would check looks healthy. On the night of the 2026 draft the schedule was
present and correct, every invocation reported `status: success` with zero
errors, KV writes were at 288 for the day against a limit of 1,000 - and the
job had not run for 25 minutes. It went dark at 19:10 local and came back
later on its own.

The cost was exact: the one-hour draft warning fires in a ten-minute window
(55 to 65 minutes out), two cron ticks fell inside that window, neither ran,
and the alert was never sent. The user found out because they were watching
the clock, not because the app told them.

Cron triggers on the free plan are best effort. Scattered single-tick misses
are normal - the same evening dropped ticks at 18:45, 18:55, 19:05, 19:50,
20:10 and a dozen more. Anything that depends on a *specific* tick firing is
built on sand. Alert windows need to be catch-up rules ("fire if not yet sent
and the moment has passed") rather than narrow windows, and that is now the
top open item.

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

**A flex slot makes every position it accepts look "needed".** `FLEX` maps to
`['RB','WR','TE']`, so `neededPositions()` kept reporting tight end as needed
after a tight end was already rostered - and a second one then competed at
full value against the first running back. That is how the draft engine
recommended a second tight end in the third round. Dedicated need and
flex-only need are now scored differently (`FLEX_PENALTY`). Any rule that asks
"do I need this position?" has to say which slot it means.

**Sleeper's `draft_slot` is not the pick number.** Pick 3 overall was made by
draft slot 3 purely by coincidence, and a whole conversation was spent
analysing the wrong team on the strength of it. Match on `picked_by` against
the user id; `draft_slot` only agrees with the pick number in round one, and
only for the team that happens to sit there.

**Sleeper rosters are empty until the draft ends.** Before that, `players` is
null or empty and `starters` is a row of `"0"` strings. An app that loaded
during the draft and never refetched will therefore insist, entirely
sincerely, that you have no team.

## Testing the browser code without a browser

There is no build step, no test runner and no `node_modules`, and that is
worth keeping. But "no tooling" turned into "no verification", and a fix was
once shipped on nothing more than counting matched brackets.

There is no Node on the machine this was built on. A portable one costs about
a minute and touches nothing:

```
# download node-vXX-win-x64.zip from nodejs.org/dist, unzip to %TEMP%
node --check app.js draft.js trade.js sw.js
```

That alone catches the failure that matters most, because a syntax error in
`app.js` is a blank screen on a phone at 11am on a Sunday.

Going further is easy and worth it. The scripts are plain globals with no
modules, so they load into a `vm` context with a stubbed `document`,
`window`, `localStorage` and `fetch`, after which the real functions can be
called directly with real Sleeper data:

- top-level `function` declarations land on the context and can be called
  *and stubbed* - which is how `describe()` gets replaced with a fake
- top-level `const` and `let` do not, so `pts`, `FLEX_SLOTS` and friends
  cannot be reached or overridden from outside. They still resolve normally
  inside the functions that close over them.
- load `app.js` before `draft.js`; the draft code leans on `FLEX_SLOTS` and
  `slotLabel` from the app

Harnesses written this way found a real ordering bug (`depthIndex` used one
line before it was declared, a crash on every load) that reading the diff had
missed. Two of the harnesses also failed first on bad fixtures rather than bad
code - a "safe" roster where every player shared a bye week, and a draft board
containing a player who had actually been taken three picks earlier. Build
fixtures from the real API responses, not from memory.

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

**The draft has now happened** (2026 season, 12 teams, PPR, 14 rounds), and
the first contact with a real roster went badly enough to be worth recording.
Inside one evening the app:

- showed an empty team, because it had loaded before the draft and had no
  refresh of any kind
- stayed stuck on the finished draft board, because completing the draft
  stopped the polling without leaving draft mode
- recommended adding a third quarterback to a one-quarterback team, and
  bidding 30% of the season's waiver budget on him
- said "nothing to do" while two weeks of the schedule had a starting slot
  that could not be filled at all

All four are fixed. None of them were subtle, and none would have survived
ten minutes of use against a real team - which is exactly the point.

**The in-season rules are still barely exercised.** The lineup checks, waiver
logic, depth-chart rule and trade checker have now seen one real roster but no
real game week. Treat the first week's output with suspicion, and check
anything it recommends against Sleeper by hand before acting on it.

## Open items

1. **The weekly checks depend on a single cron tick landing in the right
   hour.** The scheduled handler does
   `CHECK_TIMES.find((t) => t.day === day && t.hour === hour)` and returns if
   nothing matches. Given that the cron demonstrably goes dark for half-hour
   stretches, one bad hour means that check never happens - and one of those
   hours is Sunday 11am, the last look before kickoff. A missed check there is
   a broken lineup for a whole week, in silence.

   The fix is to record which checks have completed and run a missed one late
   rather than requiring the exact hour. The draft countdown needs the same
   treatment: bands should fire on "not sent yet and the moment has passed",
   not on a ten-minute window. **This is the most valuable thing left to do.**

2. **`/subscribe` and `/unsubscribe` are unauthenticated.** The worker address
   is public, so anyone who reads the repo could unsubscribe the phone, or
   overwrite the subscription with their own - and the app would still report
   "working". Note the subscription is a *single* KV key, so a second device
   subscribing silently replaces the first: enabling alerts on a laptop turns
   them off on the phone. The fix is a setup code held only in the worker's
   settings and the phone's local storage.

3. **No automated worker deploy.** Every change ships the file by hand. Either
   an API token used from the shell, or Cloudflare's git integration.

4. **The app cannot tell a free agent from a waiver claim.** It assumes
   waivers and always frames a pickup as a bid. After a draft, undrafted
   players sit in free agency and cost nothing. The advice now tells the user
   to check Sleeper's own button (Add vs Claim) rather than guessing, which is
   honest but not a fix.

5. **The timezone is assumed.** `TIMEZONE` in `worker/worker.js` is set to
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
- **Anything on screen has to carry its own age.** The same principle as the
  heartbeat, applied to the page itself, and it was missed for months. The app
  fetched once on load and never again, so on iOS - where a home-screen app is
  frozen rather than closed - it would happily show Wednesday's injuries on
  Sunday morning, looking completely normal. Stale data that looks fresh is
  worse than an error, because the user acts on it. It now refetches on
  `visibilitychange`, `pageshow` and `focus`, and says so loudly past five
  minutes.
- **Silence has to be earned, not assumed.** "Nothing to do" is a claim about
  everything the app checked, so it is only as good as the search behind it.
  It once meant "none of Sleeper's 25 trending players helps you" and read as
  "the waiver wire has nothing", and it stayed quiet about two guaranteed
  zeros later in the season. Before the app says nothing is wrong, be sure it
  actually looked.
