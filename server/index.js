const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { Demos } = require('@kynesyslabs/demosdk/websdk');
const demos = new Demos();
const app = express();
const PORT = process.env.PORT || 8787;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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

// Blockchain API endpoints
let demosConnected = false;
let walletConnected = false;

// Connect to Demos network
async function connectToDemos() {
  if (demosConnected) return true;
  
  try {
    console.log('🔗 Connecting to Demos network...');
    await demos.connect('https://node2.demos.sh');
    demosConnected = true;
    console.log('✅ Connected to Demos network');
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Demos network:', error);
    return false;
  }
}

// Connect wallet for transactions (server wallet for coordination)
async function connectWallet() {
  if (walletConnected) return true;
  
  try {
    console.log('👛 Connecting server wallet for coordination...');
    
    // Generate a new mnemonic for server-side wallet
    const mnemonic = demos.newMnemonic();
    console.log('📝 Generated server mnemonic:', mnemonic);
    
    // Connect wallet using mnemonic
    await demos.connectWallet(mnemonic, { isSeed: true });
    walletConnected = true;
    
    // Get wallet address
    const address = demos.getAddress();
    console.log('✅ Server wallet connected. Address:', address);
    
    return true;
  } catch (error) {
    console.error('❌ Failed to connect server wallet:', error);
    return false;
  }
}

// Test blockchain connection (with server wallet for coordination)
app.post('/blockchain/test', async (req, res) => {
  try {
    console.log('🧪 Testing blockchain connection...');
    
    // Test 1: Connect to network
    const connected = await connectToDemos();
    if (!connected) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect to Demos network',
        stage: 'network_connection'
      });
    }
    
    // Test 2: Connect server wallet for coordination
    const walletOk = await connectWallet();
    if (!walletOk) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect server wallet',
        stage: 'wallet_connection'
      });
    }
    
    // Test 3: Try a minimal storage transaction
    let storageSuccess = false;
    let storageError = null;
    try {
      const testData = new Uint8Array([1, 2, 3, 4, 5]);
      const storageTx = await demos.store(testData);
      console.log('✅ Storage transaction prepared:', storageTx);
      storageSuccess = true;
    } catch (error) {
      console.error('❌ Storage transaction test failed:', error);
      storageError = String(error);
    }
    
    res.json({
      ok: true,
      network: connected,
      wallet: walletOk,
      storageTransaction: storageSuccess,
      storageError: storageError,
      message: 'Blockchain connection test completed - ready for player submissions'
    });
    
  } catch (error) {
    console.error('❌ Blockchain test failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: String(error),
      stage: 'general_test'
    });
  }
});

// Validate signed stats before blockchain submission
app.post('/blockchain/validate', async (req, res) => {
  try {
    const { stats, signature, playerAddress, nonce } = req.body;
    
    if (!stats || !signature || !playerAddress || !nonce) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: stats, signature, playerAddress, nonce' 
      });
    }
    
    console.log('🔍 Validating signed stats from:', playerAddress);
    
    // Connect to network if not already connected
    const connected = await connectToDemos();
    if (!connected) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect to Demos network' 
      });
    }
    
    // Create message to verify
    const message = JSON.stringify({
      game: 'Orbit Runner',
      version: '1.0.0',
      timestamp: stats.ts,
      playerAddress: playerAddress,
      stats: stats,
      nonce: nonce
    });
    
    // Verify the signature
    const isValid = await demos.verifyMessage(message, signature, playerAddress);
    
    if (!isValid) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid signature' 
      });
    }
    
    // Additional server-side validation
    const validationErrors = [];
    
    // Validate score ranges
    if (stats.points > 10_000_000) validationErrors.push('Points too high');
    if (stats.kills > stats.points / 100) validationErrors.push('Kill ratio inconsistent');
    
    // Validate time consistency
    const gameTime = stats.survivalSec;
    if (gameTime < 10 || gameTime > 3600) validationErrors.push('Game time unrealistic');
    
    // Validate achievement consistency
    if (stats.asteroids > 0 && stats.survivalSec < 30) validationErrors.push('Asteroid achievement too fast');
    
    if (validationErrors.length > 0) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Validation failed',
        validationErrors: validationErrors
      });
    }
    
    console.log('✅ Stats validation passed for:', playerAddress);
    
    res.json({
      ok: true,
      valid: true,
      message: 'Stats validated successfully',
      nonce: nonce
    });
    
  } catch (error) {
    console.error('❌ Stats validation failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: String(error)
    });
  }
});

