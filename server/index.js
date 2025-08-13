const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json());

// In-memory store (persisted to disk)
const DATA_PATH = path.join(__dirname, 'leaderboards.json');
const top = { points: [], kills: [], asteroids: [], belt: [], survival: [], sessions: [] };
try {
  if (fs.existsSync(DATA_PATH)){
    const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    Object.assign(top, raw||{});
  }
} catch (e) { console.warn('Failed to load persisted leaderboards:', e.message); }
let saveTimer = null;
function persist(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try { fs.writeFileSync(DATA_PATH, JSON.stringify(top, null, 2)); }
    catch(e){ console.warn('Persist failed:', e.message); }
  }, 250);
}
// simple rate-limit per IP
const lastSubmitByIp = new Map();
function pushTop(list, rec, key, maxLen=10){
  list.push(rec);
  list.sort((a,b)=> (b[key]||0)-(a[key]||0));
  if (list.length>maxLen) list.length=maxLen;
  return list;
}

app.get('/health', (_req, res)=> res.json({ ok:true }));
app.get('/leaderboards', (_req, res)=> res.json({
  points: top.points, kills: top.kills, asteroids: top.asteroids, belt: top.belt, survival: top.survival
}));

app.post('/submit', (req, res)=>{
  const s = req.body||{};
  try {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const now = Date.now();
    const last = lastSubmitByIp.get(ip) || 0;
    if (now - last < 1500) return res.status(429).json({ ok:false, error:'rate-limited' });
    lastSubmitByIp.set(ip, now);
    s.ts = Date.now();
    // Basic anti-tamper: clamp fields and require uid
    s.uid = String(s.uid||'').slice(0,64);
    s.name = String(s.name||'').slice(0,24) || 'Anon';
    s.points = Math.max(0, Math.min(10_000_000, Number(s.points||0))); // 10M cap
    s.kills = Math.max(0, Math.min(1_000_000, Number(s.kills||0)));
    s.asteroids = Math.max(0, Math.min(5_000_000, Number(s.asteroids||0)));
    s.beltTimeSec = Math.max(0, Math.min(1_000_000, Number(s.beltTimeSec||0)));
    s.survivalSec = Math.max(0, Math.min(1_000_000, Number(s.survivalSec||0)));
    if (!s.uid) return res.status(400).json({ ok:false, error:'missing uid' });

    pushTop(top.sessions, s, 'ts', 100);
    pushTop(top.points, s, 'points');
    pushTop(top.kills, s, 'kills');
    pushTop(top.asteroids, s, 'asteroids');
    pushTop(top.belt, s, 'beltTimeSec');
    pushTop(top.survival, s, 'survivalSec');
    persist();
    broadcast({ type:'leaderboards', payload: {
      points: top.points, kills: top.kills, asteroids: top.asteroids, belt: top.belt, survival: top.survival
    }});
    res.json({ ok:true });
  } catch (e){ res.status(400).json({ ok:false, error:String(e) }); }
});

const server = app.listen(PORT, ()=> console.log(`Leaderboard API listening on :${PORT}`));

// WebSocket broadcast of updates
const wss = new WebSocketServer({ server });
function broadcast(msg){
  const data = JSON.stringify(msg);
  wss.clients.forEach(c=>{ try{ if (c.readyState === 1) c.send(data); }catch(_){} });
}
wss.on('connection', ws => {
  // send snapshot
  ws.send(JSON.stringify({ type:'leaderboards', payload: {
    points: top.points, kills: top.kills, asteroids: top.asteroids, belt: top.belt, survival: top.survival
  }}));
});
