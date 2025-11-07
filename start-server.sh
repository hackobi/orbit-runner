#!/bin/bash

echo "🚀 Starting Orbit Runner server..."

# Kill any existing server processes
pkill -f "node server" 2>/dev/null || true
sleep 1

# Start the server
echo "📊 Server will be available at: http://localhost:8787"
echo "🧪 Blockchain test endpoint: http://localhost:8787/blockchain/test"
echo "⚡ Press Ctrl+C to stop the server"
echo ""

node server-final.js