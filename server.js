const express = require('express'), http = require('http'), { Server } = require('socket.io');
const Database = require('better-sqlite3'), bcrypt = require('bcryptjs'), jwt = require('jsonwebtoken');

// ---- Configuración de juego ----
const SECRET = process.env.SECRET || 'cambia-esto', PORT = process.env.PORT || 3000;
const ROUNDS = 5, START = 300, NEW_COST = 120, CAP = 100, BET = 30, VET = 40;
const PRIZE = [150, 90, 50, 30], PTS = [5, 3, 2, 1], SHORT = [1000, 1200, 1400], MID = [1600, 1800, 2000, 2200], LONG = [2400, 2800, 3200];
const STATS = ['speed', 'power', 'stamina'];
const NAMES = ['Agnes Digital', 'Agnes Tachyon', 'Air Groove', 'Biwa Hayahide', 'Curren Chan', 'Daiwa Scarlet', 'El Condor Pasa', 'Fine Motion', 'Fuji Kiseki', 'Gold Ship', 'Grass Wonder', 'Hishi Amazon', 'Maruzensky', 'Mayano Top Gun', 'Mejiro McQueen', 'Mejiro Ryan', 'Mihono Bourbon', 'Narita Brian', 'Oguri Cap', 'Sakura Bakushin O', 'Seiun Sky', 'Silence Suzuka', 'Special Week', 'Symboli Rudolf', 'T.M. Opera O', 'Taiki Shuttle', 'Tamamo Cross', 'Tokai Teio', 'Vodka', 'Winning Ticket'];

// ---- Base de datos ----
const db = new Database('liga.db');
db.exec(`
CREATE TABLE IF NOT EXISTS usuario(id INTEGER PRIMARY KEY, nombre TEXT UNIQUE, hash TEXT, victorias INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS resultado_carrera(id INTEGER PRIMARY KEY, sala TEXT, ronda INT, distancia INT, usuario_id INT,
  caballo TEXT, posicion INT, premio INT, lesion TEXT, fecha DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS transaccion(id INTEGER PRIMARY KEY, sala TEXT, ronda INT, usuario_id INT, tipo TEXT, importe INT,
  fecha DEFAULT CURRENT_TIMESTAMP);`);
const insRes = db.prepare('INSERT INTO resultado_carrera(sala,ronda,distancia,usuario_id,caballo,posicion,premio,lesion) VALUES(?,?,?,?,?,?,?,?)');
const insTx = db.prepare('INSERT INTO transaccion(sala,ronda,usuario_id,tipo,importe) VALUES(?,?,?,?,?)');
const tx = (r, p, tipo, imp) => insTx.run(r.code, r.round, p.id, tipo, imp);

// ---- Auth REST ----
const app = express(); app.use(express.json()); app.use(express.static('public'));
const sign = u => jwt.sign({ id: u.id, nombre: u.nombre }, SECRET, { expiresIn: '7d' });
app.post('/api/register', (q, r) => {
  const { nombre, password } = q.body || {};
  if (!/^(?!.* {2})\w[\w ]{1,14}\w$/.test(nombre || '') || (password || '').length < 4) return r.status(400).json({ error: 'Usuario 3-16 caracteres (letras, números y espacios), contraseña mín. 4' });
  try {
    const i = db.prepare('INSERT INTO usuario(nombre,hash) VALUES(?,?)').run(nombre, bcrypt.hashSync(password, 8));
    r.json({ token: sign({ id: i.lastInsertRowid, nombre }), nombre });
  } catch { r.status(400).json({ error: 'Ese usuario ya existe' }); }
});
app.post('/api/login', (q, r) => {
  const { nombre, password } = q.body || {};
  const u = db.prepare('SELECT * FROM usuario WHERE nombre=?').get(nombre || '');
  if (!u || !bcrypt.compareSync(password || '', u.hash)) return r.status(401).json({ error: 'Credenciales incorrectas' });
  r.json({ token: sign(u), nombre: u.nombre });
});

// ---- Lógica del caballo ----
const R = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const newHorse = (nm, name = nm || NAMES[R(0, NAMES.length - 1)]) => ({ name, skills: [SKILL_OF[name]], speed: R(25, 55), power: R(25, 55), stamina: R(25, 55), wins: 0, debuff: null, outRounds: 0 });
const eff = (h, s) => h[s] - (h.debuff && h.debuff.stat === s ? h.debuff.amt : 0);
const value = h => 50 + Math.round((h.speed + h.power + h.stamina) * 1.5) + h.wins * 40; // base + stats + victorias
const upCost = (h, s) => 12 + Math.round(h[s] * h[s] / 45);
const gain = x => x < 50 ? 4 : x < 70 ? 3 : 2; // rendimientos decrecientes
const sellPrice = h => Math.round(value(h) * 0.7);
const hv = h => ({ ...h, sk: h.skills.map(id => SK[id]), eff: Object.fromEntries(STATS.map(s => [s, eff(h, s)])), up: Object.fromEntries(STATS.map(s => [s, upCost(h, s)])), gain: Object.fromEntries(STATS.map(s => [s, gain(h[s])])), sell: sellPrice(h), out: h.outRounds > 0 });