// Submit game stats to blockchain (player pays via client signature)
app.post('/blockchain/submit', async (req, res) => {
  try {
    const { stats, signature, playerAddress, nonce, gameData, dataBytes } = req.body;
    
    if (!stats || !signature || !playerAddress || !nonce || !gameData) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Missing required fields: stats, signature, playerAddress, nonce, gameData' 
      });
    }
    
    console.log('📊 Preparing blockchain submission for:', playerAddress);
    
    // Connect to network if not already connected
    const connected = await connectToDemos();
    if (!connected) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect to Demos network' 
      });
    }
    
    // Connect server wallet for coordination
    const walletOk = await connectWallet();
    if (!walletOk) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect server wallet for coordination' 
      });
    }
    
    // Verify the signature again for security
    const message = JSON.stringify({
      game: 'Orbit Runner',
      version: '1.0.0',
      timestamp: stats.ts,
      playerAddress: playerAddress,
      stats: stats,
      nonce: nonce
    });
    
    const isValid = await demos.verifyMessage(message, signature, playerAddress);
    if (!isValid) {
      return res.status(400).json({ 
        ok: false, 
        error: 'Invalid signature' 
      });
    }
    
    console.log('✅ Signature verified, preparing data for blockchain...');
    
    // Convert data bytes back to Uint8Array for storage
    const dataUint8Array = new Uint8Array(dataBytes);
    
    // Store the validated stats and prepare transaction data
    const validatedStats = {
      playerAddress: playerAddress,
      gameData: gameData,
      dataBytes: dataUint8Array,
      signature: signature,
      nonce: nonce,
      timestamp: Date.now(),
      status: 'pending_player_submission'
    };
    
    console.log('✅ Stats validated and ready for player submission...');
    
    // Return the prepared transaction data for the player to sign and submit
    res.json({
      ok: true,
      readyForSubmission: true,
      message: 'Stats validated and ready for blockchain submission',
      transactionData: {
        data: Array.from(dataUint8Array), // Convert to regular array for JSON
        message: message,
        signature: signature,
        playerAddress: playerAddress,
        nonce: nonce
      },
      instructions: 'Player should now submit this data via their browser extension'
    });
    
  } catch (error) {
    console.error('❌ Blockchain submission preparation failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: String(error)
    });
  }
});

const server = app.listen(PORT, ()=> console.log(`Leaderboard API listening on :${PORT}`));

// Leaderboards WS on root path; Multiplayer WS on /mp
const lbWss = new WebSocketServer({ noServer: true });
const mpWss = new WebSocketServer({ noServer: true });

function lbBroadcast(msg){
  const data = JSON.stringify(msg);
  lbWss.clients.forEach(c=>{ try{ if (c.readyState === 1) c.send(data); }catch(_){} });
}

lbWss.on('connection', ws => {
  // send snapshot
  ws.send(JSON.stringify({ type:'leaderboards', payload: {
    points: top.points, kills: top.kills, asteroids: top.asteroids, belt: top.belt, survival: top.survival
  }}));
});

// --- Minimal single-room multiplayer (MVP) ---
const mpRoom = {
  id: 'default',
  worldSeed: Math.floor(Math.random()*1e9),
  players: new Map(), // id -> { id, numId, name, color, lastSeen, state, input, hp, shield, invulnUntil, history:[] }
  lastTick: Date.now(),
  nextNumericId: 1,
};

function makePlayerId(){ return randomUUID().slice(0, 8); }
function now(){ return Date.now(); }

