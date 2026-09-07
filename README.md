# Fantasy Manager

A personal to-do list for my Sleeper fantasy football team.

It answers one question: **what do I need to do today?**

## What it is

A single web page. Plain HTML, CSS, and JavaScript. No build step, no backend,
no database, no API keys, no accounts, no AI, no cost to run.

It reads the free public [Sleeper API](https://docs.sleeper.com/) directly from
the browser and applies a fixed set of rules to decide what to tell me.

## How to open it

Double-click `index.html`. That's the whole process.

The live version is published with GitHub Pages (see below). Use the live
version on a phone.

## First-time setup

The first time it opens, it asks for a Sleeper username and league ID, then
remembers them on that device forever. Nothing personal is stored in this repo.

To find a league ID: open the league on sleeper.com and look at the address bar.

```
https://sleeper.com/leagues/123456789012345678/team
                            ^^^^^^^^^^^^^^^^^^ this part
```

To reset it, click "Change settings" at the bottom of the page.

## The files

| File | What it does |
| --- | --- |
| `index.html` | The page |
| `styles.css` | How it looks |
| `app.js` | Fetches Sleeper data and decides what to recommend |
| `manifest.webmanifest` | Makes it installable on a phone home screen |
| `sw.js` | Service worker, so it opens without a signal |
| `icons/` | Home screen icons |

## How the recommendations work

There is no AI. The advice comes from rules written in advance, run against
data Sleeper already publishes. In priority order:

1. The league hasn't drafted yet -> remind me when the draft is
2. A starting slot is empty -> guaranteed zero points
3. A starter is OUT, on injured reserve, or has no game this week (bye)
4. A starter is doubtful
5. A benched player projects meaningfully higher than a starter at the same slot
6. A trending free agent projects higher than my weakest player
7. Otherwise: nothing to do today

Projected points come from Rotowire via Sleeper. Injury designations come from
official NFL injury reports via Sleeper. This page just reads them and sorts.

## Draft mode

Opens automatically when the draft goes live, or from the button on the main
screen. It polls for new picks every 5 seconds and answers one question: who
do I take right now?

Ranking is **value over replacement (VOR)**, not average draft position.
A player is worth what he scores above the worst player you could otherwise
start at his position. That is why a 300-point quarterback can be a worse
pick than a 250-point running back: every team gets a good quarterback, and
running backs run out.

    VOR = projected season points - points of the last startable player
                                    at that position league-wide

Replacement level is derived from this league's actual starting slots, not a
generic assumption. For 12 teams starting 2 RB + 1 flex, roughly 30 running
backs start each week, so RB #30 is replacement level.

Guard rails on top of the ranking:

- never recommends a third QB or a second kicker
- never recommends a kicker until the final pick
- switches from "best value" to "fill your holes" once picks remaining equals
  starting slots still empty, so the draft cannot end without a kicker
- flags when a player has fallen well past his usual draft position

ADP (`adp_ppr`) is used for timing, not for ranking: it says whether a player
will likely still be there at the next pick.

## Trade checker

Sleeper's API cannot show you a trade offer. It is unauthenticated and
read-only, so it has no idea who you are and no way to reach your inbox.
Only completed transactions are public. So the offer is typed in by hand.

Pick up to three players each way, get one verdict. The value maths is the
same VOR used in draft mode, plus one rule that matters more in-season than
in a draft:

**A trade that leaves you unable to field a legal lineup is declined even
when the points favour it.** Trading your only tight end for a better running
back looks like a gain right up until you start a zero at tight end every
week. When that happens and the points do favour the trade, the verdict says
so and tells you to pick up a replacement first.

Otherwise the margin is ~10 projected points over a full season. Anything
inside that is noise, and the verdict is to keep what you have rather than
churn for no reason.

## Export for Claude

This page is deliberately dumb: fixed rules over public data, no AI, nothing
to pay for. What it cannot do is read the news, weigh a genuinely close call,
or know what a coach said on Monday.

So "Copy my team for Claude" builds one block of plain text covering the
league rules, my full lineup and bench with injuries and opponents, the
opponent's lineup, the current score, the best unowned players, and the
to-do list this page already produced.

It is written as a complete prompt, not a data dump, so pasting it is the
only thing you have to do. It also tells Claude what the rules engine already
concluded and invites disagreement, so the two are not talking past each
other.

Costs nothing unless you actually use it, which keeps the app itself free.

## Endpoints used

Documented and stable:

- `GET /v1/state/nfl` - current season and week
- `GET /v1/user/<username>` - resolve username to user id
- `GET /v1/league/<league_id>` - lineup slots, waiver day
- `GET /v1/league/<league_id>/rosters` - who owns which players
- `GET /v1/league/<league_id>/users` - team names
- `GET /v1/league/<league_id>/matchups/<week>` - this week's score
- `GET /v1/players/nfl` - all players (~15 MB, cached once per day, trimmed)
- `GET /v1/players/nfl/trending/add` - who everyone is picking up
- `GET /v1/draft/<draft_id>` - draft date, status, order, slot mapping
- `GET /v1/draft/<draft_id>/picks` - every pick made so far (polled in draft mode)
- `GET /v1/league/<league_id>/drafts` - all drafts attached to the league

Undocumented, used with a fallback if they stop working:

- `GET /schedule/nfl/regular/<season>` - real NFL schedule, for opponents and byes
- `GET /projections/nfl/<season>/<week>` - weekly projected points, plus a
  fresher injury designation than the big player file carries
- `GET /projections/nfl/<season>` - season totals and ADP, for draft mode

All of them send `access-control-allow-origin: *`, so the browser is allowed to
call them directly. Verified 2026-09-07.

## Caching

The player file is ~15 MB, which does not fit in localStorage (~5 MB limit).
It gets trimmed to just the fields this page needs before being stored, which
brings it under 1 MB. Refreshed once per day.

Refresh rates are deliberately uneven, because the data moves at different
speeds:

| Data | Normal day | Game day | Why |
| --- | --- | --- | --- |
| Player file (15 MB) | 24 h | 24 h | Too big to pull often |
| Weekly projections (2 MB) | 6 h | **15 min** | Carries live injury status |
| NFL schedule | 24 h | 24 h | Fixed months ahead |
| Season projections / ADP | 24 h | 24 h | Draft only |
| Draft picks | - | **5 s** | Only while a draft is live |

"Game day" means the NFL schedule says somebody plays today. Injury
designations move fast in the hours before kickoff - a player can go from
questionable to out ninety minutes before the game - so on those days the
projections feed is re-read every 15 minutes and its injury designation
overrides the older one in the cached player file.

The override only ever applies a designation, never clears one. Wrongly
benching a healthy player costs a few points; wrongly starting a player who
was ruled out costs the whole slot.

## Limits

- Read-only. Sleeper has no public write API, so this page cannot change a
  lineup. It says what to do; the change happens in the Sleeper app.
- It does not read news. A coach's press conference won't show up here until it
  becomes an injury designation or moves the projections.
- Close calls are close. A 1-point projection gap is noise, and the page says so
  rather than pretending to be confident.

## Publishing

Hosted free on GitHub Pages from the `main` branch.
