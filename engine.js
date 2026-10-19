// Game engine for One Night Werewolf and Werewolf x Mafia. Pure JavaScript, no server: the host's browser runs it.
// Works in the browser (window.Engine) and in Node (module.exports) so it can be tested.
(function () {
// ---- game modes. To add a character: put it in a mode's pool, add its night step to that mode's `order`, add an `act` branch below, and add it to ROLES in index.html ----
const MODES = {
  classic: { // One Night Werewolf: one night, one vote
    order: ['Doppelganger', 'Werewolf', 'Minion', 'Mason', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac'],
    fixed: ['Werewolf', 'Werewolf'], min: 3, stepMs: 5000,
    pool: ['Doppelganger', 'Mason', 'Mason', 'Minion', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Insomniac', 'Hunter', 'Tanner', 'Villager', 'Villager', 'Villager'],
    copyLater: ['Werewolf', 'Minion', 'Mason', 'Insomniac'], copyNow: ['Seer', 'Robber', 'Troublemaker', 'Drunk'],
  },
  multi: { // Werewolf x Mafia: several nights, three teams (village, werewolves, mafia); last team standing wins
    order: ['Angel', 'Doppelganger', 'Werewolf', 'Mafia', 'Mason', 'Seer', 'Detective', 'Robber', 'Troublemaker', 'Drunk', 'Doctor'], // the Angel wakes first, only if someone has fallen
    fixed: ['Werewolf', 'Werewolf', 'Mafia', 'Mafia'], min: 5, stepMs: 4000,
    pool: ['Doppelganger', 'Mason', 'Mason', 'Seer', 'Robber', 'Troublemaker', 'Drunk', 'Hunter', 'Detective', 'Doctor', 'Angel', 'Villager', 'Villager', 'Villager'],
    copyLater: ['Werewolf', 'Mafia', 'Mason'], copyNow: ['Seer', 'Detective', 'Robber', 'Troublemaker', 'Drunk', 'Doctor', 'Angel'],
  },
};
const modeOf = s => MODES[s.mode] || MODES.classic, isMulti = s => s.mode === 'multi';

const clean = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 14);
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Who wakes at a night step. A Doppelganger wakes first to copy a card (`dn` = the role copied tonight), then again at the step of a copied team/info role.
// In the multi-night mode `orig` is re-set every night to the card a player holds at the start of that night.
const wakes = (s, p, step) => !p.dead && (step === 'Doppelganger' ? p.orig === 'Doppelganger' : p.orig === step || (p.orig === 'Doppelganger' && p.dn === step && modeOf(s).copyLater.includes(step)));
const eff = p => p.role === 'Doppelganger' ? (p.dop || 'Villager') : p.role; // role used for teams and win conditions
const team = p => { const r = eff(p); return r === 'Werewolf' || r === 'Minion' ? 'wolf' : r === 'Mafia' ? 'mafia' : r === 'Tanner' ? 'tanner' : 'village'; };
const EXCLUDABLE = [...new Set([...MODES.classic.pool, ...MODES.multi.pool])]; // the operator may switch these off; the fixed cards are always in
const MAX_PLAYERS = 13;
const angelOk = s => s.order.some(id => s.players[id].dead);
const newState = () => ({ phase: 'lobby', mode: 'classic', round: 1, news: [], players: {}, order: [], center: [], step: 0, t: 0, deadline: 0, voteBy: 0, dur: 5, result: null });

// ---- game engine (pure functions on the state object) ----
function enter(s) {                      // a night step starts: info-only roles get their info right away
  const M = modeOf(s), r = M.order[s.step], multi = isMulti(s), seat = id => s.order.indexOf(id), nm = ids => ids.map(x => s.players[x].name).join(', ');
  const of = role => s.order.filter(id => wakes(s, s.players[id], role));
  s.order.forEach(id => {
    const p = s.players[id]; if (!wakes(s, p, r)) return;
    p.seen = p.seen || {}; if (r !== 'Doppelganger') p.acted = false;
    if (r === 'Doppelganger') return;
    if (r === 'Werewolf' || r === 'Mafia' || r === 'Mason') {
      const o = of(r).filter(x => x !== id);
      if (o.length) { o.forEach(x => p.seen['p' + seat(x)] = r); p.priv.push(`Your fellow ${r === 'Mafia' ? 'mafia' : r.toLowerCase()}: ${nm(o)}.`); if (!multi || r === 'Mason') p.acted = true; }
    } else if (r === 'Minion') {
      const ws = of('Werewolf'); ws.forEach(x => p.seen['p' + seat(x)] = 'Werewolf');
      p.priv.push(ws.length ? 'The werewolves are: ' + nm(ws) + '.' : 'There are no werewolves among the players.'); p.acted = true;
    } else if (r === 'Troublemaker' && s.order.filter(x => !s.players[x].dead).length < 3) { p.priv.push('Not enough players to swap anyone.'); p.acted = true; }
    else if (r === 'Insomniac') { p.seen['p' + seat(id)] = p.role; p.priv.push('Your card is now the ' + p.role + '.'); p.acted = true; }
    else if (r === 'Angel' && !angelOk(s)) { p.priv.push('Nobody has fallen yet.'); p.acted = true; }
  });
}
// sel: array of 'p<seat>' (a player, by seat number) or 'c<0-2>' (a center card)
function act(s, id, sel) {
  const p = s.players[id], step = modeOf(s).order[s.step], multi = isMulti(s);
  if (s.phase !== 'night' || !wakes(s, p, step) || p.acted) throw bad('Not your turn');
  const r = step === 'Doppelganger' && p.dn ? p.dn : step;
  p.seen = p.seen || {};
  const me = s.order.indexOf(id);
  const T = (Array.isArray(sel) ? sel : []).slice(0, 3).map(k => { const m = /^([pc])(\d{1,2})$/.exec(String(k)); return m && { t: m[1], i: +m[2], k: m[0] }; });
  if (T.some(x => !x)) throw bad('Bad choice');
  const P = x => s.players[s.order[x.i]];
  const isP = x => x.t === 'p' && x.i < s.order.length;
  const okP = x => isP(x) && x.i !== me && !P(x).dead, okS = x => isP(x) && !P(x).dead, okD = x => isP(x) && P(x).dead, okC = x => x.t === 'c' && x.i < 3;
  if (r === 'Doppelganger') {
    if (T.length !== 1 || !okP(T[0])) throw bad('Pick a player to copy');
    const t = P(T[0]); p.dop = p.dn = t.role; p.seen[T[0].k] = t.role;
    p.priv.push(`You looked at ${t.name}: the ${t.role}. You are now a Doppelganger-${t.role}.`);
    if (modeOf(s).copyNow.includes(t.role) && !(t.role === 'Angel' && !angelOk(s))) p.priv.push(`Use the ${t.role} power now.`); else p.acted = true;
    return;
  }
  if (multi && (r === 'Werewolf' || r === 'Mafia')) {
    if (T.length !== 1 || !okP(T[0])) throw bad('Pick a player to kill');
    p.target = s.order[T[0].i]; p.pack = r; p.priv.push(`You picked ${P(T[0]).name} as your victim.`);
  } else if (r === 'Werewolf' || r === 'Mason' || r === 'Drunk') {
    if (T.length !== 1 || !okC(T[0])) throw bad('Pick a center card');
    const c = T[0].i;
    if (r === 'Drunk') { [p.role, s.center[c]] = [s.center[c], p.role]; p.priv.push(`You swapped with Center ${c + 1}. You don't know your new card.`); }
    else { p.seen['c' + c] = s.center[c]; p.priv.push(`Center ${c + 1} is the ${s.center[c]}.`); }
  } else if (r === 'Seer') {
    if (T.length === 0) p.priv.push('You chose not to look.');
    else if (T.length === 1 && okP(T[0])) { const t = P(T[0]); p.seen[T[0].k] = t.role; p.priv.push(`${t.name} is the ${t.role}.`); }
    else if (T.length === 2 && T.every(okC) && T[0].i !== T[1].i) { T.forEach(x => p.seen[x.k] = s.center[x.i]); p.priv.push(`Center ${T[0].i + 1} is the ${s.center[T[0].i]} and Center ${T[1].i + 1} is the ${s.center[T[1].i]}.`); }
    else throw bad('Pick one player or two center cards');
  } else if (r === 'Detective') {
    if (T.length === 0) p.priv.push('You chose not to look.');
    else if (T.length === 1 && okP(T[0])) { const t = P(T[0]); p.seen[T[0].k] = t.role; p.priv.push(`${t.name} is the ${t.role}.`); }
    else throw bad('Pick one player');
  } else if (r === 'Doctor') {
    if (T.length === 0) p.priv.push('You protected nobody.');
    else if (T.length === 1 && okS(T[0])) { p.save = s.order[T[0].i]; p.priv.push(`You protected ${P(T[0]).name} tonight.`); }
    else throw bad('Pick one player to protect');
  } else if (r === 'Angel') {
    if (!angelOk(s)) throw bad('Nobody to bring back');
    if (T.length === 0) p.priv.push('You chose not to bring anyone back.');
    else if (T.length === 1 && okD(T[0])) { const t = P(T[0]); t.dead = false; t.priv.push('You were brought back to life. You do not know by whom.'); s.back.push(t.name); p.priv.push(`You brought ${t.name} back to life.`); }
    else throw bad('Pick one fallen player');
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
function startNight(s, now) {            // every night (and the single night of the classic mode) starts here
  s.phase = 'night'; s.step = 0; s.t = now; s.back = [];
  s.order.forEach(id => {
    const p = s.players[id];
    Object.assign(p, { orig: p.role, acted: false, seen: {}, dn: null, pack: null, target: null, save: null });
    if (isMulti(s) && !p.dead) p.priv.push(`— Night ${s.round} —`);
  });
  enter(s);
}
function resolve(s) {                    // classic mode: the single vote decides the game
  const ids = s.order, pl = s.players, votes = {};
  ids.forEach(id => { if (!pl[id].vote) { const o = ids.filter(x => x !== id); pl[id].vote = o.length ? o[Math.floor(Math.random() * o.length)] : id; } votes[id] = 0; });
  ids.forEach(id => votes[pl[id].vote]++);
  const max = Math.max(...Object.values(votes));
  const dead = max > 1 ? ids.filter(id => votes[id] === max) : [];
  const h = dead.find(id => eff(pl[id]) === 'Hunter');
  if (h && !dead.includes(pl[h].vote)) dead.push(pl[h].vote);
  const roles = dead.map(id => eff(pl[id])), wolves = ids.some(id => eff(pl[id]) === 'Werewolf'), tanner = roles.includes('Tanner');
  const village = wolves ? roles.includes('Werewolf') : (dead.length === 0 || roles.every(r => r === 'Minion')), wolfTeam = !village && !tanner;
  const win = {}; ids.forEach(id => { const r = eff(pl[id]); win[id] = r === 'Werewolf' || r === 'Minion' ? wolfTeam : r === 'Tanner' ? tanner : village; });
  s.result = {
    text: (dead.length ? 'Dead: ' + dead.map(id => `${pl[id].name} (${pl[id].role})`).join(', ') + '. ' : 'Nobody got more than one vote, so nobody died. ') + (village ? 'The village wins.' : tanner ? 'The Tanner wins.' : 'The wolves win.'),
    rows: ids.map(id => ({ id, name: pl[id].name, orig: pl[id].orig, role: pl[id].role, votes: votes[id], voted: pl[pl[id].vote].name, dead: dead.includes(id) })),
    center: s.center, win,
  };
  s.phase = 'end';
}
// ---- multi-night mode ----
const TEAM_NAME = { village: 'Village', wolf: 'Werewolves', mafia: 'Mafia', tanner: 'Tanner' };
function kill(s, id, out) {              // marks a player dead (a dying Hunter takes their last vote with them)
  const p = s.players[id]; if (!p || p.dead) return;
  p.dead = true; out.push(`${p.name} (${p.role})`);
  if (eff(p) === 'Hunter' && p.lastVote) kill(s, p.lastVote, out);
}
function winner(s) {                     // last team standing wins; null while two or more teams are alive
  const f = new Set(s.order.filter(id => !s.players[id].dead).map(id => team(s.players[id])));
  return f.size <= 1 ? [...f][0] || 'none' : null;
}
function finish(s, w) {
  const pl = s.players, win = {}, text = { village: 'The village wins! Every werewolf and mafia member is gone.', wolf: 'The werewolves win!', mafia: 'The mafia wins!', none: 'Everyone is dead. Nobody wins.' };
  s.order.forEach(id => win[id] = w !== 'none' && team(pl[id]) === w);
  s.result = { text: text[w] || 'The game is over.', rows: s.order.map(id => ({ id, name: pl[id].name, orig: pl[id].first, role: pl[id].role, votes: 0, voted: '', dead: !!pl[id].dead, team: TEAM_NAME[team(pl[id])] })), center: s.center, win };
  s.phase = 'end';
}
function next(s, now, after) {           // after a night or a vote: end the game, or move on
  const w = winner(s); s.news = s.news.slice(-40);
  if (w) return finish(s, w);
  if (after === 'night') { s.phase = 'day'; s.deadline = now + s.dur * 60000; return; }
  s.round++; s.phase = 'deal'; s.dealBy = now + 30000;
  s.order.forEach(id => { const p = s.players[id]; p.vote = null; p.ready = !!p.dead; });
}
function dawn(s, now) {                  // the night's kills, saves and revival
  const pl = s.players, alive = s.order.filter(id => !pl[id].dead).map(id => pl[id]);
  const pick = pack => {                 // each pack member picks; the most-picked victim dies, ties are random
    const c = {}; alive.filter(p => p.pack === pack && p.target && !pl[p.target].dead).forEach(p => c[p.target] = (c[p.target] || 0) + 1);
    const m = Math.max(0, ...Object.values(c)), top = Object.keys(c).filter(t => c[t] === m);
    return top.length ? top[Math.floor(Math.random() * top.length)] : null;
  };
  const saved = new Set(alive.map(p => p.save).filter(Boolean)), out = [];
  [...new Set([pick('Werewolf'), pick('Mafia')].filter(Boolean))].filter(t => !saved.has(t)).forEach(t => kill(s, t, out));
  const back = s.back || []; // brought back by the Angel earlier in the night
  s.news.push(`Night ${s.round}: ` + (out.length ? 'Killed: ' + out.join(', ') + '.' : 'Nobody died.') + (back.length ? ` Brought back to life: ${back.join(', ')}.` : ''));
  next(s, now, 'night');
}
function tally(s, now) {                 // the day's vote: the single most-voted player dies, a tie or no votes means nobody dies
  const pl = s.players, alive = s.order.filter(id => !pl[id].dead), c = {}, out = [];
  alive.forEach(id => { const t = pl[id].vote; if (t && !pl[t].dead) { c[t] = (c[t] || 0) + 1; pl[id].lastVote = t; } });
  const m = Math.max(0, ...Object.values(c)), top = Object.keys(c).filter(t => c[t] === m);
  if (m > 0 && top.length === 1) kill(s, top[0], out);
  s.news.push(`Day ${s.round}: ` + (out.length ? 'Voted out: ' + out.join(', ') + '.' : 'The vote was tied or empty. Nobody was voted out.'));
  next(s, now, 'day');
}
function advance(s, now) {               // moves the clock-driven parts of the game forward; true if anything changed
  const M = modeOf(s); let ch = false;
  if (s.phase === 'countdown' && now >= s.startAt) { s.phase = 'deal'; s.dealBy = now + 60000; ch = true; }
  if (s.phase === 'deal' && s.order.length && (s.order.every(id => s.players[id].ready) || now >= (s.dealBy || 0))) { startNight(s, now); ch = true; }
  while (s.phase === 'night') {
    const pend = s.order.some(id => wakes(s, s.players[id], M.order[s.step]) && !s.players[id].acted), t = now - s.t;
    if (t < M.stepMs || (pend && t < 45000)) break;
    ch = true;
    if (s.step === M.order.length - 1) { if (isMulti(s)) dawn(s, now); else { s.phase = 'day'; s.deadline = now + s.dur * 60000; } break; }
    s.step++; s.t = now; enter(s);
  }
  if (s.phase === 'day' && now >= s.deadline) { s.phase = 'vote'; s.voteBy = now + 90000; ch = true; }
  if (s.phase === 'vote') {
    const voters = s.order.filter(id => !s.players[id].dead);
    if (voters.length < 2 || voters.every(id => s.players[id].vote) || now >= s.voteBy) { isMulti(s) ? tally(s, now) : resolve(s); ch = true; }
  }
  return ch;
}
function view(s, uid) {
  const M = modeOf(s), p = s.players[uid], night = s.phase === 'night', r = M.order[s.step], multi = isMulti(s);
  let ask = null; const awake = !!(p && night && wakes(s, p, r));
  if (awake && !p.acted) ask = { role: r === 'Doppelganger' && p.dn ? p.dn : r };
  return {
    phase: s.phase, mode: s.mode || 'classic', round: s.round || 1, news: s.news || [], dur: s.dur, deadline: s.deadline, voteBy: s.voteBy, startAt: s.startAt || 0, off: s.off || [], step: awake ? r : null,
    players: s.order.map(id => { const q = s.players[id]; return { name: q.name, ready: !!q.ready, voted: !!q.vote, dead: !!q.dead, role: q.dead ? q.role : null }; }),
    me: p ? { seat: s.order.indexOf(uid), dead: !!p.dead, awake, seen: awake || s.phase === 'end' ? p.seen || {} : {}, orig: s.phase === 'countdown' ? null : (multi && s.phase === 'deal' ? p.role : p.orig), priv: s.phase === 'countdown' ? [] : p.priv, ready: !!p.ready, voted: !!p.vote, win: s.result ? s.result.win[uid] : null, final: s.result ? p.role : null } : null,
    ask,
    result: s.result ? { text: s.result.text, rows: s.result.rows.map(({ id, ...x }) => x), center: s.result.center } : null,
  };
}

// ---- room API: the host's browser keeps one `room` object ({ s: game state, chat: [...], hostUid }) and calls these ----
function create(hostUid) { return { s: newState(), chat: [], hostUid }; }
function tick(room, now) { return advance(room.s, now); } // true when the clock moved the game on

// Applies one request. `fromHost` is true only for calls made on the host's own device; start/config/skip are host-only.
function handle(room, uid, b, now, fromHost) {
  const s = room.s; advance(s, now);
  const hostOnly = () => { if (!fromHost) throw bad('Only the host can do that', 403); };
  if (b.action === 'poll') { /* just refresh the view */ }
  else if (b.action === 'say') {
    const p = s.players[uid];
    if (!p || !['day', 'vote', 'end'].includes(s.phase) || (isMulti(s) && p.dead && s.phase !== 'end')) throw bad('Chat is closed');
    const text = String(b.text || '').replace(/[<>]/g, '').trim().slice(0, 200);
    if (text) room.chat = [...room.chat, { from: p.name, text }].slice(-80);
  } else if (b.action === 'start') {
    hostOnly();
    if (!['lobby', 'end'].includes(s.phase)) throw bad('A round is already running');
    const M = modeOf(s);
    if (s.order.length < M.min) throw bad('Need at least ' + M.min + ' players for this mode');
    s.order = shuffle(s.order); // seats are drawn at random each round
    const ids = s.order, n = ids.length, need = n + 3 - M.fixed.length, avail = M.pool.filter(r => !(s.off || []).includes(r));
    if (avail.length < need) throw bad(`Not enough cards enabled: ${n} players need ${need} optional cards besides ${M.fixed.join(', ')}, but only ${avail.length} are enabled.`);
    const cards = shuffle([...M.fixed, ...shuffle(avail).slice(0, need)]);
    ids.forEach((id, i) => Object.assign(s.players[id], { orig: cards[i], first: cards[i], role: cards[i], ready: false, acted: false, vote: null, lastVote: null, dead: false, dop: null, dn: null, priv: [], seen: {} }));
    Object.assign(s, { center: cards.slice(n), phase: 'countdown', startAt: now + 6000, result: null, step: 0, round: 1, news: [], dur: [3, 5, 8, 10].includes(+b.dur) ? +b.dur : 5 });
    room.chat = [];
  } else if (b.action === 'config') {
    hostOnly();
    if (!['lobby', 'end'].includes(s.phase)) throw bad('Cards can only be changed between rounds');
    if (['classic', 'multi'].includes(b.mode)) s.mode = b.mode;
    s.off = [...new Set((Array.isArray(b.off) ? b.off : []).filter(r => EXCLUDABLE.includes(r)))];
  } else if (b.action === 'skip') { hostOnly(); if (s.phase === 'day') s.deadline = now; }
  else if (b.action === 'lobby') {         // after a game: everyone goes back to the lobby, players stay seated
    if (s.phase !== 'end') throw bad('The game is not over yet');
    Object.assign(s, { phase: 'lobby', result: null, round: 1, news: [], center: [], step: 0 });
    s.order.forEach(id => Object.assign(s.players[id], { orig: null, first: null, role: null, ready: false, acted: false, vote: null, lastVote: null, dead: false, dop: null, dn: null, priv: [], seen: {} }));
    room.chat = [];
  } else if (b.action === 'join') {
    if (!uid) throw bad('uid required');
    if (!s.players[uid]) {
      if (!['lobby', 'end'].includes(s.phase)) throw bad('A round is in progress. Try again when it ends.');
      if (s.order.length >= MAX_PLAYERS) throw bad('The room is full (' + MAX_PLAYERS + ' players)');
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
      if (!t || t === uid || p.dead || s.players[t].dead) throw bad('Bad vote'); p.vote = t;
    } else throw bad('Unknown action');
  }
  advance(s, now);
}
function viewOf(room, uid, now) { advance(room.s, now); return { ok: true, now, ...view(room.s, uid), chat: room.chat.slice(-80) }; }

const Engine = { create, handle, viewOf, tick, MODES, advance, act, view, newState, shuffle };
if (typeof module !== 'undefined' && module.exports) module.exports = Engine; else window.Engine = Engine;
})();
