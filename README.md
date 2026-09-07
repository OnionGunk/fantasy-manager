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
https://sleeper.com/leagues/1396275326484496384/team
                            ^^^^^^^^^^^^^^^^^^^ this part
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
- `GET /v1/draft/<draft_id>` - draft date, before the season starts

Undocumented, used with a fallback if they stop working:

- `GET /schedule/nfl/regular/<season>` - real NFL schedule, for opponents and byes
- `GET /projections/nfl/<season>/<week>` - projected points

All of them send `access-control-allow-origin: *`, so the browser is allowed to
call them directly. Verified 2026-09-07.

## Caching

The player file is ~15 MB, which does not fit in localStorage (~5 MB limit).
It gets trimmed to just the fields this page needs before being stored, which
brings it under 1 MB. Refreshed once per day.

## Limits

- Read-only. Sleeper has no public write API, so this page cannot change a
  lineup. It says what to do; the change happens in the Sleeper app.
- It does not read news. A coach's press conference won't show up here until it
  becomes an injury designation or moves the projections.
- Close calls are close. A 1-point projection gap is noise, and the page says so
  rather than pretending to be confident.

## Publishing

Hosted free on GitHub Pages from the `main` branch.
