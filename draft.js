/* ===========================================================================
   Draft mode.

   One job: during a live draft, tell the user which single player to take
   next, and be right often enough that following it blindly produces a
   competent team.

   The ranking is value over replacement (VOR), the standard method:
   a player is worth what he scores ABOVE the worst player you could
   otherwise start at that position. A quarterback projected for 300 points
   is not better than a running back projected for 250, because every team
   has a good quarterback and running backs fall off a cliff.

   Inputs, all free from Sleeper:
     - season projected points (Rotowire)  -> what a player is worth
     - average draft position (adp_ppr)    -> when he will actually be taken
   =========================================================================== */

'use strict';

const DRAFT_POLL_MS = 5000;      /* how often to check for new picks */
const DRAFT_STATUS_MS = 30000;   /* how often to re-check draft status */

/* How many of each position a sensible team ends up with. Stops the app
   recommending a third quarterback in round 9. */
const MAX_AT_POSITION = { QB: 2, RB: 6, WR: 6, TE: 2, K: 1, DEF: 1 };

/* Roughly how much of a flex slot each position soaks up league-wide.
   Used to work out where "replacement level" sits for each position. */
const FLEX_SHARE = { RB: 0.5, WR: 0.4, TE: 0.1 };

/* Season points knocked off a player who would only ever be bench depth,
   because every starting slot he fits is already covered. */
const BENCH_PENALTY = 25;

const draftState = {
  timer: null,
  statusTimer: null,
  ctx: null,
  lastPickCount: -1,
};

/* ---------------------------------------------------------------------------
   Season-long projections: points and ADP
   --------------------------------------------------------------------------- */

async function getSeasonProjections(season, statKey) {
  const adpKey = statKey === 'pts_ppr' ? 'adp_ppr'
    : statKey === 'pts_half_ppr' ? 'adp_half_ppr' : 'adp_std';

  const key = 'seasonproj.' + season + '.' + statKey;
  const hit = cacheGet(key, DAY);
  if (hit) return hit;

  const positions = ['QB', 'RB', 'WR', 'TE', 'K']
    .map((p) => '&position[]=' + p).join('');
  const url = API + '/projections/nfl/' + season
    + '?season_type=regular&order_by=' + adpKey + positions;

  const raw = await tryJSON(url);
  if (!Array.isArray(raw)) return null;

  const out = {};
  for (const row of raw) {
    if (!row || !row.player_id || !row.stats) continue;
    const pts = row.stats[statKey];
    if (pts == null) continue;
    const adp = row.stats[adpKey];
    out[row.player_id] = {
      pts: Math.round(pts * 10) / 10,
      /* 999 and 1000 are Sleeper's "no meaningful ADP" markers. */
      adp: (adp == null || adp >= 900) ? null : Math.round(adp * 10) / 10,
    };
  }
  cacheSet(key, out);
  return out;
}

/* ---------------------------------------------------------------------------
   Snake draft arithmetic
   --------------------------------------------------------------------------- */

/* Every overall pick number belonging to one draft slot. */
function pickNumbersForSlot(slot, teams, rounds) {
  const out = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound = (r % 2 === 1) ? slot : (teams - slot + 1);
    out.push((r - 1) * teams + inRound);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Replacement level
   --------------------------------------------------------------------------- */

/* Count the starting slots this league uses. */
function slotCounts(rosterPositions) {
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0, FLEX: 0 };
  for (const slot of (rosterPositions || [])) {
    if (NON_STARTING.indexOf(slot) !== -1) continue;
    if (FLEX_SLOTS[slot]) counts.FLEX += 1;
    else if (counts[slot] != null) counts[slot] += 1;
  }
  return counts;
}

