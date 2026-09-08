/* ===========================================================================
   Trade checker.

   Sleeper's public API cannot show you a trade offer - it is unauthenticated
   and read-only, so it has no idea who you are and no way to reach your
   inbox. So you type the offer in yourself and this gives a verdict.

   The maths is the same value over replacement used in draft mode, with one
   addition that matters more in-season than in a draft: a trade that leaves
   you unable to field a legal lineup is a bad trade no matter how good the
   points look.
   =========================================================================== */

'use strict';

/* Season-long points. A trade has to move the needle by more than noise
   before it is worth doing. ~10 points over a season is under one point a
   week, which is well inside the error bars on any projection. */
const TRADE_CLEAR_MARGIN = 10;

const tradeState = { ctx: null, chosen: { get: [], give: [] } };

/* ---------------------------------------------------------------------------
   Loading
   --------------------------------------------------------------------------- */

async function enterTradeMode(data) {
  el('app').hidden = true;
  el('trade').hidden = false;
  el('trade').innerHTML = '<div class="loading">Loading rosters&hellip;</div>';

  const league = data.league;

  const [players, seasonProj, rosters, users] = await Promise.all([
    getPlayers(),
    getSeasonProjections(data.season, statKeyFor(league)),
    tryJSON(API + '/v1/league/' + league.league_id + '/rosters'),
    tryJSON(API + '/v1/league/' + league.league_id + '/users'),
  ]);

  if (!seasonProj || !Array.isArray(rosters)) {
    el('trade').innerHTML = '<div class="loading">Could not load the data this '
      + 'needs. <button id="btn-leave-trade" class="linklike">Go back</button>'
      + '</div>';
    wireLeaveTrade();
    return;
  }

  const pool = buildPool(players, seasonProj);
  const byId = {};
  for (const p of pool) byId[p.id] = p;

  const teams = (league.settings && league.settings.num_teams) || rosters.length || 12;
  const replacement = replacementPoints(pool, league.roster_positions, teams);

  const mine = rosters.find((r) => r.owner_id === data.userId);
  if (!mine) {
    el('trade').innerHTML = '<div class="loading">Could not find your roster. '
      + '<button id="btn-leave-trade" class="linklike">Go back</button></div>';
    wireLeaveTrade();
    return;
  }

  const nameOf = (rosterId) => {
    const r = rosters.find((x) => x.roster_id === rosterId);
    const u = r && (users || []).find((x) => x.user_id === r.owner_id);
    if (!u) return 'Unknown team';
    return (u.metadata && u.metadata.team_name) || u.display_name || 'Unknown team';
  };

  /* Everyone I could give away. */
  const myPlayers = (mine.players || [])
    .map((id) => byId[id])
    .filter(Boolean)
    .sort((a, b) => b.pts - a.pts);

  /* Everyone somebody else owns, in one searchable list, tagged with whose
     team they are on so you know who you would be trading with. */
  const theirs = [];
  for (const r of rosters) {
    if (r.roster_id === mine.roster_id) continue;
    const owner = nameOf(r.roster_id);
    for (const id of (r.players || [])) {
      const p = byId[id];
      if (p) theirs.push(Object.assign({ owner }, p));
    }
  }
  theirs.sort((a, b) => b.pts - a.pts);

  tradeState.ctx = {
    league, byId, replacement, myPlayers, theirs,
    rosterPositions: league.roster_positions,
    rosterLimit: (league.roster_positions || []).length,
    myPlayerIds: new Set(mine.players || []),
  };
  /* Start every visit with an empty offer. */
  tradeState.chosen = { get: [], give: [] };

  renderTradeForm();
}

function wireLeaveTrade() {
  const b = el('btn-leave-trade');
  if (b) b.addEventListener('click', exitTradeMode);
}

/* ---------------------------------------------------------------------------
   The form
   --------------------------------------------------------------------------- */

/* Up to three players a side, same as Sleeper allows in practice. */
const MAX_PER_SIDE = 3;
const LIST_LIMIT = 40;

/*
  A browsable list that a search box narrows, rather than a dropdown of a
  hundred and fifty names. Typing filters; tapping a name adds it.
*/
function poolFor(side) {
  const c = tradeState.ctx;
  return (side === 'get') ? c.theirs : c.myPlayers;
}