mpWss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', ()=>{ ws.isAlive = true; });

  let playerId = null;

  function send(obj){ try{ ws.send(JSON.stringify(obj)); }catch(_){} }
  function broadcastToOthers(obj){
    const data = JSON.stringify(obj);
    mpWss.clients.forEach(c=>{ if (c!==ws && c.readyState===1) { try{ c.send(data); }catch(_){} } });
  }

  // Expect a hello first
  ws.on('message', (data)=>{
    let msg = null;
    try{ msg = JSON.parse(String(data)); }catch(_){ return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'hello' && !playerId){
      const name = String(msg.name||'').slice(0,24) || 'Anon';
      playerId = makePlayerId();
      ws.playerId = playerId;
      const color = 0x47e6ff; // same color for all players (per requirement)
      const spawn = pickSpawnPoint(mpRoom.worldSeed);
      const state = { t: now(), p: spawn.p, q: spawn.q, v: [0,0,0], sp: 20, fenix:false, yaw: 0, pitch: 0, roll: 0 };
      const input = { t: now(), throttle: 0.25, yaw: 0, pitch: 0, roll: 0, boost: false, fire: false };
      const numId = (mpRoom.nextNumericId = (mpRoom.nextNumericId % 65534) + 1);
      mpRoom.players.set(playerId, { id: playerId, numId, name, color, lastSeen: now(), state, input, hp:100, shield:0, invulnUntil:0, history:[], score:0 });

      // Send welcome with snapshot
      const snapshot = Array.from(mpRoom.players.values()).map(p=>({ id:p.id, numId:p.numId, name:p.name, color:p.color, state:p.state }));
      send({ type:'welcome', playerId, roomId: mpRoom.id, worldSeed: mpRoom.worldSeed, worldVersion:'v1', worldChecksum: worldChecksum(mpRoom.worldSeed), players: snapshot });

      // Notify others
      broadcastToOthers({ type:'player-add', id: playerId, numId, name, color, state });
      // Send room stats to this client and broadcast to others
      send(roomStatsPayload());
      broadcastRoomStats();
      return;
    }

    if (!playerId) return; // ignore anything until hello completes

    // Basic per-socket rate limit for spammy messages
    const nowMs = now();
    ws._rl = ws._rl || { last:0, count:0 };
    if (nowMs - ws._rl.last > 1000){ ws._rl.last = nowMs; ws._rl.count = 0; }
    ws._rl.count++;
    if (ws._rl.count > 30) return; // drop if >30 msgs/sec

    if (msg.type === 'input'){
      const rec = mpRoom.players.get(playerId);
      if (rec){
        rec.input = sanitizeInput(msg, nowMs);
        rec.lastSeen = nowMs;
      }
      return;
    }

    if (msg.type === 'score'){
      const rec = mpRoom.players.get(playerId);
      if (rec){
        const v = clampNum(msg.v, 0, 1_000_000_000);
        rec.score = v;
        broadcastRoomStats();
      }
      return;
    }

    if (msg.type === 'shoot'){
      const p = toVec3(msg.p); const dir = toVec3(msg.dir);
      const fenix = !!msg.fenix;
      const shotT = clampNum(msg.t, nowMs-500, nowMs+100);
      // Visuals for others
      broadcastToOthers({ type:'shoot', id: playerId, t: shotT, p, dir, fenix });
      // Authoritative hitscan against players
      processHitscan(playerId, p, dir, shotT, fenix);
      return;
    }

    if (msg.type === 'ping'){
      send({ type:'pong', tServer: nowMs, tClient: msg.t||nowMs });
      return;
    }
  });

  ws.on('close', ()=>{
    if (!playerId) return;
    mpRoom.players.delete(playerId);
    const data = JSON.stringify({ type:'player-remove', id: playerId });
    mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(data); }catch(_){} } });
    broadcastRoomStats();
  });
});

// Shared helpers
function toNum(n, def=0){ n=Number(n); return Number.isFinite(n)?n:def; }
function clampNum(n, min, max){ n=toNum(n); if (n<min) return min; if (n>max) return max; return n; }
function toVec3(a){ if (!Array.isArray(a) || a.length!==3) return [0,0,0]; return [toNum(a[0]), toNum(a[1]), toNum(a[2])]; }
function toQuat(a){ if (!Array.isArray(a) || a.length!==4) return [0,0,0,1]; return [toNum(a[0]), toNum(a[1]), toNum(a[2]), toNum(a[3])]; }

