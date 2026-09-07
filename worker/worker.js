/* ===========================================================================
   Fantasy Manager - push notification worker

   Runs on Cloudflare Workers. Two jobs:

     1. Remember which phone to notify        (POST /subscribe)
     2. Every hour, decide whether anything   (the scheduled handler)
        is wrong and, if so, push once.

   It only ever notifies about the three things that guarantee a zero:
   a starter ruled OUT, a starter on a bye, or an empty starting slot.
   Everything else stays in the app. Silence is the point - a notification
   you can safely ignore is one you will learn to ignore.

   Deliberately cheap. The Workers free plan allows 10ms of CPU per run,
   so this never touches Sleeper's 15 MB player file or its 2 MB projections
   feed. It fetches the ~14 players on the roster individually instead,
   which is about 57 KB of parsing in total.
   =========================================================================== */

const API = 'https://api.sleeper.app';

/* Injury designations that mean the player will not take the field. */
const OUT_CODES = ['OUT', 'IR', 'PUP', 'SUS', 'DNR', 'NA', 'COV'];

/* Slots that are not part of the active lineup. */
const NON_STARTING = ['BN', 'IR', 'TAXI'];

/* When to actually look, in the user's local time. Hour is 0-23,
   day is 0 = Sunday. The worker wakes every five minutes and checks this
   list, rather than using a fixed UTC schedule, so it does not drift an
   hour when the clocks change in November. */
const CHECK_TIMES = [
  { day: 0, hour: 10 },   /* Sunday morning - the important one */
  { day: 3, hour: 8 },    /* Wednesday, after waivers have run */
  { day: 4, hour: 16 },   /* Thursday afternoon, before Thursday night */
];

/*
  Draft countdown. Each fires once.

  `at` is minutes before the draft; `upto` is the newest it may fire. The
  bands never overlap, so arriving late (say the job first sees the draft
  35 minutes out) sends the 30 minute warning, not all three at once.
*/
const DRAFT_ALERTS = [
  { at: 60, upto: 65, title: 'Your draft starts in an hour',
    body: 'Be somewhere you can pick. If you miss it, Sleeper drafts your '
        + 'whole team for you, and it drafts badly.' },
  { at: 30, upto: 35, title: 'Draft in 30 minutes',
    body: 'Get to your phone or computer. Open this app and tap Draft mode '
        + 'when picking starts.' },
  { at: 10, upto: 15, title: 'Draft in 10 minutes',
    body: 'Open draft mode now. It will tell you one player to take at a time.' },
];

const TIMEZONE = 'America/Chicago';

/* ===========================================================================
   Small helpers
   =========================================================================== */

function b64urlToU8(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function u8ToB64url(u) {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat() {
  let len = 0;
  for (const a of arguments) len += a.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const a of arguments) { out.set(a, at); at += a.length; }
  return out;
}

async function getJSON(url) {
  const res = await fetch(url, { cf: { cacheTtl: 60 } });
  if (!res.ok) throw new Error(url + ' returned ' + res.status);
  return res.json();
}

/* ===========================================================================
   Web Push

   Two separate pieces of cryptography, both required by the spec:

     VAPID  - proves to Apple that this server is allowed to push to this
              subscription. A signed JWT in the Authorization header.
     aes128gcm - encrypts the message itself so that the push service
              relaying it cannot read it. RFC 8291.
   =========================================================================== */

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

async function vapidAuthHeader(endpoint, publicKey, privateKey, subject) {
  const enc = new TextEncoder();
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  };

  const signingInput = u8ToB64url(enc.encode(JSON.stringify(header)))
    + '.' + u8ToB64url(enc.encode(JSON.stringify(payload)));

  /* The private key is stored as just the 32-byte scalar. WebCrypto wants a
     full JWK, so rebuild x and y from the public key we already have. */
  const pub = b64urlToU8(publicKey);
  const jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    x: u8ToB64url(pub.slice(1, 33)),
    y: u8ToB64url(pub.slice(33, 65)),
    d: privateKey,
  };

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(signingInput));

  return 'vapid t=' + signingInput + '.' + u8ToB64url(new Uint8Array(sig))
    + ', k=' + publicKey;
}

async function encryptPayload(plaintext, p256dh, auth) {
  const enc = new TextEncoder();
  const clientPub = b64urlToU8(p256dh);
  const authSecret = b64urlToU8(auth);

  const eph = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));

  const clientKey = await crypto.subtle.importKey(
    'raw', clientPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey }, eph.privateKey, 256));

  const ikm = await hkdf(authSecret, shared,
    concat(enc.encode('WebPush: info\0'), clientPub, ephPub), 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  /* 0x02 is the final-record delimiter required by the content encoding. */
  const body = concat(enc.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, aesKey, body));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);

  /* salt | record size | key id length | ephemeral public key | ciphertext */
  return concat(salt, recordSize, new Uint8Array([65]), ephPub, ciphertext);
}

