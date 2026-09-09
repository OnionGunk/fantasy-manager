/* ===========================================================================
   Fantasy Manager

   Reads the public Sleeper API and applies a fixed set of rules to decide
   what the user should do today. There is no AI here and no server. Every
   recommendation comes from data Sleeper already publishes (official injury
   designations, the NFL schedule, and Rotowire's projected points) run
   through the rules in buildTodoList().
   =========================================================================== */

'use strict';

const API   = 'https://api.sleeper.app';
const MIN   = 60 * 1000;
const HOUR  = 60 * MIN;
const DAY   = 24 * HOUR;

const CFG_KEY = 'ffm.config';
const CACHE   = 'ffm.cache.';

/* Positions a flex-style slot will accept. */
const FLEX_SLOTS = {
  FLEX:       ['RB', 'WR', 'TE'],
  WRRB_FLEX:  ['RB', 'WR'],
  WRRB_WRT:   ['RB', 'WR', 'TE'],
  REC_FLEX:   ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};

/* Slots that are not part of the active lineup. */
const NON_STARTING = ['BN', 'IR', 'TAXI'];

/* Injury designations that mean the player will not play. */
const OUT_CODES = ['OUT', 'IR', 'PUP', 'SUS', 'DNR', 'NA', 'COV'];

const el = (id) => document.getElementById(id);

/* ===========================================================================
   Storage helpers
   =========================================================================== */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function saveConfig(cfg) {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {}
}

function cacheGet(key, maxAge) {
  try {
    const raw = localStorage.getItem(CACHE + key);
    if (!raw) return null;
    const box = JSON.parse(raw);
    if (!box || (Date.now() - box.t) > maxAge) return null;
    return box.v;
  } catch (e) { return null; }
}

function cacheSet(key, value) {
  const write = () => localStorage.setItem(CACHE + key,
    JSON.stringify({ t: Date.now(), v: value }));
  try {
    write();
  } catch (e) {
    /* Out of room. Clear our own cache and try once more. If it still
       fails we carry on without caching - the page works, it just
       re-downloads next time. */
    clearCache();
    try { write(); } catch (e2) {}
  }
}

function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.indexOf(CACHE) === 0)
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) {}
}

/* ===========================================================================
   Fetching
   =========================================================================== */

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Sleeper returned ' + res.status + ' for ' + url);
  return res.json();
}

/* Optional data. If it fails we return null and the page carries on. */
async function tryJSON(url) {
  try { return await getJSON(url); } catch (e) {
    console.warn('Optional request failed:', url, e);
    return null;
  }
}

/* ---- players: ~15 MB raw, trimmed to the handful of fields we use ---- */
async function getPlayers() {
  const hit = cacheGet('players3', DAY);
  if (hit) return hit;

  const raw = await getJSON(API + '/v1/players/nfl');
  const keep = { QB: 1, RB: 1, WR: 1, TE: 1, K: 1, DEF: 1 };
  const slim = {};

  for (const id in raw) {
    const p = raw[id];
    if (!p || !p.position || !keep[p.position]) continue;

    const name = p.full_name
      || ((p.first_name || '') + ' ' + (p.last_name || '')).trim()
      || id;

    slim[id] = {
      n: name,
      p: p.position,
      t: p.team || null,
      i: p.injury_status || null,
      s: p.status || null,
      f: (p.fantasy_positions && p.fantasy_positions.length)
        ? p.fantasy_positions : [p.position],
      r: (p.search_rank == null) ? 99999 : p.search_rank,
      /* Where he sits on his team's depth chart. This is what lets the app
         notice that the player ahead of someone has been ruled out, which is
         the moment a backup becomes worth owning. */
      d: (p.depth_chart_order == null) ? null : p.depth_chart_order,
      dp: p.depth_chart_position || null,
    };
  }

  cacheSet('players3', slim);
  return slim;
}

/*
  Group players by team and depth chart position, in order, so we can ask
  "who is ahead of this man, and are they playing?" without scanning the
  whole league every time.
*/
function buildDepthIndex(players) {
  const index = {};
  for (const id in players) {
    const p = players[id];
    if (!p.t || !p.dp || p.d == null) continue;
    const key = p.t + '|' + p.dp;
    (index[key] = index[key] || []).push({ id, name: p.n, order: p.d });
  }
  for (const key in index) index[key].sort((a, b) => a.order - b.order);
  return index;
}

/*
  Everyone listed above this player at his position whose own status says
  they will not play. If that list is not empty, he is next in line.
*/
function blockersOut(playerId, players, index) {
  const me = players[playerId];
  if (!me || !me.t || !me.dp || me.d == null) return null;

  const ahead = (index[me.t + '|' + me.dp] || [])
    .filter((x) => x.order < me.d && x.id !== playerId);
  if (!ahead.length) return null;

  const sidelined = ahead.filter((x) => health(players[x.id]).out);
  /* Only interesting if EVERY man ahead of him is out - otherwise someone
     else is still taking the touches. */
  if (!sidelined.length || sidelined.length !== ahead.length) return null;
  return sidelined.map((x) => x.name);
}

/* ---- real NFL schedule: gives us opponents and bye weeks ---- */
async function getSchedule(season) {
  const key = 'sched2.' + season;
  const hit = cacheGet(key, DAY);
  if (hit) return hit;

  const raw = await tryJSON(API + '/schedule/nfl/regular/' + season);
  if (!Array.isArray(raw)) return null;

  const byWeek = {};
  for (const g of raw) {
    if (!g || !g.week) continue;
    (byWeek[g.week] = byWeek[g.week] || []).push([g.home, g.away, g.date]);
  }
  cacheSet(key, byWeek);
  return byWeek;
}

/* Today's date as Sleeper writes it in the schedule, e.g. "2026-09-13". */
function todayStamp() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/*
  Is anybody playing today? Injury designations move constantly in the hours
  before kickoff - a player can go from questionable to out ninety minutes
  before the game - so on a game day we refresh far more often than usual.
*/
function isGameDay(schedule, week) {
  if (!schedule) return false;
  const games = schedule[week];
  if (!games) return false;
  const today = todayStamp();
  return games.some((g) => g[2] === today);
}

/*
  Returns:
    a string  -> the opponent ('NO' at home, '@NO' away)
    null      -> the team has no game this week, i.e. a bye
    undefined -> we don't know (schedule unavailable)
*/
function opponentFor(schedule, week, team) {
  if (!schedule || !team) return undefined;
  const games = schedule[week];
  if (!games) return undefined;
  for (const [home, away] of games) {
    if (home === team) return away;
    if (away === team) return '@' + home;
  }
  return null;
}

/* The date this team plays in the given week, or null if they are on a bye. */
function gameDateFor(schedule, week, team) {
  if (!schedule || !team) return null;
  const games = schedule[week];
  if (!games) return null;
  for (const g of games) {
    if (g[0] === team || g[1] === team) return g[2] || null;
  }
  return null;
}

/* ---- projected points, from Rotowire via Sleeper ---- */
async function getProjections(season, week, statKey, maxAge) {
  const key = 'proj2.' + season + '.' + week + '.' + statKey;
  const hit = cacheGet(key, maxAge);
  if (hit) return hit;

  const positions = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
    .map((p) => '&position[]=' + p).join('');
  const url = API + '/projections/nfl/' + season + '/' + week
    + '?season_type=regular&order_by=ppr' + positions;

  const raw = await tryJSON(url);
  if (!Array.isArray(raw)) return null;

  const out = {};
  for (const row of raw) {
    if (!row || !row.player_id) continue;
    const pts = row.stats ? row.stats[statKey] : null;
    if (pts == null) continue;
    out[row.player_id] = {
      p: Math.round(pts * 10) / 10,
      o: row.opponent || null,
      /* This feed carries a fresher injury designation than the big player
         file does, and it is small enough to re-fetch on a game day. */
      i: (row.player && row.player.injury_status) || null,
    };
  }
  cacheSet(key, out);
  return out;
}

/*
  Sleeper numbers waiver_day_of_week from Monday: 0 = Monday ... 6 = Sunday.
  This is not documented anywhere. It was confirmed against this league, whose
  API value of 2 lines up with the Wednesday shown in the Sleeper app.
*/
const WAIVER_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday',
  'Friday', 'Saturday', 'Sunday'];

