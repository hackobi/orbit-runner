const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 8789;

// Middleware
app.use(cors());
app.use(express.json());

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ ok: true, message: 'Server is running' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('📊 Health check: http://localhost:8789/health');
});

console.log('✅ Starting server...');