async function sendPush(sub, message, env) {
  const auth = await vapidAuthHeader(
    sub.endpoint, env.VAPID_PUBLIC, env.VAPID_PRIVATE,
    env.VAPID_SUBJECT || 'mailto:nobody@example.com');

  const body = await encryptPayload(
    JSON.stringify(message), sub.keys.p256dh, sub.keys.auth);

  return fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': auth,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body,
  });
}

/* ===========================================================================
   Working out whether anything is wrong
   =========================================================================== */

function isOut(player) {
  const inj = String(player.injury_status || '').toUpperCase();
  const st = String(player.status || '').toUpperCase();
  if (OUT_CODES.indexOf(inj) !== -1) return inj === 'NA' ? 'OUT' : inj;
  if (st.indexOf('INJURED RESERVE') !== -1 || st === 'PUP'
      || st === 'SUSPENDED') return 'IR';
  return null;
}

function playerName(p) {
  return p.full_name
    || ((p.first_name || '') + ' ' + (p.last_name || '')).trim()
    || 'A player';
}

async function findProblems(cfg) {
  const state = await getJSON(API + '/v1/state/nfl');
  const week = Number(state.display_week || state.week || 1) || 1;
  const season = state.season;

  const [league, rosters] = await Promise.all([
    getJSON(API + '/v1/league/' + cfg.leagueId),
    getJSON(API + '/v1/league/' + cfg.leagueId + '/rosters'),
  ]);

  /* Nothing to police before the draft. */
  if (league.status === 'pre_draft') return { week, problems: [] };

  const mine = (rosters || []).find((r) => r.owner_id === cfg.userId);
  if (!mine) return { week, problems: [] };

  const slots = (league.roster_positions || [])
    .filter((s) => NON_STARTING.indexOf(s) === -1);
  const starters = mine.starters || [];

  /* Which teams have a game this week. */
  let playing = null;
  try {
    const sched = await getJSON(API + '/schedule/nfl/regular/' + season);
    playing = new Set();
    for (const g of sched) {
      if (g && g.week === week) { playing.add(g.home); playing.add(g.away); }
    }
  } catch (e) { playing = null; }

  const problems = [];

  /* Empty slots need no lookup at all. */
  const filled = [];
  slots.forEach((slot, i) => {
    const id = starters[i];
    if (!id || id === '0') problems.push({ kind: 'empty', slot });
    else filled.push({ slot, id });
  });

  /* One small request per starter. Cheap, and it avoids the huge feeds. */
  const people = await Promise.all(filled.map((f) =>
    getJSON(API + '/v1/players/nfl/' + f.id).catch(() => null)));

  people.forEach((p, i) => {
    if (!p) return;
    const slot = filled[i].slot;
    const out = isOut(p);
    if (out) {
      problems.push({ kind: 'out', slot, name: playerName(p), label: out });
    } else if (playing && p.team && !playing.has(p.team)) {
      problems.push({ kind: 'bye', slot, name: playerName(p) });
    }
  });

  return { week, problems };
}

/*
  The draft is the single worst thing to miss, so it gets its own countdown
  independent of the weekly lineup checks. Runs on every wake-up.
*/
async function maybeDraftAlert(cfg, env) {
  const league = await getJSON(API + '/v1/league/' + cfg.leagueId);

  /* Once the draft is done, forget the flags and never look again. */
  if (league.status !== 'pre_draft' || !league.draft_id) {
    await env.STORE.delete('draftSent');
    return false;
  }

  const draft = await getJSON(API + '/v1/draft/' + league.draft_id);
  if (!draft || !draft.start_time) return false;

  const minutesAway = (draft.start_time - Date.now()) / 60000;
  if (minutesAway <= 0) return false;

  const band = DRAFT_ALERTS.find((a) => minutesAway > (a.at - 5) && minutesAway <= a.upto);
  if (!band) return false;

  const sent = JSON.parse(await env.STORE.get('draftSent') || '[]');
  if (sent.indexOf(band.at) !== -1) return false;

  const res = await sendPush(cfg.subscription,
    { title: band.title, body: band.body, tag: 'draft' }, env);

  if (res.status === 404 || res.status === 410) {
    await env.STORE.delete('sub');
    return true;
  }
  if (res.ok) {
    sent.push(band.at);
    await env.STORE.put('draftSent', JSON.stringify(sent));
  }
  return true;
}

