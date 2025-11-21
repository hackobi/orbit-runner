const express = require('express');
const cors = require('cors');
const { DemosSdk: Demos } = require('@kynesyslabs/demosdk');

const app = express();
const PORT = 8787;

// Middleware
app.use(cors());
app.use(express.json());

// Demos network connection
let networkConnected = false;
let walletConnected = false;

// Connect to Demos network
async function connectToDemos() {
  if (networkConnected) return true;
  
  try {
    console.log('🔗 Connecting to Demos network...');
    
    // Connect to Demos network - minimal connection
    await Demos.connectNetwork('testnet');
    networkConnected = true;
    console.log('✅ Connected to Demos network');
    
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to Demos network:', error);
    return false;
  }
}

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// Blockchain test endpoint
app.post('/blockchain/test', async (req, res) => {
  try {
    console.log('🧪 Testing blockchain connection...');
    
    // Test 1: Connect to network
    const connected = await connectToDemos();
    if (!connected) {
      return res.status(500).json({ 
        ok: false, 
        error: 'Failed to connect to Demos network' 
      });
    }
    
    console.log('✅ Blockchain test successful');
    res.json({
      ok: true,
      network: true,
      message: 'Blockchain connection test successful'
    });
    
  } catch (error) {
    console.error('❌ Blockchain test failed:', error);
    res.status(500).json({ 
      ok: false, 
      error: String(error) 
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Leaderboard API listening on :${PORT}`);
  console.log('🧪 Blockchain test available at /blockchain/test');
});