function waiverInfo(league, roster) {
  const s = (league && league.settings) || {};
  /* waiver_type 2 means blind bidding: you spend a season-long budget
     rather than taking turns in a priority order. */
  const budget = (s.waiver_type === 2) ? (s.waiver_budget || null) : null;
  const used = (roster && roster.settings
    && roster.settings.waiver_budget_used) || 0;
  return {
    day: WAIVER_DAYS[s.waiver_day_of_week] || null,
    dayIndex: (s.waiver_day_of_week == null) ? null : s.waiver_day_of_week,
    faab: budget,
    remaining: (budget == null) ? null : Math.max(0, budget - used),
  };
}

/*
  The single most useful thing for someone who has never played: not what to
  do, but WHEN to look. There are two moments each week that decide almost
  everything, and missing them is how people lose without noticing.
*/
function whenToCheck(waivers) {
  const today = new Date().getDay();          /* 0 = Sunday */
  const day = waivers && waivers.day;
  /* Sleeper counts from Monday; JavaScript counts from Sunday. */
  const waiverJsDay = (waivers && waivers.dayIndex != null)
    ? (waivers.dayIndex + 1) % 7 : null;

  if (today === 0) {
    return 'Games are today. Set your lineup before the first kickoff &mdash; once '
      + 'a player\'s game starts you cannot move him.';
  }
  if (today === 6) {
    return 'Games are tomorrow. Set your lineup tonight or first thing in the '
      + 'morning.';
  }
  if (waiverJsDay != null && today === waiverJsDay) {
    return 'Waivers ran this morning. Anyone still unowned is now first come, '
      + 'first served, so you can add them straight away.';
  }
  if (waiverJsDay != null && ((waiverJsDay - today + 7) % 7) === 1) {
    return 'Waivers run tomorrow morning. If you want anybody, put the claim '
      + 'in tonight &mdash; after that you are competing with everyone else.';
  }
  return 'Two moments matter each week: '
    + (day ? (day + ' morning, when waivers run') : 'waiver day')
    + ', and Sunday before kickoff, when your lineup locks.';
}

/* Which projection number matches this league's scoring. */
function statKeyFor(league) {
  const rec = league && league.scoring_settings
    ? Number(league.scoring_settings.rec) : 0;
  if (rec >= 1)   return 'pts_ppr';
  if (rec >= 0.5) return 'pts_half_ppr';
  return 'pts_std';
}

/* ===========================================================================
   Small helpers about a single player
   =========================================================================== */

function health(pl) {
  if (!pl) return { out: false, level: 'ok', label: null };

  const inj = String(pl.i || '').toUpperCase();
  const st  = String(pl.s || '').toUpperCase();

  if (OUT_CODES.indexOf(inj) !== -1) {
    return { out: true, level: 'out', label: inj === 'NA' ? 'OUT' : inj };
  }
  if (st.indexOf('INJURED RESERVE') !== -1 || st === 'PUP'
      || st === 'SUSPENDED' || st === 'NON FOOTBALL INJURY') {
    return { out: true, level: 'out', label: 'IR' };
  }
  if (inj === 'DOUBTFUL') {
    return { out: false, level: 'doubtful', label: 'DOUBTFUL' };
  }
  if (inj === 'QUESTIONABLE') {
    return { out: false, level: 'questionable', label: 'QUESTIONABLE' };
  }
  return { out: false, level: 'ok', label: null };
}

function slotAccepts(slot, fantasyPositions) {
  const allowed = FLEX_SLOTS[slot] || [slot];
  return (fantasyPositions || []).some((p) => allowed.indexOf(p) !== -1);
}

/*
  "vs NO" for a home game, "at MIA" for an away one. opponentFor() marks away
  games with a leading @, so prefixing that with "vs" reads as "vs @MIA".
  Returns null when we do not know.
*/
function opponentLabel(p) {
  if (!p || p.onBye || p.opponent === undefined || p.opponent === null) return null;
  const o = String(p.opponent);
  return (o.charAt(0) === '@') ? ('at ' + o.slice(1)) : ('vs ' + o);
}

function slotLabel(slot) {
  return (slot === 'SUPER_FLEX') ? 'SFLX'
    : (slot.indexOf('FLEX') !== -1 || slot === 'WRRB_WRT') ? 'FLEX'
    : slot;
}

/* Build the object the rest of the app reasons about. */
function describe(playerId, players, projections, schedule, week) {
  const pl = players[playerId];
  if (!pl) return null;

  const proj = projections ? projections[playerId] : null;
  let opp = opponentFor(schedule, week, pl.t);
  /* Fall back to the opponent the projections feed reports. */
  if (opp === undefined && proj && proj.o) opp = proj.o;

  /* Prefer the projections feed's injury designation when it has one: it is
     refreshed far more often than the big player file. We only override when
     it reports an actual designation, never to clear one, so a player who is
     newly ruled OUT is caught within minutes while a stale flag costs at
     worst one unnecessary bench. */
  const withFreshInjury = (proj && proj.i) ? { i: proj.i, s: pl.s } : pl;

  const gameDate = gameDateFor(schedule, week, pl.t);
  const today = todayStamp();

  return {
    gameDate,
    /* His game is today, so his lineup spot is about to lock, or just has. */
    playsToday: !!gameDate && gameDate === today,
    /*
      His game already happened. Nothing about him can be changed now, so
      advice mentioning him is dead advice.

      This uses dates, not kickoff times, because the schedule feed only
      gives us dates. A player whose game started three hours ago today is
      still treated as changeable. Same-day locking is not detectable here.
    */
    gamePlayed: !!gameDate && gameDate < today,
    id: playerId,
    name: pl.n,
    pos: pl.p,
    team: pl.t,
    fantasyPositions: pl.f,
    rank: pl.r,
    health: health(withFreshInjury),
    onBye: opp === null,
    opponent: opp,
    /* null means "we genuinely don't have a number", which is different
       from a projection of zero. */
    points: proj ? proj.p : null,
  };
}

/*
  Which upcoming weeks leave several starters without a game.

  Byes cluster. Three starters off in the same week is a hole you have to
  plan for two weeks early, while there are still replacements on the waiver
  wire - not something to discover on the Sunday morning.
*/
/*
  Which starting slots could this set of available players actually fill?

  Strict slots first, then flex from whatever is left over, so a flex slot
  never swallows a player that a dedicated slot needed more. Returns the
  slots that would be left empty.
*/
function unfillableSlots(availableByPos, startingSlots) {
  const pool = Object.assign({}, availableByPos);
  const empty = [];

  const strict = startingSlots.filter((s) => !FLEX_SLOTS[s]);
  const flex = startingSlots.filter((s) => FLEX_SLOTS[s]);

  for (const slot of strict) {
    if (pool[slot] > 0) pool[slot] -= 1;
    else empty.push(slot);
  }
  for (const slot of flex) {
    const taken = FLEX_SLOTS[slot].find((pos) => pool[pos] > 0);
    if (taken) pool[taken] -= 1;
    else empty.push(slot);
  }
  return empty;
}

/*
  Weeks ahead where the roster cannot field a full lineup.

  The old version of this counted how many *starters* had a bye and spoke up
  at two or more, three weeks ahead. That is the wrong question twice over.
  Two starters resting is harmless when the bench covers them, and it looked
  only at the starters, so it could not tell. Meanwhile a lone kicker on a
  bye with nobody behind him - a guaranteed zero - never reached the
  threshold and was never mentioned at all.

  What matters is whether every slot can be filled by somebody. That is rare
  enough to be worth saying every time it is true, and it is always worth
  real points, which is the bar for saying anything at all.

  Scans the whole remaining season rather than a fixed window: an empty slot
  is worth knowing about early, while there is still a trade or a waiver
  claim that could fix it.
*/
function upcomingByes(lineup, bench, schedule, week, startingSlots) {
  if (!schedule || !startingSlots || !startingSlots.length) return [];

  /* Everyone who could be started. Injured reserve cannot, so it is out. */
  const roster = lineup.map((s) => s.player)
    .concat(bench || [])
    .filter((p) => p && p.team && p.pos && !p.onIR);
  if (!roster.length) return [];

  const out = [];
  for (let w = week + 1; w <= 18; w++) {
    const games = schedule[w];
    if (!games) continue;

    const playing = new Set();
    for (const g of games) { playing.add(g[0]); playing.add(g[1]); }

    const availableByPos = {};
    const off = [];
    for (const p of roster) {
      if (playing.has(p.team)) {
        availableByPos[p.pos] = (availableByPos[p.pos] || 0) + 1;
      } else {
        off.push(p);
      }
    }

    const empty = unfillableSlots(availableByPos, startingSlots);
    if (empty.length) out.push({ week: w, empty, players: off });
  }
  return out;
}

