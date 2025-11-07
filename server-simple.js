const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 8788;

// Middleware
app.use(cors());
app.use(express.json());

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// Blockchain test endpoint
app.post('/blockchain/test', async (req, res) => {
  try {
    console.log('🧪 Testing blockchain connection...');
    
    // For now, just return success to test the server
    res.json({
      ok: true,
      network: true,
      message: 'Blockchain connection test successful (mock)'
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