function sanitizeInput(msg, nowMs){
  return {
    t: Number(msg.t)||nowMs,
    throttle: clampNum(msg.throttle, 0, 1),
    yaw: clampNum(msg.yaw, -1, 1),
    pitch: clampNum(msg.pitch, -1, 1),
    roll: clampNum(msg.roll, -1, 1),
    boost: !!msg.boost,
    fire: !!msg.fire,
    fenix: !!msg.fenix,
  };
}

// Kinematic integration (minimal flight model)
const TICK_HZ = 30;
const TICK_MS = Math.floor(1000 / TICK_HZ);
const MIN_SPEED = 5;
const MAX_SPEED_BASE = 60;
const FENIX_MULT = 1.05;
const BOOST_MULT = 3.08;
const YAW_RATE = 2.0;     // rad/sec
const PITCH_RATE = 1.35;  // rad/sec
const SPEED_ACCEL = 22;   // units/sec^2

function eulerToQuatYXZ(pitch, yaw, roll){
  const cy = Math.cos(yaw*0.5), sy = Math.sin(yaw*0.5);
  const cx = Math.cos(pitch*0.5), sx = Math.sin(pitch*0.5);
  const cz = Math.cos(roll*0.5), sz = Math.sin(roll*0.5);
  // q = qY * qX * qZ
  const w = cy*cx*cz + sy*sx*sz;
  const x = cy*sx*cz + sy*cx*sz;
  const y = sy*cx*cz - cy*sx*sz;
  const z = cy*cx*sz - sy*sx*cz;
  return [x,y,z,w];
}

function forwardFromYawPitch(yaw, pitch){
  const cp = Math.cos(pitch);
  return [Math.sin(yaw)*cp, Math.sin(pitch), Math.cos(yaw)*cp];
}

function integratePlayers(dt){
  for (const [id, rec] of mpRoom.players){
    const i = rec.input; const s = rec.state;
    // Turn
    s.yaw += (i?.yaw||0) * YAW_RATE * dt;
    s.pitch += (i?.pitch||0) * PITCH_RATE * dt;
    // Clamp pitch to avoid flips
    const HALF_PI = Math.PI/2 - 0.05;
    if (s.pitch > HALF_PI) s.pitch = HALF_PI; if (s.pitch < -HALF_PI) s.pitch = -HALF_PI;
    // Target speed from throttle with boost/fenix multipliers to match client
    let effectiveMax = MAX_SPEED_BASE;
    if (i?.fenix) effectiveMax *= FENIX_MULT;
    if (i?.boost) effectiveMax *= BOOST_MULT;
    const targetSp = MIN_SPEED + clampNum(i?.throttle ?? 0.25, 0, 1) * (effectiveMax - MIN_SPEED);
    if (s.sp < targetSp){ s.sp = Math.min(targetSp, s.sp + SPEED_ACCEL*dt); }
    else if (s.sp > targetSp){ s.sp = Math.max(targetSp, s.sp - SPEED_ACCEL*dt); }
    // Move
    const fwd = forwardFromYawPitch(s.yaw, s.pitch);
    s.p = [ s.p[0] + fwd[0]*s.sp*dt, s.p[1] + fwd[1]*s.sp*dt, s.p[2] + fwd[2]*s.sp*dt ];
    s.v = [ fwd[0]*s.sp, fwd[1]*s.sp, fwd[2]*s.sp ];
    s.q = eulerToQuatYXZ(s.pitch, s.yaw, s.roll||0);
    s.t = now();
  }
}

// Simple PvP collision detection and damage
const SHIP_RADIUS = 1.8;
function distanceSq(a,b){ const dx=a[0]-b[0], dy=a[1]-b[1], dz=a[2]-b[2]; return dx*dx+dy*dy+dz*dz; }
function length(v){ return Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); }
function applyDamage(rec, dmg){
  if (!rec) return;
  const nowMs = Date.now();
  if (nowMs < (rec.invulnUntil||0)) return;
  let remaining = dmg;
  if (rec.shield>0){ const absorbed = Math.min(rec.shield, remaining); rec.shield -= absorbed; remaining -= absorbed; }
  if (remaining>0){ rec.hp -= remaining; }
  if (rec.hp <= 0){ handleDeath(rec); }
}
function handleDeath(rec){
  rec.hp = 0; rec.invulnUntil = Date.now() + 1300; // i-frames after respawn
  // Broadcast death then respawn
  const spawn = pickSpawnPoint(mpRoom.worldSeed);
  rec.state.p = spawn.p.slice();
  rec.state.q = spawn.q.slice();
  rec.state.v = [0,0,0];
  rec.state.sp = 20;
  rec.hp = 100; rec.shield = 0;
  const data = JSON.stringify({ type:'respawn', id: rec.id, p: rec.state.p, q: rec.state.q });
  mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(data); }catch(_){} } });
}