const SKILL_OF = {
  'Agnes Digital': 'todoterreno',
  'Agnes Tachyon': 'recuperacion',
  'Air Groove': 'campeon',
  'Biwa Hayahide': 'fondista',
  'Curren Chan': 'salida',
  'Daiwa Scarlet': 'remontada',
  'El Condor Pasa': 'firme',
  'Fine Motion': 'reserva',
  'Fuji Kiseki': 'barro',
  'Gold Ship': 'coraza',
  'Grass Wonder': 'todoterreno',
  'Hishi Amazon': 'veterano',
  'Maruzensky': 'salida',
  'Mayano Top Gun': 'remontada',
  'Mejiro McQueen': 'fondista',
  'Mejiro Ryan': 'reserva',
  'Mihono Bourbon': 'barro',
  'Narita Brian': 'veterano',
  'Oguri Cap': 'coraza',
  'Sakura Bakushin O': 'salida',
  'Seiun Sky': 'firme',
  'Silence Suzuka': 'firme',
  'Special Week': 'campeon',
  'Symboli Rudolf': 'veterano',
  'T.M. Opera O': 'fondista',
  'Taiki Shuttle': 'recuperacion',
  'Tamamo Cross': 'reserva',
  'Tokai Teio': 'campeon',
  'Vodka': 'coraza',
  'Winning Ticket': 'barro'
};

// ---- Habilidades especiales (cada caballo trae la suya; máx. 2: la propia + la heredada del anterior) ----
const SK = {
  salida: { n: 'Salida explosiva', d: '+4 de rendimiento en carreras cortas (menos de 1600 m).' },
  fondista: { n: 'Fondista', d: '+4 en carreras largas (2400 m o más).' },
  todoterreno: { n: 'Todoterreno', d: '+4 en carreras medias (1600-2200 m).' },
  barro: { n: 'Rey del barro', d: '+4 en pista pesada.' },
  firme: { n: 'Pista veloz', d: '+4 en pista firme.' },
  veterano: { n: 'Veterano', d: '+2 por cada victoria del caballo (máx. +6).' },
  remontada: { n: 'Remontada', d: '+3 si algún rival te supera en puntos de campeonato.' },
  campeon: { n: 'Corazón de campeón', d: '+2 en todas las carreras.' },
  coraza: { n: 'Piel de acero', d: 'La probabilidad de lesionarse se reduce a la mitad.' },
  recuperacion: { n: 'Recuperación rápida', d: 'Las lesiones leves solo penalizan 1 ronda en vez de 2.' },
  reserva: { n: 'Reserva de energía', d: 'Sufre la mitad de penalización si una estadística no llega al mínimo de la carrera.' }
};
function skillBonus(h, p, r) {
  const has = k => h.skills.includes(k), d = r.race.distance, c = r.race.cond;
  let b = 0;
  if (has('salida') && d < 1600) b += 4;
  if (has('fondista') && d >= 2400) b += 4;
  if (has('todoterreno') && d >= 1600 && d < 2400) b += 4;
  if (has('barro') && c === 'pesada') b += 4;
  if (has('firme') && c === 'firme') b += 4;
  if (has('veterano')) b += Math.min(6, h.wins * 2);
  if (has('remontada') && r.players.some(x => x.points > p.points)) b += 3;
  if (has('campeon')) b += 2;
  return b;
}

// Distancias: siempre 1 corta, 1 media, 1 larga y 2 libres, barajadas y sin repetir seguidas
const pick = a => a[R(0, a.length - 1)], shuffle = a => a.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
const mkDists = () => { let d; do d = shuffle([pick(SHORT), pick(MID), pick(LONG), pick(SHORT.concat(MID, LONG)), pick(SHORT.concat(MID, LONG))]); while (d.some((x, i) => x === d[i - 1])); return d; };