/*
  Replacement level is the points you could get for free at each position.
  In a 12 team league starting 2 RB plus a flex, roughly 30 running backs
  get started every week, so RB number 30 is "replacement" - anything above
  him is real value.
*/
function replacementPoints(pool, rosterPositions, teams) {
  const counts = slotCounts(rosterPositions);
  const out = {};

  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K']) {
    const flex = (FLEX_SHARE[pos] || 0) * counts.FLEX;
    const rank = Math.max(1, Math.round(teams * ((counts[pos] || 0) + flex)));

    const atPos = pool
      .filter((p) => p.pos === pos)
      .sort((a, b) => b.pts - a.pts);

    const target = atPos[Math.min(rank, atPos.length) - 1];
    out[pos] = target ? target.pts : 0;
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Building the candidate pool
   --------------------------------------------------------------------------- */

/*
  Which position should we rank this player at?

  Some players carry a listed position we have no replacement level for -
  Travis Hunter is listed DB but is drafted as a wide receiver. Ranking him
  at DB would subtract a replacement value of zero and make his value look
  enormous, floating him into the top ten. So fall back to the first of his
  fantasy-eligible positions that we actually rank.
*/
const RANKED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K'];

function rankablePosition(pl) {
  if (RANKED_POSITIONS.indexOf(pl.p) !== -1) return pl.p;
  for (const p of (pl.f || [])) {
    if (RANKED_POSITIONS.indexOf(p) !== -1) return p;
  }
  return null;
}

function buildPool(players, seasonProj) {
  const pool = [];
  for (const id in seasonProj) {
    const pl = players[id];
    if (!pl) continue;
    const pos = rankablePosition(pl);
    if (!pos) continue;
    const sp = seasonProj[id];
    pool.push({
      id,
      name: pl.n,
      pos,
      team: pl.t,
      pts: sp.pts,
      adp: sp.adp,
      health: health(pl),
    });
  }
  return pool;
}

/* ---------------------------------------------------------------------------
   What do I still need?
   --------------------------------------------------------------------------- */

/*
  Walk the starting slots and see which ones this roster cannot yet fill.
  Returns the list of unfilled starting slots.
*/
function unfilledSlots(rosterPositions, myPlayers) {
  const startingSlots = (rosterPositions || [])
    .filter((s) => NON_STARTING.indexOf(s) === -1);

  const remaining = myPlayers.slice();
  const unfilled = [];

  /* Fill the strict positions first, then the flex slots with whatever
     is left over, so a flex slot is never "filled" by a player another
     slot needed more. */
  const strict = startingSlots.filter((s) => !FLEX_SLOTS[s]);
  const flex = startingSlots.filter((s) => FLEX_SLOTS[s]);

  for (const slot of strict.concat(flex)) {
    const allowed = FLEX_SLOTS[slot] || [slot];
    const i = remaining.findIndex((p) => allowed.indexOf(p.pos) !== -1);
    if (i === -1) unfilled.push(slot);
    else remaining.splice(i, 1);
  }
  return unfilled;
}

/* Positions that would fill at least one currently unfilled starting slot. */
function neededPositions(unfilled) {
  const set = new Set();
  for (const slot of unfilled) {
    for (const pos of (FLEX_SLOTS[slot] || [slot])) set.add(pos);
  }
  return set;
}

/* ---------------------------------------------------------------------------
   THE RECOMMENDATION
   --------------------------------------------------------------------------- */

function recommend(ctx) {
  const {
    pool, taken, myPlayers, rosterPositions,
    replacement, picksLeft, nextPickNo, pickAfterNextNo, teams,
  } = ctx;

  const have = {};
  for (const p of myPlayers) have[p.pos] = (have[p.pos] || 0) + 1;

  const unfilled = unfilledSlots(rosterPositions, myPlayers);
  const needed = neededPositions(unfilled);

  /* If we are down to exactly as many picks as we have holes to fill,
     stop taking value and start filling holes. This is what stops you
     finishing the draft with no kicker. */
  const mustFill = picksLeft <= unfilled.length;

  let candidates = pool.filter((p) => {
    if (taken.has(p.id)) return false;
    if (p.health.out) return false;

    const cap = MAX_AT_POSITION[p.pos];
    if (cap != null && (have[p.pos] || 0) >= cap) return false;

    /* A kicker is worth almost nothing. Never take one until the very end. */
    if (p.pos === 'K' && picksLeft > 1) return false;

    if (mustFill && !needed.has(p.pos)) return false;
    return true;
  });

  if (!candidates.length) return null;

  for (const p of candidates) {
    p.vor = Math.round((p.pts - (replacement[p.pos] || 0)) * 10) / 10;
  }

  /*
    Value over replacement alone is not enough, and a full mock draft proved
    it: taking the highest-VOR player every round produced six receivers and
    three running backs, with the last two running backs 45 points BELOW
    replacement level. Receivers kept looking better round by round, and by
    the time running back became urgent, every good one was gone.

    The missing idea is opportunity cost. What matters is not how good a
    player is, but how much better he is than whoever would still be there at
    your NEXT pick. A receiver you can get again in two rounds is worth less
    than a running back who will not be.
  */
  const bestLater = {};
  for (const p of candidates) {
    if (bestLater[p.pos] === undefined) {
      let top = 0;
      for (const q of candidates) {
        if (q.pos !== p.pos) continue;
        /* Anyone normally drafted before our next pick is probably gone. */
        if (pickAfterNextNo != null && q.adp != null && q.adp < pickAfterNextNo) continue;
        if (q.vor > top) top = q.vor;
      }
      bestLater[p.pos] = top;
    }
    p.urgency = Math.round((p.vor - bestLater[p.pos]) * 10) / 10;

    /* A second quarterback never starts in a one-quarterback league. Depth
       at a position already covered is worth far less than it looks. */
    p.score = needed.has(p.pos) ? p.urgency : (p.urgency - BENCH_PENALTY);
  }

  candidates.sort((a, b) => (b.score - a.score) || (b.vor - a.vor));

  const best = candidates[0];

  /* Will he still be there next time? Players go roughly in ADP order, so
     if his ADP is comfortably past our next-but-one pick, we can wait. */
  const willLast = best.adp != null && pickAfterNextNo != null
    && best.adp > pickAfterNextNo + teams * 0.5;

  /* How thin is his position getting? */
  const sameposLeft = candidates.filter((p) => p.pos === best.pos).length;
  const runnerUpSamePos = candidates.find((p) => p.pos === best.pos && p.id !== best.id);
  const gapToNextSamePos = runnerUpSamePos
    ? Math.round((best.vor - runnerUpSamePos.vor) * 10) / 10 : null;

  let reason;
  if (mustFill) {
    reason = 'You have ' + picksLeft + ' pick' + (picksLeft === 1 ? '' : 's')
      + ' left and still need to fill ' + unfilled.length + ' starting spot'
      + (unfilled.length === 1 ? '' : 's') + '. He is the best '
      + describePosition(best.pos) + ' available.';
  } else if (best.urgency >= 25) {
    reason = 'Take him now. ' + describePosition(best.pos) + 's are thinning '
      + 'out, and the best one likely still on the board at your next pick is '
      + 'about ' + Math.round(best.urgency) + ' points worse over the season.';
  } else if (gapToNextSamePos != null && gapToNextSamePos >= 15) {
    reason = 'He is projected for ' + Math.round(gapToNextSamePos)
      + ' more points than the next '
      + describePosition(best.pos) + ' on the board, and that gap does not '
      + 'come back around.';
  } else if (best.adp != null && best.adp < nextPickNo) {
    reason = 'He is usually drafted around pick ' + Math.round(best.adp)
      + ', so he has fallen further than he should have. Take the discount.';
  } else if (!willLast) {
    reason = 'He is the most valuable player left for your team, and he is '
      + 'unlikely to still be there at your next pick.';
  } else {
    reason = 'He is the most valuable player left for your team, projected '
      + 'for ' + Math.round(best.pts) + ' points this season.';
  }

  /* Backups: the next best, favouring different positions so a single
     position run does not wipe out all three. */
  const backups = [];
  const seenPos = new Set([best.pos]);
  for (const p of candidates.slice(1)) {
    if (backups.length >= 3) break;
    if (backups.length < 2 && seenPos.has(p.pos)) continue;
    seenPos.add(p.pos);
    backups.push(p);
  }
  while (backups.length < 3 && candidates.length > backups.length + 1) {
    const extra = candidates.slice(1).find((p) => backups.indexOf(p) === -1);
    if (!extra) break;
    backups.push(extra);
  }

  return { best, reason, backups, unfilled, mustFill, sameposLeft };
}

function describePosition(pos) {
  return { QB: 'quarterback', RB: 'running back', WR: 'wide receiver',
    TE: 'tight end', K: 'kicker', DEF: 'defense' }[pos] || pos;
}

/* ---------------------------------------------------------------------------
   Rendering
   --------------------------------------------------------------------------- */

function renderDraft(view) {
  const box = el('draft');
  const parts = [];

  parts.push('<div class="draft-top">'
    + '<div><h1>Draft</h1><p class="subtle">' + view.leagueName + '</p></div>'
    + '<button id="btn-leave-draft" class="btn-icon" title="Leave draft mode" '
    + 'aria-label="Leave draft mode">&times;</button></div>');

  /* --- not started yet --- */
  if (view.status === 'pre_draft') {
    parts.push('<div class="draft-wait"><p class="draft-wait-title">'
      + 'Waiting for the draft to start</p><p class="subtle">' + view.startsAt
      + '</p><p class="subtle tiny">This screen updates on its own when the '
      + 'first pick is made. Leave it open.</p></div>');
  }

  /* --- the countdown --- */
  if (view.status === 'drafting') {
    if (view.onTheClock) {
      parts.push('<div class="draft-clock you-are-up">'
        + '<div class="clock-big">YOU ARE ON THE CLOCK</div>'
        + '<div class="clock-sub">Pick ' + view.nextPickNo
        + ' &middot; round ' + view.nextRound + '</div></div>');
    } else if (view.picksAway != null) {
      parts.push('<div class="draft-clock">'
        + '<div class="clock-big">' + view.picksAway + '</div>'
        + '<div class="clock-sub">pick' + (view.picksAway === 1 ? '' : 's')
        + ' until your turn &middot; you are up at pick ' + view.nextPickNo
        + ' (round ' + view.nextRound + ')</div></div>');
    } else {
      parts.push('<div class="draft-clock"><div class="clock-sub">'
        + 'You have made all of your picks. The draft is finishing up.'
        + '</div></div>');
    }
  }

  /* --- the one recommendation --- */
  if (view.rec) {
    const b = view.rec.best;
    parts.push('<div class="pick-card">'
      + '<div class="pick-label">Take</div>'
      + '<div class="pick-name">' + b.name + '</div>'
      + '<div class="pick-meta">' + describePosition(b.pos)
      + (b.team ? ' &middot; ' + b.team : '')
      + (b.adp != null ? ' &middot; usually goes around pick ' + Math.round(b.adp) : '')
      + '</div>'
      + '<p class="pick-why">' + view.rec.reason + '</p>'
      + '</div>');

    if (view.rec.backups.length) {
      parts.push('<h2 class="draft-h2">If someone takes him first</h2>');
      parts.push('<div class="backups">' + view.rec.backups.map((p) =>
        '<div class="backup"><div class="backup-name">' + p.name + '</div>'
        + '<div class="backup-meta">' + describePosition(p.pos)
        + (p.team ? ' &middot; ' + p.team : '') + '</div></div>').join('')
        + '</div>');
    }
  } else if (view.status === 'drafting') {
    parts.push('<div class="pick-card"><div class="pick-name">Your team is full'
      + '</div><p class="pick-why">Every spot is filled. Nothing left to do.'
      + '</p></div>');
  }

  /* --- what I still need --- */
  if (view.unfilledLabels && view.unfilledLabels.length) {
    parts.push('<h2 class="draft-h2">Still to fill</h2>');
    parts.push('<div class="need-row">' + view.unfilledLabels.map((s) =>
      '<span class="need">' + s + '</span>').join('') + '</div>');
  } else if (view.myPlayers && view.myPlayers.length) {
    parts.push('<h2 class="draft-h2">Still to fill</h2>');
    parts.push('<p class="subtle">Every starting spot is covered. '
      + 'Anything else is bench depth.</p>');
  }

  /* --- my team so far --- */
  parts.push('<h2 class="draft-h2">My team so far ('
    + (view.myPlayers ? view.myPlayers.length : 0) + ')</h2>');
  if (view.myPlayers && view.myPlayers.length) {
    parts.push('<div class="roster-group">' + view.myPlayers.map((p) =>
      '<div class="player"><div class="slot">' + p.pos + '</div>'
      + '<div class="player-main"><div class="player-name">' + p.name
      + '</div><div class="player-meta">' + (p.team || 'free agent')
      + ' &middot; round ' + p.round + '</div></div></div>').join('') + '</div>');
  } else {
    parts.push('<p class="subtle">No picks yet.</p>');
  }

  parts.push('<p class="draft-foot subtle tiny">Updating every '
    + (DRAFT_POLL_MS / 1000) + ' seconds. Make the actual pick in the Sleeper '
    + 'app &mdash; this page cannot draft for you.</p>');

  box.innerHTML = parts.join('');
  const leave = el('btn-leave-draft');
  if (leave) leave.addEventListener('click', exitDraftMode);
}

/* ---------------------------------------------------------------------------
   The polling loop
   --------------------------------------------------------------------------- */

async function refreshDraft() {
  const c = draftState.ctx;
  if (!c) return;

  const picks = await tryJSON(API + '/v1/draft/' + c.draftId + '/picks');
  if (!Array.isArray(picks)) return;

  /* Nothing has changed since last time, so skip the work. */
  if (picks.length === draftState.lastPickCount) return;
  draftState.lastPickCount = picks.length;

  const taken = new Set();
  const myPlayers = [];
  for (const pick of picks) {
    if (pick.player_id) taken.add(pick.player_id);
    if (pick.draft_slot === c.mySlot) {
      const pl = c.players[pick.player_id];
      myPlayers.push({
        id: pick.player_id,
        name: pl ? pl.n : (pick.metadata
          ? ((pick.metadata.first_name || '') + ' ' + (pick.metadata.last_name || '')).trim()
          : 'Unknown'),
        pos: pl ? (rankablePosition(pl) || pl.p)
          : (pick.metadata ? pick.metadata.position : '?'),
        team: pl ? pl.t : (pick.metadata ? pick.metadata.team : null),
        round: pick.round,
      });
    }
  }

  const made = picks.length;
  const nextPickNo = c.myPickNumbers.find((n) => n > made);
  const pickAfterNextNo = c.myPickNumbers.find((n) => n > (nextPickNo || Infinity));
  const picksLeft = c.myPickNumbers.filter((n) => n > made).length;

  const rec = nextPickNo ? recommend({
    pool: c.pool,
    taken,
    myPlayers,
    rosterPositions: c.rosterPositions,
    replacement: c.replacement,
    picksLeft,
    nextPickNo,
    pickAfterNextNo,
    teams: c.teams,
  }) : null;

  renderDraft({
    leagueName: c.leagueName,
    status: c.status,
    startsAt: c.startsAt,
    onTheClock: nextPickNo === made + 1,
    picksAway: nextPickNo ? (nextPickNo - made - 1) : null,
    nextPickNo,
    nextRound: nextPickNo ? Math.ceil(nextPickNo / c.teams) : null,
    rec,
    myPlayers,
    unfilledLabels: rec ? rec.unfilled.map(slotLabel) : null,
  });
}

async function checkDraftStatus() {
  const c = draftState.ctx;
  if (!c) return;
  const draft = await tryJSON(API + '/v1/draft/' + c.draftId);
  if (!draft) return;
  if (draft.status !== c.status) {
    c.status = draft.status;
    draftState.lastPickCount = -1;  /* force a full redraw */
    refreshDraft();
  }
  if (draft.status === 'complete') stopPolling();
}

function stopPolling() {
  if (draftState.timer) clearInterval(draftState.timer);
  if (draftState.statusTimer) clearInterval(draftState.statusTimer);
  draftState.timer = null;
  draftState.statusTimer = null;
}

/* ---------------------------------------------------------------------------
   Entering and leaving
   --------------------------------------------------------------------------- */

async function enterDraftMode(data, cfg) {
  const league = data.league;
  const draftId = league.draft_id;
  if (!draftId) {
    alert('This league has no draft attached to it.');
    return;
  }

  el('app').hidden = true;
  el('draft').hidden = false;
  el('draft').innerHTML = '<div class="loading">Loading the draft board&hellip;</div>';

  const [draft, players, seasonProj] = await Promise.all([
    tryJSON(API + '/v1/draft/' + draftId),
    getPlayers(),
    getSeasonProjections(data.season, statKeyFor(league)),
  ]);

  if (!draft) {
    el('draft').innerHTML = '<div class="loading">Could not load the draft. '
      + '<button id="btn-leave-draft" class="linklike">Go back</button></div>';
    const leave = el('btn-leave-draft');
    if (leave) leave.addEventListener('click', exitDraftMode);
    return;
  }

  if (!seasonProj) {
    el('draft').innerHTML = '<div class="loading">Sleeper did not return draft '
      + 'rankings this time, so draft mode cannot make a recommendation. '
      + '<button id="btn-leave-draft" class="linklike">Go back</button></div>';
    const leave = el('btn-leave-draft');
    if (leave) leave.addEventListener('click', exitDraftMode);
    return;
  }

  const teams = (draft.settings && draft.settings.teams) || 12;
  const rounds = (draft.settings && draft.settings.rounds) || 15;
  const mySlot = draft.draft_order ? draft.draft_order[data.userId] : null;

  if (!mySlot) {
    el('draft').innerHTML = '<div class="loading">The draft order is not set '
      + 'yet, so this page cannot work out when your picks are. Check back '
      + 'closer to the draft. '
      + '<button id="btn-leave-draft" class="linklike">Go back</button></div>';
    const leave = el('btn-leave-draft');
    if (leave) leave.addEventListener('click', exitDraftMode);
    return;
  }

  const pool = buildPool(players, seasonProj);

  draftState.ctx = {
    draftId,
    status: draft.status,
    leagueName: league.name || 'Draft',
    teams,
    rounds,
    mySlot,
    myPickNumbers: pickNumbersForSlot(mySlot, teams, rounds),
    rosterPositions: league.roster_positions,
    players,
    pool,
    replacement: replacementPoints(pool, league.roster_positions, teams),
    startsAt: draft.start_time
      ? new Date(draft.start_time).toLocaleString(undefined, {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit' })
      : 'Start time not set',
  };
  draftState.lastPickCount = -1;

  /* Render immediately with what we have, then start polling. */
  renderDraft({
    leagueName: draftState.ctx.leagueName,
    status: draft.status,
    startsAt: draftState.ctx.startsAt,
    myPlayers: [],
  });

  await refreshDraft();
  stopPolling();
  draftState.timer = setInterval(refreshDraft, DRAFT_POLL_MS);
  draftState.statusTimer = setInterval(checkDraftStatus, DRAFT_STATUS_MS);
}

function exitDraftMode() {
  stopPolling();
  draftState.ctx = null;
  /* Remember the choice, so a live draft does not pull them back in. */
  draftDismissed = true;
  el('draft').hidden = true;
  el('draft').innerHTML = '';
  el('app').hidden = false;
}