function processHitscan(shooterId, origin, dir, shotT, fenix){
  const maxRange = fenix ? 380 : 300; // meters
  const shooter = mpRoom.players.get(shooterId);
  if (!shooter) return;
  // Test players only for MVP
  let closest = null; let closestDist = Infinity;
  for (const [id, rec] of mpRoom.players){
    if (id === shooterId) continue;
    // Rewind approximation: assume constant velocity; project to shotT
    const dt = (shotT - rec.state.t)/1000;
    const px = rec.state.p[0] + rec.state.v[0]*dt;
    const py = rec.state.p[1] + rec.state.v[1]*dt;
    const pz = rec.state.p[2] + rec.state.v[2]*dt;
    // Closest approach from ray to sphere center
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const dx = dir[0], dy = dir[1], dz = dir[2];
    const cx = px-ox, cy = py-oy, cz = pz-oz;
    const t = Math.max(0, Math.min(maxRange, (cx*dx+cy*dy+cz*dz)));
    const qx = ox + dx*t, qy = oy + dy*t, qz = oz + dz*t;
    const d2 = (qx-px)*(qx-px)+(qy-py)*(qy-py)+(qz-pz)*(qz-pz);
    if (d2 <= (SHIP_RADIUS*SHIP_RADIUS)){
      if (t < closestDist){ closestDist = t; closest = rec; }
    }
  }
  if (closest){
    const dmg = fenix ? 35 : 20;
    applyDamage(closest, dmg);
    const hitMsg = JSON.stringify({ type:'hit', target:'player', id: closest.id, by: shooterId, dmg });
    mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(hitMsg); }catch(_){} } });
  }
}

// Binary broadcaster for state
function buildStateBuffer(){ return buildStateBufferFor(null, Infinity, null); }

function buildStateBufferFor(center, radius, excludePlayerId){
  const BYTES_PER = 2 + 4 + 12 + 16 + 12 + 1; // id,u32,p(3*f32),q(4*f32),v(3*f32),flags
  // Count first
  let count = 0;
  for (const [id, rec] of mpRoom.players){
    if (excludePlayerId && id===excludePlayerId) { count++; continue; } // include self for reconciliation
    if (center){ const d2 = distanceSq(rec.state.p, center); if (d2 > radius*radius) continue; }
    count++;
  }
  const buf = Buffer.allocUnsafe(count * BYTES_PER);
  let off = 0;
  for (const [id, rec] of mpRoom.players){
    if (excludePlayerId && id===excludePlayerId){ /* still include self */ }
    if (center){ const d2 = distanceSq(rec.state.p, center); if (d2 > radius*radius) continue; }
    const s = rec.state; const flags = (s.fenix?1:0);
    buf.writeUInt16BE(rec.numId&0xffff, off); off+=2;
    buf.writeUInt32BE(Math.floor(s.t)>>>0, off); off+=4;
    off = writeF32Array(buf, off, s.p);
    off = writeF32Array(buf, off, s.q);
    off = writeF32Array(buf, off, s.v);
    buf.writeUInt8(flags, off); off+=1;
  }
  return buf;
}

function writeF32Array(buf, off, arr){
  for (let k=0;k<arr.length;k++){ buf.writeFloatBE(arr[k], off); off+=4; }
  return off;
}

function broadcastRoomStats(){
  const msg = JSON.stringify(roomStatsPayload());
  mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(msg); }catch(_){} } });
}

function roomStatsPayload(){
  const players = Array.from(mpRoom.players.values()).map(p=>({ id:p.id, name:p.name, score: p.score>>>0 }));
  return { type:'room-stats', players };
}

