const express = require('express');
const cors = require('cors');
const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json());

// In-memory store (replace with a DB later)
const top = { points: [], kills: [], asteroids: [], belt: [], survival: [], sessions: [] };
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
    s.ts = Date.now();
    pushTop(top.sessions, s, 'ts', 100);
    pushTop(top.points, s, 'points');
    pushTop(top.kills, s, 'kills');
    pushTop(top.asteroids, s, 'asteroids');
    pushTop(top.belt, s, 'beltTimeSec');
    pushTop(top.survival, s, 'survivalSec');
    res.json({ ok:true });
  } catch (e){ res.status(400).json({ ok:false, error:String(e) }); }
});

app.listen(PORT, ()=> console.log(`Leaderboard API listening on :${PORT}`));