/* A player who cannot help you this week at all. */
function isDeadWeight(p) {
  return !p || p.health.out || p.onBye;
}

const pts = (p) => (p && p.points != null) ? p.points : -1;

/* Best replacement on the bench for a given slot. */
function bestBenchFor(slot, bench, used) {
  const options = bench.filter((p) =>
    p && !used.has(p.id)
    && !p.onIR
    /* No use suggesting someone whose game is already over. */
    && !p.gamePlayed
    && slotAccepts(slot, p.fantasyPositions)
    && !isDeadWeight(p)
    && p.health.level !== 'doubtful');

  options.sort((a, b) => {
    const d = pts(b) - pts(a);
    if (d !== 0) return d;
    return a.rank - b.rank; /* no projections? fall back to season ranking */
  });

  return options[0] || null;
}

/* ===========================================================================
   THE RULES

   This is the whole "recommendation engine". It is a list of if-then checks
   in priority order. Same inputs always give the same output.
   =========================================================================== */

function buildTodoList(ctx) {
  const todos = [];
  const used = new Set();   /* bench players already spoken for */

  /* --- Rule 0: the league hasn't drafted yet ---------------------------- */
  if (ctx.league.status === 'pre_draft') {
    let when = 'Check the Sleeper app for the date.';
    if (ctx.draftTime) {
      const d = new Date(ctx.draftTime);
      when = d.toLocaleString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
      });
    }
    todos.push({
      level: 'urgent',
      rank: 'Before anything else',
      action: 'Your draft is ' + when,
      why: 'Be at your computer or phone and ready. If you miss it, Sleeper '
         + 'auto-picks your whole team for you, and it picks badly. Nothing '
         + 'else on this page matters until the draft is done.',
    });
    return todos;
  }

  /* lineup always has one entry per starting slot, filled or not, so counting
     it tells us nothing. Look for an actual player. */
  const hasAnyPlayer = ctx.bench.length
    || ctx.lineup.some((s) => s.player || s.unknown);

  if (!hasAnyPlayer) {
    todos.push({
      level: 'info',
      rank: 'Nothing yet',
      action: 'You have no players on your roster',
      why: 'Your league has drafted, but this team is empty. Check the '
         + 'Sleeper app to make sure you are looking at the right league.',
    });
    return todos;
  }

  /* --- Rule 1: empty starting slots -------------------------------------- */
  for (const s of ctx.lineup) {
    if (s.player || s.unknown) continue;
    const fill = bestBenchFor(s.slot, ctx.bench, used);
    if (fill) used.add(fill.id);
    todos.push({
      level: 'urgent',
      rank: 'Empty slot',
      action: fill
        ? ('Put ' + fill.name + ' in your empty ' + slotLabel(s.slot) + ' slot')
        : ('Your ' + slotLabel(s.slot) + ' slot is empty'),
      why: 'An empty slot scores exactly zero points, guaranteed. '
         + (fill
           ? ('You have ' + fill.name + ' sitting on the bench doing nothing.')
           : ('You have nobody on your bench who can play there, so you will '
            + 'need to pick someone up.')),
    });
  }

  /* --- Rule 2: a starter is OUT, on IR, or has no game this week ---------- */
  for (const s of ctx.lineup) {
    const p = s.player;
    if (!p) continue;
    if (p.gamePlayed) continue;
    if (!p.health.out && !p.onBye) continue;

    const fill = bestBenchFor(s.slot, ctx.bench, used);
    if (fill) used.add(fill.id);

    const problem = p.health.out
      ? ('He is listed <span class="term" tabindex="0" data-def="An official '
        + 'NFL injury designation. OUT means the player will definitely not '
        + 'play, so he scores zero.">' + p.health.label + '</span> and will '
        + 'score zero')
      : ('His team has no game this week &mdash; that is called a '
        + '<span class="term" tabindex="0" data-def="One week each season '
        + 'where a player\'s real NFL team does not play at all. A player on '
        + 'a bye scores exactly zero.">bye week</span> &mdash; so he scores '
        + 'zero');

    todos.push({
      level: 'urgent',
      rank: p.onBye ? 'Bye week' : 'Injured',
      action: fill
        ? ('Bench ' + p.name + '. Start ' + fill.name + ' instead.')
        : ('Bench ' + p.name + ' &mdash; he cannot score this week'),
      why: problem + '. '
        + (fill
          ? (fill.name + ' is healthy, plays this week'
            + (fill.points != null
              ? (', and is projected for ' + fill.points + ' points.')
              : '.'))
          : 'You have nobody healthy on the bench who can take that slot, so '
          + 'look at who is available to pick up.'),
    });
  }

  /* --- Rule 3: a starter is doubtful -------------------------------------- */
  for (const s of ctx.lineup) {
    const p = s.player;
    if (!p || p.health.level !== 'doubtful' || p.onBye || p.gamePlayed) continue;

    const fill = bestBenchFor(s.slot, ctx.bench, used);
    if (fill) used.add(fill.id);

    todos.push({
      level: 'warn',
      rank: 'Probably out',
      action: fill
        ? ('Consider benching ' + p.name + ' for ' + fill.name)
        : ('Keep an eye on ' + p.name),
      why: p.name + ' is listed <span class="term" tabindex="0" '
        + 'data-def="An official NFL injury designation meaning the player is '
        + 'unlikely to play. Most doubtful players sit out.">DOUBTFUL</span>, '
        + 'which usually means he will not play. '
        + (fill
          ? (fill.name + ' is a safe swap'
            + (fill.points != null ? ' at ' + fill.points + ' projected points.' : '.'))
          : 'You have no healthy bench option, so check again before kickoff.'),
    });
  }

  /* --- Rule 3b: a questionable starter, on the day he actually plays ------- */
  for (const s of ctx.lineup) {
    const p = s.player;
    if (!p || p.health.level !== 'questionable') continue;
    if (p.onBye || p.gamePlayed || !p.playsToday) continue;

    const fill = bestBenchFor(s.slot, ctx.bench, used);
    todos.push({
      level: 'warn',
      rank: 'Check before kickoff',
      action: 'Check on ' + p.name + ' before his game starts',
      why: p.name + ' is listed <span class="term" tabindex="0" '
        + 'data-def="An official NFL injury designation meaning it is genuinely '
        + 'unclear whether the player will play. Most are settled about 90 '
        + 'minutes before kickoff.">QUESTIONABLE</span> and plays today. Open '
        + 'the Sleeper app about 90 minutes before his game. If he has been '
        + 'ruled out by then, '
        + (fill ? ('start ' + fill.name + ' instead.')
          : 'you will need to put someone else in.'),
    });
  }

  /* --- Rule 4: someone on the bench projects clearly higher ---------------- */
  for (const s of ctx.lineup) {
    const p = s.player;
    if (!p || p.health.out || p.onBye || p.points == null) continue;
    if (p.gamePlayed) continue;
    if (p.health.level === 'doubtful') continue; /* already covered above */

    const fill = bestBenchFor(s.slot, ctx.bench, used);
    if (!fill || fill.points == null) continue;

    const gap = fill.points - p.points;
    /* Both a real gap and a meaningful relative gap, so we don't nag about
       noise. Projections are not precise enough to act on small edges. */
    if (gap < 3 || fill.points < p.points * 1.25) continue;

    used.add(fill.id);
    todos.push({
      level: 'info',
      rank: 'Upgrade',
      action: 'Swap ' + p.name + ' out for ' + fill.name,
      why: fill.name + ' is projected for ' + fill.points + ' points this week '
        + 'and ' + p.name + ' for ' + p.points + '. Both are healthy, so this '
        + 'is a straight upgrade of about ' + Math.round(gap) + ' points.',
    });
  }

  /* --- Rule 5: a free agent is better than your weakest player ------------ */
  if (ctx.pickup) {
    const { add, drop } = ctx.pickup;

    /*
      How much to bid. There is no exact right answer, but "bid what he is
      worth to you" is useless advice to someone who has never done it. So:
      a player good enough to start right away is worth a real chunk of the
      remaining budget; bench depth is worth a token amount.
    */
    /*
      Compare him with the man he would actually replace - the weakest
      starter at his own position - not with the lowest-scoring starter on
      the team. That is always the kicker, and every quarterback, running
      back and receiver on earth outscores a kicker. Judged that way the
      app rated a third-string quarterback as an instant starter and asked
      for 30% of a season's budget.
    */
    const samePos = ctx.lineup
      .map((s) => s.player)
      .filter((p) => p && p.points != null && p.pos === add.pos)
      .map((p) => p.points);
    const wouldStart = add.points != null
      && (!samePos.length || add.points > Math.min.apply(null, samePos));
    const remaining = ctx.waivers ? ctx.waivers.remaining : null;
    const bid = (remaining && remaining > 0)
      ? Math.max(1, Math.round(remaining * (wouldStart ? 0.3 : 0.08)))
      : null;

    todos.push({
      level: 'info',
      rank: 'Pick up',
      action: 'Add ' + add.name + '. Drop ' + drop.name + ' to make room.',
      why: add.name + ' (' + add.pos + ') is unowned in your league'
        + (add.nextInLine
          ? (' and just moved to the front of his team\'s depth chart &mdash; '
            + add.nextInLine.join(' and ') + ' '
            + (add.nextInLine.length === 1 ? 'is' : 'are') + ' out, so the '
            + 'work should fall to him. This is the moment to claim a player, '
            + 'before the projections catch up and everyone else notices')
          : (' and one of the most added players in the last day'
            + (add.points != null ? ', projected for ' + add.points + ' points' : '')))
        + '. ' + drop.name + ' is your weakest player'
        + (drop.points != null ? ' at ' + drop.points + ' projected' : '')
        + '. Put the claim in through '
        + '<span class="term" tabindex="0" data-def="The queue for claiming '
        + 'players nobody owns. Claims are collected and processed together on '
        + 'a set day each week rather than first-come first-served.">waivers'
        + '</span> in the Sleeper app'
        + (ctx.waivers && ctx.waivers.day
          ? (' before they run on <b>' + ctx.waivers.day + ' morning</b>')
          : ' before your league\'s next waiver run')
        + (bid
          ? ('. <b>Check Sleeper first:</b> if his button says <b>Add</b> he is '
            + 'a free agent and costs nothing, so just take him. Only if it '
            + 'says <b>Claim</b> does this go through waivers - then bid <b>$'
            + bid + '</b> of your remaining $' + remaining + '. '
            + (wouldStart
              ? 'He would start for you straight away, which is worth paying for.'
              : 'He is bench depth, so keep it cheap.')
            + ' Highest bid wins and you only pay if you win, so a losing bid '
            + 'costs you nothing.')
          : '.'),
    });
  }

  /* --- Rule 5a: somebody on your bench just inherited a starting job ------- */
  for (const p of ctx.bench) {
    if (!p || p.onIR || p.gamePlayed || isDeadWeight(p)) continue;
    const blockers = ctx.depthIndex
      ? blockersOut(p.id, ctx.players, ctx.depthIndex) : null;
    if (!blockers) continue;

    /* Only worth saying if he could actually go into your lineup. */
    const slot = ctx.lineup.find((s) => s.player
      && slotAccepts(s.slot, p.fantasyPositions)
      && !s.player.gamePlayed
      && (s.player.points == null || p.points == null
        || p.points >= s.player.points - 2));
    if (!slot) continue;

    todos.push({
      level: 'info',
      rank: 'New starter',
      action: 'Consider starting ' + p.name + ' over ' + slot.player.name,
      why: 'Everyone ahead of ' + p.name + ' on his team is out ('
        + blockers.join(', ') + '), so he should get the work this week. '
        + 'Projections are slow to catch up to news like this, so he is '
        + 'probably worth more than his number suggests.',
    });
    break; /* one of these is plenty */
  }

  /* --- Rule 5b: byes coming up that need planning now ---------------------- */
  if (ctx.byeAhead && ctx.byeAhead.length) {
    const b = ctx.byeAhead[0];
    const away = b.week - ctx.week;
    const slots = b.empty.map(slotLabel);
    const names = b.players.map((p) => p.name);

    /* Close enough to act on is a warning; months out is a heads-up. */
    todos.push({
      level: (away <= 2) ? 'warn' : 'info',
      rank: (away <= 2) ? 'Bye week gap' : 'Plan ahead',
      action: 'In week ' + b.week + ' you cannot fill '
        + (slots.length === 1
          ? ('your ' + slots[0] + ' slot')
          : (slots.length + ' starting slots (' + slots.join(', ') + ')')),
      why: (names.length
        ? (names.join(', ') + ' '
          + (names.length === 1 ? 'is' : 'are') + ' on a bye that week, which '
          + 'leaves nobody for ' + (slots.length === 1 ? 'that slot' : 'those slots') + '. ')
        : '')
        + 'An empty slot scores zero, and no lineup change can fix it on the '
        + 'day - the player has to already be on your roster. That is '
        + away + ' week' + (away === 1 ? '' : 's') + ' away, so claim '
        + 'somebody on <span class="term" tabindex="0" data-def="The queue '
        + 'for claiming players nobody owns. Claims are processed together on a '
        + 'set day each week.">waivers</span> while there is still anybody '
        + 'worth having'
        + (away > 4
          ? ', or trade for someone on a different bye. There is plenty of '
            + 'time, but nothing fixes itself.'
          : '. Waiting until that week means picking over scraps.'),
    });
  }

  /* --- Rule 5c: dates that sneak up on you -------------------------------- */
  const lset = ctx.league.settings || {};

  if (lset.trade_deadline
      && (ctx.week === lset.trade_deadline - 1 || ctx.week === lset.trade_deadline)) {
    todos.push({
      level: 'info',
      rank: 'Deadline',
      action: (ctx.week === lset.trade_deadline)
        ? 'Trades close at the end of this week'
        : 'Trades close at the end of next week',
      why: 'After week ' + lset.trade_deadline + ' nobody in your league can '
        + 'trade for the rest of the season. If someone has offered you '
        + 'something reasonable, this is the last chance to take it.',
    });
  }

  if (lset.playoff_week_start && ctx.week === lset.playoff_week_start - 1) {
    todos.push({
      level: 'info',
      rank: 'Playoffs',
      action: 'The playoffs start next week',
      why: 'From week ' + lset.playoff_week_start + ', the top '
        + (lset.playoff_teams || 6) + ' teams play knockout games. One loss '
        + 'ends your season, so it is worth being careful with your lineup '
        + 'from here rather than coasting.',
    });
  }

  /* --- Rule 6: nothing to do ---------------------------------------------- */
  if (!todos.length) {
    todos.push({
      level: 'good',
      rank: '',
      action: 'Nothing to do today',
      why: 'Every starting slot is filled, nobody in your lineup is injured or '
         + 'on a bye, and there is no obvious upgrade sitting on your bench. '
         + 'Check back on game day.',
    });
  }

  return todos;
}

