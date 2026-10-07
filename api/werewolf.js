// Vercel serverless function: One Night Werewolf rooms. Game state lives in MongoDB Atlas (one document per room).
const { MongoClient } = require('mongodb');
const URI = process.env.MONGODB_URI;
const ROOM_RE = /^[A-Z0-9]{4}$/, ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER = ['Werewolf', 'Minion', 'Mason', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac'];
// Deck: always 2 Werewolves, then (players + 1) cards drawn from this pool, so the center always holds 3 cards.
const POOL = ['Mason', 'Mason', 'Minion', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac', 'Hunter', 'Tanner', 'Villager', 'Villager', 'Villager'];

let colP; // one cached connection per warm function instance
const rooms = () => colP ||= new MongoClient(URI, { maxPoolSize: 5 }).connect().then(async c => {
  const col = c.db(process.env.MONGODB_DB || 'werewolf').collection('rooms');
  await col.createIndex({ at: 1 }, { expireAfterSeconds: 86400 }); // rooms vanish 24h after last activity
  return col;
});
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 14);
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MIN_PLAYERS = 3; // bots fill empty seats up to this number when a round starts
const newState = () => ({ phase: 'lobby', players: {}, order: [], center: [], step: 0, t: 0, deadline: 0, voteBy: 0, dur: 5, result: null });

// ---- game engine (pure functions on the state object) ----
function enter(s) {                      // a night step starts: info-only roles get their info right away
  const r = ORDER[s.step], seat = id => s.order.indexOf(id), nm = ids => ids.map(x => s.players[x].name).join(', ');
  const of = role => s.order.filter(id => s.players[id].orig === role);
  s.order.forEach(id => {
    const p = s.players[id]; if (p.orig !== r) return;
    p.seen = p.seen || {};
    if (r === 'Werewolf' || r === 'Mason') {
      const o = of(r).filter(x => x !== id);
      if (o.length) { o.forEach(x => p.seen['p' + seat(x)] = r); p.priv.push(`Your fellow ${r.toLowerCase()}: ${nm(o)}.`); p.acted = true; }
    } else if (r === 'Minion') {
      const ws = of('Werewolf'); ws.forEach(x => p.seen['p' + seat(x)] = 'Werewolf');
      p.priv.push(ws.length ? 'The werewolves are: ' + nm(ws) + '.' : 'There are no werewolves among the players.'); p.acted = true;
    } else if (r === 'Troublemaker' && s.order.length < 3) { p.priv.push('Not enough players to swap anyone.'); p.acted = true; }
    else if (r === 'Insomniac') { p.seen['p' + seat(id)] = p.role; p.priv.push('Your card is now the ' + p.role + '.'); p.acted = true; }
  });
}
function botAct(s, id) {                 // bots pick random legal moves
  const r = ORDER[s.step], me = s.order.indexOf(id), R = k => Math.floor(Math.random() * k);
  const others = s.order.map((_, i) => i).filter(i => i !== me), pp = () => 'p' + others.splice(R(others.length), 1)[0];
  let sel;
  if (r === 'Werewolf' || r === 'Mason' || r === 'Drunk') sel = ['c' + R(3)];
  else if (r === 'Seer') sel = R(2) ? [pp()] : ['c0', 'c' + (1 + R(2))];
  else if (r === 'Robber') sel = [pp()];
  else sel = [pp(), pp()];
  try { act(s, id, sel); } catch (e) { s.players[id].acted = true; }
}
// sel: array of 'p<seat>' (a player, by seat number) or 'c<0-2>' (a center card)
function act(s, id, sel) {
  const p = s.players[id], r = ORDER[s.step];
  if (s.phase !== 'night' || p.orig !== r || p.acted) throw bad('Not your turn');
  p.seen = p.seen || {};
  const me = s.order.indexOf(id);
  const T = (Array.isArray(sel) ? sel : []).slice(0, 3).map(k => { const m = /^([pc])(\d{1,2})$/.exec(String(k)); return m && { t: m[1], i: +m[2], k: m[0] }; });
  if (T.some(x => !x)) throw bad('Bad choice');
  const okP = x => x.t === 'p' && x.i < s.order.length && x.i !== me, okC = x => x.t === 'c' && x.i < 3;
  const P = x => s.players[s.order[x.i]];
  if (r === 'Werewolf' || r === 'Mason' || r === 'Drunk') {
    if (T.length !== 1 || !okC(T[0])) throw bad('Pick a center card');
    const c = T[0].i;
    if (r === 'Drunk') { [p.role, s.center[c]] = [s.center[c], p.role]; p.priv.push(`You swapped with Center ${c + 1}. You don't know your new card.`); }
    else { p.seen['c' + c] = s.center[c]; p.priv.push(`Center ${c + 1} is the ${s.center[c]}.`); }
  } else if (r === 'Seer') {
    if (T.length === 0) p.priv.push('You chose not to look.');
    else if (T.length === 1 && okP(T[0])) { const t = P(T[0]); p.seen[T[0].k] = t.role; p.priv.push(`${t.name} is the ${t.role}.`); }
    else if (T.length === 2 && T.every(okC) && T[0].i !== T[1].i) { T.forEach(x => p.seen[x.k] = s.center[x.i]); p.priv.push(`Center ${T[0].i + 1} is the ${s.center[T[0].i]} and Center ${T[1].i + 1} is the ${s.center[T[1].i]}.`); }
    else throw bad('Pick one player or two center cards');
  } else if (r === 'Robber') {
    if (T.length === 0) p.priv.push('You robbed nobody.');
    else if (T.length === 1 && okP(T[0])) { const t = P(T[0]); [p.role, t.role] = [t.role, p.role]; p.seen['p' + me] = p.role; p.seen[T[0].k] = t.role; p.priv.push(`You robbed ${t.name}. You are now the ${p.role}.`); }
    else throw bad('Pick one player');
  } else if (r === 'Troublemaker') {
    if (T.length === 0) p.priv.push('You swapped nobody.');
    else if (T.length === 2 && T.every(okP) && T[0].i !== T[1].i) { const x = P(T[0]), y = P(T[1]); [x.role, y.role] = [y.role, x.role]; p.priv.push(`You swapped ${x.name} and ${y.name}.`); }
    else throw bad('Pick two different players');
  } else throw bad('Nothing to do');
  p.acted = true;
}
function resolve(s) {
  const ids = s.order, pl = s.players, votes = {};
  ids.forEach(id => { if (!pl[id].vote) { const o = ids.filter(x => x !== id); pl[id].vote = o.length ? o[Math.floor(Math.random() * o.length)] : id; } votes[id] = 0; });
  ids.forEach(id => votes[pl[id].vote]++);
  const max = Math.max(...Object.values(votes));
  const dead = max > 1 ? ids.filter(id => votes[id] === max) : [];
  const h = dead.find(id => pl[id].role === 'Hunter');
  if (h && !dead.includes(pl[h].vote)) dead.push(pl[h].vote);
  const roles = dead.map(id => pl[id].role), wolves = ids.some(id => pl[id].role === 'Werewolf'), tanner = roles.includes('Tanner');
  const village = wolves ? roles.includes('Werewolf') : (dead.length === 0 || roles.every(r => r === 'Minion')), wolfTeam = !village && !tanner;
  const win = {}; ids.forEach(id => { const r = pl[id].role; win[id] = r === 'Werewolf' || r === 'Minion' ? wolfTeam : r === 'Tanner' ? tanner : village; });
  s.result = {
    text: (dead.length ? 'Dead: ' + dead.map(id => `${pl[id].name} (${pl[id].role})`).join(', ') + '. ' : 'Nobody got more than one vote, so nobody died. ') + (village ? 'The village wins.' : tanner ? 'The Tanner wins.' : 'The wolves win.'),
    rows: ids.map(id => ({ id, name: pl[id].name, orig: pl[id].orig, role: pl[id].role, votes: votes[id], voted: pl[pl[id].vote].name, dead: dead.includes(id) })),
    center: s.center, win,
  };
  s.phase = 'end';
}
function advance(s, now) {               // moves the clock-driven parts of the game forward; true if anything changed
  let ch = false;
  if (s.phase === 'deal' && s.order.length && s.order.every(id => s.players[id].ready)) { s.phase = 'night'; s.step = 0; s.t = now; enter(s); ch = true; }
  while (s.phase === 'night') {
    s.order.forEach(id => { const p = s.players[id]; if (p.bot && p.orig === ORDER[s.step] && !p.acted) botAct(s, id); });
    const pend = s.order.some(id => s.players[id].orig === ORDER[s.step] && !s.players[id].acted), t = now - s.t;
    if (t < 3000 || (pend && t < 45000)) break;
    ch = true;
    if (s.step === ORDER.length - 1) { s.phase = 'day'; s.deadline = now + s.dur * 60000; break; }
    s.step++; s.t = now; enter(s);
  }
  if (s.phase === 'day' && now >= s.deadline) {
    s.phase = 'vote'; s.voteBy = now + 90000; ch = true;
    s.order.forEach(id => { const p = s.players[id], o = s.order.filter(x => x !== id); if (p.bot && o.length) p.vote = o[Math.floor(Math.random() * o.length)]; });
  }
  if (s.phase === 'vote' && (s.order.length < 2 || s.order.every(id => s.players[id].vote) || now >= s.voteBy)) { resolve(s); ch = true; }
  return ch;
}
function view(s, uid) {
  const p = s.players[uid], night = s.phase === 'night', r = ORDER[s.step];
  let ask = null;
  if (p && night && p.orig === r && !p.acted) ask = { role: r };
  return {
    phase: s.phase, dur: s.dur, deadline: s.deadline, voteBy: s.voteBy, step: night ? r : null,
    players: s.order.map(id => ({ bot: !!s.players[id].bot, name: s.players[id].name, ready: !!s.players[id].ready, voted: !!s.players[id].vote })),
    me: p ? { seat: s.order.indexOf(uid), seen: p.seen || {}, orig: p.orig, priv: p.priv, ready: !!p.ready, voted: !!p.vote, win: s.result ? s.result.win[uid] : null, final: s.result ? p.role : null } : null,
    ask,
    result: s.result ? { text: s.result.text, rows: s.result.rows.map(({ id, ...x }) => x), center: s.result.center } : null,
  };
}
async function mutate(room, fn) {        // optimistic concurrency: save only if nobody else saved first, otherwise retry
  const col = await rooms();
  for (let i = 0; i < 8; i++) {
    const d = await col.findOne({ _id: room });
    if (!d) throw bad('Room not found', 404);
    const out = await fn(d.s, d), $set = { s: d.s, at: new Date() };
    if (d.clearChat) $set.chat = [];
    if ((await col.updateOne({ _id: room, v: d.v }, { $set, $inc: { v: 1 } })).matchedCount) return { s: d.s, out };
  }
  throw bad('Server busy, try again', 503);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URI) return res.status(500).json({ error: 'MongoDB not connected. Add MongoDB Atlas in Vercel Storage and redeploy.' });
  try {
    const now = Date.now(), col = await rooms();
    const b = req.method === 'POST' ? (typeof req.body === 'string' ? parse(req.body) || {} : req.body || {}) : {};

    if (b.action === 'create') {
      const pin = String(b.pin || '').slice(0, 8);
      for (let i = 0; i < 6; i++) {
        const code = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
        try { await col.insertOne({ _id: code, s: newState(), pin, v: 0, chat: [], at: new Date() }); return res.json({ ok: true, room: code, pinRequired: !!pin }); }
        catch (e) { if (e.code !== 11000) throw e; }
      }
      return res.status(503).json({ error: 'Could not create a room, please try again' });
    }

    const room = String((req.method === 'GET' ? req.query.room : b.room) || '').toUpperCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'Bad room code' });
    const uid = String((req.method === 'GET' ? req.query.uid : b.uid) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);

    if (req.method === 'GET') {
      const d = await col.findOne({ _id: room });
      if (!d) return res.status(404).json({ error: 'Room not found' });
      let s = d.s;
      if (advance(structuredClone(s), now)) s = (await mutate(room, x => { advance(x, now); })).s;
      return res.json({ now, pinRequired: !!d.pin, ...view(s, uid), chat: (d.chat || []).slice(-80) });
    }
    if (req.method !== 'POST') return res.status(405).end();

    const d0 = await col.findOne({ _id: room }, { projection: { s: 1, pin: 1 } });
    if (!d0) return res.status(404).json({ error: 'Room not found' });
    const pin = d0.pin, ref = () => { if (pin && b.pin !== pin) throw bad('Wrong referee PIN', 401); };

    if (b.action === 'say') {
      const s = d0.s;
      if (!s.players[uid] || !['day', 'vote', 'end'].includes(s.phase)) return res.status(400).json({ error: 'Chat is closed' });
      const text = String(b.text || '').replace(/[<>]/g, '').trim().slice(0, 200);
      if (text) await col.updateOne({ _id: room }, { $push: { chat: { $each: [{ from: s.players[uid].name, text }], $slice: -80 } }, $set: { at: new Date() } });
      return res.json({ ok: true });
    }
    if (b.action === 'auth') { ref(); return res.json({ ok: true }); }

    const { s } = await mutate(room, async (s, d) => {
      advance(s, now);
      if (b.action === 'start') {
        ref();
        if (!['lobby', 'end'].includes(s.phase)) throw bad('A round is already running');
        s.order = s.order.filter(id => { if (s.players[id].bot) { delete s.players[id]; return false; } return true; });
        if (!s.order.length) throw bad('Need at least 1 player');
        const bn = shuffle(['Ada', 'Bram', 'Cleo', 'Dax', 'Esme', 'Finn']);
        for (let i = 0; s.order.length < MIN_PLAYERS; i++) { s.players['bot' + i] = { name: '🤖 ' + bn[i], bot: true, priv: [] }; s.order.push('bot' + i); }
        const ids = s.order, n = ids.length;
        const cards = shuffle(['Werewolf', 'Werewolf', ...shuffle(POOL).slice(0, n + 1)]);
        ids.forEach((id, i) => Object.assign(s.players[id], { orig: cards[i], role: cards[i], ready: !!s.players[id].bot, acted: false, vote: null, priv: [], seen: {} }));
        Object.assign(s, { center: cards.slice(n), phase: 'deal', result: null, step: 0, dur: [3, 5, 8, 10].includes(+b.dur) ? +b.dur : 5 });
        d.clearChat = true;
      } else if (b.action === 'skip') { ref(); if (s.phase === 'day') s.deadline = now; }
      else if (b.action === 'join') {
        if (!uid) throw bad('uid required');
        if (!s.players[uid]) {
          if (!['lobby', 'end'].includes(s.phase)) throw bad('A round is in progress. Try again when it ends.');
          if (s.order.length >= 10) throw bad('The room is full (10 players)');
          let name = clean(b.name) || 'Player', base = name, k = 2;
          while (s.order.some(id => s.players[id].name === name)) name = base.slice(0, 12) + k++;
          s.players[uid] = { name, priv: [] }; s.order.push(uid);
        }
      } else {
        const p = s.players[uid]; if (!p) throw bad('You are not in this game');
        if (b.action === 'ready' && s.phase === 'deal') p.ready = true;
        else if (b.action === 'act') act(s, uid, b.sel);
        else if (b.action === 'vote' && s.phase === 'vote') {
          const t = s.order[Math.floor(+b.a)];
          if (!t || t === uid) throw bad('Bad vote'); p.vote = t;
        } else throw bad('Unknown action');
      }
      advance(s, now);
    });
    return res.json({ ok: true, ...view(s, uid), now });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