function buildMessage(week, problems) {
  const first = problems[0];
  let lead;
  if (first.kind === 'empty') lead = 'Your ' + first.slot + ' slot is empty';
  else if (first.kind === 'out') lead = first.name + ' is ' + first.label;
  else lead = first.name + ' has no game this week';

  const more = problems.length - 1;
  return {
    title: problems.length === 1 ? 'Fix your lineup'
      : ('Fix your lineup - ' + problems.length + ' problems'),
    body: lead + (more > 0
      ? (', plus ' + more + ' other problem' + (more === 1 ? '' : 's') + '.')
      : '.') + ' Tap to see what to do.',
    week,
  };
}

/* ===========================================================================
   HTTP: subscribing, and reporting whether this thing is alive
   =========================================================================== */

function cors(extra) {
  return Object.assign({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }, extra || {});
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: cors({ 'Content-Type': 'application/json' }),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    if (url.pathname === '/subscribe' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

      if (!body || !body.subscription || !body.subscription.endpoint
          || !body.subscription.keys || !body.userId || !body.leagueId) {
        return json({ error: 'missing fields' }, 400);
      }
      await env.STORE.put('sub', JSON.stringify(body));
      await env.STORE.delete('lastAlert');
      return json({ ok: true });
    }

    if (url.pathname === '/unsubscribe' && request.method === 'POST') {
      await env.STORE.delete('sub');
      return json({ ok: true });
    }

    /* The app calls this on every load. If lastRun is old, it warns the user
       rather than letting them assume silence means "nothing to do". */
    if (url.pathname === '/health') {
      const [lastRun, sub] = await Promise.all([
        env.STORE.get('lastRun'), env.STORE.get('sub'),
      ]);
      return json({ lastRun: lastRun || null, subscribed: !!sub });
    }

    /*
      Send a test notification on demand, so the whole chain - signing,
      encryption, Apple, the phone - can be proven without waiting for
      something to actually go wrong.

      Behind a key that lives only in the worker's settings and never in
      this repo, because the worker's address is public.
    */
    if (url.pathname === '/test') {
      if (!env.TEST_KEY || url.searchParams.get('key') !== env.TEST_KEY) {
        return json({ error: 'bad or missing key' }, 403);
      }
      const raw = await env.STORE.get('sub');
      if (!raw) return json({ error: 'no phone is subscribed' }, 404);

      const cfg = JSON.parse(raw);
      const res = await sendPush(cfg.subscription, {
        title: 'Test alert',
        body: 'If you can read this, alerts work. Real ones only arrive when '
            + 'something actually needs fixing.',
        tag: 'test',
      }, env);

      return json({ ok: res.ok, pushStatus: res.status });
    }

    return json({ error: 'not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const now = new Date();

      /* Heartbeat, so the app can tell a dead job from a quiet week.

         Written on every run. That is 288 KV writes a day against a free
         limit of 1,000, which is comfortable - and writing it only hourly
         meant the app showed a red "not running" warning for up to an hour
         after setup, which is exactly the false alarm this is meant to
         prevent. */
      await env.STORE.put('lastRun', now.toISOString());

      const raw = await env.STORE.get('sub');
      if (!raw) return;
      const cfg = JSON.parse(raw);

      /* The draft countdown is checked on every wake-up, not just at the
         weekly times, because it needs minute-level accuracy. */
      if (await maybeDraftAlert(cfg, env)) return;

      /* Is this one of the hours worth checking, in the user's local time? */
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', hour12: false,
      }).formatToParts(new Date());
      const dayName = parts.find((p) => p.type === 'weekday').value;
      const hour = Number(parts.find((p) => p.type === 'hour').value);
      const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayName);

      const due = CHECK_TIMES.some((t) => t.day === day && t.hour === hour);
      if (!due) return;

      const { week, problems } = await findProblems(cfg);
      if (!problems.length) {
        await env.STORE.delete('lastAlert');
        return;
      }

      /* Do not say the same thing twice. */
      const signature = week + '|' + problems
        .map((p) => p.kind + ':' + (p.name || p.slot)).sort().join(',');
      if (await env.STORE.get('lastAlert') === signature) return;

      const res = await sendPush(cfg.subscription, buildMessage(week, problems), env);

      /* 404 or 410 means the phone threw the subscription away. Drop it so
         the app notices and can offer to set it up again. */
      if (res.status === 404 || res.status === 410) {
        await env.STORE.delete('sub');
        return;
      }
      if (res.ok) await env.STORE.put('lastAlert', signature);
    })());
  },
};