/* Find a worthwhile free agent, if there is one. */
/*
  Everybody nobody owns, ranked.

  This used to be Sleeper's "most added in the last 24 hours" list - twenty
  five names. That is a popularity contest, not a search. The best free agent
  on the wire was invisible unless other managers happened to be adding him
  that day, which meant the app could report "nothing to do" while a useful
  player sat there unowned all week.

  Anyone with a projection for this week is worth considering; the rest are
  third-stringers and noise. If the projections feed is down we fall back to
  the trending list, which is worse but is at least something.
*/
function buildFreeAgentPool(players, projections, schedule, week, ownedIds,
                            depthIndex, trendingIds) {
  const haveProj = !!projections;
  const pool = [];

  for (const id in players) {
    if (ownedIds.has(id)) continue;
    if (haveProj ? !projections[id] : !(trendingIds && trendingIds.has(id))) continue;

    const p = describe(id, players, projections, schedule, week);
    if (!p || isDeadWeight(p)) continue;
    p.trending = !!(trendingIds && trendingIds.has(id));
    pool.push(p);
  }

  pool.sort((a, b) => pts(b) - pts(a));

  /*
    Depth-chart lookups are the expensive part, so only ask about players
    good enough to matter. Anyone below the top of the pool is not going to
    win the comparison against a rostered player anyway.
  */
  for (const p of pool.slice(0, 60)) {
    /* Has everyone ahead of him been ruled out? Then he is first in line
       for the touches, which is the moment a backup becomes worth owning. */
    p.nextInLine = depthIndex ? blockersOut(p.id, players, depthIndex) : null;
  }
  return pool;
}