setInterval(()=>{
  const nowMs = Date.now();
  const dt = Math.min(0.1, (nowMs - mpRoom.lastTick)/1000);
  mpRoom.lastTick = nowMs;
  integratePlayers(dt);
  // PvP collision check (pairwise naive for MVP)
  const players = Array.from(mpRoom.players.values());
  for (let i=0;i<players.length;i++){
    for (let j=i+1;j<players.length;j++){
      const a = players[i], b = players[j];
      const d2 = distanceSq(a.state.p, b.state.p);
      const rad = SHIP_RADIUS*2;
      if (d2 <= rad*rad){
        // Damage proportional to relative speed
        const rel = [a.state.v[0]-b.state.v[0], a.state.v[1]-b.state.v[1], a.state.v[2]-b.state.v[2]];
        const relSpeed = length(rel);
        const dmg = Math.max(10, Math.min(120, relSpeed * 0.8));
        applyDamage(a, dmg*0.5);
        applyDamage(b, dmg*0.5);
        const hitMsg = JSON.stringify({ type:'hit', target:'player', id: a.id, by: b.id, dmg: Math.round(dmg*0.5) });
        const hitMsg2 = JSON.stringify({ type:'hit', target:'player', id: b.id, by: a.id, dmg: Math.round(dmg*0.5) });
        mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(hitMsg); c.send(hitMsg2); }catch(_){} } });
      }
    }
  }
  // Interest-filtered binary broadcast per client
  const INTEREST_RADIUS = Infinity; // include all players for now so everyone sees everyone
  mpWss.clients.forEach(c=>{
    if (c.readyState!==1) return;
    const pid = c.playerId; const rec = pid? mpRoom.players.get(pid): null;
    const center = rec? rec.state.p : null;
    const payload = buildStateBufferFor(center, INTEREST_RADIUS, pid);
    try{ c.send(payload, { binary: true }); }catch(_){}
  });
}, TICK_MS);

// Deterministic spawn picker around the target belt region (approx.)
function mulberry32(seed){ return function(){ let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function pickSpawnPoint(worldSeed){
  // Spawn far from the blue planet: require ~30s at 60 speed to reach belt
  // Belt center ~z=-20000; pick a position near origin plane at ~12000 away from belt edge
  const rand = mulberry32((worldSeed>>>0) ^ (Date.now()>>>0));
  const angle = rand()*Math.PI*2;
  const baseToBelt = 20000 - 5200; // ~14800 from origin to belt inner edge along z
  const extra = 3000 + rand()*3000; // push farther back to ensure ~30s travel at 60
  const radius = Math.max(4000, baseToBelt + extra); // ~17800-20800
  const y = (rand()-0.5)*200; // more vertical jitter
  const x = Math.cos(angle)*radius;
  const z = Math.sin(angle)*radius;
  const q = [0,0,0,1];
  return { p:[x,y,z], q };
}

// Simple checksum over seed for client verification
function worldChecksum(seed){
  let x = seed>>>0; x ^= x<<13; x ^= x>>>17; x ^= x<<5; x = x>>>0;
  return ('00000000'+x.toString(16)).slice(-8);
}

// Periodic liveness check and stale player cleanup
setInterval(()=>{
  lbWss.clients.forEach(ws=>{ if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try{ ws.ping(); }catch(_){} });
  mpWss.clients.forEach(ws=>{ if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; try{ ws.ping(); }catch(_){} });
  // prune idle players
  const cutoff = Date.now() - 15000;
  for (const [id, p] of mpRoom.players){ if (p.lastSeen < cutoff){ mpRoom.players.delete(id); const data = JSON.stringify({ type:'player-remove', id }); mpWss.clients.forEach(c=>{ if (c.readyState===1){ try{ c.send(data); }catch(_){} } }); } }
}, 10000);

// Route upgrades by path
server.on('upgrade', (req, socket, head) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/mp'){
      mpWss.handleUpgrade(req, socket, head, function done(ws){ mpWss.emit('connection', ws, req); });
    } else {
      lbWss.handleUpgrade(req, socket, head, function done(ws){ lbWss.emit('connection', ws, req); });
    }
  } catch (e){ socket.destroy(); }
});
