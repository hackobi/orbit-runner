// Orbit‑Runner: Open‑World Space Flight
// Excitement + Damage/Shield pass + Massive Asteroid Fields with Dense Patches + Green Shield Orbs
import { FontLoader } from 'https://unpkg.com/three@0.164.0/examples/jsm/loaders/FontLoader.js';
import { TextGeometry } from 'https://unpkg.com/three@0.164.0/examples/jsm/geometries/TextGeometry.js';
(() => {
  const canvas = document.getElementById('gameCanvas');
  // Welcome DOM
  const welcomeScreen = document.getElementById('welcome-screen');
  const launchBtn = document.getElementById('launch-btn');
  
  // Wallet DOM elements
  const extensionStatus = document.getElementById('extension-status');
  const extensionIndicator = document.getElementById('extension-indicator');
  const extensionStatusText = document.getElementById('extension-status-text');
  const connectExtensionBtn = document.getElementById('connect-extension-btn');
  const extensionWarning = document.getElementById('extension-warning');
  const connectedWallet = document.getElementById('connected-wallet');
  const connectedAddress = document.getElementById('connected-address');
  const connectedBalance = document.getElementById('connected-balance');
  const disconnectBtn = document.getElementById('disconnect-btn');
  
  let walletAddress = '';
  let currentProvider = null;
  let providersDetected = false;
  let connecting = false;
  let detectionRetryTimer = null;
  let detectionInProgress = false;
  let lastStatus = 'init'; // 'checking' | 'available' | 'unavailable'
  let gameInitialized = false;
  if (!canvas) { console.error('Canvas not found'); return; }
  canvas.tabIndex = 0; canvas.style.outline = 'none'; canvas.focus();

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.45;
  renderer.setClearColor(0x030a1a, 1);

  const scene = new THREE.Scene();

  // --- Debug logger (ring buffer) ---
  const DBG = { on: true, buf: [] };
  function vecToArr(v){ return v ? [Number(v.x?.toFixed?.(1) ?? v[0] ?? 0), Number(v.y?.toFixed?.(1) ?? v[1] ?? 0), Number(v.z?.toFixed?.(1) ?? v[2] ?? 0)] : [0,0,0]; }
  function dbg(tag, data){ const rec = Object.assign({ t: new Date().toISOString(), tag }, data||{}); DBG.buf.push(rec); if (DBG.buf.length>400) DBG.buf.shift(); try{ console.log('[OR]', tag, rec); }catch(_){} }
  window.orDbg = { dump: () => { try{ const s = JSON.stringify(DBG.buf, null, 2); console.log(s); return s; }catch(e){ return '[]'; } }, clear: ()=>{ DBG.buf.length=0; }, buf: DBG.buf };

  const baseFov = 70;
  const camera = new THREE.PerspectiveCamera(baseFov, window.innerWidth / window.innerHeight, 0.1, 100000);
  const starLight = new THREE.PointLight(0x88bbff, 1.0, 800);
  camera.add(starLight);
  scene.add(camera);

  const ambient = new THREE.AmbientLight(0x708090, 0.6);
  scene.add(ambient);
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(1, 1.5, 0.8).multiplyScalar(1000);
  scene.add(sun);

  // Projectile tuning (used for reach calculations)
  const DEFAULT_BULLET_SPEED = 230;
  const DEFAULT_BULLET_LIFE = 3.0; // seconds
  const FENIX_BEAM_SPEED = 300;
  const FENIX_BEAM_LIFE = (DEFAULT_BULLET_SPEED * DEFAULT_BULLET_LIFE * 1.12) / FENIX_BEAM_SPEED; // 12% longer reach vs default
  const MIN_WORMHOLE_TELEPORT_DIST = 12000; // meters (12 km)

  // Global caps to prevent overload
  const CAPS = {
    shield: 160,
    pink: 120,
    fenix: 120,
    zaphire: 120,
    wormhole: 120,
    boost: 120,
    miner: 300,   // green: x2 asteroid points
    hunter: 300,  // blue: x2 kill points
  };
  const ONLY_RING_ORBS = true; // place all orbs in the belt only
  const USE_SPATIAL_HASH = true; // optimize bullet vs asteroid checks

  // Early declaration so ring seeding can reference it
  const boostOrbs = [];
  const minerOrbs = [];   // green multiplier (asteroid x2)
  const hunterOrbs = [];  // blue multiplier (kill x2)
  // Early declaration so animate() can reference bots safely
  const bots = [];

  // HUD and overlays
  const hud = document.getElementById('hud') || (() => { const d = document.createElement('div'); d.id='hud'; d.style.position='absolute'; d.style.top='10px'; d.style.left='10px'; d.style.color='#0ff'; d.style.fontSize='1.1rem'; d.style.display='none'; document.body.appendChild(d); return d; })();
  const help = document.getElementById('help') || (() => { const d = document.createElement('div'); d.id='help'; d.style.position='absolute'; d.style.bottom='12px'; d.style.left='50%'; d.style.transform='translateX(-50%)'; d.style.fontSize='0.95rem'; d.style.color='#ccc'; d.style.opacity='0.85'; d.style.background='rgba(0,0,0,0.35)'; d.style.padding='6px 10px'; d.style.borderRadius='6px'; d.style.display='none'; d.textContent='W/↑ speed • S/↓ slow • A/D or ←/→ yaw • I/K pitch • Space shoot • H target • N name • T dev 500 • R restart'; document.body.appendChild(d); return d; })();

  // Reconnect overlay (shown on tab refocus)
  let reconnectOverlay = null; let reconnectBtn = null; let reconnectMsg = null; let reconnectTimer = null; let controlsUnlockAt = 0;
  function ensureReconnectOverlay(){
    if (reconnectOverlay) return reconnectOverlay;
    const ov = document.createElement('div');
    ov.id = 'reconnectOverlay';
    Object.assign(ov.style, { position:'absolute', top:'0', left:'0', width:'100%', height:'100%', display:'none', alignItems:'center', justifyContent:'center', backdropFilter:'blur(2px)', background:'rgba(0,0,0,0.45)', zIndex: 9998 });
    const card = document.createElement('div');
    Object.assign(card.style, { padding:'18px 22px', borderRadius:'10px', background:'rgba(10,20,30,0.8)', border:'1px solid rgba(71,230,255,0.3)', color:'#cfefff', textAlign:'center', minWidth:'260px', boxShadow:'0 0 24px rgba(71,230,255,0.2)' });
    const title = document.createElement('div'); title.textContent = 'Paused - Tab changed'; Object.assign(title.style, { fontSize:'18px', marginBottom:'8px', color:'#9feaff' });
    reconnectMsg = document.createElement('div'); reconnectMsg.textContent = 'Click Reconnect to continue'; Object.assign(reconnectMsg.style, { fontSize:'13px', opacity:'0.8', marginBottom:'12px' });
    reconnectBtn = document.createElement('button'); reconnectBtn.textContent = 'Reconnect'; Object.assign(reconnectBtn.style, { padding:'10px 16px', fontSize:'14px', fontWeight:'600', border:'none', borderRadius:'6px', background:'linear-gradient(45deg, #47e6ff, #66ff99)', color:'#001018', cursor:'pointer' });
    card.appendChild(title); card.appendChild(reconnectMsg); card.appendChild(reconnectBtn); ov.appendChild(card); document.body.appendChild(ov);
    reconnectOverlay = ov; return ov;
  }
  function showReconnectOverlay(){ ensureReconnectOverlay(); reconnectOverlay.style.display = 'flex'; }
  function hideReconnectOverlay(){ if (reconnectOverlay) reconnectOverlay.style.display = 'none'; }
  function isControlsLocked(){ return Date.now() < controlsUnlockAt; }

  // End-of-round overlay (Restart or Free Flight)
  let endOverlay = null; let endMsg = null; let endRestartBtn = null; let endFreeBtn = null; let endDemosBtn = null; let endShown = false;
  function ensureEndOverlay(){
    if (endOverlay) return endOverlay;
    const ov = document.createElement('div');
    ov.id = 'endOverlay';
    Object.assign(ov.style, { position:'absolute', top:'0', left:'0', width:'100%', height:'100%', display:'none', alignItems:'center', justifyContent:'center', backdropFilter:'blur(2px)', background:'rgba(0,0,0,0.55)', zIndex: 9998 });
    const card = document.createElement('div');
    Object.assign(card.style, { padding:'20px 24px', borderRadius:'12px', background:'rgba(10,20,30,0.85)', border:'1px solid rgba(71,230,255,0.3)', color:'#cfefff', textAlign:'center', minWidth:'280px', boxShadow:'0 0 30px rgba(71,230,255,0.25)' });
    const title = document.createElement('div'); title.textContent = 'Round Over'; Object.assign(title.style, { fontSize:'20px', marginBottom:'8px', color:'#9feaff' });
    endMsg = document.createElement('div'); endMsg.textContent = 'Choose an option'; Object.assign(endMsg.style, { fontSize:'13px', opacity:'0.85', marginBottom:'14px' });
    const btnRow = document.createElement('div'); Object.assign(btnRow.style, { display:'flex', gap:'10px', justifyContent:'center', flexWrap:'wrap' });
    endRestartBtn = document.createElement('button'); endRestartBtn.textContent = 'Restart (3 min)'; Object.assign(endRestartBtn.style, { padding:'10px 14px', fontSize:'14px', fontWeight:'600', border:'none', borderRadius:'6px', background:'linear-gradient(45deg, #47e6ff, #66ff99)', color:'#001018', cursor:'pointer' });
    endFreeBtn = document.createElement('button'); endFreeBtn.textContent = 'Free Flight'; Object.assign(endFreeBtn.style, { padding:'10px 14px', fontSize:'14px', fontWeight:'600', border:'1px solid rgba(255,255,255,0.25)', borderRadius:'6px', background:'rgba(0,0,0,0.3)', color:'#e8f8ff', cursor:'pointer' });
    endDemosBtn = document.createElement('button'); endDemosBtn.textContent = 'Submit to Demos'; Object.assign(endDemosBtn.style, { padding:'10px 14px', fontSize:'14px', fontWeight:'600', border:'1px solid rgba(255,255,255,0.25)', borderRadius:'6px', background:'rgba(0,0,0,0.3)', color:'#e8f8ff', cursor:'pointer' });
    btnRow.appendChild(endRestartBtn); btnRow.appendChild(endFreeBtn); btnRow.appendChild(endDemosBtn);
    card.appendChild(title); card.appendChild(endMsg); card.appendChild(btnRow); ov.appendChild(card); document.body.appendChild(ov);
    endOverlay = ov; return ov;
  }
  function showEndOverlay(){ ensureEndOverlay(); endOverlay.style.display = 'flex'; endShown = true; }
  function hideEndOverlay(){ if (endOverlay) endOverlay.style.display = 'none'; endShown = false; }
  // Wallet functions
  function updateLaunchButton(){
    const isValid = walletAddress.length > 0;
    if (launchBtn){
      launchBtn.disabled = !isValid;
      if (isValid) launchBtn.classList.add('enabled'); else launchBtn.classList.remove('enabled');
    }
  }

  function updateConnectedWallet(address, balance = 1000) {
    if (connectedAddress) {
      connectedAddress.textContent = address ? `${address.slice(0, 6)}...${address.slice(-4)}` : 'Not connected';
    }
    if (connectedBalance) {
      connectedBalance.textContent = `Balance: ${balance} DEMOS`;
    }
    if (connectedWallet) {
      connectedWallet.style.display = address ? 'flex' : 'none';
    }
    if (extensionStatus) {
      extensionStatus.style.display = address ? 'none' : 'flex';
    }
  }

  function showExtensionNotDetected() {
    if (extensionIndicator) {
      extensionIndicator.className = 'status-indicator unavailable';
    }
    if (extensionStatusText) {
      extensionStatusText.textContent = 'Demos extension not found';
    }
    if (connectExtensionBtn) {
      connectExtensionBtn.disabled = true;
      connectExtensionBtn.classList.remove('enabled');
    }
    if (extensionWarning) {
      extensionWarning.style.display = 'block';
    }
  }

  // Detect and connect to Demos extension
  function setStatus(state){
    if (state === lastStatus) return;
    lastStatus = state;
    if (!extensionIndicator || !extensionStatusText) return;
    if (state === 'checking'){
      extensionIndicator.className = 'status-indicator checking';
      extensionStatusText.textContent = 'Checking for Demos extension...';
    } else if (state === 'available'){
      extensionIndicator.className = 'status-indicator available';
      extensionStatusText.textContent = 'Demos extension detected';
    } else if (state === 'unavailable'){
      extensionIndicator.className = 'status-indicator unavailable';
      extensionStatusText.textContent = 'Demos extension not found';
    }
  }

  async function detectAndConnectExtension() {
    if (detectionInProgress) return;
    detectionInProgress = true;
    console.log('🔍 Detecting Demos extension...');
    
    if (extensionStatus) {
      extensionIndicator.className = 'status-indicator checking';
    }
    if (extensionStatusText) {
      extensionStatusText.textContent = 'Checking for Demos extension...';
    }
    
    try {
      // Check if Demos extension detector is available
      if (typeof window.detectDemosExtension === 'function') {
        const providers = await window.detectDemosExtension();
        console.log('📋 Detection results:', providers);
        // Filter to request-capable providers and exclude self artifacts
        const normalized = (providers||[])
          .map(p=>({ info: p?.info||{ name:'Demos Provider' }, provider: p?.provider||p }))
          .filter(p=> p && p.provider && typeof p.provider.request === 'function' && String(p.info?.name||'').indexOf('demosProviders')===-1);
        // Also consider direct globals
        if (window.demos && typeof window.demos.request === 'function') normalized.unshift({ info:{ name:'Demos Extension' }, provider: window.demos });
        if (window.ethereum && typeof window.ethereum.request === 'function' && (window.ethereum.isDemos||window.ethereum.isDemosWallet||(window.ethereum.providers?.some?.(pp=>pp.isDemos)))) normalized.unshift({ info:{ name:'Demos Extension (Ethereum)' }, provider: window.ethereum });

        if (normalized.length > 0) {
          console.log('✅ Request-capable Demos providers:', normalized.length);
          // Detection only; enable connect (no auto-connect to avoid popup loops)
          setStatus('available');
          if (connectExtensionBtn) { connectExtensionBtn.disabled = false; connectExtensionBtn.classList.add('enabled'); connectExtensionBtn.textContent = 'Connect Demos Extension'; }
          if (extensionWarning) extensionWarning.style.display = 'none';
          // Store filtered providers
          window.demosProviders = normalized; providersDetected = true;
          console.log('✅ Providers stored:', window.demosProviders);
        } else {
          console.log('⚠️ No Demos extension providers found');
          setStatus('unavailable');
          showExtensionNotDetected();
        }
      } else {
        console.log('⚠️ Demos extension detector not loaded');
        showExtensionNotDetected();
      }
    } catch (error) {
      console.error('❌ Extension detection failed:', error);
      setStatus('unavailable');
      showExtensionNotDetected();
    }
    detectionInProgress = false;
  }

  // Retry detection a few times to catch post-login injection
  function scheduleDetectionRetry(tries=5){
    if (tries <= 0 || providersDetected) return;
    clearTimeout(detectionRetryTimer);
    detectionRetryTimer = setTimeout(async ()=>{
      try{
        await detectAndConnectExtension();
      }finally{
        if (!providersDetected){
          scheduleDetectionRetry(tries-1);
        }
      }
    }, 1000);
  }

  // Resolve a request-capable provider from various shapes
  function resolveRequestProvider(detail){
    if (!detail) return null;
    // event-based detail may be { info, provider }, or just the provider
    let cand = detail.provider || detail;
    if (Array.isArray(cand) && cand.length>0) cand = cand[0];
    // If provider is a function, wrap it to a request-capable interface using {type,params}
    if (typeof cand === 'function'){
      return {
        request: (arg1, arg2)=>{
          if (typeof arg1 === 'string'){ return cand({ type: arg1, params: arg2||[] }); }
          const o = arg1 || {}; return cand({ type: o.method, params: o.params||[] });
        }
      };
    }
    if (cand && typeof cand.request === 'function') return cand;
    if (window.demos && typeof window.demos.request === 'function') return window.demos;
    if (window.ethereum && (window.ethereum.isDemos || window.ethereum.isDemosWallet || (window.ethereum.providers?.some?.(p=>p.isDemos))) && typeof window.ethereum.request === 'function') return window.ethereum;
    if (window.injectproviderv3 && typeof window.injectproviderv3.request === 'function') return window.injectproviderv3;
    return null;
  }

  async function tryRequest(prov, method, params){
    // Special handling for injectproviderv3 which expects { type, params }
    if (prov === window.injectproviderv3){
      try { return await prov.request({ type: method, params: params||[] }); } catch(_){ }
      // Common aliases
      if (method === 'eth_requestAccounts' || method === 'demos_requestAccounts'){
        try { return await prov.request({ type: 'connect', params: [] }); } catch(_){ }
        try { return await prov.request({ type: 'accounts', params: [] }); } catch(_){ }
      }
      if (method === 'eth_accounts'){
        try { return await prov.request({ type: 'accounts', params: [] }); } catch(_){ }
      }
      if (method === 'personal_sign'){
        try { return await prov.request({ type: 'personal_sign', params: params||[] }); } catch(_){ }
      }
    }
    // EIP-1193 object form
    try { return await prov.request({ id: Date.now(), jsonrpc: '2.0', method, params: params||[] }); } catch(_){ }
    // Some providers accept (method, params)
    try { return await prov.request(method, params||[]); } catch(_){ }
    // Legacy send/sendAsync
    try { return await prov.send({ id: Date.now(), jsonrpc: '2.0', method, params: params||[] }); } catch(_){ }
    try {
      return await new Promise((resolve, reject)=>{
        if (typeof prov.sendAsync !== 'function') return reject(new Error('no sendAsync'));
        prov.sendAsync({ id: Date.now(), jsonrpc: '2.0', method, params: params||[] }, (err, res)=>{
          if (err) reject(err); else resolve(res && res.result ? res.result : res);
        });
      });
    } catch(_){ }
    // Legacy enable/connect fallbacks
    if (method === 'eth_requestAccounts'){
      if (typeof prov.enable === 'function'){
        try { const res = await prov.enable(); return Array.isArray(res)? res : (res?.data||res); } catch(_){ }
      }
      if (typeof prov.connect === 'function'){
        try { await prov.connect(); } catch(_){ }
        // try get accounts after connect
        try { return await prov.request({ method: 'eth_accounts', params: [] }); } catch(_){ }
      }
    }
    return null;
  }

  // Connect with a specific provider (robust to provider shapes and methods)
  async function connectWithProvider(providerDetail) {
    const name = providerDetail?.info?.name || 'Unknown Provider';
    console.log('🔌 Connecting with provider:', name);

    const prov = resolveRequestProvider(providerDetail);
    if (!prov){
      console.warn('⚠️ No request-capable provider found in detail; aborting real connect');
      if (extensionWarning) extensionWarning.style.display = 'block';
      return false;
    }

    try {
      // Helper to normalize various account response shapes
      const normalizeAccounts = (acc)=>{
        if (!acc) return [];
        if (Array.isArray(acc)) return acc;
        if (Array.isArray(acc.result)) return acc.result;
        if (Array.isArray(acc.data)) return acc.data;
        if (Array.isArray(acc.accounts)) return acc.accounts;
        if (typeof acc.address === 'string') return [acc.address];
        if (typeof acc.defaultAccount === 'string') return [acc.defaultAccount];
        return [];
      };

      // Request accounts using provider-specific variants/signatures
      let accounts = null;
      // Prefer direct accounts() if available (per Demos Wallet provider)
      try { if (typeof prov.accounts === 'function') accounts = await prov.accounts(); } catch(_){ }
      // Demos-style request API (support both {method:'accounts'} and {method:'demos_accounts'})
      if (!accounts) try { accounts = await prov.request({ method: 'accounts', params: [] }); } catch(_){ }
      if (!accounts) try { accounts = await prov.request({ method: 'demos_accounts', params: [] }); } catch(_){ }
      // Common EIP-1193 variants
      if (!accounts) accounts = await tryRequest(prov, 'demos_requestAccounts', []);
      if (!accounts) accounts = await tryRequest(prov, 'eth_requestAccounts', []);
      if (!accounts) accounts = await tryRequest(prov, 'eth_accounts', []);
      // Some providers use personal_sign for auth handshake. If no accounts, try a benign sign to prompt unlock
      if (!accounts){
        try { await tryRequest(prov, 'personal_sign', ['OrbitRunner login', '0x0000000000000000000000000000000000000000']); } catch(_){ }
        accounts = await tryRequest(prov, 'eth_accounts', []);
      }

      // Normalize common response shapes
      const list = normalizeAccounts(accounts);
      let addr = list[0] || '';

      if (addr){
        walletAddress = String(addr);
        currentProvider = providerDetail;
        updateConnectedWallet(walletAddress, 1000);
        updateLaunchButton();
        console.log('✅ Connected to real Demos provider:', walletAddress);
        // Listen to account changes if supported
        try{ prov.on && prov.on('accountsChanged', (accs)=>{ if (Array.isArray(accs) && accs[0]){ walletAddress = accs[0]; updateConnectedWallet(walletAddress, 1000); updateLaunchButton(); } }); }catch(_){ }
        return true;
      }

      // Try explicit connect via various provider-specific methods
      try { await prov.request({ method:'connect', params: [{ origin: location.origin }] }); } catch(_){ }
      // Demos-specific alternative connect with providerId/uuid if available
      try {
        const pid = providerDetail?.provider?.providerId || providerDetail?.info?.uuid || prov?.providerId;
        if (pid) await prov.request({ method:'demos_connect', params: [{ origin: location.origin, providerId: pid }] });
      } catch(_){ }
      // EIP-2255 style permissions
      try { await prov.request({ method:'wallet_requestPermissions', params: [ { eth_accounts: {} } ] }); } catch(_){ }
      try { await prov.request({ method:'requestPermissions', params: [ { eth_accounts: {} } ] }); } catch(_){ }

      // Short polling for accounts (some wallets populate after connect)
      for (let i=0;i<10 && !addr;i++){
        await new Promise(r=>setTimeout(r, 300));
        try { if (typeof prov.accounts === 'function') accounts = await prov.accounts(); } catch(_){ }
        if (!accounts) try { accounts = await prov.request({ method:'accounts', params: [] }); } catch(_){ }
        if (!accounts) try { accounts = await tryRequest(prov, 'eth_accounts', []); } catch(_){ }
        const pl = normalizeAccounts(accounts); addr = pl[0] || addr;
      }

      if (addr){
        walletAddress = String(addr);
        currentProvider = providerDetail;
        updateConnectedWallet(walletAddress, 1000);
        updateLaunchButton();
        console.log('✅ Connected after connect/poll:', walletAddress);
        return true;
      }

      console.warn('⚠️ Provider responded without accounts; show warning');
      if (extensionWarning){ extensionWarning.style.display = 'block'; extensionWarning.textContent = 'Open the Demos wallet, unlock it, and approve access for this site, then press Connect again.'; }
      return false;
    } catch (error) {
      console.error('❌ Extension connection failed:', error);
      if (extensionWarning){ extensionWarning.style.display = 'block'; extensionWarning.textContent = 'Connection failed. Please approve in the Demos extension and retry.'; }
      return false;
    }
  }

  // Set up wallet event listeners
  if (connectExtensionBtn) {
    connectExtensionBtn.addEventListener('click', async () => {
      console.log('🔗 Extension connect button clicked');
      if (connecting) return; connecting = true;
      // Prefer direct globals if available
      const direct = (window.demos && typeof window.demos.request==='function') ? { info:{ name:'Demos Extension' }, provider: window.demos }
        : (window.ethereum && typeof window.ethereum.request==='function' ? { info:{ name:'Demos Extension (Ethereum)' }, provider: window.ethereum } : null);
      try{
        if (direct){ await connectWithProvider(direct); updateLaunchButton(); return; }
        if (window.demosProviders && window.demosProviders.length > 0) { await connectWithProvider(window.demosProviders[0]); updateLaunchButton(); return; }
        setStatus('checking');
        await detectAndConnectExtension();
        scheduleDetectionRetry(5);
      } finally {
        connecting = false;
      }
    });
  }

  // When the provider announces itself, auto-detect and update UI (no auto-connect)
  window.addEventListener('demosAnnounceProvider', ()=>{ if (!providersDetected) detectAndConnectExtension(); });

  if (disconnectBtn) {
    disconnectBtn.addEventListener('click', () => {
      console.log('🔌 Disconnect button clicked');
      walletAddress = '';
      currentProvider = null;
      updateConnectedWallet('');
      updateLaunchButton();
      
      if (extensionIndicator) {
        extensionIndicator.className = 'status-indicator checking';
      }
      if (extensionStatusText) {
        extensionStatusText.textContent = 'Checking for Demos extension...';
      }
    });
  }

  // Manual detection button
  const manualDetectBtn = document.getElementById('manual-detect-btn');
  const detectionResults = document.getElementById('detection-results');
  
  if (manualDetectBtn) {
    manualDetectBtn.addEventListener('click', async () => {
      console.log('🔍 Manual detection button clicked');
      
      if (detectionResults) {
        detectionResults.innerHTML = '<div>🔍 Running manual detection...</div>';
      }
      
      try {
        // Check what's available in window
        const walletObjects = {};
        const walletKeywords = ['demos', 'ethereum', 'web3', 'wallet', 'provider', 'injected'];
        
        for (const key in window) {
          if (walletKeywords.some(keyword => key.toLowerCase().includes(keyword))) {
            walletObjects[key] = typeof window[key];
          }
        }
        
        // Run detection
        const providers = await window.detectDemosExtension();
        
        // Display results
        if (detectionResults) {
          let resultsHTML = '<div><strong>🔍 Detection Results:</strong></div>';
          
          if (Object.keys(walletObjects).length > 0) {
            resultsHTML += '<div><strong>Wallet-related objects found:</strong></div>';
            for (const [key, type] of Object.entries(walletObjects)) {
              resultsHTML += `<div>• window.${key}: ${type}</div>`;
            }
          } else {
            resultsHTML += '<div>❌ No wallet-related objects found</div>';
          }
          
          resultsHTML += `<div><strong>Providers detected: ${providers.length}</strong></div>`;
          
          if (providers.length > 0) {
            providers.forEach((provider, index) => {
              resultsHTML += `<div>✅ Provider ${index + 1}: ${provider.info.name}</div>`;
            });
          } else {
            resultsHTML += '<div>❌ No Demos providers found</div>';
            resultsHTML += '<div><strong>Troubleshooting:</strong></div>';
            resultsHTML += '<div>• Make sure Demos extension is installed</div>';
            resultsHTML += '<div>• Check extension is enabled in browser</div>';
            resultsHTML += '<div>• Try refreshing the page</div>';
            resultsHTML += '<div>• Check browser console for errors</div>';
          }
          
          detectionResults.innerHTML = resultsHTML;
        }
        
        // Update UI based on results
        if (providers.length > 0) {
          if (extensionIndicator) {
            extensionIndicator.className = 'status-indicator available';
          }
          if (extensionStatusText) {
            extensionStatusText.textContent = 'Demos extension detected';
          }
          if (connectExtensionBtn) {
            connectExtensionBtn.disabled = false;
            connectExtensionBtn.classList.add('enabled');
          }
        }
        
      } catch (error) {
        console.error('❌ Manual detection failed:', error);
        if (detectionResults) {
          detectionResults.innerHTML = `<div>❌ Detection failed: ${error.message}</div>`;
        }
      }
    });
  }

  if (launchBtn) {
    launchBtn.addEventListener('click', () => {
      if (!walletAddress) {
        alert('Please connect your wallet first!');
        return;
      }
      
      console.log('🚀 Launching with wallet address:', walletAddress);
      
      if (welcomeScreen) welcomeScreen.classList.add('hidden');
      if (canvas) { 
        canvas.classList.remove('hidden'); 
        canvas.style.display = 'block'; 
      }
      
      // ensure HUD becomes visible when created dynamically later
      startGame();
      // Start the 3-minute round at game launch
      roundActive = true; 
      roundEndsAt = Date.now() + 3*60*1000;
      canvas.focus();
    });
  }

  // Initialize extension detection with delay
  setTimeout(() => {
    console.log('🔍 Starting extension detection after delay...');
    detectAndConnectExtension();
  }, 2000);
  // Reconnect button behavior: on click, start 3s countdown, keep overlay visible until done
  document.addEventListener('click', (e)=>{
    if (e.target === reconnectBtn){
      e.preventDefault(); e.stopPropagation();
      if (reconnectTimer) return; // already counting down
      let remaining = 3;
      controlsUnlockAt = Date.now() + remaining*1000;
      // Do not start a new timed round here; timer starts on Launch
      if (reconnectBtn){ reconnectBtn.disabled = true; reconnectBtn.style.opacity = '0.8'; reconnectBtn.style.cursor = 'default'; reconnectBtn.textContent = 'Reconnecting...'; }
      if (reconnectMsg){ reconnectMsg.textContent = `Reconnecting in ${remaining}...`; }
      reconnectTimer = setInterval(()=>{
        remaining--;
        if (remaining <= 0){
          clearInterval(reconnectTimer); reconnectTimer = null;
          hideReconnectOverlay();
          controlsUnlockAt = 0;
          if (reconnectBtn){ reconnectBtn.disabled = false; reconnectBtn.style.opacity = '1'; reconnectBtn.style.cursor = 'pointer'; reconnectBtn.textContent = 'Reconnect'; }
          if (reconnectMsg){ reconnectMsg.textContent = 'Click Reconnect to continue'; }
          try{ canvas.focus(); }catch(_){ }
        } else {
          if (reconnectMsg){ reconnectMsg.textContent = `Reconnecting in ${remaining}...`; }
        }
      }, 1000);
    }
    if (e.target === endRestartBtn){
      e.preventDefault(); e.stopPropagation();
      // Restart timed round: reset score and timers; respawn to initial area (local)
      hideEndOverlay();
      // Reset ship state, HP, shield, and score
      score = 0; killsCount = 0; asteroidsDestroyed = 0; beltTimeSec = 0;
      health = 100; shield = 0; gameOver = false; hideGameOver();
      roundSubmitted = false; statsSaved = false;
      // Local soft respawn near origin; reset movement
      speedUnitsPerSec = 20; targetSpeedUnitsPerSec = 20; velocity.set(0,0,0);
      shipPosition.set(0,0,0); ship.position.copy(shipPosition);
      yaw = 0; pitch = 0; roll = 0; ship.quaternion.setFromEuler(new THREE.Euler(pitch,yaw,roll,'YXZ'));
      // Start new timed round
      roundActive = true; roundEndsAt = Date.now() + 3*60*1000;
      controlsUnlockAt = Date.now() + 2000; // brief lock to avoid immediate inputs
      try{ canvas.focus(); }catch(_){ }
    }
    if (e.target === endFreeBtn){
      e.preventDefault(); e.stopPropagation();
      hideEndOverlay();
      // Free flight: stop round and prevent further score submissions
      roundActive = false;
      try{ canvas.focus(); }catch(_){ }
    }
    if (e.target === endDemosBtn){
      e.preventDefault(); e.stopPropagation();
      // Fire-and-forget call to your Demos gateway when provided
      try{
        const payload = getSessionStats();
        const demosUrl = window.DEMOS_API || ''; // set later when you have it
        if (demosUrl){ fetch(`${demosUrl}/submit`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(payload) }).catch(()=>{}); }
      }catch(_){ }
      // keep overlay visible so user can choose Restart/Free
    }
  }, { capture:true });
  let lbRefreshTimer = null;
  function startGame(){
    if (gameInitialized) return;
    gameInitialized=true;
    hud.style.display='block';
    help.style.display='block';
    connectMP();
    // Show leaderboard overlay at top-right by default
    ensureLbOverlay().style.display = 'block';
    renderLb();
    if (!lbRefreshTimer){ lbRefreshTimer = setInterval(()=>{ if (lbOverlay && lbOverlay.style.display!=='none') renderLb(); }, 5000); }
  }
  // MP overlay (P to toggle)
  let mpOverlay = null; let mpOverlayOn = false; let latestRoomStats = [];
  function ensureMpOverlay(){ if (mpOverlay) return mpOverlay; const d=document.createElement('div'); d.id='mpOverlay'; Object.assign(d.style,{ position:'absolute', top:'10px', right:'10px', color:'#fff', background:'rgba(0,0,0,0.5)', padding:'8px 10px', borderRadius:'8px', fontSize:'12px', display:'none', zIndex:9999, whiteSpace:'pre' }); document.body.appendChild(d); mpOverlay=d; return d; }
  function renderMpOverlay(){ if (!mpOverlayOn) return; ensureMpOverlay(); const rows = latestRoomStats.slice().sort((a,b)=> (b.score||0)-(a.score||0)).map(p=> `${(p.name||'Anon').slice(0,16).padEnd(16)}  ${String(p.score||0).padStart(6)}`); mpOverlay.innerText = ['Players (P to hide):', ...rows].join('\n'); }
  const gameOverEl = document.getElementById('gameover') || (()=>{ const d=document.createElement('div'); d.id='gameover'; d.style.position='absolute'; d.style.top='45%'; d.style.left='50%'; d.style.transform='translate(-50%,-50%)'; d.style.fontSize='2rem'; d.style.color='#fff'; d.style.display='none'; d.style.textAlign='center'; d.style.textShadow='0 0 8px #000'; d.innerHTML='CRASHED<br/>Press R to Restart'; document.body.appendChild(d); return d; })();

  // Placeholder patch system to avoid reference errors
  const patches = [];
  function ensurePatches(){ /* no-op for now */ }
  function maintainPatches(){ /* no-op for now */ }

  // Ship (factory functions)
  function buildDefaultShip(){
    const mat = new THREE.MeshStandardMaterial({ color: 0x47e6ff, emissive: 0x0a2a44, emissiveIntensity: 1.5, metalness: 0.2, roughness: 0.5 });
    const geo = new THREE.ConeGeometry(1.0, 3.2, 14);
    geo.rotateX(Math.PI / 2); // nose +Z
    return new THREE.Mesh(geo, mat);
  }
  let ship = buildDefaultShip();
  scene.add(ship);

  // Stats
  let health = 100;    // %
  let shield = 0;      // %
  let gameOver = false;
  let damageCooldown = 0; // sec i‑frames after a hit
  let fenixActive = false;

  // Movement state
  let speedUnitsPerSec = 20;
  let targetSpeedUnitsPerSec = 20;
  const minSpeed = 5;
  const baseMaxSpeed = 60;
  const DEV_TURBO_SPEED = 500;
  const yawRate = 2.0;     // rad/sec
  const pitchRate = 1.35;  // rad/sec
  let yaw = 0, pitch = 0, roll = 0;
  let mouseX = 0, mouseY = 0, mouseDown = false;
  let devTurboActive = false;

  const shipPosition = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  const shipHitRadius = 1.8;      // generous to make crashes easier
  const pickupHitRadius = 2.2;

  // Camera follow
  const cameraOffsetLocal = new THREE.Vector3(0, 3.7, -10.8);
  let cameraShake = 0; // meters

  // Boost state
  let boostActive = false;
  let boostTimer = 0; // seconds remaining

  // Planets
  const planets = [];
  function addPlanet(pos, radius, color) {
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.22, metalness: 0.1, roughness: 0.85 });
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 40), mat);
    m.position.copy(pos);
    m.userData.radius = radius;
    const glow = new THREE.PointLight(color, 2.0, radius * 22);
    glow.position.copy(pos);
    scene.add(m, glow);
    planets.push(m);
    return m;
  }
  const targetPlanet = addPlanet(new THREE.Vector3(0, 0, -20000), 1200, 0x3355aa);
  addPlanet(new THREE.Vector3(15000, 6000, 12000), 900, 0xaa7755);
  addPlanet(new THREE.Vector3(-18000, -4000, -9000), 700, 0x669966);

  // Removed belt "veil" halo for a cleaner look

  // Multiplayer meetup landmark: Mothership inside the ring
  function addMotherShip(planet, radius=4400){
    const angle = 0; // fixed reference
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(angle)*radius,
      planet.position.y,
      planet.position.z + Math.sin(angle)*radius
    );
    const hull = new THREE.Mesh(new THREE.BoxGeometry(160, 40, 520), new THREE.MeshStandardMaterial({ color:0x223344, metalness:0.6, roughness:0.3, emissive:0x112233, emissiveIntensity:0.3 }));
    hull.position.copy(pos);
    hull.rotation.y = Math.PI/2;
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(60, 28, 80), new THREE.MeshStandardMaterial({ color:0x334455, metalness:0.5, roughness:0.35, emissive:0x223344, emissiveIntensity:0.35 }));
    bridge.position.copy(pos).add(new THREE.Vector3(0, 28, 160));
    const beacon = new THREE.PointLight(0x66ccff, 2.0, 2000);
    beacon.position.copy(pos).add(new THREE.Vector3(0, 80, 0));
    const beaconGlow = new THREE.Mesh(new THREE.SphereGeometry(14, 18, 18), new THREE.MeshBasicMaterial({ color:0x66ccff, transparent:true, opacity:0.7, blending:THREE.AdditiveBlending, depthWrite:false }));
    beaconGlow.position.copy(beacon.position);
    scene.add(hull, bridge, beacon, beaconGlow);
    return { hull, bridge, beacon };
  }
  const motherShip = addMotherShip(targetPlanet, 4400);

  // Starfield
  (function makeStars(){
    const count = 7000;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count*3);
    for (let i=0;i<count;i++){
      const r = 22000 + rand()*32000;
      const theta = rand()*Math.PI*2;
      const phi = Math.acos(2*rand()-1);
      positions[i*3+0] = r * Math.sin(phi)*Math.cos(theta);
      positions[i*3+1] = r * Math.cos(phi);
      positions[i*3+2] = r * Math.sin(phi)*Math.sin(theta);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x99ccff, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.9 });
    scene.add(new THREE.Points(geo, mat));
  })();

  // Belt helpers and scoring
  const RING_INNER = 3600;
  const RING_OUTER = 5200;
  function isWithinBeltXZ(pos){
    const dx = pos.x - targetPlanet.position.x;
    const dz = pos.z - targetPlanet.position.z;
    const r2 = dx*dx + dz*dz;
    return (r2 >= RING_INNER*RING_INNER) && (r2 <= RING_OUTER*RING_OUTER);
  }
  function getAsteroidScore(base, pos){
    let mult = 1;
    if (asteroidMultTimer > 0) mult *= 2;
    if (isWithinBeltXZ(pos)) mult *= 2;
    return Math.round(base * mult);
  }
  function getKillScore(base, pos){
    let mult = 1;
    if (killMultTimer > 0) mult *= 2;
    if (isWithinBeltXZ(pos)) mult *= 2;
    return Math.round(base * mult);
  }

  // Math utility: squared-distance radius check to avoid sqrt per frame
  function isWithinRadiusSquared(posA, posB, combinedRadius){
    const dx = posA.x - posB.x;
    const dy = posA.y - posB.y;
    const dz = posA.z - posB.z;
    return (dx*dx + dy*dy + dz*dz) < (combinedRadius * combinedRadius);
  }

  // Spatial hash for broad-phase collision
  class SpatialHash {
    constructor(cellSize){ this.cellSize = cellSize; this.map = new Map(); }
    key(x,y,z){ const cs=this.cellSize; return ((x/cs)|0)+":"+((y/cs)|0)+":"+((z/cs)|0); }
    clear(){ this.map.clear(); }
    insert(obj, pos){ const k=this.key(pos.x,pos.y,pos.z); let a=this.map.get(k); if(!a){ a=[]; this.map.set(k,a);} a.push(obj); }
    query(pos, radius){
      const cs=this.cellSize, r=radius; const out=[]; const m=this.map;
      const minX=((pos.x-r)/cs|0), maxX=((pos.x+r)/cs|0);
      const minY=((pos.y-r)/cs|0), maxY=((pos.y+r)/cs|0);
      const minZ=((pos.z-r)/cs|0), maxZ=((pos.z+r)/cs|0);
      for(let x=minX;x<=maxX;x++) for(let y=minY;y<=maxY;y++) for(let z=minZ;z<=maxZ;z++){
        const a=m.get(x+":"+y+":"+z); if(a) out.push(...a);
      }
      return out;
    }
  }

  // Utility: glow sprite texture for wormholes
  let glowTexture = null;
  function getGlowTexture(){
    if (glowTexture) return glowTexture;
    const size = 128;
    const cvs = document.createElement('canvas'); cvs.width = cvs.height = size;
    const ctx = cvs.getContext('2d');
    const g = ctx.createRadialGradient(size/2, size/2, 10, size/2, size/2, size/2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0,0,size,size);
    glowTexture = new THREE.CanvasTexture(cvs);
    glowTexture.colorSpace = THREE.SRGBColorSpace;
    glowTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return glowTexture;
  }

  // Seeded RNG for MP deterministic world
  var rng = null;
  function mulberry32(seed){ return function(){ let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function setRand(seed){ rng = mulberry32(seed>>>0); }
  function rand(){ return rng ? rng() : Math.random(); }

  // Asteroids
  const asteroids = [];      // { mesh, radius, inRing?, inPatch?, vel?, rotAxis?, rotSpeed?, orbitRadius?, orbitAngle?, orbitSpeed?, nearMissCooldown? }
  const asteroidGeometry = new THREE.DodecahedronGeometry(1, 0);
  function randomAxis() { const v = new THREE.Vector3(rand()*2-1,rand()*2-1,rand()*2-1); v.normalize(); return v; }
  function randomVel(scale){ return new THREE.Vector3(rand()*2-1,rand()*2-1,rand()*2-1).multiplyScalar(scale); }

  function spawnAsteroidAround(center, minR, maxR) {
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 0.8 + rand()*3.2;
    const mat = new THREE.MeshStandardMaterial({ color: 0xb0b0b0, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.15 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(1.5), rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*0.8, nearMissCooldown: 0 });
  }
  function spawnAsteroidClose(center, minR, maxR) {
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const scale = 1.2 + rand()*2.5;
    const mat = new THREE.MeshStandardMaterial({ color: 0xc0c0c0, roughness: 0.9, metalness: 0.05, emissive: 0x333333, emissiveIntensity: 0.25 });
    const m = new THREE.Mesh(asteroidGeometry, mat);
    m.scale.setScalar(scale);
    m.position.copy(pos);
    scene.add(m);
    asteroids.push({ mesh: m, radius: scale*0.95, vel: randomVel(2.2), rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*1.0, nearMissCooldown: 0 });
  }
  function seedAsteroids(countFar, countNear, around) {
    for (let i=0;i<countFar;i++) spawnAsteroidAround(around, 1500, 9000);
    for (let i=0;i<countNear;i++) spawnAsteroidClose(around, 300, 1200);
  }
  seedAsteroids(7000, 1400, shipPosition);

  function createRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*120;
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      const pos = new THREE.Vector3(x, planet.position.y + yJitter, z);
      const scale = 0.9 + rand()*3.2;
      const mat = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.18 });
      const m = new THREE.Mesh(asteroidGeometry, mat);
      m.scale.setScalar(scale);
      m.position.copy(pos);
      scene.add(m);
      asteroids.push({ mesh:m, radius: scale*0.95, inRing:true, orbitRadius:r, orbitAngle:a, orbitSpeed:(rand()*0.5+0.2)*0.06, rotAxis: randomAxis(), rotSpeed: (rand()*2-1)*0.8, nearMissCooldown: 0, instanceId:-1, instanceGroup:-1, scale });
    }
  }
  // Double the number of ring asteroids for richer belts
  createRings(targetPlanet, 3600, 5200, 13000);

  // Grouped InstancedMesh rendering for ring asteroids (2-3 batches)
  let ringInstancedGroups = [];
  const instTmp = new THREE.Object3D();
  function disposeRingInstancedGroups(){
    if (!ringInstancedGroups || ringInstancedGroups.length===0) return;
    for (const im of ringInstancedGroups){ try { scene.remove(im); im.geometry.dispose?.(); if (im.material.dispose) im.material.dispose(); } catch(_){} }
    ringInstancedGroups = [];
  }
  function buildRingInstancedGroups(groupCount=3){
    disposeRingInstancedGroups();
    const ringIndices = [];
    for (let i=0;i<asteroids.length;i++){ if (asteroids[i].inRing) ringIndices.push(i); }
    if (ringIndices.length === 0) return;
    // Partition into groupCount buckets
    const buckets = Array.from({length: groupCount}, ()=>[]);
    for (let j=0;j<ringIndices.length;j++){ buckets[j % groupCount].push(ringIndices[j]); }
    const geom = asteroidGeometry.clone();
    for (let g=0; g<groupCount; g++){
      const count = buckets[g].length; if (count === 0){ ringInstancedGroups[g] = null; continue; }
      const mat = new THREE.MeshStandardMaterial({ color: 0xa8a8a8, roughness: 0.95, metalness: 0.05, emissive: 0x222222, emissiveIntensity: 0.18 });
      const im = new THREE.InstancedMesh(geom, mat, count);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(im);
      ringInstancedGroups[g] = im;
      // Assign mapping and initialize matrices
      for (let k=0;k<count;k++){
        const idx = buckets[g][k];
        const a = asteroids[idx];
        a.instanceGroup = g; a.instanceId = k;
        a.mesh.visible = false; // hide original render mesh; keep for position/collision
        instTmp.position.copy(a.mesh.position);
        instTmp.rotation.set(0,0,0);
        instTmp.scale.set(a.scale, a.scale, a.scale);
        instTmp.updateMatrix();
        im.setMatrixAt(k, instTmp.matrix);
      }
      im.instanceMatrix.needsUpdate = true;
    }
  }
  buildRingInstancedGroups(3);

  // Removed InstancedMesh rendering to restore per-mesh movement/rendering for ring asteroids

  // Font for 3D labels
  let gameFont = null;
  const fontLoader = new FontLoader();
  fontLoader.load('https://unpkg.com/three@0.164.0/examples/fonts/helvetiker_regular.typeface.json', f => { gameFont = f; }, undefined, e => console.error('Font load error', e));
  const shieldTextLabels = []; // { mesh, life }
  function spawnShieldText(position){
    if (!gameFont) return;
    const geo = new TextGeometry('SHIELD', {
      font: gameFont, size: 2.0, depth: 0.6, curveSegments: 8,
      bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 2,
    });
    geo.computeBoundingBox(); geo.center();
    const mat = new THREE.MeshBasicMaterial({ color: 0x66ff99, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 3, 0));
    scene.add(mesh);
    shieldTextLabels.push({ mesh, life: 3.0 });
  }

  // Duende SVG label for pink orb hits (renders as billboarded plane)
  const duendeTextLabels = []; // { group, life }
  function spawnDuendeText(position){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 520 160" width="520" height="160" role="img" aria-labelledby="title desc">\n  <title id="title">Demos logo with wave-dual emblem</title>\n  <desc id="desc">A circular emblem split by a flowing S-like curve with asymmetric dots, followed by the word Demos.</desc>\n  <defs>\n    <clipPath id="emblem-clip">\n      <circle cx="80" cy="80" r="70"/>\n    </clipPath>\n  </defs>\n  <g transform="translate(80 80) rotate(-12) translate(-80 -80)">\n    <circle cx="80" cy="80" r="70" fill="#111111"/>\n    <g clip-path="url(#emblem-clip)">\n      <path fill="#ffffff" fill-rule="evenodd" d="\n        M -20 -20 H 180 V 180 H -20 Z\n        M -20 -20\n        L 28 -20\n        C 84 -18 120 40 133 78\n        C 146 114 94 142 12 160\n        L -20 160 Z\"/>\n    </g>\n    <circle cx="108" cy="48" r="11" fill="#ffffff"/>\n    <circle cx="52"  cy="114" r="15" fill="#111111"/>\n    <circle cx="80" cy="80" r="70" fill="none" stroke="#111111" stroke-width="2"/>\n  </g>\n  <text x="170" y="86" fill="#222222" font-size="64" font-weight="700" dominant-baseline="middle">Demos</text>\n</svg>`;
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const aspect = 520/160; // 3.25
      const widthUnits = 9;   // visible but not huge
      const heightUnits = widthUnits / aspect;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthUnits, heightUnits), mat);
      const group = new THREE.Group();
      group.add(mesh);
      group.position.copy(position).add(new THREE.Vector3(0, 3, 0));
      scene.add(group);
      duendeTextLabels.push({ group, life: 3.0 });
    });
  }

  // Fenix SVG label (renders as billboard plane)
  function spawnFenixLabel(position){
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 480" width="600" height="480" role="img" aria-labelledby="title desc">\n  <title id="title">Fenix emblem with centered wordmark</title>\n  <desc id="desc">A stylized phoenix with outstretched wings, central flame-tail, and the word Fenix centered below.</desc>\n  <defs>\n    <style>\n      :root { --ink: #FFFFFF; }\n      .ink { fill: var(--ink); }\n      text { fill: var(--ink); font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, Ubuntu, Cantarell, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif; font-weight: 700; letter-spacing: 0.5px; }\n    </style>\n  </defs>\n  <g aria-label="Fenix emblem">\n    <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z\"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 186 C 258 145, 214 112, 165 116 C 128 118, 120 149, 152 168 C 114 170, 104 198, 138 210 C 118 228, 158 238, 204 227 C 236 219, 270 201, 300 192 Z\"/>\n    </g>\n    <path class="ink" d=" M 300 188 C 330 198, 352 222, 352 252 C 352 286, 327 311, 306 331 C 296 341, 293 356, 300 378 C 282 362, 276 346, 279 331 C 254 321, 246 297, 257 277 C 236 262, 241 234, 267 218 C 281 208, 290 196, 300 188 Z\"/>\n    <path class="ink" d=" M 300 186 C 305 164, 318 147, 340 139 C 355 134, 371 141, 380 153 C 366 149, 352 151, 340 160 C 348 168, 360 175, 374 177 C 356 182, 340 181, 328 173 C 324 184, 314 191, 300 194 Z\"/>\n    <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z\"/>\n    <g transform="translate(600,0) scale(-1,1)">\n      <path class="ink" d=" M 300 332 C 270 342, 248 364, 244 388 C 249 383, 262 374, 283 368 C 280 385, 287 401, 300 410 Z\"/>\n    </g>\n    <path class="ink" d=" M 300 330 C 314 358, 312 386, 300 410 C 314 394, 326 371, 334 344 C 322 356, 312 348, 300 330 Z\"/>\n  </g>\n  <text x="300" y="452" font-size="56" text-anchor="middle">Fenix</text>\n</svg>`;
    const dataUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    const loader = new THREE.TextureLoader();
    loader.load(dataUrl, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
      const aspect = 600/480;
      const widthUnits = 10; const heightUnits = widthUnits / aspect;
      const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthUnits, heightUnits), mat);
      const group = new THREE.Group(); group.add(mesh);
      group.position.copy(position).add(new THREE.Vector3(0, 4, 0));
      scene.add(group);
      duendeTextLabels.push({ group, life: 3.0 });
    });
  }

  // Replace ship with a Fenix model
  function buildFenixShip(){
    const group = new THREE.Group();
    const blackMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0x000000, metalness: 0.2, roughness: 0.6 });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1 });

    const bodyGeo = new THREE.ConeGeometry(1.2, 4.0, 24); bodyGeo.rotateX(Math.PI/2);
    const bodyMesh = new THREE.Mesh(bodyGeo, blackMat);
    const bodyEdges = new THREE.LineSegments(new THREE.EdgesGeometry(bodyGeo, 10), edgeMat);
    group.add(bodyMesh, bodyEdges);

    const wingGeo = new THREE.BoxGeometry(0.2, 0.05, 3.2);
    const leftWing = new THREE.Mesh(wingGeo, blackMat);
    const rightWing = new THREE.Mesh(wingGeo, blackMat);
    const leftEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wingGeo), edgeMat);
    const rightEdges = new THREE.LineSegments(new THREE.EdgesGeometry(wingGeo), edgeMat);
    leftWing.position.set(-1.3, -0.2, -0.2); leftWing.rotation.y = Math.PI/10; leftEdges.position.copy(leftWing.position); leftEdges.rotation.copy(leftWing.rotation);
    rightWing.position.set(1.3, -0.2, -0.2); rightWing.rotation.y = -Math.PI/10; rightEdges.position.copy(rightWing.position); rightEdges.rotation.copy(rightWing.rotation);
    group.add(leftWing, rightWing, leftEdges, rightEdges);

    const tailGeo = new THREE.CylinderGeometry(0.15, 0.35, 0.8, 12);
    const tail = new THREE.Mesh(tailGeo, blackMat); tail.position.set(0, -0.4, -1.6); tail.rotation.x = Math.PI/2;
    const tailEdges = new THREE.LineSegments(new THREE.EdgesGeometry(tailGeo), edgeMat); tailEdges.position.copy(tail.position); tailEdges.rotation.copy(tail.rotation);
    group.add(tail, tailEdges);

    return group;
  }
  function transformToFenixShip(){
    if (fenixActive) return;
    const newShip = buildFenixShip();
    newShip.position.copy(ship.position);
    newShip.quaternion.copy(ship.quaternion);
    scene.add(newShip);
    scene.remove(ship);
    ship = newShip;
    fenixActive = true;
    health = 100; // restore to full when transforming
    cameraShake += 0.5;
  }

  // Shield Orbs (now 5% of asteroids; pulsating green; unique explosions)
  const shieldOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const shieldOrbGeometry = new THREE.SphereGeometry(0.9, 16, 16);
  function makeAdditiveMaterial(color, opacity=0.9){ return new THREE.MeshBasicMaterial({ color, transparent:true, opacity, blending:THREE.AdditiveBlending, depthWrite:false }); }
  function spawnShieldOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta),
      r * Math.cos(phi),
      r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const mat = makeAdditiveMaterial(0x33ff66, 0.95); // green
    const m = new THREE.Mesh(shieldOrbGeometry, mat);
    m.position.copy(pos);
    const baseScale = 1.25;
    m.scale.setScalar(baseScale);
    scene.add(m);
    shieldOrbs.push({ mesh:m, radius: 1.2, bob: rand()*Math.PI*2, bobSpeed: 1 + rand()*1.5, baseScale, pulseSpeed: 3 + rand()*3 });
  }
  function spawnShieldOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const mat = makeAdditiveMaterial(0x33ff66, 0.95);
    const m = new THREE.Mesh(shieldOrbGeometry, mat);
    m.position.copy(pos);
    const baseScale = 1.25; m.scale.setScalar(baseScale);
    scene.add(m);
    shieldOrbs.push({ mesh:m, radius: 1.2, bob: rand()*Math.PI*2, bobSpeed: 1 + rand()*1.5, baseScale, pulseSpeed: 3 + rand()*3 });
  }
  function seedShieldOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.shield, Math.max(12, Math.floor(asteroids.length * 0.05)));
    while (shieldOrbs.length < desired) spawnShieldOrbAround(shipPosition);
  }
  seedShieldOrbsFromAsteroidCount();

  // New: Neon Pink Orbs
  const pinkOrbs = []; // { mesh, radius, bob, bobSpeed, baseScale, pulseSpeed }
  const pinkOrbGeometry = shieldOrbGeometry; // same base shape
  function spawnPinkOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(pinkOrbGeometry, makeAdditiveMaterial(0xff33cc, 0.95));
    m.position.copy(pos);
    const baseScale = 1.7;
    m.scale.setScalar(baseScale);
    scene.add(m);
    pinkOrbs.push({ mesh:m, radius: 1.6, bob: rand()*Math.PI*2, bobSpeed: 1.6 + rand()*2.0, baseScale, pulseSpeed: 4.0 + rand()*3.5 });
  }
  function spawnPinkOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const m = new THREE.Mesh(pinkOrbGeometry, makeAdditiveMaterial(0xff33cc, 0.98));
    m.position.copy(pos);
    const baseScale = 1.7; m.scale.setScalar(baseScale);
    scene.add(m);
    pinkOrbs.push({ mesh:m, radius: 1.6, bob: rand()*Math.PI*2, bobSpeed: 1.6 + rand()*2.0, baseScale, pulseSpeed: 4.0 + rand()*3.5 });
  }
  function seedPinkOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.pink, Math.max(6, Math.floor(asteroids.length * 0.01)));
    while (pinkOrbs.length < desired) spawnPinkOrbAround(shipPosition);
  }
  seedPinkOrbsFromAsteroidCount();

  // New: Fenix Orbs
  const fenixOrbs = [];
  const fenixOrbGeometry = shieldOrbGeometry;
  function spawnFenixOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    // Neon orange core (more orange hue)
    const m = new THREE.Mesh(fenixOrbGeometry, makeAdditiveMaterial(0xff7a00, 0.98));
    m.position.copy(pos);
    const baseScale = 1.8; m.scale.setScalar(baseScale);
    // Yellow glow
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xfff066, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    fenixOrbs.push({ mesh:m, glow, radius: 1.7, bob: rand()*Math.PI*2, bobSpeed: 1.0 + rand()*1.6, baseScale, pulseSpeed: 3.6 + rand()*3.6 });
  }
  function spawnFenixOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    // Neon orange core (more orange hue)
    const m = new THREE.Mesh(fenixOrbGeometry, makeAdditiveMaterial(0xff7a00, 0.98));
    m.position.copy(pos);
    const baseScale = 1.8; m.scale.setScalar(baseScale);
    // Yellow glow
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xfff066, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    fenixOrbs.push({ mesh:m, glow, radius: 1.7, bob: rand()*Math.PI*2, bobSpeed: 1.0 + rand()*1.6, baseScale, pulseSpeed: 3.6 + rand()*3.6 });
  }
  function seedFenixOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.fenix, Math.max(20, Math.floor(asteroids.length * 0.10)));
    while (fenixOrbs.length < desired) spawnFenixOrbAround(shipPosition);
  }
  seedFenixOrbsFromAsteroidCount();

  // New: Zaphire Orbs
  const zaphireOrbs = [];
  const zaphireOrbGeometry = shieldOrbGeometry;
  function spawnZaphireOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const m = new THREE.Mesh(zaphireOrbGeometry, makeAdditiveMaterial(0xff3333, 1.0));
    m.position.copy(pos);
    const baseScale = 2.5; // doubled size
    m.scale.setScalar(baseScale);
    // Add bright red glow sprite for extra visibility/brightness
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xff4444, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    zaphireOrbs.push({ mesh:m, glow, radius:2.4, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, baseScale, pulseSpeed: 3.0 + rand()*3.0 });
  }
  function spawnZaphireOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2;
    const r = innerR + rand()*(outerR-innerR);
    const yJ = (rand()-0.5)*40;
    const pos = new THREE.Vector3(
      planet.position.x + Math.cos(a)*r,
      planet.position.y + yJ,
      planet.position.z + Math.sin(a)*r
    );
    const m = new THREE.Mesh(zaphireOrbGeometry, makeAdditiveMaterial(0xff3333, 1.0));
    m.position.copy(pos);
    const baseScale = 2.5; m.scale.setScalar(baseScale);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xff4444, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(14,14,1);
    scene.add(m, glow);
    zaphireOrbs.push({ mesh:m, glow, radius:2.4, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, baseScale, pulseSpeed: 3.0 + rand()*3.0 });
  }

  function seedAllOrbsInRingByProportion(planet, innerR=3600, outerR=5200){
    // Keep existing asteroids; clear only orbs
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) scene.remove(o.mesh); fenixOrbs.length = 0;
    for (const o of zaphireOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } zaphireOrbs.length = 0;
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;

    let ring = 0;
    for (const a of asteroids){ if (a.inRing) ring++; }
    if (ring <= 0) return;

    // Use generous minimums to guarantee visible saturation
    const desiredShield = Math.max(80, Math.min(CAPS.shield, Math.floor(ring * 0.03)));
    const desiredPink   = Math.max(80, Math.min(CAPS.pink,   Math.floor(ring * 0.03)));
    const desiredFenix  = Math.max(80, Math.min(CAPS.fenix,  Math.floor(ring * 0.08)));
    const desiredZaph   = Math.max(40, Math.min(CAPS.zaphire,Math.floor(ring * 0.10)));
    const desiredWorm   = Math.max(60, Math.min(CAPS.wormhole,Math.floor(ring * 0.20)));
    const desiredBoost  = Math.max(70, Math.min(CAPS.boost,  Math.floor(ring * 0.15)));

    for (let i=0;i<desiredShield;i++) spawnShieldOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredPink;i++)   spawnPinkOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredFenix;i++)  spawnFenixOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredZaph;i++)   spawnZaphireOrbOnRing(planet, innerR, outerR);
    // Disperse uniformly by sampling the full [0..2π) ring range evenly
    const slots = 64;
    const angles = Array.from({length: slots}, (_,i)=> (i/slots)*Math.PI*2 + rand()*((Math.PI*2)/slots*0.25));
    const placeRing = (count, fn)=>{ const step = Math.max(1, Math.floor(slots / Math.max(1,count))); let placed=0; for (let i=0;i<slots && placed<count;i+=step){ const a=angles[i%slots]; fn(a); placed++; } };
    placeRing(desiredShield, (a)=> spawnShieldOrbOnRing(planet, innerR, outerR));
    placeRing(desiredPink,   (a)=> spawnPinkOrbOnRing(planet, innerR, outerR));
    placeRing(desiredFenix,  (a)=> spawnFenixOrbOnRing(planet, innerR, outerR));
    placeRing(desiredZaph,   (a)=> spawnZaphireOrbOnRing(planet, innerR, outerR));
    seedWormholesOnRings(planet, innerR, outerR, Math.max(desiredWorm, Math.floor(ring*0.03)));
    seedBoostOnRings(planet, innerR, outerR, Math.max(desiredBoost, Math.floor(ring*0.03)));
    // Add multiplier orbs in the belt
    const desiredMiner  = Math.min(CAPS.miner,  Math.max(50, Math.floor(ring * 0.15)));   // 5x
    const desiredHunter = Math.min(CAPS.hunter, Math.max(50, Math.floor(ring * 0.15)));   // 5x
    for (let i=0;i<desiredMiner;i++) spawnMinerOrbOnRing(planet, innerR, outerR);
    for (let i=0;i<desiredHunter;i++) spawnHunterOrbOnRing(planet, innerR, outerR);
  }
  function seedZaphireOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.zaphire, Math.max(40, Math.floor(asteroids.length * 0.20)));
    while (zaphireOrbs.length < desired) spawnZaphireOrbAround(shipPosition);
  }
  seedZaphireOrbsFromAsteroidCount();

  // New: Wormhole Orbs (visible bright glow)
  const wormholeOrbs = []; // { mesh, halo, glow, cubeCam, coreMat, radius, bob, bobSpeed, pulseSpeed, lastCubeUpdate }
  function createWormholeAtPosition(pos){
    const rt = new THREE.WebGLCubeRenderTarget(256);
    const cubeCam = new THREE.CubeCamera(0.1, 1000, rt);
    cubeCam.position.copy(pos);
    scene.add(cubeCam);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 1.0, roughness: 0.02, envMap: rt.texture, envMapIntensity: 0.0 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 24, 24), coreMat);
    core.position.copy(pos);
    const halo = new THREE.Mesh(new THREE.RingGeometry(2.2, 4.0, 64), new THREE.MeshBasicMaterial({ color:0xffffff, transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    halo.position.copy(pos); halo.lookAt(camera.position);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0xffffff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(12,12,1);
    scene.add(core, halo, glow);
    wormholeOrbs.push({ mesh:core, halo, glow, cubeCam, coreMat, radius: 1.8, bob: rand()*Math.PI*2, bobSpeed: 1.2 + rand()*1.8, pulseSpeed: 3.0 + rand()*3.0, lastCubeUpdate: 0 });
  }
  function spawnWormholeOrbAround(center, minR=1200, maxR=12000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    createWormholeAtPosition(pos);
  }
  function seedWormholesFromAsteroidCount(){
    const desired = Math.min(CAPS.wormhole, Math.max(40, Math.floor(asteroids.length * 0.20)));
    while (wormholeOrbs.length < desired) spawnWormholeOrbAround(shipPosition);
  }
  seedWormholesFromAsteroidCount();

  // Heavily bias wormholes/boost into planet rings on init
  function seedWormholesOnRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*40; // tighter vertical spread
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      createWormholeAtPosition(new THREE.Vector3(x, planet.position.y + yJitter, z));
    }
  }
  function seedBoostOnRings(planet, innerR, outerR, count){
    for (let i=0;i<count;i++){
      const a = rand()*Math.PI*2;
      const r = innerR + rand()*(outerR-innerR);
      const yJitter = (rand()-0.5)*40;
      const x = planet.position.x + Math.cos(a)*r;
      const z = planet.position.z + Math.sin(a)*r;
      // use existing boost orb creation but at fixed position
      const pos = new THREE.Vector3(x, planet.position.y + yJitter, z);
      const core = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 18), makeAdditiveMaterial(0x33ff77, 0.95)); core.position.copy(pos);
      const ringG = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 48), new THREE.MeshBasicMaterial({ color:0x33ff77, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ringG.position.copy(pos); ringG.lookAt(camera.position);
      const ringP = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.8, 64), new THREE.MeshBasicMaterial({ color:0xaa55ff, transparent:true, opacity:0.45, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ringP.position.copy(pos); ringP.lookAt(camera.position);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0x88ccff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false })); glow.position.copy(pos); glow.scale.set(10,10,1);
      scene.add(core, ringG, ringP, glow);
      boostOrbs.push({ core, ringG, ringP, glow, radius:1.2, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3.0 + rand()*3.0 });
    }
  }
  // Initial ring saturation
  seedWormholesOnRings(targetPlanet, 3600, 5200, 100);
  seedBoostOnRings(targetPlanet, 3600, 5200, 140);
  // Seed extra multiplier orbs immediately for visibility
  for (let i=0;i<80;i++) spawnMinerOrbOnRing(targetPlanet, 3600, 5200);
  for (let i=0;i<80;i++) spawnHunterOrbOnRing(targetPlanet, 3600, 5200);

  // New: Boost Orbs (green + purple)
  function spawnBoostOrbAround(center, minR=800, maxR=9000){
    const r = minR + rand()*(maxR-minR);
    const theta = rand()*Math.PI*2;
    const phi = Math.acos(2*rand()-1);
    const pos = new THREE.Vector3(
      r * Math.sin(phi)*Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi)*Math.sin(theta)
    ).add(center);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.1, 18, 18), makeAdditiveMaterial(0x33ff77, 0.95));
    core.position.copy(pos);
    const ringG = new THREE.Mesh(new THREE.RingGeometry(1.6, 2.6, 48), new THREE.MeshBasicMaterial({ color:0x33ff77, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    ringG.position.copy(pos); ringG.lookAt(camera.position);
    const ringP = new THREE.Mesh(new THREE.RingGeometry(2.8, 3.8, 64), new THREE.MeshBasicMaterial({ color:0xaa55ff, transparent:true, opacity:0.45, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false }));
    ringP.position.copy(pos); ringP.lookAt(camera.position);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: 0x88ccff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.position.copy(pos); glow.scale.set(10,10,1);
    scene.add(core, ringG, ringP, glow);
    boostOrbs.push({ core, ringG, ringP, glow, radius:1.2, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3.0 + rand()*3.0 });
  }

  // New: Miner (green) and Hunter (blue) multiplier orbs
  function spawnMinerOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2; const r = innerR + rand()*(outerR-innerR); const yJ=(rand()-0.5)*40;
    const pos = new THREE.Vector3(planet.position.x+Math.cos(a)*r, planet.position.y+yJ, planet.position.z+Math.sin(a)*r);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.2, 18, 18), makeAdditiveMaterial(0x33ff66, 0.98)); core.position.copy(pos);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.8, 48), new THREE.MeshBasicMaterial({ color:0x66ff99, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ring.position.copy(pos);
    ring.lookAt(camera.position);
    scene.add(core, ring);
    minerOrbs.push({ core, ring, radius:1.3, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3 + rand()*3 });
  }
  function spawnHunterOrbOnRing(planet, innerR=3600, outerR=5200){
    const a = rand()*Math.PI*2; const r = innerR + rand()*(outerR-innerR); const yJ=(rand()-0.5)*40;
    const pos = new THREE.Vector3(planet.position.x+Math.cos(a)*r, planet.position.y+yJ, planet.position.z+Math.sin(a)*r);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.2, 18, 18), makeAdditiveMaterial(0x3399ff, 0.98)); core.position.copy(pos);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.8, 2.8, 48), new THREE.MeshBasicMaterial({ color:0x66aaff, transparent:true, opacity:0.6, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false })); ring.position.copy(pos);
    ring.lookAt(camera.position);
    scene.add(core, ring);
    hunterOrbs.push({ core, ring, radius:1.3, bob: rand()*Math.PI*2, bobSpeed: 1.1 + rand()*1.7, pulseSpeed: 3 + rand()*3 });
  }
  function seedBoostOrbsFromAsteroidCount(){
    const desired = Math.min(CAPS.boost, Math.max(30, Math.floor(asteroids.length * 0.15))); // ~15%
    while (boostOrbs.length < desired) spawnBoostOrbAround(shipPosition);
  }
  seedBoostOrbsFromAsteroidCount();

  // Particles
  const bullets = []; // { mesh, velocity, life, radius, kind?:'player'|'fenix'|'bot' }
  const bulletGeometry = new THREE.SphereGeometry(0.25, 8, 8);
  const beamGeometry = new THREE.CylinderGeometry(0.06, 0.06, 12, 8, 1, true); // thinner Fenix beam

  // Bullet pools (player + fenix only; bots unchanged for now)
  const playerBulletPool = [];
  const fenixBeamPool = [];
  function acquirePlayerBulletMesh(){
    const m = playerBulletPool.pop();
    if (m) return m;
    return new THREE.Mesh(bulletGeometry, new THREE.MeshStandardMaterial({ color: 0x66ffff, emissive: 0x66ffff, emissiveIntensity: 3 }));
  }
  function releasePlayerBulletMesh(mesh){ playerBulletPool.push(mesh); }
  function acquireFenixBeamMesh(){
    const m = fenixBeamPool.pop();
    if (m) return m;
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2222, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    return new THREE.Mesh(beamGeometry, mat);
  }
  function releaseFenixBeamMesh(mesh){ fenixBeamPool.push(mesh); }

  const exhaustParticles = []; // { mesh, vel, life }
  const impactParticles = [];  // { mesh, vel, life }
  // Simple object pools to reduce GC churn
  const exhaustPool = [];
  const impactPool = [];
  function acquireExhaustMesh(){
    const m = exhaustPool.pop();
    if (m) return m;
    return new THREE.Mesh(exhaustGeometry, makeAdditiveMaterial(0x66ccff, 0.7));
  }
  function releaseExhaustMesh(mesh){
    exhaustPool.push(mesh);
  }
  function acquireImpactMesh(baseColor){
    const m = impactPool.pop();
    if (m){ if (m.material && m.material.color) m.material.color.setHex(baseColor); return m; }
    const mat = makeAdditiveMaterial(baseColor, 0.95);
    return new THREE.Mesh(impactGeometry, mat);
  }
  function releaseImpactMesh(mesh){
    impactPool.push(mesh);
  }
  const exhaustGeometry = new THREE.SphereGeometry(0.18, 6, 6);
  const impactGeometry = new THREE.SphereGeometry(0.22, 6, 6);

  // Ring burst effect (used by several orbs/events)
  const ringBursts = []; // { mesh, life, growth, fade }
  const ringGeo = new THREE.RingGeometry(0.6, 0.9, 48);
  function spawnShieldRing(position, color=0x66ff99){
    const mat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, side:THREE.DoubleSide, depthWrite:false });
    const ring = new THREE.Mesh(ringGeo, mat);
    ring.position.copy(position);
    scene.add(ring);
    ringBursts.push({ mesh:ring, life: 0.6, growth: 6.0, fade: 1.5 });
  }

  function spawnExhaust(ratePerSec, dt){
    const count = Math.max(0, Math.floor(ratePerSec * dt));
    if (count === 0) return;
    let q;
    q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const back = new THREE.Vector3(0,0,1).applyQuaternion(q).normalize().multiplyScalar(-1);
    // Move the exhaust origin further back as speed rises to avoid a visible gap
    const backOffset = 1.6 + Math.min(8, speedUnitsPerSec * 0.04);
    const basePos = shipPosition;
    const origin = new THREE.Vector3().copy(basePos)
      .addScaledVector(back, backOffset)
      .add(new THREE.Vector3(0,0.25,0).applyQuaternion(q));
    for (let i=0;i<count;i++){
      const p = acquireExhaustMesh();
      p.position.copy(origin).add(randomVel(0.4));
      p.scale.setScalar(0.6 + Math.random()*0.5);
      if (!p.parent) scene.add(p);
      // Give particles some ship velocity so the trail stays connected and smooth at high speeds
      const vel = new THREE.Vector3().copy(velocity)
        .add(back.clone().multiplyScalar(14 + speedUnitsPerSec*0.55))
        .add(randomVel(0.8));
      exhaustParticles.push({ mesh:p, vel, life: 0.5 + Math.random()*0.25 });
    }
  }

  function spawnImpactBurst(position, baseColor=0xffaa66, count=26){
    for (let i=0;i<count;i++){
      const p = acquireImpactMesh(baseColor);
      p.position.copy(position);
      p.scale.setScalar(0.7 + Math.random()*0.9);
      if (!p.parent) scene.add(p);
      const vel = randomVel(20);
      impactParticles.push({ mesh:p, vel, life: 0.6 + Math.random()*0.2 });
    }
    cameraShake += 0.6;
  }

  // Shield-specific explosion (green variants for pickup/shot)
  function spawnShieldExplosion(position, variant='pickup'){
    const mainColor = variant === 'shot' ? 0x99ffcc : 0x66ff99;
    const count = variant === 'shot' ? 16 : 28;
    for (let i=0;i<count;i++){
      const p = acquireImpactMesh(mainColor);
      p.position.copy(position);
      p.scale.setScalar(0.6 + Math.random()*1.0);
      if (!p.parent) scene.add(p);
      const vel = randomVel(variant === 'shot' ? 16 : 12);
      impactParticles.push({ mesh:p, vel, life: variant === 'shot' ? (0.45 + Math.random()*0.2) : (0.7 + Math.random()*0.25) });
    }
    spawnShieldRing(position, mainColor);
    cameraShake += (variant === 'shot' ? 0.25 : 0.15);
  }

  function shoot() {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    const tipWorld = new THREE.Vector3().copy(shipPosition).add(dir.clone().multiplyScalar(1.8));

    if (fenixActive) {
      const beam = acquireFenixBeamMesh();
      const alignQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0), dir);
      beam.quaternion.copy(alignQuat);
      const halfLen = 6; // visual length only; reach is controlled by life * speed
      beam.position.copy(tipWorld).add(dir.clone().multiplyScalar(halfLen));
      if (!beam.parent) scene.add(beam);
      bullets.push({ mesh: beam, velocity: dir.multiplyScalar(FENIX_BEAM_SPEED), life: FENIX_BEAM_LIFE, radius: 0.45, kind:'fenix' });
    } else {
      const bullet = acquirePlayerBulletMesh();
      bullet.position.copy(tipWorld);
      if (!bullet.parent) scene.add(bullet);
      bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(DEFAULT_BULLET_SPEED), life: DEFAULT_BULLET_LIFE, radius: 0.25, kind:'player' });
    }
    cameraShake += 0.05;
    // Notify server for authoritative hitscan
    if (MP.ws && MP.ws.readyState === 1){
      try{ MP.ws.send(JSON.stringify({ type:'shoot', t: Date.now(), p:[tipWorld.x, tipWorld.y, tipWorld.z], dir:[dir.x, dir.y, dir.z], fenix: !!fenixActive })); }catch(_){ }
    }
  }

  // Inputs
  const input = { yawLeft:false, yawRight:false, pitchUp:false, pitchDown:false, speedUp:false, speedDown:false, fire:false, toggleLb:false };
  function onKeyDown(e){
    // Disable game controls while welcome screen is visible or when typing in inputs
    const active = document.activeElement;
    const typing = active && ((active.tagName==='INPUT') || (active.tagName==='TEXTAREA') || active.isContentEditable);
    const welcomeVisible = !!(welcomeScreen && !welcomeScreen.classList.contains('hidden'));
    if (welcomeVisible || typing || (typeof isControlsLocked==='function' && isControlsLocked())){ return; }
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR','KeyT','KeyL','KeyP','KeyN'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    // Standard yaw: Left/A => yaw left, Right/D => yaw right
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = true;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = true;
    // Throttle on W/S
    if (c==='KeyW') input.speedUp = true;
    if (c==='KeyS') input.speedDown = true;
    // Standard pitch: Up/I => pitch up, Down/K => pitch down (mouse unchanged)
    if (c==='ArrowUp'||c==='KeyI') input.pitchUp = true;
    if (c==='ArrowDown'||c==='KeyK') input.pitchDown = true;
    if (c==='Space') input.fire = true;
    if (c==='KeyH') {
      const to = new THREE.Vector3().copy(targetPlanet.position).sub(shipPosition).normalize();
      yaw = Math.atan2(to.x, to.z);
      pitch = Math.asin(THREE.MathUtils.clamp(to.y, -1, 1));
      targetSpeedUnitsPerSec = Math.max(targetSpeedUnitsPerSec, 22);
    }
    if (c==='KeyN') {
      if (welcomeScreen){ welcomeScreen.classList.remove('hidden'); const inp = document.getElementById('pilot-name-input'); if (inp) inp.focus(); }
    }
    if (c==='KeyT') {
      devTurboActive = !devTurboActive;
      if (devTurboActive){
        targetSpeedUnitsPerSec = DEV_TURBO_SPEED;
        spawnCenteredTextLabel('DEV 500', shipPosition, 0xffee88, 2.2, 1.4);
      } else {
        targetSpeedUnitsPerSec = Math.min(targetSpeedUnitsPerSec, baseMaxSpeed);
        spawnCenteredTextLabel('DEV OFF', shipPosition, 0xff8888, 2.0, 1.2);
      }
    }
    if (c==='KeyL') { input.toggleLb = true; renderLb(); ensureLbOverlay().style.display = (ensureLbOverlay().style.display==='none'?'block':'none'); }
    if (c==='KeyP') { mpOverlayOn = !mpOverlayOn; ensureMpOverlay().style.display = mpOverlayOn ? 'block' : 'none'; renderMpOverlay(); }
    if (c==='KeyR' && gameOver) resetGame();
  }
  function onKeyUp(e){
    const active = document.activeElement;
    const typing = active && ((active.tagName==='INPUT') || (active.tagName==='TEXTAREA') || active.isContentEditable);
    const welcomeVisible = !!(welcomeScreen && !welcomeScreen.classList.contains('hidden'));
    if (welcomeVisible || typing || (typeof isControlsLocked==='function' && isControlsLocked())){ return; }
    const c = e.code;
    const handled = ['ArrowLeft','ArrowRight','KeyA','KeyD','ArrowUp','ArrowDown','KeyW','KeyS','Space','KeyI','KeyK','KeyH','KeyR','KeyT','KeyL','KeyN'].includes(c);
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    if (c==='ArrowLeft'||c==='KeyA') input.yawLeft = false;
    if (c==='ArrowRight'||c==='KeyD') input.yawRight = false;
    if (c==='KeyW') input.speedUp = false;
    if (c==='KeyS') input.speedDown = false;
    if (c==='ArrowUp'||c==='KeyI') input.pitchUp = false;
    if (c==='ArrowDown'||c==='KeyK') input.pitchDown = false;
    if (c==='Space') input.fire = false;
    if (c==='KeyL') input.toggleLb = false;
  }
  document.addEventListener('keydown', onKeyDown, { capture:true });
  document.addEventListener('keyup', onKeyUp, { capture:true });
  window.addEventListener('keydown', onKeyDown, { capture:true });
  window.addEventListener('keyup', onKeyUp, { capture:true });
  window.addEventListener('pointerdown', e => { if (e.target === canvas) { canvas.focus(); mouseDown = true; } }, { capture:true });
  window.addEventListener('pointerup', () => { mouseDown = false; });
  window.addEventListener('pointermove', e => {
    mouseX = (e.clientX / window.innerWidth) * 2 - 1;
    mouseY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // HUD
  let score = 0;
  let roundActive = false;
  let roundEndsAt = 0; // epoch ms when the 3-minute round ends
  let roundSubmitted = false; // prevent duplicate submits per round
  let killsCount = 0;
  let asteroidsDestroyed = 0;
  let beltTimeSec = 0;
  // Multipliers and belt scoring
  let asteroidMultTimer = 0; // seconds for x2 asteroid points
  let killMultTimer = 0;     // seconds for x2 kill points
  let lastFireTimer = 0;     // seconds since last shot
  let beltPassiveAccu = 0;   // fractional accumulator for passive belt points
  function updateHud() {
    const speedTxt = speedUnitsPerSec.toFixed(1);
    const distFromOrigin = shipPosition.length().toFixed(0);
    const distToTarget = shipPosition.distanceTo(targetPlanet.position).toFixed(0);
    const hp = Math.max(0, Math.round(health));
    const sh = Math.max(0, Math.round(shield));
    const ax2 = asteroidMultTimer>0 ? ` | Ax2 ${Math.ceil(asteroidMultTimer)}s` : '';
    const kx2 = killMultTimer>0 ? ` | Kx2 ${Math.ceil(killMultTimer)}s` : '';
    let mp = '';
    if (MP && MP.ws){
      const st = MP.ws.readyState;
      const status = st===1?`ON (${MP.remotes.size+1||1})`:(st===0? 'CONNECTING':'OFF');
      mp = ` | MP ${status}`;
    }
    const timeLeftSec = roundActive ? Math.max(0, Math.ceil((roundEndsAt - Date.now())/1000)) : 0;
    const timeText = roundActive ? ` | Time ${Math.floor(timeLeftSec/60)}:${String(timeLeftSec%60).padStart(2,'0')}` : '';
    hud.textContent = `Speed ${speedTxt}${timeText} | HP ${hp}% | Shield ${sh}% | Points ${score} | Kills ${killsCount} | Ast ${asteroidsDestroyed}${ax2}${kx2} | Dist ${distFromOrigin} | Target ${distToTarget}${mp}`;
  }

  function showGameOver(){ gameOverEl.style.display = 'block'; }
  function hideGameOver(){ gameOverEl.style.display = 'none'; }

  // Leaderboards (local with optional server sync)
  let survivalStartMs = performance.now();
  let statsSaved = false;
  let serverAvailable = false;
  async function detectServer(){
    const defaultApi = `http://${location.hostname}:8787`;
    const url = window.ORBIT_RUNNER_API || defaultApi;
    try{ const r = await fetch(url + '/health', { method:'GET', mode:'cors' }); if (r.ok){ window.ORBIT_RUNNER_API = url; serverAvailable = true; } }
    catch(_){ serverAvailable = false; }
  }
  detectServer();
  // Use structured welcome screen in index.html; no dynamic overlay needed now

  // Identity (local only; for display on leaderboards)
  function getOrMakeUid(){
    let id = localStorage.getItem('or_uid');
    if (!id){ id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('or_uid', id); }
    return id;
  }
  function getPlayerName(){ return localStorage.getItem('or_name') || ''; }
  function ensurePlayerName(){ return localStorage.getItem('or_name') || playerName || ''; }

  // Live server leaderboards via WebSocket
  let lbWs = null;
  let latestServerLB = null;
  function connectLbWS(){
    if (!serverAvailable || lbWs) return;
    try {
      const httpBase = window.ORBIT_RUNNER_API || `http://${location.hostname}:8787`;
      const wsUrl = httpBase.replace(/^http/, 'ws');
      lbWs = new WebSocket(wsUrl);
      lbWs.onmessage = (ev)=>{
        try {
          const msg = JSON.parse(ev.data);
          if (msg && msg.type === 'leaderboards'){ latestServerLB = msg.payload; if (lbOverlay && lbOverlay.style.display !== 'none') renderLb(); }
        } catch(_){}
      };
      lbWs.onclose = ()=>{ lbWs = null; setTimeout(connectLbWS, 2000); };
      lbWs.onerror = ()=>{ try{ lbWs.close(); }catch(_){} };
    } catch(_){}
  }
  // try to connect shortly after detection
  setTimeout(connectLbWS, 500);
  
  // --- Multiplayer (input → server, binary state ← server) ---
  const MP = {
    active: false,
    ws: null,
    myId: null,
    myNumId: null,
    worldSeed: 0,
    serverOffsetMs: 0,
    serverOffsetEma: null,
    idToNum: new Map(), // string id -> numId
    remotes: new Map(), // numId -> { mesh, samples:[{t,p,q,v}], lastRender:{p,q} }
    selfServerState: null,
  };

  function vec3From(arr){ return new THREE.Vector3(arr[0]||0, arr[1]||0, arr[2]||0); }
  function quatFrom(arr){ return new THREE.Quaternion(arr[0]||0, arr[1]||0, arr[2]||0, arr[3]||1); }
  function lerpQuat(a, b, t){ return a.clone().slerp(b, t); }

  function createRemoteShip(numId){
    const m = buildDefaultShip();
    m.matrixAutoUpdate = true;
    scene.add(m);
    MP.remotes.set(numId, { mesh: m, samples: [], lastRender: { p: new THREE.Vector3(), q: new THREE.Quaternion() } });
  }
  function removeRemoteShipByNumId(numId){
    const r = MP.remotes.get(numId); if (!r) return;
    try { scene.remove(r.mesh); } catch(_){}
    MP.remotes.delete(numId);
  }

  async function handleMpMessage(ev){
    if (!ev || !ev.data) return;
    if (typeof ev.data !== 'string'){
      // Ignore early binary frames until we've received 'welcome'
      if (!MP.active) return;
      // Binary state buffer
      const buf = ev.data instanceof ArrayBuffer ? ev.data : await ev.data.arrayBuffer();
      const dv = new DataView(buf);
      const BYTES_PER = 2 + 4 + 12 + 16 + 12 + 1;
      const count = Math.floor(dv.byteLength / BYTES_PER);
      let off = 0;
      const nowLocal = Date.now();
      for (let i=0;i<count;i++){
        const numId = dv.getUint16(off); off+=2;
        const t = dv.getUint32(off); off+=4;
        const p = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8)]; off+=12;
        const q = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8), dv.getFloat32(off+12)]; off+=16;
        const v = [dv.getFloat32(off), dv.getFloat32(off+4), dv.getFloat32(off+8)]; off+=12;
        const flags = dv.getUint8(off); off+=1;
        // Do not update offset here (use ping/pong for more stable estimate)
        if (numId === MP.myNumId){
          // Track authoritative self state for resync after tab visibility changes, but do not render from it in real-time
          MP.selfServerState = { t, p, q, v, flags };
          if ((i%12)===0) dbg('self-state', { t, p, v });
          continue;
        }
        let r = MP.remotes.get(numId);
        if (!r){ createRemoteShip(numId); r = MP.remotes.get(numId); }
        const MAX_BUF = 30;
        r.samples.push({ t, p, q, v, flags });
        if (r.samples.length > MAX_BUF) r.samples.shift();
      }
      return;
    }
    // JSON control/event message
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome'){
        dbg('welcome', { you: msg.playerId, players: (msg.players||[]).length, seed: msg.worldSeed });
        MP.active = true;
        MP.myId = msg.playerId;
        MP.worldSeed = msg.worldSeed;
        // Build id->num and remote meshes
        MP.idToNum.clear();
        // Remove any prior remote meshes (fresh session)
        for (const [nid, r] of MP.remotes){ try{ scene.remove(r.mesh); }catch(_){} }
        MP.remotes.clear();
        for (const p of (msg.players||[])){
          if (p.id === msg.playerId){ MP.myNumId = p.numId; continue; }
          if (p.numId!=null){ MP.idToNum.set(p.id, p.numId); createRemoteShip(p.numId); }
        }
        return;
      }
      if (msg.type === 'respawn'){
        dbg('respawn', { id: msg.id, p: msg.p });
        if (msg.id === MP.myId){
          const p = vec3From(msg.p), q = quatFrom(msg.q);
          shipPosition.copy(p); ship.position.copy(p);
          ship.quaternion.copy(q);
        } else {
          const numId = MP.idToNum.get(msg.id);
          const r = numId!=null ? MP.remotes.get(numId) : null;
          if (r){ r.mesh.position.copy(vec3From(msg.p)); r.mesh.quaternion.copy(quatFrom(msg.q)); r.samples.length = 0; }
        }
        return;
      }
      if (msg.type === 'hit'){
        if (msg.id === MP.myId){ cameraShake += 0.4; }
        return;
      }
      if (msg.type === 'player-add'){
        if (msg.id === MP.myId) return;
        if (msg.numId!=null){ MP.idToNum.set(msg.id, msg.numId); createRemoteShip(msg.numId); }
        return;
      }
      if (msg.type === 'player-remove'){
        const numId = MP.idToNum.get(msg.id);
        if (numId!=null){ removeRemoteShipByNumId(numId); MP.idToNum.delete(msg.id); }
        return;
      }
      if (msg.type === 'room-stats'){
        latestRoomStats = msg.players||[];
        // Ensure remotes exist for any known ids
        for (const p of latestRoomStats){
          if (p.id && p.id !== MP.myId){
            const numId = MP.idToNum.get(p.id);
            if (numId!=null){ if (!MP.remotes.get(numId)) createRemoteShip(numId); }
          }
        }
        renderMpOverlay();
        return;
      }
      if (msg.type === 'pong'){
        const nowLocal = Date.now();
        const rtt = nowLocal - msg.tClient;
        const estServerNow = msg.tServer + rtt*0.5;
        const estOffset = estServerNow - nowLocal;
        MP.serverOffsetEma = (MP.serverOffsetEma==null? estOffset : MP.serverOffsetEma*0.8 + estOffset*0.2);
        return;
      }
    } catch(_){}
  }

  function connectMP(){
    if (!serverAvailable || MP.ws) return;
    try {
      const httpBase = window.ORBIT_RUNNER_API || `http://${location.hostname}:8787`;
      const wsUrl = httpBase.replace(/^http/, 'ws') + '/mp';
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      ws.onopen = ()=>{ dbg('ws-open'); ws.send(JSON.stringify({ type:'hello', name: ensurePlayerName(), clientVersion: 'mp1' })); };
      ws.onmessage = handleMpMessage;
      ws.onclose = ()=>{ dbg('ws-close'); MP.ws = null; MP.active = false; setTimeout(connectMP, 1500); };
      ws.onerror = (e)=>{ dbg('ws-error', { e: String(e?.message||e) }); try{ ws.close(); }catch(_){} };
      MP.ws = ws;
    } catch(_){ /* ignore */ }
  }

  // Send inputs at 30 Hz
  setInterval(()=>{
    if (!MP.ws || MP.ws.readyState !== 1) return;
    const yawKeys = (input.yawRight?-1:0) + (input.yawLeft?1:0);
    const pitchKeys = (input.pitchUp?1:0) + (input.pitchDown?-1:0);
    const yawInput = yawKeys + (mouseDown ? mouseX*0.6 : 0);
    const pitchInput = pitchKeys + (mouseDown ? -mouseY*0.6 : 0);
    const throttle = THREE.MathUtils.clamp((targetSpeedUnitsPerSec - minSpeed) / (baseMaxSpeed - minSpeed), 0, 1);
    const msg = { type:'input', t: Date.now(), throttle, yaw: THREE.MathUtils.clamp(yawInput, -1, 1), pitch: THREE.MathUtils.clamp(pitchInput, -1, 1), roll: 0, boost: boostActive, fire: !!input.fire, fenix: !!fenixActive };
    try{ MP.ws.send(JSON.stringify(msg)); }catch(_){ }
    // Periodically send score to update room-stats overlay
    if ((Math.floor(Date.now()/1000) % 2) === 0){ try{ MP.ws.send(JSON.stringify({ type:'score', v: (score>>>0) })); }catch(_){ } }
  }, 33);

  // Defer MP connect slightly after server detection
  // MP connect happens after home overlay triggers startGame()

  // When MP becomes active (welcome), rebuild deterministic world
  const originalSeedAll = seedAllOrbsInRingByProportion;
  function rebuildWorldForMP(){
    if (!MP.active) return;
    // Reset world random and clear existing spawned collections
    setRand(MP.worldSeed>>>0);
    // Clear existing orbs and asteroids
    for (const a of asteroids){ scene.remove(a.mesh); }
    asteroids.length = 0;
    disposeRingInstancedGroups();
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } fenixOrbs.length = 0;
    for (const o of zaphireOrbs) { scene.remove(o.mesh); if (o.glow) scene.remove(o.glow); } zaphireOrbs.length = 0;
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;
    for (const o of minerOrbs) { scene.remove(o.core); scene.remove(o.ring); } minerOrbs.length = 0;
    for (const o of hunterOrbs) { scene.remove(o.core); scene.remove(o.ring); } hunterOrbs.length = 0;

    // Reseed deterministic world
    seedAsteroids(7000, 1400, new THREE.Vector3());
    createRings(targetPlanet, 3600, 5200, 13000);
    buildRingInstancedGroups(3);
    seedAllOrbsInRingByProportion(targetPlanet, 3600, 5200);
  }

  // Hook welcome to trigger rebuild
  const prevHandleMpMessage = handleMpMessage;
  handleMpMessage = async function(ev){
    const wasActive = MP.active;
    await prevHandleMpMessage(ev);
    if (!wasActive && MP.active){ rebuildWorldForMP(); }
  };

  // Ping loop to estimate server offset (ms)
  setInterval(()=>{
    if (!MP.ws || MP.ws.readyState!==1) return;
    try{ MP.ws.send(JSON.stringify({ type:'ping', t: Date.now() })); }catch(_){ }
  }, 1000);

  // Reconcile local player gently to server truth when drift is large
  function reconcileSelf(dt, allowSnap = true){
    if (!MP.active || !MP.selfServerState) return;
    const s = MP.selfServerState;
    const sp = vec3From(s.p);
    const sq = quatFrom(s.q);
    const posErr = shipPosition.distanceTo(sp);
    if (allowSnap && posErr > 10){ // snap if way off (disabled on focus)
      shipPosition.copy(sp); ship.position.copy(sp); ship.quaternion.copy(sq);
      return;
    }
    if (posErr > 2){ // gentle nudge toward server
      const alpha = Math.min(0.5, dt*0.8);
      shipPosition.lerp(sp, alpha); ship.position.copy(shipPosition);
      ship.quaternion.slerp(sq, alpha);
    }
  }

  // When tab visibility changes, perform a short soft reconciliation after focus (no hard snap)
  let focusReconcileTimer = 0;
  document.addEventListener('visibilitychange', ()=>{
    if (!document.hidden){
      dbg('focus');
      // Show reconnect overlay and require user action
      showReconnectOverlay();
    } else {
      dbg('hidden');
      input.fire = false;
    }
  });
  function getSessionStats(){
    const now = performance.now();
    const survivalSec = Math.max(0, Math.round((now - survivalStartMs)/1000));
    return {
      ts: Date.now(),
      uid: getOrMakeUid(),
      name: getPlayerName(),
      points: score,
      kills: killsCount,
      asteroids: asteroidsDestroyed,
      beltTimeSec: Math.round(beltTimeSec),
      survivalSec,
    };
  }
  function pushTop(list, rec, key, maxLen=10){
    list.push(rec); list.sort((a,b)=> (b[key]||0)-(a[key]||0)); if (list.length>maxLen) list.length=maxLen; return list;
  }
  function saveLeaderboards(){
    const s = getSessionStats();
    try{
      const parse = k => { const v = localStorage.getItem(k); return v? JSON.parse(v): []; };
      const save  = (k,arr)=> localStorage.setItem(k, JSON.stringify(arr));
      save('or_sessions', pushTop(parse('or_sessions'), s, 'ts', 50));
      save('or_lb_points', pushTop(parse('or_lb_points'), s, 'points'));
      save('or_lb_kills', pushTop(parse('or_lb_kills'), s, 'kills'));
      save('or_lb_asteroids', pushTop(parse('or_lb_asteroids'), s, 'asteroids'));
      save('or_lb_belt', pushTop(parse('or_lb_belt'), s, 'beltTimeSec'));
      save('or_lb_survival', pushTop(parse('or_lb_survival'), s, 'survivalSec'));
      // fire-and-forget sync endpoint if configured
      if (window.ORBIT_RUNNER_API){
        fetch(`${window.ORBIT_RUNNER_API}/submit`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(s) }).catch(()=>{});
      }
    }catch(e){ console.warn('Leaderboard save failed', e); }
  }

  // Simple overlay to view top 5 leaderboards
  let lbOverlay = null;
  function ensureLbOverlay(){
    if (lbOverlay) return lbOverlay;
    const d = document.createElement('div');
    d.id = 'leaderboards';
    Object.assign(d.style, { position:'absolute', right:'10px', top:'10px', padding:'10px', background:'rgba(0,0,0,0.6)', color:'#fff', fontSize:'12px', border:'1px solid rgba(255,255,255,0.2)', borderRadius:'8px', maxWidth:'360px', display:'none', zIndex:'9998' });
    document.body.appendChild(d); lbOverlay = d; return d;
  }
  async function renderLb(){
    ensureLbOverlay();
    const get = k => { const v = localStorage.getItem(k); return v? JSON.parse(v): []; };
    const fmt = (s)=> new Date(s.ts).toLocaleTimeString();
    const rows = (arr,key,unit='')=> arr.slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')} • ${fmt(r)}</div>`).join('') || '<div>—</div>';
    let html = `
      <div style="font-weight:700;margin-bottom:6px">Leaderboards (Top 5)</div>
      <div><b>Survival</b>${rows(get('or_lb_survival'),'survivalSec','s')}</div>
      <div><b>Kills</b>${rows(get('or_lb_kills'),'kills')}</div>
      <div><b>Asteroids</b>${rows(get('or_lb_asteroids'),'asteroids')}</div>
      <div><b>Belt Time</b>${rows(get('or_lb_belt'),'beltTimeSec','s')}</div>
      <div><b>Points</b>${rows(get('or_lb_points'),'points')}</div>
    `;
    if (serverAvailable){
      if (latestServerLB){
        const rrows = (arr,key,unit='')=> (arr||[]).slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')}</div>`).join('') || '<div>—</div>';
        html += `
          <div style=\"margin-top:8px;font-weight:700\">Server (live)</div>
          <div><b>Survival</b>${rrows(latestServerLB.survival,'survivalSec','s')}</div>
          <div><b>Kills</b>${rrows(latestServerLB.kills,'kills')}</div>
          <div><b>Asteroids</b>${rrows(latestServerLB.asteroids,'asteroids')}</div>
          <div><b>Belt Time</b>${rrows(latestServerLB.belt,'beltTimeSec','s')}</div>
          <div><b>Points</b>${rrows(latestServerLB.points,'points')}</div>
        `;
      } else {
      try{
        const r = await fetch(window.ORBIT_RUNNER_API + '/leaderboards', { mode:'cors' });
        if (r.ok){
          const data = await r.json();
          const rrows = (arr,key,unit='')=> (arr||[]).slice(0,5).map(r=>`<div>${r[key]}${unit} • Pts ${r.points} • ${(r.name||'Anon')}</div>`).join('') || '<div>—</div>';
          html += `
            <div style=\"margin-top:8px;font-weight:700\">Server</div>
            <div><b>Survival</b>${rrows(data.survival,'survivalSec','s')}</div>
            <div><b>Kills</b>${rrows(data.kills,'kills')}</div>
            <div><b>Asteroids</b>${rrows(data.asteroids,'asteroids')}</div>
            <div><b>Belt Time</b>${rrows(data.belt,'beltTimeSec','s')}</div>
            <div><b>Points</b>${rrows(data.points,'points')}</div>
          `;
        }
      }catch(_){ /* ignore */ }
      }
    }
    lbOverlay.innerHTML = html;
  }

  // Simple helper to spawn centered 3D text with color
  function spawnCenteredTextLabel(text, position, color=0xffffff, size=2.0, life=2.5){
    if (!gameFont) return;
    const geo = new TextGeometry(text, { font: gameFont, size, depth: 0.5, curveSegments: 8 });
    geo.computeBoundingBox(); geo.center();
    const mat = new THREE.MeshBasicMaterial({ color, transparent:true, opacity:1, blending:THREE.AdditiveBlending, depthWrite:false });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(position).add(new THREE.Vector3(0, 3, 0));
    scene.add(mesh);
    duendeTextLabels.push({ group: mesh, life }); // reuse label updater; treat as group
  }

  // Store Overlay UI
  let storeOverlay = null;
  function ensureStoreOverlay(){
    if (storeOverlay) return storeOverlay;
    const overlay = document.createElement('div');
    overlay.id = 'storeOverlay';
    Object.assign(overlay.style, {
      position:'fixed', inset:'0', background:'rgba(0,0,0,0.35)', display:'none', zIndex:'9999',
      color:'#fff', fontFamily:'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Helvetica Neue, Arial, Noto Sans, sans-serif'
    });

    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position:'absolute', left:'50%', top:'50%', transform:'translate(-50%,-50%)',
      width:'min(520px, 90vw)', background:'rgba(20,20,26,0.85)', border:'1px solid rgba(255,255,255,0.2)', borderRadius:'10px',
      boxShadow:'0 12px 30px rgba(0,0,0,0.45)', padding:'16px 16px 60px 16px'
    });

    const header = document.createElement('div');
    header.textContent = 'Store';
    Object.assign(header.style, { fontSize:'22px', fontWeight:'700', marginBottom:'10px' });

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    Object.assign(closeBtn.style, {
      position:'absolute', right:'10px', top:'10px', width:'32px', height:'32px', border:'none', borderRadius:'6px',
      color:'#fff', background:'rgba(255,255,255,0.15)', cursor:'pointer'
    });
    closeBtn.onclick = () => hideStoreOverlay();

    const list = document.createElement('ul');
    Object.assign(list.style, { listStyle:'none', padding:'0', margin:'6px 0 0 0', lineHeight:'1.8' });
    const items = [
      { key:'hp', label:'HP +100% (Cost: 1500)', cost:1500, action: () => { health = 100; } },
      { key:'fenix', label:'Fenix Upgrade (Cost: 2000)', cost:2000, action: () => { transformToFenixShip(); } },
      { key:'shield', label:'Shield +100% (Cost: 1000)', cost:1000, action: () => { shield = 100; } },
    ];
    items.forEach(entry => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.gap = '10px';
      const span = document.createElement('span'); span.textContent = entry.label;
      const buy = document.createElement('button'); buy.textContent = 'Buy';
      Object.assign(buy.style, { padding:'4px 10px', border:'none', borderRadius:'6px', cursor:'pointer', background:'rgba(0,255,180,0.25)', color:'#fff' });
      buy.onclick = () => {
        if (score >= entry.cost){
          score -= entry.cost;
          entry.action();
          updateHud();
          hideStoreOverlay();
        } else {
          buy.textContent = 'Not enough points';
          setTimeout(()=>{ buy.textContent = 'Buy'; }, 1200);
        }
      };
      li.append(span, buy); list.appendChild(li);
    });

    const actions = document.createElement('div');
    Object.assign(actions.style, {
      position:'absolute', left:'0', right:'0', bottom:'10px', display:'flex', gap:'10px', justifyContent:'center'
    });
    const accept = document.createElement('button'); accept.textContent = 'Accept';
    const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
    [accept,cancel].forEach(btn => Object.assign(btn.style, { padding:'8px 18px', border:'none', borderRadius:'8px', cursor:'pointer',
      background:'rgba(255,255,255,0.2)', color:'#fff' }));
    accept.onclick = () => hideStoreOverlay();
    cancel.onclick = () => hideStoreOverlay();
    actions.append(accept, cancel);

    panel.append(header, closeBtn, list, actions);
    overlay.append(panel);
    document.body.appendChild(overlay);
    storeOverlay = overlay; return overlay;
  }
  function rebuildStoreOverlay(){ if (storeOverlay){ try { document.body.removeChild(storeOverlay); } catch(_){} storeOverlay = null; } ensureStoreOverlay(); }
  function showStoreOverlay(){ rebuildStoreOverlay(); storeOverlay.style.display = 'block'; }
  function hideStoreOverlay(){ if (storeOverlay) storeOverlay.style.display = 'none'; }

  // Population/field maintenance
  function keepFieldPopulated() {
    const maxDist = 16000;
    for (let i = asteroids.length - 1; i >= 0; i--) {
      const a = asteroids[i];
      if (!a.inRing && a.mesh.position.distanceTo(shipPosition) > maxDist) {
        scene.remove(a.mesh);
        asteroids.splice(i,1);
      }
    }

    const distToPlanet = shipPosition.distanceTo(targetPlanet.position);
    const t = THREE.MathUtils.clamp(1 - (distToPlanet / 22000), 0, 1);
    const desiredAmbient = Math.floor(7000 + t * 7000);
    let ambientCount = 0; for (const a of asteroids) if (!a.inRing) ambientCount++;
    // Disable dynamic spawning to avoid sudden configuration changes in MP
    // while (ambientCount < desiredAmbient) { spawnAsteroidAround(shipPosition, 800, 11000); ambientCount++; }

    let excess = ambientCount - Math.floor(desiredAmbient * 1.2);
    // Disable dynamic removal to keep layout stable for MP experience
    // if (excess > 0){ ... }

    const desiredOrbs = Math.min(CAPS.shield, Math.max(12, Math.floor(asteroids.length * 0.05)));
    for (let i = shieldOrbs.length - 1; i >= 0; i--){
      const o = shieldOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); shieldOrbs.splice(i,1); }
    }
    while (shieldOrbs.length < desiredOrbs) spawnShieldOrbAround(shipPosition);

    const desiredPink = Math.min(CAPS.pink, Math.max(6, Math.floor(asteroids.length * 0.01)));
    for (let i = pinkOrbs.length - 1; i >= 0; i--){
      const o = pinkOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.mesh); pinkOrbs.splice(i,1); }
    }
    while (pinkOrbs.length < desiredPink) spawnPinkOrbAround(shipPosition);

    const desiredFenix = Math.min(CAPS.fenix, Math.max(20, Math.floor(asteroids.length * 0.10)));
    for (let i = fenixOrbs.length - 1; i >= 0; i--){
      const o = fenixOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ if (o.glow) scene.remove(o.glow); scene.remove(o.mesh); fenixOrbs.splice(i,1); }
    }
    while (fenixOrbs.length < desiredFenix) spawnFenixOrbAround(shipPosition);

    const desiredZaphire = Math.min(CAPS.zaphire, Math.max(40, Math.floor(asteroids.length * 0.20)));
    for (let i = zaphireOrbs.length - 1; i >= 0; i--){
      const o = zaphireOrbs[i];
      if (!o.mesh.parent || o.mesh.position.distanceTo(shipPosition) > maxDist){ if (o.glow) scene.remove(o.glow); scene.remove(o.mesh); zaphireOrbs.splice(i,1); }
    }
    while (zaphireOrbs.length < desiredZaphire) spawnZaphireOrbAround(shipPosition);

    const desiredWormholes = Math.min(CAPS.wormhole, Math.max(40, Math.floor(asteroids.length * 0.20)));
    for (let i = wormholeOrbs.length - 1; i >= 0; i--){
      const w = wormholeOrbs[i];
      if (!w.mesh.parent || w.mesh.position.distanceTo(shipPosition) > maxDist){ scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); wormholeOrbs.splice(i,1); }
    }
    while (wormholeOrbs.length < desiredWormholes) spawnWormholeOrbAround(shipPosition);

    const desiredBoost = Math.min(CAPS.boost, Math.max(30, Math.floor(asteroids.length * 0.15)));
    for (let i = boostOrbs.length - 1; i >= 0; i--){
      const o = boostOrbs[i];
      if (!o.core.parent || o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); boostOrbs.splice(i,1); }
    }

    // clean multiplier orbs
    for (let i = minerOrbs.length - 1; i >= 0; i--){ const o = minerOrbs[i]; if (!o.core.parent) { minerOrbs.splice(i,1); continue; } if (o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ring); minerOrbs.splice(i,1);} }
    for (let i = hunterOrbs.length - 1; i >= 0; i--){ const o = hunterOrbs[i]; if (!o.core.parent) { hunterOrbs.splice(i,1); continue; } if (o.core.position.distanceTo(shipPosition) > maxDist){ scene.remove(o.core); scene.remove(o.ring); hunterOrbs.splice(i,1);} }
    while (boostOrbs.length < desiredBoost) spawnBoostOrbAround(shipPosition);

    ensurePatches();
  }

  function applyCrashDamage(type, hitPosition){
    if (damageCooldown > 0 || gameOver) return;
    const dmgFactor = (type === 'asteroid' && fenixActive) ? 0.5 : 1.0;
    if (type === 'asteroid'){
      const healthDamage = (45 + Math.random()*30) * dmgFactor;
      const shieldDamage = (22 + Math.random()*22) * dmgFactor;
      if (shield > 0){ shield = Math.max(0, shield - shieldDamage); }
      health = Math.max(0, health - healthDamage);
      spawnImpactBurst(hitPosition || shipPosition);
      cameraShake += 0.4;
    } else if (type === 'planet'){
      health = 0; spawnImpactBurst(hitPosition || shipPosition, 0xff7766, 40); cameraShake += 1.2;
    }
    damageCooldown = 0.6;
    if (health <= 0){
      // Ship explosion on death
      const explodeAt = (hitPosition || shipPosition).clone();
      for (let i=0;i<30;i++){
        const burst = acquireImpactMesh(0xff8855);
        burst.position.copy(explodeAt).add(randomVel(1.2));
        burst.scale.setScalar(0.9 + Math.random()*1.2);
        if (!burst.parent) scene.add(burst);
        const vel = randomVel(30 + Math.random()*40);
        impactParticles.push({ mesh: burst, vel, life: 0.6 + Math.random()*0.5 });
      }
      ship.visible = false;
      gameOver = true;
      try { if (!statsSaved){ saveLeaderboards(); statsSaved = true; } } catch(_){ }
      showGameOver();
    }
  }

  function resetGame(){
    for (const a of asteroids) scene.remove(a.mesh); asteroids.length = 0;
    for (const b of bullets) scene.remove(b.mesh); bullets.length = 0;
    for (const p of exhaustParticles) scene.remove(p.mesh); exhaustParticles.length = 0;
    for (const p of impactParticles) scene.remove(p.mesh); impactParticles.length = 0;
    for (const o of shieldOrbs) scene.remove(o.mesh); shieldOrbs.length = 0;
    for (const o of pinkOrbs) scene.remove(o.mesh); pinkOrbs.length = 0;
    for (const o of fenixOrbs) scene.remove(o.mesh); fenixOrbs.length = 0;
    for (const o of zaphireOrbs) scene.remove(o.mesh); zaphireOrbs.length = 0;
    for (const w of wormholeOrbs) { scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); } wormholeOrbs.length = 0;
    for (const o of boostOrbs) { scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); } boostOrbs.length = 0;
    patches.length = 0;

    scene.remove(ship); ship = buildDefaultShip(); ship.visible = true; scene.add(ship);

    health = 100; shield = 0; score = 0; gameOver = false; hideGameOver();
    fenixActive = false; boostActive = false; boostTimer = 0;
    yaw = 0; pitch = 0; roll = 0; speedUnitsPerSec = 20; targetSpeedUnitsPerSec = 20;
    shipPosition.set(0,0,0); velocity.set(0,0,0);

    seedAsteroids(7000, 1400, shipPosition);
    createRings(targetPlanet, 3600, 5200, 13000);
    // Focus orb population into the planet ring with proportional counts
    seedAllOrbsInRingByProportion(targetPlanet, 3600, 5200);
  }

  let fireCooldown = 0;
  let frameCounter = 0; // used to throttle heavy updates
  const clock = new THREE.Clock();

  function animate(){
    // Do not run the game loop until the player launches
    if (!gameInitialized){ requestAnimationFrame(animate); return; }
    const dt = Math.min(0.033, clock.getDelta());

    if (!gameOver){
      if (damageCooldown > 0) damageCooldown -= dt;
      if (boostActive){
        boostTimer -= dt;
        if (boostTimer <= 0){ boostActive = false; }
      }

      let effectiveMaxSpeed = devTurboActive ? DEV_TURBO_SPEED : (fenixActive ? 80 : baseMaxSpeed);
      if (boostActive && !devTurboActive) effectiveMaxSpeed *= 3.08; // boost speed reduced by ~30%
      // If boost just ended, ensure our target is clamped to non-boost top speed
      if (!boostActive) targetSpeedUnitsPerSec = Math.min(targetSpeedUnitsPerSec, effectiveMaxSpeed);

      if (input.speedUp) targetSpeedUnitsPerSec = Math.min(effectiveMaxSpeed, targetSpeedUnitsPerSec + 22*dt);
      if (input.speedDown) targetSpeedUnitsPerSec = Math.max(minSpeed, targetSpeedUnitsPerSec - 22*dt);
      if (boostActive || devTurboActive) targetSpeedUnitsPerSec = effectiveMaxSpeed;

      speedUnitsPerSec += (targetSpeedUnitsPerSec - speedUnitsPerSec) * Math.min(1, boostActive ? 10*dt : 6*dt);
      const fovKick = boostActive ? 10 : 0;
      const fovTarget = baseFov + THREE.MathUtils.clamp((speedUnitsPerSec-14)*0.7 + fovKick, 0, 28);
      camera.fov += (fovTarget - camera.fov) * Math.min(1, 6*dt);
      camera.updateProjectionMatrix();

      // Keyboard yaw/pitch: Left/A => yaw left; Right/D => yaw right. Up/I => pitch up; Down/K => pitch down.
      // Direct, explicit mapping with no extra signs
      // Left/A should turn left; Right/D should turn right
      const yawKeys = (input.yawRight?-1:0) + (input.yawLeft?1:0);
      // Up/I -> positive pitch (nose up), Down/K -> negative pitch (nose down)
      const pitchKeys = (input.pitchUp?1:0) + (input.pitchDown?-1:0);
      const mouseYaw = (mouseDown ? mouseX*0.6 : 0);
      const mousePitch = (mouseDown ? -mouseY*0.6 : 0);
      const devScale = devTurboActive ? 0.25 : 1; // damp mouse at dev speed
      const yawInput = yawKeys + mouseYaw * devScale;
      const pitchInput = pitchKeys + mousePitch * devScale;
      yaw += yawInput * yawRate * dt;
      pitch = THREE.MathUtils.clamp(pitch + pitchInput * pitchRate * dt, -Math.PI/2+0.05, Math.PI/2-0.05);
      const targetRoll = THREE.MathUtils.clamp(-yawInput*0.9 - (mouseDown?mouseX*0.5:0), -0.7, 0.7);
      roll += (targetRoll - roll) * Math.min(1, 8*dt);

      // Auto-level at dev turbo to avoid unintended vertical drift
      if (devTurboActive){
        pitch += (-pitch) * Math.min(1, 1.2*dt);
        roll += (-roll) * Math.min(1, 1.2*dt);
      }

      const forward = new THREE.Vector3(0,0,1).applyEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')).normalize();
      const speedMultiplier = fenixActive ? 1.05 : 1.0; // Fenix is 5% faster
      velocity.copy(forward).multiplyScalar(speedUnitsPerSec * speedMultiplier);
      shipPosition.addScaledVector(velocity, dt);

      ship.position.copy(shipPosition);
      ship.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ'));

      fireCooldown -= dt;
      if (input.fire && fireCooldown <= 0){ shoot(); fireCooldown = 0.11; lastFireTimer = 0; }
    }

    // decrement timers
    if (asteroidMultTimer > 0) asteroidMultTimer = Math.max(0, asteroidMultTimer - dt);
    if (killMultTimer > 0) killMultTimer = Math.max(0, killMultTimer - dt);
    lastFireTimer += dt;

    // passive belt points
    if (!gameOver && isWithinBeltXZ(shipPosition)){
      const rate = lastFireTimer < 10 ? 2 : 1; // 2/sec during recent combat, else 1/sec
      beltPassiveAccu += rate * dt;
      if (beltPassiveAccu >= 1){
        const add = Math.floor(beltPassiveAccu);
        if (roundActive) score += add;
        beltPassiveAccu -= add;
      }
    }

    // Camera follow + shake
    const camLocal = cameraOffsetLocal.clone().applyQuaternion(ship.quaternion);
    const camPos = ship.position.clone().add(camLocal);
    cameraShake = Math.max(0, cameraShake - 2.2*dt);
    if (cameraShake > 0){ camPos.x += (Math.random()*2-1) * cameraShake; camPos.y += (Math.random()*2-1) * cameraShake * 0.6; camPos.z += (Math.random()*2-1) * cameraShake; }
    camera.position.copy(camPos);
    const lookForward = new THREE.Vector3(0,0,1).applyEuler(new THREE.Euler(pitch, yaw, roll, 'YXZ')).normalize();
    camera.lookAt(ship.position.clone().add(lookForward.multiplyScalar(20)));

    // Update bullets
    for (let i = bullets.length-1; i>=0; i--){
      const b = bullets[i];
      b.life -= dt; if (b.life <= 0){
        scene.remove(b.mesh);
        if (b.kind==='player') releasePlayerBulletMesh(b.mesh);
        else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
        bullets.splice(i,1); continue;
      }
      b.mesh.position.addScaledVector(b.velocity, dt);
    }

    // Update asteroids; build spatial hash for broad-phase
    const hash = USE_SPATIAL_HASH ? new SpatialHash(120) : null;
    outer: for (let i = asteroids.length-1; i>=0; i--){
      const a = asteroids[i];
      if (a.inRing){
        // Smooth per-frame update to eliminate visible jitter
        a.orbitAngle += a.orbitSpeed * dt;
        const x = targetPlanet.position.x + Math.cos(a.orbitAngle) * a.orbitRadius;
        const z = targetPlanet.position.z + Math.sin(a.orbitAngle) * a.orbitRadius;
        a.mesh.position.set(x, a.mesh.position.y, z);
        // Update instanced matrix for its group
        if (a.instanceGroup>=0 && a.instanceId>=0){
          const im = ringInstancedGroups[a.instanceGroup];
          if (im){
            instTmp.position.copy(a.mesh.position);
            instTmp.rotation.set(0,0,0);
            instTmp.scale.set(a.scale, a.scale, a.scale);
            instTmp.updateMatrix();
            im.setMatrixAt(a.instanceId, instTmp.matrix);
            im.instanceMatrix.needsUpdate = true;
          }
        }
        } else {
        a.mesh.position.addScaledVector(a.vel, dt);
      }
      // Enable collisions for ring asteroids as well
      if (a.rotAxis && a.rotSpeed) a.mesh.rotateOnAxis(a.rotAxis, a.rotSpeed*dt);
      if (hash) hash.insert({ i, a }, a.mesh.position);

      if (a.nearMissCooldown > 0) a.nearMissCooldown -= dt;
      const nearMissDist = a.radius + 3.2;
      if (isWithinRadiusSquared(a.mesh.position, shipPosition, nearMissDist) && a.nearMissCooldown <= 0){
        spawnImpactBurst(a.mesh.position, 0x66ccff, 10); cameraShake += 0.25; a.nearMissCooldown = 1.2;
      }

      if (!gameOver && isWithinRadiusSquared(a.mesh.position, shipPosition, a.radius + shipHitRadius)){
        applyCrashDamage('asteroid', a.mesh.position);
        if (a.instanceGroup>=0 && a.instanceId>=0){
          const im = ringInstancedGroups[a.instanceGroup];
          if (im){
            instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
            im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
          }
        }
        scene.remove(a.mesh); asteroids.splice(i,1);
        break outer;
      }

      if (!hash){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(a.mesh.position, b.mesh.position, a.radius + b.radius)){
            spawnImpactBurst(a.mesh.position, 0xffaa66, 26);
            cameraShake += 0.25;
            // Remove instance after one frame to allow VFX to be seen
            if (a.instanceGroup>=0 && a.instanceId>=0){
              const im = ringInstancedGroups[a.instanceGroup];
              if (im){ setTimeout(()=>{ try{
                instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
                im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
              }catch(_){ } }, 0); }
              }
            setTimeout(()=>{ try{ scene.remove(a.mesh); }catch(_){ } }, 0); asteroids.splice(i,1);
            scene.remove(b.mesh);
            if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
            bullets.splice(j,1);
            if (roundActive) score += getAsteroidScore(a.inRing ? 160 : 110, a.mesh.position);
            asteroidsDestroyed++;
            break outer;
          }
        }
      }
    }

    if (hash){
      for (let j = bullets.length-1; j>=0; j--){
        const b = bullets[j];
        const near = hash.query(b.mesh.position, 200);
        for (let k=0;k<near.length;k++){
          const { i, a } = near[k]; if (!asteroids[i]) continue;
           if (isWithinRadiusSquared(a.mesh.position, b.mesh.position, a.radius + b.radius)){
             spawnImpactBurst(a.mesh.position, 0xffaa66, 26);
             cameraShake += 0.25;
             // Hide instance after one frame to allow VFX to be seen
             if (a.instanceGroup>=0 && a.instanceId>=0){
               const im = ringInstancedGroups[a.instanceGroup];
               if (im){ setTimeout(()=>{ try{
                 instTmp.position.set(0,0,0); instTmp.rotation.set(0,0,0); instTmp.scale.set(0,0,0); instTmp.updateMatrix();
                 im.setMatrixAt(a.instanceId, instTmp.matrix); im.instanceMatrix.needsUpdate = true;
               }catch(_){ } }, 0); }
               }
             setTimeout(()=>{ try{ scene.remove(a.mesh); }catch(_){ } }, 0); asteroids.splice(i,1);
            scene.remove(b.mesh);
            if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh);
            bullets.splice(j,1);
            if (roundActive) score += getAsteroidScore(a.inRing ? 160 : 110, a.mesh.position);
            asteroidsDestroyed++;
            break;
          }
        }
      }
    }

    // Shield orbs
    for (let i = shieldOrbs.length-1; i>=0; i--){
      const o = shieldOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.2 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.7 + 0.3 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          shield = Math.min(100, shield + 25);
          spawnShieldExplosion(o.mesh.position, 'pickup');
          scene.remove(o.mesh); shieldOrbs.splice(i,1); continue;
        }
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            shield = Math.min(100, shield + 25);
            spawnShieldText(o.mesh.position);
            spawnShieldExplosion(o.mesh.position, 'shot');
            scene.remove(o.mesh); shieldOrbs.splice(i,1);
            scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Pink orbs
    for (let i = pinkOrbs.length-1; i>=0; i--){
      const o = pinkOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.02;
      const pulse = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      o.mesh.material.opacity = 0.75 + 0.25 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.9*dt;

      if (!gameOver){
        const trigger = () => { spawnDuendeText(o.mesh.position); spawnImpactBurst(o.mesh.position, 0xff33cc, 20); spawnShieldRing(o.mesh.position, 0xff33cc); };
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); continue;
        }
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            trigger(); scene.remove(o.mesh); pinkOrbs.splice(i,1); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Fenix orbs
    for (let i = fenixOrbs.length-1; i>=0; i--){
      const o = fenixOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.03;
      const pulse = 1 + 0.32 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      if (o.glow){ o.glow.scale.setScalar(14 + 7*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed))); o.glow.material.opacity = 0.85 + 0.12*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/8)); }
      o.mesh.material.opacity = 0.9 + 0.1 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.7*dt;

      if (!gameOver){
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
           if (o.mesh.position.distanceTo(b.mesh.position) < (o.radius + b.radius)){
            spawnFenixLabel(o.mesh.position);
            spawnImpactBurst(o.mesh.position, 0xffaa55, 24);
            spawnShieldRing(o.mesh.position, 0xffaa55);
            transformToFenixShip();
            if (o.glow) scene.remove(o.glow);
            scene.remove(o.mesh); fenixOrbs.splice(i,1);
             scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Zaphire orbs (Store)
    for (let i = zaphireOrbs.length-1; i>=0; i--){
      const o = zaphireOrbs[i];
      o.bob += o.bobSpeed * dt;
      o.mesh.position.y += Math.sin(o.bob) * 0.03;
      const pulse = 1 + 0.28 * Math.sin(o.bob * o.pulseSpeed);
      o.mesh.scale.setScalar(o.baseScale * pulse);
      if (o.glow){
        o.glow.scale.setScalar(14 + 6*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed)));
        o.glow.material.opacity = 0.85 + 0.1*(0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/6));
      }
      o.mesh.material.opacity = 0.9 + 0.1 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI*0.5));
      o.mesh.rotation.y += 0.8*dt;

      if (!gameOver){
        // Fly-through opens store and removes both core and glow
        if (isWithinRadiusSquared(o.mesh.position, shipPosition, o.radius + pickupHitRadius)){
          spawnCenteredTextLabel('STORE', o.mesh.position, 0xffeeee, 2.8, 2.2);
          spawnImpactBurst(o.mesh.position, 0xff6666, 26);
          spawnShieldRing(o.mesh.position, 0xff6666);
          showStoreOverlay();
          if (o.glow) scene.remove(o.glow);
          scene.remove(o.mesh); zaphireOrbs.splice(i,1);
          continue;
        }
        // Shot also opens store and cleans up glow + core
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
            if (isWithinRadiusSquared(o.mesh.position, b.mesh.position, o.radius + b.radius)){
            spawnCenteredTextLabel('STORE', o.mesh.position, 0xffeeee, 2.8, 2.2);
            spawnImpactBurst(o.mesh.position, 0xff6666, 26);
            spawnShieldRing(o.mesh.position, 0xff6666);
            showStoreOverlay();
            if (o.glow) scene.remove(o.glow);
            scene.remove(o.mesh); zaphireOrbs.splice(i,1);
            scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Boost orbs (grant super speed 3–6s)
    for (let i = boostOrbs.length-1; i>=0; i--){
      const o = boostOrbs[i];
      o.bob += o.bobSpeed * dt;
      const puls = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(puls);
      o.ringG.lookAt(camera.position);
      o.ringP.lookAt(camera.position);
      o.ringG.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      o.ringP.material.opacity = 0.4 + 0.3 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed + Math.PI/3));
      if (o.glow){ o.glow.scale.setScalar(9 + 3*(0.5 + 0.5*Math.sin(o.bob*o.pulseSpeed))); o.glow.material.color.setHex(0x66ddff); o.glow.material.opacity = 0.6 + 0.25*(0.5 + 0.5*Math.sin(o.bob*o.pulseSpeed + Math.PI/5)); }

      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 5.0; // extra generous radius for reliable activation
        const triggerBoost = () => {
          boostActive = true; boostTimer = 3 + Math.random()*3;
          spawnCenteredTextLabel('Boost', o.core.position, 0x99ff66, 2.2, 3.0);
          spawnShieldRing(o.core.position, 0x99ff66);
          spawnImpactBurst(o.core.position, 0xaa55ff, 18);
          cameraShake += 0.3;
          scene.remove(o.core); scene.remove(o.ringG); scene.remove(o.ringP); if (o.glow) scene.remove(o.glow); boostOrbs.splice(i,1);
        };
        // Pickup
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){
          triggerBoost(); continue;
        }
        // Shot
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){
            triggerBoost(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // Miner orbs (x2 asteroid points)
    for (let i = minerOrbs.length-1; i>=0; i--){
      const o = minerOrbs[i];
      o.bob += o.bobSpeed * dt;
      const s = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(s);
      o.ring.lookAt(camera.position);
      o.ring.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 3.0;
        const trigger = () => {
          asteroidMultTimer = Math.min(60, Math.max(asteroidMultTimer, 30));
          spawnShieldRing(o.core.position, 0x66ff99);
          spawnImpactBurst(o.core.position, 0x66ff99, 16);
          scene.remove(o.core); scene.remove(o.ring); minerOrbs.splice(i,1);
        };
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){ trigger(); continue; }
        for (let j = bullets.length-1; j>=0; j--){ const b = bullets[j]; if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){ trigger(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break; } }
      }
    }

    // Hunter orbs (x2 kill points)
    for (let i = hunterOrbs.length-1; i>=0; i--){
      const o = hunterOrbs[i];
      o.bob += o.bobSpeed * dt;
      const s = 1 + 0.22 * Math.sin(o.bob * o.pulseSpeed);
      o.core.scale.setScalar(s);
      o.ring.lookAt(camera.position);
      o.ring.material.opacity = 0.55 + 0.35 * (0.5 + 0.5*Math.sin(o.bob * o.pulseSpeed));
      if (!gameOver){
        const effR = o.radius * o.core.scale.x + 3.0;
        const trigger = () => {
          killMultTimer = Math.min(60, Math.max(killMultTimer, 30));
          spawnShieldRing(o.core.position, 0x66aaff);
          spawnImpactBurst(o.core.position, 0x66aaff, 16);
          scene.remove(o.core); scene.remove(o.ring); hunterOrbs.splice(i,1);
        };
        if (isWithinRadiusSquared(o.core.position, shipPosition, effR + pickupHitRadius)){ trigger(); continue; }
        for (let j = bullets.length-1; j>=0; j--){ const b = bullets[j]; if (isWithinRadiusSquared(o.core.position, b.mesh.position, effR + b.radius)){ trigger(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break; } }
      }
    }

    // Wormhole orbs (teleport)
    for (let i = wormholeOrbs.length-1; i>=0; i--){
      const w = wormholeOrbs[i];
      w.bob += w.bobSpeed * dt;
      const s = 1 + 0.25 * Math.sin(w.bob * w.pulseSpeed);
      w.mesh.scale.setScalar(s);
      w.halo.lookAt(camera.position);
      w.halo.material.opacity = 0.45 + 0.35 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed));
      if (w.glow){ w.glow.scale.setScalar(10 + 4 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed))); w.glow.material.opacity = 0.65 + 0.25 * (0.5 + 0.5*Math.sin(w.bob * w.pulseSpeed + Math.PI/4)); }
      // Mirror reflection only when close
      const dist = w.mesh.position.distanceTo(shipPosition);
      const intensity = THREE.MathUtils.clamp(1 - (dist-60)/180, 0, 1); // ramps within ~60..240m
      w.coreMat.envMapIntensity = intensity;
      if (intensity > 0.02){
        const now = performance.now() * 0.001;
        if (now - w.lastCubeUpdate > 0.25){
          const prevVis = w.mesh.visible; w.mesh.visible = false; // avoid self-capture
          w.cubeCam.position.copy(w.mesh.position);
          w.cubeCam.update(renderer, scene);
          w.mesh.visible = prevVis;
          w.lastCubeUpdate = now;
        }
      }

      if (!gameOver){
        const tryTeleport = ()=>{
          // Choose a destination at least 12 km away from the source
          const srcPos = w.mesh.position;
          const farCandidates = wormholeOrbs.filter(o => o !== w && o.mesh.position.distanceTo(srcPos) >= MIN_WORMHOLE_TELEPORT_DIST);
          let destPos;
          if (farCandidates.length > 0){
            const picked = farCandidates[Math.floor(Math.random()*farCandidates.length)];
            destPos = picked.mesh.position.clone();
          } else {
            const rnd = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize();
            const dist = MIN_WORMHOLE_TELEPORT_DIST + Math.random()*8000; // 12–20 km
            destPos = srcPos.clone().add(rnd.multiplyScalar(dist));
          }
          const local = new THREE.Vector3(Math.random()*2-1, Math.random()*2-1, Math.random()*2-1).normalize().multiplyScalar(150 + Math.random()*250);
          shipPosition.copy(destPos).add(local);
          ship.position.copy(shipPosition);
          cameraShake += 1.0; spawnShieldRing(destPos, 0xffffff);
          scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); if (w.cubeCam) scene.remove(w.cubeCam); wormholeOrbs.splice(i,1);
        };
        // Fly-through activation
        if (isWithinRadiusSquared(w.mesh.position, shipPosition, w.radius + pickupHitRadius)){
          tryTeleport(); continue;
        }
        // Shot activation
        for (let j = bullets.length-1; j>=0; j--){
          const b = bullets[j];
          if (isWithinRadiusSquared(w.mesh.position, b.mesh.position, w.radius + b.radius)){
            tryTeleport(); scene.remove(b.mesh); if (b.kind==='player') releasePlayerBulletMesh(b.mesh); else if (b.kind==='fenix') releaseFenixBeamMesh(b.mesh); bullets.splice(j,1); break;
          }
        }
      }
    }

    // 3D text labels update
    for (let i = shieldTextLabels.length-1; i>=0; i--){
      const lbl = shieldTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){ scene.remove(lbl.mesh); shieldTextLabels.splice(i,1); continue; }
      lbl.mesh.lookAt(camera.position);
      if (lbl.life < 0.8){ const mat = lbl.mesh.material; mat.opacity = Math.max(0, lbl.life / 0.8); }
    }
    for (let i = duendeTextLabels.length-1; i>=0; i--){
      const lbl = duendeTextLabels[i];
      lbl.life -= dt; if (lbl.life <= 0){ scene.remove(lbl.group); duendeTextLabels.splice(i,1); continue; }
      if (lbl.group.lookAt) lbl.group.lookAt(camera.position);
      if (lbl.life < 0.8){
        if (lbl.group.traverse){ lbl.group.traverse(obj => { if (obj.material && obj.material.opacity !== undefined){ obj.material.opacity = Math.max(0, lbl.life / 0.8); } }); }
        else { const mat = lbl.group.material; if (mat && mat.opacity!==undefined) mat.opacity = Math.max(0, lbl.life / 0.8); }
      }
    }

    // Planet crash check + belt time accumulation
    if (!gameOver){
      for (const p of planets){
        const d = shipPosition.distanceTo(p.position);
        if (d < (p.userData.radius + 20)) { applyCrashDamage('planet', shipPosition); break; }
      }
      if (isWithinBeltXZ(shipPosition)) beltTimeSec += dt;
    }

    // Particles update
    for (let i = exhaustParticles.length-1; i>=0; i--){
      const p = exhaustParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); releaseExhaustMesh(p.mesh); exhaustParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      const s2 = Math.max(0.1, p.mesh.scale.x * (1 - 2.2*dt));
      p.mesh.scale.setScalar(s2);
      const mat = p.mesh.material; mat.opacity = Math.max(0, mat.opacity - 1.6*dt);
    }
    for (let i = impactParticles.length-1; i>=0; i--){
      const p = impactParticles[i];
      p.life -= dt; if (p.life <= 0){ scene.remove(p.mesh); releaseImpactMesh(p.mesh); impactParticles.splice(i,1); continue; }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(1 - 2.0*dt);
      const s3 = Math.max(0.05, p.mesh.scale.x * (1 - 1.8*dt));
      p.mesh.scale.setScalar(s3);
      const mat2 = p.mesh.material; mat2.opacity = Math.max(0, mat2.opacity - 2.8*dt);
    }

    // Animate ring bursts
    for (let i = ringBursts.length-1; i>=0; i--){
      const r = ringBursts[i];
      r.life -= dt; if (r.life <= 0){ scene.remove(r.mesh); ringBursts.splice(i,1); continue; }
      r.mesh.scale.x += r.growth * dt; r.mesh.scale.y += r.growth * dt;
      r.mesh.material.opacity = Math.max(0, r.mesh.material.opacity - r.fade * dt);
      r.mesh.lookAt(camera.position);
    }

    // Exhaust
    if (!gameOver) spawnExhaust(50 + speedUnitsPerSec*4, dt);

    // --- Bots update ---
    updateBots(dt);

    // Bot bullets -> player
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      if (b.owner === 'bot') {
        if (isWithinRadiusSquared(b.mesh.position, shipPosition, shipHitRadius + b.radius)) {
          if (!gameOver) {
            spawnImpactBurst(b.mesh.position);
            cameraShake += 0.25;
            const shieldDamage = 20, healthDamage = 12;
            if (shield > 0){ shield = Math.max(0, shield - shieldDamage); }
            health = Math.max(0, health - healthDamage);
            if (health <= 0){ gameOver = true; showGameOver(); }
          }
          scene.remove(b.mesh); bullets.splice(i, 1);
        }
      }
    }

    // Player bullets -> bots
    for (let bi = bots.length - 1; bi >= 0; bi--) {
      const bot = bots[bi];
      for (let i = bullets.length - 1; i >= 0; i--) {
        const b = bullets[i];
        if (b.owner !== 'bot') { // player's or fenix beams
          if (isWithinRadiusSquared(b.mesh.position, bot.pos, bot.radius + b.radius)) {
            spawnImpactBurst(bot.pos);
            scene.remove(bot.mesh); bots.splice(bi, 1);
            scene.remove(b.mesh); bullets.splice(i, 1);
            if (roundActive) score += getKillScore(300, bot.pos); // base 300; belt & multipliers apply
            killsCount++;
            break;
          }
        }
      }
    }

    maintainPatches();
    keepFieldPopulated();
    updateHud();

    // Multiplayer: render remotes with 120ms interpolation buffer
    if (MP.active && MP.remotes.size){
      const renderNow = Date.now() + ((MP.serverOffsetEma||0)) - 200; // larger buffer for stability
      for (const [numId, r] of MP.remotes){
        const s = r.samples;
        if (!s || s.length === 0) continue;
        // find two samples around renderNow
        let a = null, b = null;
        for (let i=0;i<s.length;i++){
          if (s[i].t <= renderNow) a = s[i];
          if (s[i].t > renderNow){ b = s[i]; break; }
        }
        if (!a) a = s[0]; if (!b) b = s[s.length-1];
        const ta = a.t, tb = Math.max(a.t+1, b.t);
        let t = (renderNow - ta) / (tb - ta);
        if (!Number.isFinite(t)) t = 1;
        t = THREE.MathUtils.clamp(t, 0, 1);
        const pa = vec3From(a.p), pb = vec3From(b.p);
        const qa = quatFrom(a.q), qb = quatFrom(b.q);
        let p = pa.lerp(pb, t);
        let q = lerpQuat(qa, qb, t);
        // If buffer underflow (renderNow beyond last sample), do a tiny capped extrapolation using last velocity
        if (renderNow > b.t + 24){
          const dtEx = Math.min(0.06, (renderNow - b.t)/1000);
          const vv = vec3From(b.v);
          p = vec3From(b.p).addScaledVector(vv, dtEx);
          q = qb; // keep last orientation
        }
        r.mesh.position.copy(p);
        r.mesh.quaternion.copy(q);
      }
    }

    // Round timer end: stop round when time elapses
    if (roundActive && Date.now() >= roundEndsAt){
      roundActive = false;
      // Ensure overlay exists, then set message and submit
      ensureEndOverlay();
      if (endMsg){
        endMsg.innerHTML = `<div>Final score: ${score} | Enemies killed: ${killsCount} | Asteroids: ${asteroidsDestroyed}</div><div style="opacity:0.85;margin-top:6px">Choose an option</div>`;
      }
      if (!roundSubmitted){
        try { if (!statsSaved){ saveLeaderboards(); statsSaved = true; } } catch(_){ }
        roundSubmitted = true;
      }
      showEndOverlay();
    }

    renderer.render(scene, camera);
    if ((frameCounter % 30) === 0){ dbg('tick', { pos: vecToArr(shipPosition), spd: Number(speedUnitsPerSec.toFixed(1)), active: !!MP.active, remotes: MP.remotes.size }); }
    requestAnimationFrame(animate);
    frameCounter++;

    // Periodic integrity sweep to remove orphan glows/rings (prevents glow-only orbs)
    if ((frameCounter % 60) === 0){
      // Fenix
      for (let i=fenixOrbs.length-1;i>=0;i--){ const o=fenixOrbs[i]; if (!o.mesh.parent){ if (o.glow) scene.remove(o.glow); fenixOrbs.splice(i,1); } }
      // Zaphire
      for (let i=zaphireOrbs.length-1;i>=0;i--){ const o=zaphireOrbs[i]; if (!o.mesh.parent){ if (o.glow) scene.remove(o.glow); zaphireOrbs.splice(i,1); } }
      // Wormholes
      for (let i=wormholeOrbs.length-1;i>=0;i--){ const w=wormholeOrbs[i]; if (!w.mesh.parent){ scene.remove(w.mesh); scene.remove(w.halo); if (w.glow) scene.remove(w.glow); wormholeOrbs.splice(i,1); } }
      // Boost
      for (let i=boostOrbs.length-1;i>=0;i--){ const o=boostOrbs[i]; if (!o.core.parent){ if (o.glow) scene.remove(o.glow); if (o.ringG) scene.remove(o.ringG); if (o.ringP) scene.remove(o.ringP); boostOrbs.splice(i,1); } }
      // Multipliers
      for (let i=minerOrbs.length-1;i>=0;i--){ const o=minerOrbs[i]; if (!o.core.parent){ scene.remove(o.ring); minerOrbs.splice(i,1); } }
      for (let i=hunterOrbs.length-1;i>=0;i--){ const o=hunterOrbs[i]; if (!o.core.parent){ scene.remove(o.ring); hunterOrbs.splice(i,1); } }
    }
  }

  function onResize(){ const w = window.innerWidth, h = window.innerHeight; renderer.setSize(w,h); camera.aspect = w/h; camera.updateProjectionMatrix(); }
  window.addEventListener('resize', onResize);
  onResize();
  animate();

  // --- Bots (AI players) ---
  // bots is declared early above to avoid TDZ errors
  const BOT_COUNT = 3;
  const BOT_FIRE_COOLDOWN = 0.45;
  const BOT_TURN_RATE = 1.2; // rad/s
  const BOT_PITCH_RATE = 0.9; // rad/s
  const BOT_SPEED = 20; // units/s
  const BOT_RANGE = 1400; // engage distance
  const BOT_SHOT_SPREAD = 0.02; // radians

  function tintShip(mesh, color = 0xff6666) {
    mesh.traverse?.(n => {
      if (n.isMesh && n.material) {
        if (Array.isArray(n.material)) n.material.forEach(m => { m.color?.setHex?.(color); m.emissive?.setHex?.(color); });
        else { n.material.color?.setHex?.(color); n.material.emissive?.setHex?.(color); }
      }
    });
  }

  function spawnBotAtPosition(pos) {
    const mesh = buildDefaultShip();
    tintShip(mesh, 0xff6666);
    mesh.position.copy(pos);
    scene.add(mesh);
    const bot = {
      mesh,
      pos: mesh.position,
      yaw: 0, pitch: 0, roll: 0,
      speed: BOT_SPEED,
      fireCooldown: 1.0 + Math.random()*0.5,
      radius: 1.8
    };
    // Face roughly toward player
    const toPlayer = new THREE.Vector3().copy(shipPosition).sub(bot.pos);
    bot.yaw = Math.atan2(toPlayer.x, toPlayer.z);
    bot.pitch = Math.atan2(-toPlayer.y, new THREE.Vector2(toPlayer.x, toPlayer.z).length());
    bots.push(bot);
  }

  function botShoot(bot) {
    // Simple blue-ish shot like player (not Fenix)
    const mat = new THREE.MeshStandardMaterial({ color: 0xff8866, emissive: 0xff6644, emissiveIntensity: 2.5 });
    const bullet = new THREE.Mesh(bulletGeometry, mat);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(bot.pitch, bot.yaw, bot.roll, 'YXZ'));
    const dir = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
    // Apply slight random spread so it's not perfect aim
    const spread = BOT_SHOT_SPREAD;
    dir.applyAxisAngle(new THREE.Vector3(0,1,0), (Math.random()-0.5)*spread);
    dir.applyAxisAngle(new THREE.Vector3(1,0,0), (Math.random()-0.5)*spread);

    const tip = new THREE.Vector3().copy(bot.pos).add(dir.clone().multiplyScalar(1.8));
    bullet.position.copy(tip);
    scene.add(bullet);
    bullets.push({ mesh: bullet, velocity: dir.multiplyScalar(DEFAULT_BULLET_SPEED), life: DEFAULT_BULLET_LIFE, radius: 0.25, owner: 'bot' });
  }

  function updateBots(dt) {
    for (let i = bots.length - 1; i >= 0; i--) {
      const b = bots[i];
      // Steering toward player
      const toPlayer = new THREE.Vector3().copy(shipPosition).sub(b.pos);
      const dist = toPlayer.length();
      if (dist < 0.001) continue;
      const desiredYaw = Math.atan2(toPlayer.x, toPlayer.z);
      const desiredPitch = Math.atan2(-toPlayer.y, new THREE.Vector2(toPlayer.x, toPlayer.z).length());

      // Shortest angle delta for yaw
      let dy = desiredYaw - b.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      const dp = desiredPitch - b.pitch;

      const maxYawStep = BOT_TURN_RATE * dt;
      const maxPitchStep = BOT_PITCH_RATE * dt;

      b.yaw += THREE.MathUtils.clamp(dy, -maxYawStep, maxYawStep);
      b.pitch += THREE.MathUtils.clamp(dp, -maxPitchStep, maxPitchStep);

      // Move forward
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(b.pitch, b.yaw, b.roll, 'YXZ'));
      const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
      b.pos.addScaledVector(forward, b.speed * dt);
      b.mesh.quaternion.copy(q);

      // Fire when roughly aligned and in range
      b.fireCooldown -= dt;
      const facingDot = forward.dot(toPlayer.clone().normalize()); // 1 = directly at player
      if (dist < BOT_RANGE && facingDot > 0.985 && b.fireCooldown <= 0) {
        botShoot(b);
        b.fireCooldown = BOT_FIRE_COOLDOWN + Math.random()*0.2;
      }
    }
  }

  // Spawn initial bots around the player
  for (let i = 0; i < BOT_COUNT; i++) {
    const r = 1200 + Math.random()*1600;
    const theta = Math.random()*Math.PI*2;
    const phi = (Math.random()-0.5) * 0.6;
    const offset = new THREE.Vector3(
      r*Math.cos(theta)*Math.cos(phi),
      r*Math.sin(phi),
      r*Math.sin(theta)*Math.cos(phi)
    );
    spawnBotAtPosition(new THREE.Vector3().copy(shipPosition).add(offset));
  }

})();