/*
  `myPlayers` is the pool we are allowed to drop from - the bench, when
  there is one. `allMine` is the whole roster, and is what decides whether
  a position has room; counting only the bench would think a team with two
  starting receivers and none on the bench was short of receivers.
*/
function findPickup(pool, myPlayers, depthIndex, startingSlots, allMine) {
  let candidates = (pool || []).slice(0, 60);
  if (!candidates.length) return null;

  /*
    Drop anyone who could never reach the lineup.

    Quarterbacks outscore every other position in raw points, so sorting
    trending adds by projection alone recommends a quarterback almost every
    week - including a third one, in a league that starts a single one. The
    first real recommendation this app made was to spend a third of a
    season's waiver budget on exactly that.

    A candidate earns his place only if we are short of bodies at his
    position, or he is better than the worst one we already have there.
  */
  const roster = (allMine && allMine.length) ? allMine : myPlayers;
  const room = {};
  for (const slot of (startingSlots || [])) {
    for (const pos of (FLEX_SLOTS[slot] || [slot])) {
      room[pos] = (room[pos] || 0) + 1;
    }
  }
  const worstOwnedAt = {};
  const ownedAt = {};
  for (const p of roster) {
    if (!p || !p.pos) continue;
    ownedAt[p.pos] = (ownedAt[p.pos] || 0) + 1;
    const cur = worstOwnedAt[p.pos];
    if (cur === undefined || pts(p) < pts(cur)) worstOwnedAt[p.pos] = p;
  }

  /* Without slot information we cannot judge fit, so judge nothing. */
  const useful = !Object.keys(room).length ? candidates : candidates.filter((c) => {
    const slots = room[c.pos] || 0;
    /* No slot on this roster will ever accept him. */
    if (slots === 0) return false;
    /* Short-handed at the position: any warm body is an upgrade on nobody. */
    if ((ownedAt[c.pos] || 0) < slots) return true;
    /* Otherwise he has to beat the man he would replace. */
    const worst = worstOwnedAt[c.pos];
    return !worst || pts(c) > pts(worst);
  });
  if (!useful.length) return null;
  candidates = useful;

  /* A man who just inherited a starting job beats a marginally higher
     projection, because the projection has not caught up to the news yet. */
  candidates.sort((a, b) => {
    const line = (b.nextInLine ? 1 : 0) - (a.nextInLine ? 1 : 0);
    if (line !== 0) return line;
    return pts(b) - pts(a);
  });
  const add = candidates[0];

  /* Drop the weakest player we own who is not currently helping. */
  const droppable = myPlayers
    /* Never suggest dropping someone stashed on injured reserve. That slot
       costs nothing, so cutting him is pure loss. */
    .filter((p) => p && !p.onIR)
    .sort((a, b) => {
      /* Dead weight first, then lowest projection, then worst season rank. */
      const dead = (isDeadWeight(b) ? 1 : 0) - (isDeadWeight(a) ? 1 : 0);
      if (dead !== 0) return dead;
      const d = pts(a) - pts(b);
      if (d !== 0) return d;
      return b.rank - a.rank;
    });
  const drop = droppable[0];
  if (!drop) return null;

  /* Only bother if the add is actually better than the drop. */
  const addPts  = pts(add);
  const dropPts = pts(drop);
  if (!isDeadWeight(drop) && !(addPts > dropPts + 2)) return null;

  return { add, drop };
}

/* ===========================================================================
   Loading everything
   =========================================================================== */

