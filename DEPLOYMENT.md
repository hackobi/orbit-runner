# Orbit Runner Deployment Guide

## Backend Server Deployment (Railway)

The backend server at `https://orbit-runner-production.up.railway.app` needs to be redeployed with the latest CORS settings.

### Required Environment Variables
```env
PORT=8787
NODE_ENV=production
TELEGRAM_BOT_TOKEN=your_token_here
TELEGRAM_CHAT_ID=your_chat_id_here
DEMOS_PRIVATE_KEY=your_private_key_here
```

### CORS Configuration
The server is configured to accept connections from:
- `https://terrific-warmth-production.up.railway.app` (new frontend)
- `https://orbit-runner-production.up.railway.app` (original frontend)
- Any `*.railway.app`, `*.netlify.app`, or `*.vercel.app` domain
- Local development (localhost:3000, :8000, :8787)

### Deployment Steps

1. **Push to GitHub**
   ```bash
   git push origin feature/pvp-combat-system
   ```

2. **Deploy Backend to Railway**
   - Go to Railway dashboard
   - Select the orbit-runner backend service
   - Deploy from `feature/pvp-combat-system` branch
   - Verify environment variables are set
   - Wait for deployment to complete

3. **Verify Backend**
   - Check health endpoint: `https://orbit-runner-production.up.railway.app/health`
   - Should return: `{"ok": true}`

4. **Frontend Configuration**
   The frontend at `https://terrific-warmth-production.up.railway.app` is already configured to connect to the backend at `https://orbit-runner-production.up.railway.app`.

### Testing Multiplayer

#### Demo Mode (No Wallet Required)
Access with: `https://terrific-warmth-production.up.railway.app?demo=true`

#### Show Demo Button
Access with: `https://terrific-warmth-production.up.railway.app?showdemo=true`

### Troubleshooting

#### CORS Errors
If you see CORS errors:
1. Ensure backend is deployed with latest `server/index.js`
2. Check that frontend URL is in CORS whitelist
3. Verify backend is running (check health endpoint)

#### WebSocket Connection Issues
- Ensure both HTTP and WebSocket servers are running
- Check that ports 8787 (HTTP) and 8788 (WebSocket) are configured
- Verify firewall/proxy allows WebSocket connections

#### Payment/Wallet Issues
- Ensure DEMOS_PRIVATE_KEY is set in environment
- Check that wallet extension is installed
- Verify balance with Demos network

## Frontend Deployment

The frontend is already deployed at `https://terrific-warmth-production.up.railway.app`.

### Updating Frontend
1. Push changes to GitHub
2. Railway will auto-deploy from the connected branch
3. Clear browser cache if needed

## Testing PvP Combat

1. Open game in two browser windows
2. Launch with demo mode (`?demo=true`)
3. Press G key to teleport players together
4. Test shooting with spacebar
5. Verify health reduction and bullet visibility