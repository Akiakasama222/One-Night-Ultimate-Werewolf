
// Vercel serverless function: One Night Werewolf rooms. Game state lives in MongoDB Atlas (one document per room).
const { MongoClient } = require('mongodb');
const URI = process.env.MONGODB_URI;
const ROOM_RE = /^[A-Z0-9]{4}$/, ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ORDER = ['Werewolf', 'Minion', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac'];
const POOL = ['Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac', 'Minion', 'Tanner', 'Hunter', 'Villager', 'Villager', 'Villager'];

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
const newState = () => ({ phase: 'lobby', players: {}, order: [], center: [], step: 0, t: 0, deadline: 0, voteBy: 0, dur: 5, result: null });

// ---- game engine (pure functions on the state object) ----
function enter(s) {                      // a night step starts: info-only roles get their info right away
  const r = ORDER[s.step], ws = s.order.filter(id => s.players[id].orig === 'Werewolf'), nm = ids => ids.map(x => s.players[x].name).join(', ');
  s.order.forEach(id => {
    const p = s.players[id]; if (p.orig !== r) return;
    if (r === 'Werewolf') { const o = ws.filter(x => x !== id); if (o.length) { p.priv.push('Your fellow werewolf: ' + nm(o) + '.'); p.acted = true; } }
    else if (r === 'Minion') { p.priv.push(ws.length ? 'The werewolves are: ' + nm(ws) + '.' : 'There are no werewolves among the players.'); p.acted = true; }
    else if (r === 'Insomniac') { p.priv.push('Your card is now the ' + p.role + '.'); p.acted = true; }
  });
}
function act(s, id, b) {
  const p = s.players[id], r = ORDER[s.step];
  if (s.phase !== 'night' || p.orig !== r || p.acted) throw bad('Not your turn');
  const o = s.order.filter(x => x !== id), L = x => s.players[x], a = Math.floor(+b.a), q = Math.floor(+b.b);
  const inR = (v, n) => Number.isInteger(v) && v >= 0 && v < n;
  if (r === 'Werewolf' || r === 'Drunk') {
    if (!inR(a, 3)) throw bad('Pick a center card');
    if (r === 'Werewolf') p.priv.push(`Center ${a + 1} is the ${s.center[a]}.`);
    else { [p.role, s.center[a]] = [s.center[a], p.role]; p.priv.push(`You swapped with Center ${a + 1}. You don't know your new card.`); }
  } else if (r === 'Seer') {
    if (!inR(a, o.length + 1)) throw bad('Bad choice');
    if (a < o.length) p.priv.push(`${L(o[a]).name} is the ${L(o[a]).role}.`);
    else { const c = shuffle([0, 1, 2]); p.priv.push(`The center has the ${s.center[c[0]]} and the ${s.center[c[1]]}.`); }
  } else if (r === 'Robber') {
    if (!inR(a, o.length + 1)) throw bad('Bad choice');
    if (a < o.length) { const t = L(o[a]); [p.role, t.role] = [t.role, p.role]; p.priv.push(`You robbed ${t.name}. You are now the ${p.role}.`); } else p.priv.push('You robbed nobody.');
  } else if (r === 'Troublemaker') {
    if (!inR(a, o.length) || !inR(q, o.length) || a === q) throw bad('Pick two different players');
    const x = L(o[a]), y = L(o[q]); [x.role, y.role] = [y.role, x.role]; p.priv.push(`You swapped ${x.name} and ${y.name}.`);
  } else throw bad('Nothing to do');
  p.acted = true;
}
function resolve(s) {
  const ids = s.order, pl = s.players, votes = {};
  ids.forEach(id => { if (!pl[id].vote) { const o = ids.filter(x => x !== id); pl[id].vote = o[Math.floor(Math.random() * o.length)]; } votes[id] = 0; });
  ids.forEach(id => votes[pl[id].vote]++);
  const max = Math.max(...Object.values(votes));
  const dead = max > 1 ? ids.filter(id => votes[id] === max) : [];
  const h = dead.find(id => pl[id].role === 'Hunter');
  if (h && !dead.includes(pl[h].vote)) dead.push(pl[h].vote);
  const roles = dead.map(id => pl[id].role), wolves = ids.some(id => pl[id].role === 'Werewolf'), tanner = roles.includes('Tanner');
  const village = wolves ? roles.includes('Werewolf') : dead.length === 0, wolfTeam = !village && !tanner;
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
    const pend = s.order.some(id => s.players[id].orig === ORDER[s.step] && !s.players[id].acted), t = now - s.t;
    if (t < 3000 || (pend && t < 45000)) break;
    ch = true;
    if (s.step === ORDER.length - 1) { s.phase = 'day'; s.deadline = now + s.dur * 60000; break; }
    s.step++; s.t = now; enter(s);
  }
  if (s.phase === 'day' && now >= s.deadline) { s.phase = 'vote'; s.voteBy = now + 90000; ch = true; }
  if (s.phase === 'vote' && (s.order.every(id => s.players[id].vote) || now >= s.voteBy)) { resolve(s); ch = true; }
  return ch;
}
function view(s, uid) {
  const p = s.players[uid], night = s.phase === 'night', r = ORDER[s.step];
  let ask = null;
  if (p && night && p.orig === r && !p.acted) ask = { role: r, others: s.order.filter(x => x !== uid).map(x => s.players[x].name) };
  return {
    phase: s.phase, dur: s.dur, deadline: s.deadline, voteBy: s.voteBy, step: night ? r : null,
    players: s.order.map(id => ({ name: s.players[id].name, ready: !!s.players[id].ready, voted: !!s.players[id].vote })),
    me: p ? { orig: p.orig, priv: p.priv, ready: !!p.ready, voted: !!p.vote, win: s.result ? s.result.win[uid] : null, final: s.result ? p.role : null } : null,
    ask, others: p && s.phase === 'vote' ? s.order.filter(x => x !== uid).map(x => s.players[x].name) : null,
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
        const ids = s.order, n = ids.length;
        if (n < 3) throw bad('Need at least 3 players');
        const cards = shuffle(['Werewolf', 'Werewolf', ...shuffle(POOL).slice(0, n + 1)]);
        ids.forEach((id, i) => Object.assign(s.players[id], { orig: cards[i], role: cards[i], ready: false, acted: false, vote: null, priv: [] }));
        Object.assign(s, { center: cards.slice(n), phase: 'deal', result: null, step: 0, dur: [3, 5, 8, 10].includes(+b.dur) ? +b.dur : 5 });
        d.clearChat = true;
      } else if (b.action === 'skip') { ref(); if (s.phase === 'day') s.deadline = now; }
      else if (b.action === 'join') {
        if (!uid) throw bad('uid required');
        if (!s.players[uid]) {
          if (s.phase !== 'lobby') throw bad('That game has already started');
          if (s.order.length >= 10) throw bad('The room is full (10 players)');
          let name = clean(b.name) || 'Player', base = name, k = 2;
          while (s.order.some(id => s.players[id].name === name)) name = base.slice(0, 12) + k++;
          s.players[uid] = { name, priv: [] }; s.order.push(uid);
        }
      } else {
        const p = s.players[uid]; if (!p) throw bad('You are not in this game');
        if (b.action === 'ready' && s.phase === 'deal') p.ready = true;
        else if (b.action === 'act') act(s, uid, b);
        else if (b.action === 'vote' && s.phase === 'vote') {
          const o = s.order.filter(x => x !== uid), t = o[Math.floor(+b.a)];
          if (!t) throw bad('Bad vote'); p.vote = t;
        } else throw bad('Unknown action');
      }
      advance(s, now);
    });
    return res.json({ ok: true, ...view(s, uid), now });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
};