// ---- Simulación de carrera (el servidor decide todo) ----
function simulate(r) {
  const d = r.race.distance, t = Math.min(1, Math.max(0, (d - 1000) / 2200));  // 0 = corta, 1 = larga
  const w = { speed: .55 - .4 * t, power: .3, stamina: .15 + .4 * t };
  const cd = { firme: .1, normal: 0, pesada: -.1 }[r.race.cond] || 0; w.speed += cd; w.power -= cd; // estado de la pista   // pesos según distancia
  const req = { speed: 65 - 40 * t, power: 38, stamina: 20 + 50 * t };   // mínimos: penalizan especializarse en una sola stat
  const soft = x => x <= 60 ? x : 60 + (x - 60) * .5;                     // rendimientos decrecientes
  const res = [];
  for (const p of r.players) {
    const h = p.horse, e = k => eff(h, k), sk = k => h.skills.includes(k);
    if (h.outRounds > 0) { h.outRounds--; res.push({ id: p.id, name: p.name, horse: h.name, dns: true }); continue; }
    let perf = STATS.reduce((a, k) => a + w[k] * soft(e(k)), 0)
      - STATS.reduce((a, k) => a + Math.max(0, req[k] - e(k)), 0) * (sk('reserva') ? .22 : .45) + skillBonus(h, p, r)
      + (Math.random() * 2 - 1) * 5;               // suerte limitada (±5)
    if (h.debuff && --h.debuff.rounds <= 0) h.debuff = null;
    const o = { id: p.id, name: p.name, horse: h.name, injury: null, dnf: false, stopAt: 1 };
    if (Math.random() < (.07 + .06 * t) * (sk('coraza') ? .5 : 1)) {
      o.injury = Math.random() < .3 ? 'grave' : 'leve';
      if (o.injury === 'grave') { o.dnf = true; o.stopAt = .3 + Math.random() * .5; h.outRounds = 1; }
      else { perf *= .85; h.debuff = { stat: STATS[R(0, 2)], amt: 6, rounds: sk('recuperacion') ? 1 : 2 }; }
    }
    o.time = d / 18 * 45 / Math.max(perf, 10);
    res.push(o);
  }
  const run = res.filter(x => !x.dns).sort((a, b) => a.dnf - b.dnf || (a.dnf ? b.stopAt - a.stopAt : a.time - b.time));
  run.forEach((x, i) => {
    const p = r.players.find(p => p.id === x.id);
    x.pos = i + 1; x.prize = x.dnf ? 0 : PRIZE[i]; p.coins += x.prize; p.points += x.dnf ? 0 : PTS[i];
    if (x.prize) tx(r, p, 'premio', x.prize);
    if (i === 0 && !x.dnf) p.horse.wins++;
    insRes.run(r.code, r.round, r.race.distance, p.id, x.horse, x.pos, x.prize, x.injury);
  });
  r.results = [...run, ...res.filter(x => x.dns)];
  const win = run[0] && !run[0].dnf ? run[0].name : null;
  r.bets = r.players.filter(p => p.bet).map(p => {
    const won = p.bet === win, pay = BET * r.players.length;
    if (won) { p.coins += pay; tx(r, p, 'apuesta_ganada', pay); }
    const o = { name: p.name, on: p.bet, won }; p.bet = null; return o;
  });
}

// ---- Salas y sockets ----
const server = http.createServer(app), io = new Server(server), rooms = new Map(), chatLog = [];
const pub = r => ({
  code: r.code, phase: r.phase, round: r.round, rounds: ROUNDS, race: r.race, results: r.results, bets: r.bets, newCost: NEW_COST,
  host: r.players.find(p => p.id === r.host)?.name,
  players: r.players.map(p => ({ name: p.name, coins: p.coins, points: p.points, online: p.online, hasBet: !!p.bet, ready: p.ready || !p.online, value: value(p.horse), horse: hv(p.horse) }))
});
const push = r => io.to(r.code).emit('state', pub(r));
function startRound(r) {
  r.round++; r.phase = 'market'; r.results = null; r.race = { distance: r.dists[r.round - 1], cond: pick(['firme', 'normal', 'normal', 'pesada']) };
  r.players.forEach(p => p.ready = false); push(r);
}
function finish(r) {
  r.phase = 'end';
  const w = [...r.players].sort((a, b) => b.points - a.points || b.coins - a.coins)[0];
  db.prepare('UPDATE usuario SET victorias=victorias+1 WHERE id=?').run(w.id);
}
function check(r) {
  const all = r.players.every(p => p.ready || !p.online);
  if (r.phase === 'market' && all) { simulate(r); r.phase = 'results'; r.players.forEach(p => p.ready = false); }
  else if (r.phase === 'results' && all) { if (r.round >= ROUNDS) finish(r); else return startRound(r); }
  push(r);
}