function renderPickerList(side) {
  const c = tradeState.ctx;
  const query = (el('search-' + side).value || '').trim().toLowerCase();
  const chosen = tradeState.chosen[side];

  const matches = poolFor(side).filter((p) => {
    if (chosen.indexOf(p.id) !== -1) return false;
    if (!query) return true;
    return (p.name + ' ' + p.pos + ' ' + (p.team || '')).toLowerCase()
      .indexOf(query) !== -1;
  });

  const box = el('list-' + side);

  if (!matches.length) {
    box.innerHTML = '<div class="picker-empty">'
      + (query ? 'No player matches that.' : 'Nobody left to choose.')
      + '</div>';
    return;
  }

  box.innerHTML = matches.slice(0, LIST_LIMIT).map((p) =>
    '<button type="button" class="picker-row" data-side="' + side
    + '" data-id="' + p.id + '">'
    + '<span class="picker-name">' + p.name + '</span>'
    + '<span class="picker-meta">' + p.pos
    + (p.team ? ' &middot; ' + p.team : '')
    + (p.owner ? ' &middot; ' + p.owner : '')
    + ' &middot; ' + Math.round(p.pts) + ' pts</span>'
    + '</button>').join('')
    + (matches.length > LIST_LIMIT
      ? ('<div class="picker-empty">' + (matches.length - LIST_LIMIT)
        + ' more &mdash; keep typing to narrow it down.</div>') : '');
}

function renderChosen(side) {
  const chosen = tradeState.chosen[side];
  const pool = poolFor(side);
  el('chosen-' + side).innerHTML = chosen.map((id) => {
    const p = pool.find((x) => x.id === id);
    return '<span class="chip">' + (p ? p.name : id)
      + '<button type="button" class="chip-x" data-side="' + side
      + '" data-id="' + id + '" aria-label="Remove">&times;</button></span>';
  }).join('');

  el('search-' + side).disabled = (chosen.length >= MAX_PER_SIDE);
  el('search-' + side).placeholder = (chosen.length >= MAX_PER_SIDE)
    ? 'Three is the most you can pick'
    : 'Type a name to narrow the list';
}

function pickerSection(side, heading) {
  return '<h2 class="draft-h2">' + heading + '</h2>'
    + '<div class="chosen" id="chosen-' + side + '"></div>'
    + '<input class="picker-search" id="search-' + side + '" type="text" '
    + 'autocapitalize="none" autocorrect="off" spellcheck="false" '
    + 'placeholder="Type a name to narrow the list">'
    + '<div class="picker-list" id="list-' + side + '"></div>';
}

function renderTradeForm() {
  const c = tradeState.ctx;

  if (!c.myPlayers.length || !c.theirs.length) {
    el('trade').innerHTML =
      '<div class="draft-top"><div><h1>Trade checker</h1></div>'
      + '<button id="btn-leave-trade" class="btn-icon" '
      + 'aria-label="Close">&times;</button></div>'
      + '<div class="draft-wait"><p class="draft-wait-title">Nothing to trade yet</p>'
      + '<p class="subtle">Nobody in your league owns any players, so there is '
      + 'nothing to put on either side. This becomes usable once your draft '
      + 'is done.</p></div>';
    wireLeaveTrade();
    return;
  }

  el('trade').innerHTML =
    '<div class="draft-top">'
    + '<div><h1>Trade checker</h1><p class="subtle">Someone offered you a '
    + 'trade? Put it in below.</p></div>'
    + '<button id="btn-leave-trade" class="btn-icon" title="Close" '
    + 'aria-label="Close trade checker">&times;</button></div>'

    + pickerSection('get', 'They give you')
    + pickerSection('give', 'You give them')

    + '<button id="btn-check-trade" class="btn-primary">Check this trade</button>'
    + '<div id="trade-verdict"></div>'

    + '<p class="draft-foot subtle tiny">This cannot see offers in your Sleeper '
    + 'inbox &mdash; Sleeper does not make them public. Accept or decline in the '
    + 'Sleeper app once you have a verdict.</p>';

  wireLeaveTrade();
  el('btn-check-trade').addEventListener('click', checkTrade);

  for (const side of ['get', 'give']) {
    el('search-' + side).addEventListener('input', () => renderPickerList(side));
    renderChosen(side);
    renderPickerList(side);
  }

  /* One listener for the whole panel, since the lists are rebuilt as you type. */
  el('trade').addEventListener('click', (e) => {
    const row = e.target.closest('.picker-row');
    if (row) {
      const side = row.getAttribute('data-side');
      const chosen = tradeState.chosen[side];
      if (chosen.length < MAX_PER_SIDE) chosen.push(row.getAttribute('data-id'));
      el('search-' + side).value = '';
      renderChosen(side);
      renderPickerList(side);
      return;
    }
    const x = e.target.closest('.chip-x');
    if (x) {
      const side = x.getAttribute('data-side');
      const id = x.getAttribute('data-id');
      tradeState.chosen[side] = tradeState.chosen[side].filter((v) => v !== id);
      renderChosen(side);
      renderPickerList(side);
    }
  });
}

function selectedIds(side) {
  return tradeState.chosen[side].slice();
}

/* ---------------------------------------------------------------------------
   The verdict
   --------------------------------------------------------------------------- */

function vorOf(p, replacement) {
  return Math.round((p.pts - (replacement[p.pos] || 0)) * 10) / 10;
}