async function loadEverything(cfg) {
  const state = await getJSON(API + '/v1/state/nfl');
  const season = state.season;
  const week = Number(state.display_week || state.week || 1) || 1;

  const user = await getJSON(API + '/v1/user/'
    + encodeURIComponent(cfg.username.trim().toLowerCase()));
  if (!user || !user.user_id) {
    throw new Error('NO_USER');
  }

  const [league, rosters, users] = await Promise.all([
    getJSON(API + '/v1/league/' + cfg.leagueId),
    getJSON(API + '/v1/league/' + cfg.leagueId + '/rosters'),
    getJSON(API + '/v1/league/' + cfg.leagueId + '/users'),
  ]);

  const mine = (rosters || []).find((r) => r.owner_id === user.user_id);
  if (!mine) throw new Error('NO_ROSTER');

  const statKey = statKeyFor(league);

  /* The schedule comes first because it tells us whether anyone plays today,
     which decides how hard we refresh everything else. */
  const schedule = await getSchedule(season);
  const gameDay = isGameDay(schedule, week);
  const projTtl = gameDay ? 15 * MIN : 6 * HOUR;

  const [players, projections, trending, matchups] = await Promise.all([
    getPlayers(),
    getProjections(season, week, statKey, projTtl),
    tryJSON(API + '/v1/players/nfl/trending/add?lookback_hours=24&limit=25'),
    tryJSON(API + '/v1/league/' + cfg.leagueId + '/matchups/' + week),
  ]);

  let draftTime = null;
  let draftStatus = null;
  if (league.draft_id
      && (league.status === 'pre_draft' || league.status === 'drafting')) {
    const draft = await tryJSON(API + '/v1/draft/' + league.draft_id);
    if (draft) {
      draftStatus = draft.status;
      if (draft.start_time) draftTime = draft.start_time;
    }
  }

  /* ---- lineup and bench ---- */
  const startingSlots = (league.roster_positions || [])
    .filter((s) => NON_STARTING.indexOf(s) === -1);

  const starterIds = mine.starters || [];
  const lineup = startingSlots.map((slot, i) => {
    const id = starterIds[i];
    const filled = id && id !== '0';
    const player = filled ? describe(id, players, projections, schedule, week) : null;
    /* A slot can hold a player we failed to look up - an unusual position,
       or someone Sleeper added after our cached player list was built. That
       is NOT the same as an empty slot, and must never be reported as one. */
    return { slot, player, unknown: !!(filled && !player) };
  });

  const startingSet = new Set(starterIds.filter((id) => id && id !== '0'));

  /* Players parked in the injured reserve slot. This league has one. They sit
     outside the normal bench: they cannot be started, and dropping one is a
     mistake because the slot they occupy is free. */
  const reserveSet = new Set(mine.reserve || []);

  const bench = (mine.players || [])
    .filter((id) => !startingSet.has(id))
    .map((id) => describe(id, players, projections, schedule, week))
    .filter(Boolean)
    .sort((a, b) => pts(b) - pts(a));

  for (const p of bench) p.onIR = reserveSet.has(p.id);

  /* ---- who owns whom, for free-agent checks ---- */
  const ownedIds = new Set();
  for (const r of (rosters || [])) {
    for (const id of (r.players || [])) ownedIds.add(id);
  }

  const depthIndex = buildDepthIndex(players);

  /* Unowned players worth knowing about, for the export. */
  const trendingIds = new Set((Array.isArray(trending) ? trending : [])
    .map((row) => row && row.player_id).filter(Boolean));

  const faPool = buildFreeAgentPool(players, projections, schedule, week,
                                    ownedIds, depthIndex, trendingIds);
  const freeAgents = faPool.slice(0, 8);

  const myPlayers = lineup.map((s) => s.player).filter(Boolean).concat(bench);
  const pickup = findPickup(faPool, bench.length ? bench : myPlayers,
                            depthIndex, startingSlots, myPlayers);

  /* ---- this week's matchup ---- */
  let matchup = null;
  if (Array.isArray(matchups) && matchups.length) {
    const meRow = matchups.find((m) => m.roster_id === mine.roster_id);
    if (meRow && meRow.matchup_id != null) {
      const oppRow = matchups.find((m) =>
        m.matchup_id === meRow.matchup_id && m.roster_id !== mine.roster_id);

      const nameOf = (rosterId) => {
        const r = (rosters || []).find((x) => x.roster_id === rosterId);
        const u = r && (users || []).find((x) => x.user_id === r.owner_id);
        if (!u) return 'Unknown team';
        return (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown team';
      };

      matchup = {
        mine:  { name: nameOf(mine.roster_id), points: meRow.points || 0 },
        theirs: oppRow
          ? {
            name: nameOf(oppRow.roster_id),
            points: oppRow.points || 0,
            /* Their lineup too, so an export can show both sides. */
            lineup: (oppRow.starters || []).map((id, i) => ({
              slot: startingSlots[i] || '?',
              player: (id && id !== '0')
                ? describe(id, players, projections, schedule, week) : null,
            })),
          }
          : null,
      };
    }
  }

  return {
    season, week, league, lineup, bench, matchup, draftTime, draftStatus,
    gameDay,
    waivers: waiverInfo(league, mine),
    freeAgents,
    players,
    depthIndex,
    byeAhead: upcomingByes(lineup, bench, schedule, week, startingSlots),
    userId: user.user_id,
    hasProjections: !!projections,
    hasSchedule: !!schedule,
    pickup,
    teamName: (users || []).find((u) => u.user_id === user.user_id),
  };
}

/* ===========================================================================
   Rendering
   =========================================================================== */

const LEVEL_CLASS = {
  urgent: 'p-urgent', warn: 'p-warn', info: 'p-info', good: 'p-good',
};

function renderTodos(todos) {
  const box = el('todo-list');
  box.innerHTML = '';
  for (const t of todos) {
    const card = document.createElement('div');
    card.className = 'todo ' + (LEVEL_CLASS[t.level] || '');
    card.innerHTML =
      (t.rank ? '<div class="todo-rank">' + t.rank + '</div>' : '')
      + '<p class="todo-action">' + t.action + '</p>'
      + '<p class="todo-why">' + t.why + '</p>';
    box.appendChild(card);
  }
}

function playerRow(slot, p, unknown) {
  const row = document.createElement('div');
  row.className = 'player';

  if (!p) {
    const title = unknown ? 'Player not recognised' : 'Empty';
    const note = unknown
      ? 'Someone is in this slot, but this page could not look them up'
      : 'Nobody in this slot';
    row.innerHTML =
      '<div class="slot">' + slotLabel(slot) + '</div>'
      + '<div class="player-main">'
      + '<div class="player-name' + (unknown ? '' : ' empty') + '">' + title + '</div>'
      + '<div class="player-meta">' + note + '</div></div>';
    return row;
  }

  let tag = '';
  if (p.health.label) {
    const cls = p.health.out ? 'tag-out' : 'tag-warn';
    tag = '<span class="tag ' + cls + '">' + p.health.label + '</span>';
  }
  if (p.onBye) tag += '<span class="tag tag-bye">BYE</span>';
  if (p.onIR) tag += '<span class="tag tag-bye">IR SLOT</span>';

  const where = p.onBye ? 'No game this week'
    : (opponentLabel(p) || 'Opponent unknown');

  const meta = [p.pos, p.team || 'no team', where].join(' &middot; ');

  const proj = (p.points != null)
    ? '<div class="player-proj"><b>' + p.points + '</b>proj</div>' : '';

  row.innerHTML =
    '<div class="slot">' + (slot ? slotLabel(slot) : p.pos) + '</div>'
    + '<div class="player-main">'
    + '<div class="player-name">' + p.name + tag + '</div>'
    + '<div class="player-meta">' + meta + '</div>'
    + '</div>' + proj;
  return row;
}

function renderRoster(data) {
  /* Before the draft every slot is empty. Showing nine "Empty" rows would be
     noise, so the whole section stays hidden until there are real players. */
  const hasAnyPlayer = data.bench.length
    || data.lineup.some((s) => s.player || s.unknown);
  if (!hasAnyPlayer) return;

  const starters = el('starters');
  const bench = el('bench');
  starters.innerHTML = '';
  bench.innerHTML = '';

  for (const s of data.lineup) starters.appendChild(playerRow(s.slot, s.player, s.unknown));
  for (const p of data.bench)  bench.appendChild(playerRow('BN', p));

  el('roster-block').hidden = false;
}

function renderMatchup(data) {
  const m = data.matchup;
  if (!m) return;

  const box = el('matchup');
  const rows = [
    '<div class="score-row"><div class="score-name">' + m.mine.name
      + ' <span class="you">(you)</span></div>'
      + '<div class="score-pts">' + m.mine.points.toFixed(1) + '</div></div>',
  ];

  if (m.theirs) {
    rows.push('<div class="score-row"><div class="score-name">' + m.theirs.name
      + '</div><div class="score-pts">' + m.theirs.points.toFixed(1)
      + '</div></div>');

    const diff = m.mine.points - m.theirs.points;
    let verdict;
    if (Math.abs(diff) < 0.05) verdict = 'Dead level right now.';
    else if (diff > 0) verdict = 'You are ahead by ' + diff.toFixed(1) + ' points.';
    else verdict = 'You are behind by ' + Math.abs(diff).toFixed(1) + ' points.';
    rows.push('<p class="score-verdict">' + verdict
      + ' Scores only move while games are being played.</p>');
  }

  box.innerHTML = rows.join('');
  el('matchup-block').hidden = false;
}

function renderHeader(data) {
  el('league-name').textContent = data.league.name || 'Fantasy Manager';
  const label = (data.league.status === 'pre_draft')
    ? (data.season + ' season &middot; not drafted yet')
    : ('Week ' + data.week + ' &middot; ' + data.season + ' season');
  el('week-label').innerHTML = label;
}

function renderWhenToCheck(data) {
  const box = el('when-to-check');
  /* Before the draft there is no lineup and no waiver wire, so this is noise. */
  if (data.league.status === 'pre_draft') { box.hidden = true; return; }
  box.innerHTML = '<b>When to check:</b> ' + whenToCheck(data.waivers);
  box.hidden = false;
}

function renderNote(data) {
  const missing = [];
  if (!data.hasProjections) missing.push('projected points');
  if (!data.hasSchedule) missing.push('opponents and bye weeks');
  const note = el('todo-note');
  if (!missing.length) { note.hidden = true; return; }
  note.textContent = 'Note: Sleeper did not return ' + missing.join(' or ')
    + ' this time, so some advice above is less specific than usual. '
    + 'Injury and empty-slot checks still work.';
  note.hidden = false;
}

/* ===========================================================================
   Export for Claude

   This page is deliberately dumb: fixed rules over public data, no AI, no
   cost. What it cannot do is read the news, weigh a genuinely close call, or
   know that a coach said something on Monday. So this builds one block of
   text you can paste into Claude to get exactly that.

   It is written as a complete prompt rather than a data dump, so pasting it
   is the only thing you have to do.
   =========================================================================== */

function pad(s, n) {
  s = String(s == null ? '' : s);
  return (s.length >= n) ? s : s + new Array(n - s.length + 1).join(' ');
}

/* Strip the HTML we use for tooltips - this is going into plain text. */
function plain(html) {
  return String(html).replace(/<[^>]*>/g, '').replace(/&mdash;/g, '-')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function exportPlayerLine(slot, p, onIR) {
  if (!p) return '  ' + pad(slot ? slotLabel(slot) : '--', 6) + 'EMPTY SLOT';
  const where = p.onBye ? 'BYE WEEK' : (opponentLabel(p) || 'opp ?');
  const status = (p.health.label ? p.health.label : 'healthy')
    + (onIR ? ' (on IR slot)' : '');
  return '  ' + pad(slot ? slotLabel(slot) : p.pos, 6)
    + pad(p.name, 24)
    + pad(p.team || '--', 5)
    + pad(where, 11)
    + pad(p.points != null ? ('proj ' + p.points) : 'proj ?', 12)
    + status;
}

function buildExport(data, todos) {
  const L = [];
  const s = (data.league.settings) || {};

  L.push('I play in a fantasy football league and I know almost nothing about');
  L.push('football. Below is my exact situation this week, pulled live from the');
  L.push('Sleeper API. Please tell me:');
  L.push('  1. Any lineup changes I should make, and why');
  L.push('  2. Anyone I should pick up or drop');
  L.push('  3. Anything I am missing that the numbers do not show');
  L.push('Use recent news and injury reports if you have them. Keep it short and');
  L.push('plain, and tell me what to do rather than giving me options.');
  L.push('');
  L.push('=== LEAGUE ===');
  L.push('Week ' + data.week + ' of the ' + data.season + ' season.');
  L.push('Scoring: ' + (Number(s.rec) >= 1 ? 'full PPR (1 point per catch)'
    : Number(s.rec) >= 0.5 ? 'half PPR' : 'standard, no PPR')
    + ', ' + (s.pass_td || 4) + ' point passing TDs.');
  L.push('Starting lineup: '
    + (data.league.roster_positions || [])
      .filter((x) => NON_STARTING.indexOf(x) === -1).map(slotLabel).join(', '));
  L.push('Teams: ' + (s.num_teams || '?') + '. '
    + (data.waivers.day ? ('Waivers run ' + data.waivers.day + '. ') : '')
    + (data.waivers.remaining != null
      ? ('Waiver budget left: $' + data.waivers.remaining + ' of $'
        + data.waivers.faab + '.') : ''));
  if (s.playoff_week_start) {
    L.push('Playoffs start week ' + s.playoff_week_start
      + '. Trade deadline is week ' + (s.trade_deadline || '?') + '.');
  }

  L.push('');
  L.push('=== MY TEAM' + (data.matchup ? ' (' + data.matchup.mine.name + ')' : '')
    + ' ===');
  L.push('STARTING:');
  for (const row of data.lineup) L.push(exportPlayerLine(row.slot, row.player));
  if (data.bench.length) {
    L.push('BENCH:');
    for (const p of data.bench) L.push(exportPlayerLine('BN', p, p.onIR));
  }

  if (data.matchup && data.matchup.theirs) {
    L.push('');
    L.push('=== THIS WEEK I PLAY: ' + data.matchup.theirs.name + ' ===');
    L.push('Score right now - me ' + data.matchup.mine.points.toFixed(1)
      + ', them ' + data.matchup.theirs.points.toFixed(1) + '.');
    if (data.matchup.theirs.lineup && data.matchup.theirs.lineup.length) {
      L.push('Their starting lineup:');
      for (const row of data.matchup.theirs.lineup) {
        L.push(exportPlayerLine(row.slot, row.player));
      }
    }
  }

  if (data.freeAgents && data.freeAgents.length) {
    L.push('');
    L.push('=== AVAILABLE PLAYERS (nobody in the league owns these) ===');
    for (const p of data.freeAgents) L.push(exportPlayerLine(null, p));
  }

  L.push('');
  L.push('=== WHAT MY OWN APP ALREADY TOLD ME ===');
  L.push('(fixed rules over the same data, no AI - say if you disagree)');
  todos.forEach((t, i) => {
    L.push((i + 1) + '. ' + plain(t.action));
    L.push('   ' + plain(t.why));
  });

  return L.join('\n');
}

async function copyExport() {
  const text = el('export-text').value;
  const status = el('export-status');
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch (e) {
    /* Older browsers, or a page without clipboard permission. */
    try {
      el('export-text').select();
      ok = document.execCommand('copy');
    } catch (e2) { ok = false; }
  }
  status.textContent = ok
    ? 'Copied. Paste it into Claude.'
    : 'Could not copy automatically - select the text below and copy it yourself.';
  status.hidden = false;
}

/* ===========================================================================
   Push notifications

   The page cannot notify you on its own - nothing of ours runs when you are
   not looking at it. A small scheduled job elsewhere does the watching and
   pushes only when a starter is OUT, on a bye, or a slot is empty.

   The job writes a heartbeat every hour. This page reads it, so a job that
   has quietly died shows up as a warning here rather than as silence you
   mistake for good news.
   =========================================================================== */

/* The scheduled job that does the watching. Empty would hide the feature. */
const PUSH_WORKER = 'https://fantasy-alerts.trmarkusen19.workers.dev';

const VAPID_PUBLIC =
  'BDmUGfikNH9V_GlD64s9HIpBCngHSZ5Of6cu-sByb_Sg1EqCaARGJVspHDSwJ3tTQ2h65Kt6qyRlpsY8rzgaQos';

/* A heartbeat older than this means something is broken. The job runs hourly. */
const HEARTBEAT_STALE_MS = 3 * HOUR;

function urlB64ToU8(s) {
  const padded = (s + '='.repeat((4 - s.length % 4) % 4))
    .replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window
    && 'Notification' in window;
}

/* On iOS the Push API only exists once the app is on the home screen. */
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function setPushStatus(html, level) {
  const box = el('push-status');
  box.innerHTML = html;
  box.className = 'push-status push-' + (level || 'info');
  box.hidden = false;
}

async function renderNotifications(data) {
  const block = el('push-block');
  if (!PUSH_WORKER) { block.hidden = true; return; }
  block.hidden = false;

  const btn = el('btn-push');
  btn.hidden = true;

  if (isIOS() && !isStandalone()) {
    setPushStatus('To get alerts, add this page to your home screen first: tap '
      + 'the <b>Share</b> button, then <b>Add to Home Screen</b>, and open it '
      + 'from there. Apple only allows notifications for installed apps.', 'info');
    return;
  }

  if (!pushSupported()) {
    setPushStatus('This browser cannot do notifications. Open the app from '
      + 'your home screen instead.', 'info');
    return;
  }

  if (Notification.permission === 'denied') {
    setPushStatus('Notifications are blocked. To turn them back on, open '
      + '<b>Settings &rarr; Notifications &rarr; Fantasy</b> on your phone and '
      + 'allow them.', 'warn');
    return;
  }

  let sub = null;
  try {
    const reg = await navigator.serviceWorker.ready;
    sub = await reg.pushManager.getSubscription();
  } catch (e) { sub = null; }

  if (!sub) {
    setPushStatus('Your phone will stay quiet unless a starter is ruled out, '
      + 'is on a bye, or a slot is empty. Nothing else will buzz you.', 'info');
    btn.hidden = false;
    btn.textContent = 'Turn on notifications';
    return;
  }

  /* Subscribed here - now check the job on the other end is actually alive. */
  let health = null;
  try {
    const res = await fetch(PUSH_WORKER + '/health', { cache: 'no-store' });
    health = await res.json();
  } catch (e) { health = null; }

  if (!health) {
    setPushStatus('Could not reach the alert service, so alerts may not be '
      + 'working. Check again later &mdash; do not rely on it this week.', 'warn');
    return;
  }

  if (!health.subscribed) {
    setPushStatus('This phone is no longer registered for alerts, which happens '
      + 'occasionally. Tap below to fix it.', 'warn');
    btn.hidden = false;
    btn.textContent = 'Turn notifications back on';
    return;
  }

  const age = health.lastRun ? (Date.now() - new Date(health.lastRun).getTime()) : null;
  if (age == null || age > HEARTBEAT_STALE_MS) {
    setPushStatus('<b>Alerts are not running.</b> The service last checked '
      + (health.lastRun ? ('on ' + new Date(health.lastRun).toLocaleString())
        : 'never')
      + '. Do not count on being warned &mdash; check your lineup yourself '
      + 'this week.', 'bad');
    return;
  }

  const mins = Math.round(age / MIN);
  setPushStatus('Alerts are on and working. Last checked '
    + (mins < 2 ? 'just now' : (mins + ' minutes ago'))
    + '. You will only hear from it when something needs fixing.', 'good');
}

/*
  Hand the worker what it cannot work out for itself.

  The worker gets 10ms of CPU, so it can never load the 15 MB player file or
  the 2 MB projections feed. This page can. So when it runs, it posts the
  conclusions the worker could not reach - bench upgrades, and players who
  have just inherited a starting job - and the next scheduled alert carries
  them.

  Not circular: this page opens every time a notification is tapped, so the
  alerts keep their own input fresh. One small write per open, which is
  nothing against the free plan's daily allowance.
*/
const WORKER_ONLY_BLIND_SPOTS = ['Upgrade', 'New starter'];

async function sendAdvice(data, todos) {
  if (!PUSH_WORKER || !lastData) return;

  const items = todos
    .filter((t) => WORKER_ONLY_BLIND_SPOTS.indexOf(t.rank) !== -1)
    .map((t) => plain(t.action))
    .slice(0, 3);

  if (!items.length) return;

  try {
    await fetch(PUSH_WORKER + '/advice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ week: data.week, items }),
    });
  } catch (e) {
    /* Never let this get in the way of the page rendering. */
    console.warn('Could not send advice to the alert service:', e);
  }
}

async function enablePush() {
  const btn = el('btn-push');
  btn.disabled = true;
  btn.textContent = 'Setting up…';

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setPushStatus('You said no to notifications. Tap the button again if you '
        + 'change your mind.', 'warn');
      return;
    }

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToU8(VAPID_PUBLIC),
      });
    }

    const res = await fetch(PUSH_WORKER + '/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        userId: lastData.userId,
        leagueId: loadConfig().leagueId,
      }),
    });
    if (!res.ok) throw new Error('the alert service refused it (' + res.status + ')');

    await renderNotifications(lastData);
  } catch (err) {
    console.error(err);
    setPushStatus('Could not turn notifications on: ' + (err.message || err)
      + '. Nothing is broken &mdash; the rest of the app works as normal.', 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Turn on notifications';
  }
}