io.use((s, next) => { try { s.user = jwt.verify(s.handshake.auth.token, SECRET); next(); } catch { next(new Error('auth')); } });
io.on('connection', s => {
  const u = s.user; let room = null;
  const me = () => room && room.players.find(p => p.id === u.id);
  const np = () => ({ id: u.id, name: u.nombre, coins: START, points: 0, ready: false, online: true, horse: newHorse(u.nombre === 'Random07' && Math.random() < .5 ? 'Sakura Bakushin O' : null) });
  const enter = r => { room = r; s.join(r.code); me().online = true; push(r); };
  const on = (ev, fn) => s.on(ev, (a, cb) => { try { const e = fn(a); cb && cb(e ? { error: e } : {}); } catch (x) { console.error(x); cb && cb({ error: 'Error interno' }); } });
  const market = () => !room || room.phase !== 'market' ? 'Ahora no se puede' : me().ready ? 'Ya estás listo' : null;

  const existing = [...rooms.values()].find(r => r.players.some(p => p.id === u.id)); // reconexión
  if (existing) enter(existing);

  let lastMsg = 0; s.emit('chatlog', chatLog);
  s.on('chat', p => {
    let t = typeof p === 'string' ? p : p && p.t, img = p && p.img;
    t = String(t || '').trim().slice(0, 200);
    img = typeof img === 'string' && img.length < 300000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img) ? img : null;
    if ((!t && !img) || Date.now() - lastMsg < 800) return;
    lastMsg = Date.now();
    const m = { n: u.nombre, t, img }; chatLog.push(m); if (chatLog.length > 50) chatLog.shift();
    io.emit('chat', m);
  });
  on('heal', () => {
    const e = market(); if (e) return e;
    const p = me(), h = p.horse;
    if (!h.debuff && !h.outRounds) return 'Tu caballo no está lesionado';
    if (p.coins < VET) return 'Monedas insuficientes';
    p.coins -= VET; h.debuff = null; h.outRounds = 0; tx(room, p, 'veterinario', -VET); push(room);
  });
  on('bet', n => {
    const e = market(); if (e) return e;
    const p = me();
    if (p.bet) return 'Ya has apostado esta ronda';
    if (!room.players.some(x => x.name === n)) return 'Jugador inválido';
    if (p.coins < BET) return 'Monedas insuficientes';
    p.coins -= BET; p.bet = n; tx(room, p, 'apuesta', -BET); push(room);
  });
  on('create', () => {
    if (room) return 'Ya estás en una sala';
    let c; do c = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[R(0, 23)]).join(''); while (rooms.has(c));
    const r = { code: c, host: u.id, phase: 'lobby', round: 0, players: [np()], results: null, race: null, dists: mkDists() };
    rooms.set(c, r); enter(r);
  });
  on('join', c => {
    if (room) return 'Ya estás en una sala';
    const r = rooms.get(String(c || '').toUpperCase());
    if (!r) return 'Sala no encontrada';
    if (r.phase !== 'lobby') return 'La partida ya empezó';
    if (r.players.length >= 4) return 'Sala llena (máx. 4)';
    r.players.push(np()); enter(r);
  });
  on('start', () => {
    if (!room || room.host !== u.id || room.phase !== 'lobby') return 'No puedes empezar';
    if (room.players.length < 2) return 'Mínimo 2 jugadores';
    startRound(room);
  });
  on('upgrade', k => {
    const e = market(); if (e) return e;
    if (!STATS.includes(k)) return 'Estadística inválida';
    const p = me(), h = p.horse, c = upCost(h, k);
    if (h[k] >= CAP) return 'Ya está al máximo';
    if (p.coins < c) return 'Monedas insuficientes';
    p.coins -= c; h[k] = Math.min(CAP, h[k] + gain(h[k])); tx(room, p, 'mejora_' + k, -c); push(room);
  });
  on('replace', () => {
    const e = market(); if (e) return e;
    const p = me(), sell = sellPrice(p.horse);
    if (p.coins + sell < NEW_COST) return 'Monedas insuficientes';
    p.coins += sell - NEW_COST; tx(room, p, 'venta', sell); tx(room, p, 'compra', -NEW_COST);
    const old = p.horse; p.horse = newHorse(); p.horse.skills = [...new Set([...p.horse.skills, old.skills[0]])]; push(room); // hereda la habilidad propia del anterior
  });
  on('ready', () => {
    if (!room || !['market', 'results'].includes(room.phase)) return 'Ahora no se puede';
    me().ready = true; check(room);
  });
  on('leave', () => {
    if (!room) return;
    if (!['lobby', 'end'].includes(room.phase)) return 'No puedes salir en plena partida';
    const r = room; r.players = r.players.filter(p => p.id !== u.id); s.leave(r.code); room = null; s.emit('left');
    if (!r.players.length) rooms.delete(r.code); else { if (r.host === u.id) r.host = r.players[0].id; push(r); }
  });
  s.on('disconnect', () => {
    const p = me(); if (!p) return;
    p.online = false;
    if (room.players.every(p => !p.online)) return rooms.delete(room.code);
    check(room);
  });
});

server.listen(PORT, () => console.log('Liga de Carreras en http://localhost:' + PORT));
