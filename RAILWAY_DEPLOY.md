# Railway Deployment Instructions

## Prerequisites
1. Railway account: https://railway.app
2. GitHub repository with this code

## Environment Variables to Set in Railway

### Required Variables
```
DEMOS_SERVER_MNEMONIC=your_12_word_mnemonic_here
DEMOS_TREASURY_MNEMONIC=your_12_word_mnemonic_here  
NODE_ENV=production
TREASURY_MIN_RESERVE=3
PAYOUT_MIN_PRIZE=1
```

### Optional Variables
```
PORT=8787  # Railway will override this automatically
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

## Deployment Steps

### Option 1: Deploy from GitHub (Recommended)
1. Go to https://railway.app/dashboard
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository: `randomblocker/orbit-runner-multiplayer-mvp`
5. Select branch: `feature/random-multiplayer-mvp`
6. Railway will automatically detect Node.js and deploy

### Option 2: Railway CLI
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Deploy
railway up
```

## Post-Deployment Configuration

1. **Set Environment Variables:**
   - Go to your project dashboard
   - Click on "Variables" tab
   - Add all required environment variables listed above

2. **Custom Domain (Optional):**
   - In project settings, add your custom domain
   - Update CORS settings if needed

3. **View Logs:**
   - Use Railway dashboard or CLI: `railway logs`

## Health Check
Once deployed, your app will be available at:
- `https://your-app-name.up.railway.app`

Test endpoints:
- `/` - Should serve the game
- Health check should pass automatically

## Troubleshooting

### Common Issues:
1. **Build fails**: Check that all dependencies are in `package.json`
2. **App won't start**: Verify `npm start` command works locally
3. **Environment variables**: Make sure all required vars are set
4. **Port issues**: Railway sets PORT automatically, don't hardcode it

### Debug Commands:
```bash
railway logs          # View deployment logs
railway status        # Check service status  
railway shell         # Access container shell
```

## Multiplayer Features
This deployment includes:
- ✅ 15x larger ships with red/white colors
- ✅ Fixed minimap with dynamic zoom  
- ✅ Turbo mode (press T for 2000 speed)
- ✅ Ships persist when players disconnect
- ✅ Visual indicators for disconnected players
- ✅ WebSocket multiplayer support
- ✅ Demos blockchain payment integration

## Performance Notes
- The app serves static files and handles WebSocket connections
- No build step required - all client code is vanilla JS
- Memory usage should be minimal
- WebSocket connections scale well on Railway