function judgeTrade(getIds, giveIds, c) {
  const get = getIds.map((id) => c.byId[id]).filter(Boolean);
  const give = giveIds.map((id) => c.byId[id]).filter(Boolean);

  if (!get.length && !give.length) {
    return { error: 'Pick at least one player on one side.' };
  }

  const getVor = get.reduce((sum, p) => sum + vorOf(p, c.replacement), 0);
  const giveVor = give.reduce((sum, p) => sum + vorOf(p, c.replacement), 0);
  const net = Math.round((getVor - giveVor) * 10) / 10;

  /* What my roster looks like afterwards. */
  const giveSet = new Set(giveIds);
  const after = [];
  for (const id of c.myPlayerIds) {
    if (giveSet.has(id)) continue;
    const p = c.byId[id];
    if (p) after.push(p);
  }
  for (const p of get) after.push(p);

  const holes = unfilledSlots(c.rosterPositions, after);
  const overLimit = after.length - c.rosterLimit;

  /* --- a trade that breaks your lineup is bad regardless of the points --- */
  if (holes.length) {
    return {
      verdict: 'DECLINE',
      level: 'bad',
      net,
      headline: 'This breaks your lineup',
      why: 'After this trade you would have nobody to put in your '
        + holes.map(slotLabel).join(' and ') + ' slot'
        + (holes.length === 1 ? '' : 's')
        + ', which is a guaranteed zero every week. '
        + (net > 0
          ? ('The players coming back are worth more on paper, so this is not '
            + 'a terrible offer &mdash; but only take it if you pick up a '
            + 'replacement off waivers first. Do that, then check again.')
          : 'You would be giving up value and breaking your lineup at the '
            + 'same time.'),
      get, give, overLimit,
    };
  }

  /* --- otherwise it is about value --- */
  const best = get.concat(give).sort((a, b) => vorOf(b, c.replacement) - vorOf(a, c.replacement))[0];
  const bestIsIncoming = best && get.indexOf(best) !== -1;

  let verdict, level, headline, why;

  if (net > TRADE_CLEAR_MARGIN) {
    verdict = 'ACCEPT';
    level = 'good';
    headline = 'Take it';
    why = 'You come out about ' + Math.round(net) + ' projected points ahead '
      + 'over the rest of the season'
      + (bestIsIncoming && best
        ? ', mostly because ' + best.name + ' is the best player in the deal '
          + 'and you are the one getting him.'
        : '.');
  } else if (net < -TRADE_CLEAR_MARGIN) {
    verdict = 'DECLINE';
    level = 'bad';
    headline = 'Turn it down';
    why = 'You would come out about ' + Math.round(Math.abs(net))
      + ' projected points behind'
      + (best && !bestIsIncoming
        ? ', because ' + best.name + ' is the best player in the deal and you '
          + 'would be giving him away.'
        : ' over the rest of the season.');
  } else {
    verdict = 'DECLINE';
    level = 'close';
    headline = 'Too close to be worth it';
    why = 'The two sides are within ' + TRADE_CLEAR_MARGIN + ' projected points '
      + 'of each other over a whole season, which is noise rather than a real '
      + 'edge. When a trade is this even, keeping the players you already have '
      + 'is the simpler choice.';
  }

  return { verdict, level, net, headline, why, get, give, overLimit };
}

function renderVerdict(r) {
  const box = el('trade-verdict');

  if (r.error) {
    box.innerHTML = '<p class="setup-error">' + r.error + '</p>';
    return;
  }

  const list = (players, label) => players.length
    ? ('<div class="verdict-side"><div class="verdict-side-label">' + label
      + '</div>' + players.map((p) => '<div class="verdict-player">' + p.name
      + ' <span class="subtle">(' + p.pos + ', ' + Math.round(p.pts)
      + ' pts)</span></div>').join('') + '</div>')
    : '';

  let extra = '';
  if (r.overLimit > 0) {
    extra = '<p class="trade-warn">You would also be ' + r.overLimit
      + ' player' + (r.overLimit === 1 ? '' : 's') + ' over your roster limit, '
      + 'so you would have to drop somebody to make it fit.</p>';
  }

  box.innerHTML =
    '<div class="verdict verdict-' + r.level + '">'
    + '<div class="verdict-word">' + r.verdict + '</div>'
    + '<div class="verdict-headline">' + r.headline + '</div>'
    + '<p class="verdict-why">' + r.why + '</p>'
    + '</div>'
    + '<div class="verdict-sides">' + list(r.get, 'You get')
    + list(r.give, 'You give') + '</div>'
    + extra;

  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function checkTrade() {
  const c = tradeState.ctx;
  if (!c) return;
  renderVerdict(judgeTrade(selectedIds('get'), selectedIds('give'), c));
}

function exitTradeMode() {
  tradeState.ctx = null;
  tradeState.chosen = { get: [], give: [] };
  el('trade').hidden = true;
  el('trade').innerHTML = '';
  el('app').hidden = false;
}