/* ===========================================================================
   Jargon tooltips
   =========================================================================== */

let activeTip = null;

function hideTip() {
  el('tip').hidden = true;
  activeTip = null;
}

function showTip(target) {
  const def = target.getAttribute('data-def');
  if (!def) return;
  const tip = el('tip');
  tip.textContent = def;
  tip.hidden = false;

  const r = target.getBoundingClientRect();
  const tw = tip.offsetWidth;
  let left = r.left + window.scrollX + (r.width / 2) - (tw / 2);
  left = Math.max(12, Math.min(left, window.innerWidth - tw - 12));

  let top = r.bottom + window.scrollY + 8;
  if (r.bottom + tip.offsetHeight + 20 > window.innerHeight) {
    top = r.top + window.scrollY - tip.offsetHeight - 8;
  }
  tip.style.left = left + 'px';
  tip.style.top = top + 'px';
  activeTip = target;
}

function wireTooltips() {
  document.addEventListener('click', (e) => {
    const term = e.target.closest('.term');
    if (term) {
      if (activeTip === term) hideTip(); else showTip(term);
      e.stopPropagation();
      return;
    }
    hideTip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTip();
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('.term')) {
      e.preventDefault();
      const t = e.target.closest('.term');
      if (activeTip === t) hideTip(); else showTip(t);
    }
  });
  document.addEventListener('mouseover', (e) => {
    const term = e.target.closest('.term');
    if (term && !activeTip) showTip(term);
  });
  document.addEventListener('mouseout', (e) => {
    const term = e.target.closest('.term');
    if (term && activeTip === term) hideTip();
  });
  window.addEventListener('scroll', hideTip, { passive: true });
}

