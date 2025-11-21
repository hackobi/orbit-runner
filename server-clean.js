const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 8787;

// Middleware
app.use(cors());
app.use(express.json());

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// Leaderboards endpoint
app.get('/leaderboards', (req, res) => {
  res.json({
    points: [],
    kills: [],
    asteroids: [],
    belt: [],
    survival: []
  });
});

// Blockchain test endpoint (mock for now)
app.post('/blockchain/test', (req, res) => {
  res.json({
    ok: true,
    network: true,
    message: 'Blockchain connection test successful (mock mode)'
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📊 Health check: http://localhost:8787/health');
  console.log('🧪 Blockchain test: http://localhost:8787/blockchain/test');
});

// Handle server errors
server.on('error', (err) => {
  console.error('❌ Server error:', err);
});

console.log('✅ Starting server...');