/* ===========================================================================
   Screens
   =========================================================================== */

function showSetup(prefill) {
  el('app').hidden = true;
  el('fatal').hidden = true;
  el('setup').hidden = false;
  if (prefill) {
    el('in-username').value = prefill.username || '';
    el('in-league').value = prefill.leagueId || '';
  }
  el('in-username').focus();
}

function showFatal(message) {
  el('app').hidden = true;
  el('setup').hidden = true;
  el('fatal').hidden = false;
  el('fatal-msg').textContent = message;
}

function friendlyError(err) {
  const msg = String(err && err.message || err);
  if (msg === 'NO_USER') {
    return 'Sleeper has no account with that username. It should be your '
      + 'login name in lowercase with no spaces, not your team name. '
      + 'Click below to try again.';
  }
  if (msg === 'NO_ROSTER') {
    return 'That username is real and that league is real, but that user is '
      + 'not in that league. One of the two is probably from a different '
      + 'account or a different season. Click below to try again.';
  }
  if (msg.indexOf('404') !== -1) {
    return 'Sleeper could not find that league. Check the league ID is the '
      + 'long number from your league\'s web address. Click below to try again.';
  }
  if (msg.indexOf('Failed to fetch') !== -1 || msg.indexOf('NetworkError') !== -1) {
    return 'Could not reach Sleeper. Check your internet connection and '
      + 'try again.';
  }
  return 'Sleeper returned an unexpected error: ' + msg;
}

/* ===========================================================================
   Boot
   =========================================================================== */

let refreshing = false;
let lastData = null;
/* Set when the user closes draft mode, so a live draft does not keep
   dragging them back into it against their will. */
let draftDismissed = false;

/* When the data on screen was last loaded successfully. */
let lastLoadedAt = 0;

/*
  How old what is on screen may get before we refetch, and before we say
  on the page that it cannot be trusted.

  This matters more than it sounds. The page used to load once and never
  again, so an app left in the background since Wednesday would still be
  showing Wednesday's injuries on Sunday morning - looking entirely
  normal - while the user set their lineup from it. Five minutes is short
  enough that a returning user is always looking at live data.
*/
const STALE_MS = 5 * MIN;

/*
  Say how old the numbers are, and say it loudly once they are too old.
  Called on a timer as well as after a load, so the warning appears while
  the page is sitting open rather than only when something else happens.
*/
function renderUpdatedAt() {
  const node = el('updated-at');
  if (!node) return;
  if (!lastLoadedAt) { node.textContent = ''; return; }

  const time = new Date(lastLoadedAt).toLocaleTimeString(
    undefined, { hour: 'numeric', minute: '2-digit' });
  const stale = (Date.now() - lastLoadedAt) > STALE_MS;

  node.textContent = stale
    ? ('Out of date - last loaded ' + time + '. Pull to refresh before '
      + 'trusting anything here.')
    : ('Updated ' + time);
  node.classList.toggle('stale', stale);
}

/* The button only makes sense while there is a draft to open. */
function renderDraftButton(data) {
  const btn = el('btn-draft');
  const live = data.draftStatus === 'drafting';
  const soon = data.draftStatus === 'pre_draft';
  btn.hidden = !(live || soon);
  btn.textContent = live ? 'Draft is live - open draft mode'
    : 'Open draft mode';
  btn.classList.toggle('live', live);

  /* Trades need rosters, which do not exist until the draft is done. */
  el('btn-trade').hidden = (data.league.status === 'pre_draft');
}

async function run(cfg) {
  if (refreshing) return;
  refreshing = true;
  el('btn-refresh').classList.add('spinning');

  try {
    const data = await loadEverything(cfg);
    lastData = data;
    renderDraftButton(data);
    renderHeader(data);
    const todos = buildTodoList(data);
    renderTodos(todos);
    renderWhenToCheck(data);
    renderNote(data);

    /* Build the paste-into-Claude block from the same data the page shows. */
    el('export-text').value = buildExport(data, todos);
    el('export-block').hidden = (data.league.status === 'pre_draft');
    el('export-status').hidden = true;

    /* Both run on their own; neither blocks the page if the service is down. */
    renderNotifications(data);
    sendAdvice(data, todos);
    renderMatchup(data);
    renderRoster(data);

    lastLoadedAt = Date.now();
    renderUpdatedAt();

    el('setup').hidden = true;
    el('fatal').hidden = true;
    el('app').hidden = false;

    /* A live draft is the only thing that matters while it is happening,
       so go straight there unless the user has closed it already. */
    if (data.draftStatus === 'drafting' && !draftDismissed) {
      enterDraftMode(data, cfg);
    }
  } catch (err) {
    console.error(err);
    showFatal(friendlyError(err));
  } finally {
    refreshing = false;
    el('btn-refresh').classList.remove('spinning');
  }
}

function wireControls() {
  el('btn-save').addEventListener('click', () => {
    const username = el('in-username').value.trim().toLowerCase();
    const leagueId = el('in-league').value.trim();
    const err = el('setup-error');

    if (!username) {
      err.textContent = 'Enter your Sleeper username.';
      err.hidden = false; return;
    }
    if (!/^\d{6,}$/.test(leagueId)) {
      err.textContent = 'A league ID is a long string of digits only. Copy it '
        + 'from your league\'s web address on sleeper.com.';
      err.hidden = false; return;
    }
    err.hidden = true;

    const cfg = { username, leagueId };
    saveConfig(cfg);
    clearCache();
    run(cfg);
  });

  el('in-league').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('btn-save').click();
  });

  el('btn-refresh').addEventListener('click', () => {
    const cfg = loadConfig();
    if (cfg) run(cfg);
  });

  el('btn-draft').addEventListener('click', () => {
    draftDismissed = false;
    if (lastData) enterDraftMode(lastData, loadConfig());
  });

  el('btn-export').addEventListener('click', copyExport);
  el('btn-push').addEventListener('click', enablePush);

  el('btn-trade').addEventListener('click', () => {
    if (lastData) enterTradeMode(lastData);
  });

  el('btn-reset').addEventListener('click', () => showSetup(loadConfig()));
  el('btn-fatal-reset').addEventListener('click', () => showSetup(loadConfig()));

  el('btn-clear-cache').addEventListener('click', () => {
    clearCache();
    const cfg = loadConfig();
    if (cfg) run(cfg);
  });
}

/*
  Refetch whenever the user comes back to the app.

  On iOS a home-screen app is not closed when it is backgrounded, it is
  frozen. Every pick made in the Sleeper app, every check of the score,
  leaves this page suspended - and it used to thaw showing whatever it
  had loaded days ago, with no hint that anything was wrong.

  `visibilitychange` covers backgrounding, `pageshow` covers the back/
  forward cache, and `focus` covers a desktop window regaining focus.
  All three are cheap: nothing refetches unless the data is actually old.
*/
function wireFreshness() {
  const onReturn = () => {
    if (document.visibilityState === 'hidden') return;
    renderUpdatedAt();

    const cfg = loadConfig();
    if (!cfg || !cfg.username || !cfg.leagueId) return;
    if (Date.now() - lastLoadedAt > STALE_MS) run(cfg);
  };

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('pageshow', onReturn);
  window.addEventListener('focus', onReturn);

  /* Keeps the warning honest on a page nobody has touched for an hour. */
  setInterval(renderUpdatedAt, 30 * 1000);
}

function start() {
  wireControls();
  wireTooltips();
  wireFreshness();

  const cfg = loadConfig();
  if (cfg && cfg.username && cfg.leagueId) run(cfg);
  else showSetup(null);

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

start();
