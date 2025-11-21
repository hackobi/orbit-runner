# Orbit Runner Project Analysis - November 15, 2025

## Project Overview
**Name**: orbit-runner  
**Type**: 3D space-flight multiplayer game with blockchain integration  
**Tech Stack**: Three.js, Node.js, Express, WebSocket, Demos Blockchain SDK

## Core Architecture

### Frontend (Client)
- **Main Entry**: `index.html` with ES modules importmap
- **Core Logic**: `main.js` - gameplay, rendering, UI
- **Styling**: `style.css` - HUD and overlays
- **Dependencies**: Three.js (3D graphics), Demos SDK (blockchain)

### Backend (Server)
- **Main Server**: `server/index.js` - Express + WebSocket
- **Features**: Multiplayer lobby, leaderboards, blockchain integration
- **Data Persistence**: JSON-based leaderboards storage

## Key Features

### Gameplay Mechanics
- **Flight Controls**: W/S (accelerate/decelerate), A/D or arrows (yaw), I/K or up/down (pitch)
- **Combat**: Space bar shooting, PvP with hitscan
- **Orb Types**: Shield (green), Pink, Fenix (orange/yellow), Zaphire (red/store), Wormhole, Boost
- **Environment**: Asteroid fields, planetary rings, near-miss effects
- **Store**: Points-based system for HP, Shield, Fenix upgrades

### Multiplayer System
- **Architecture**: Single lobby, deterministic world seed
- **Networking**: 30Hz input sync, server-authoritative simulation
- **Features**: PvP collisions, timestamp rewind, respawns with i-frames
- **Optimization**: Interest filtering for bandwidth reduction

### Blockchain Integration (Demos)
- **Wallet Detection**: `demos-extension-detector.js` for browser extension
- **DAHR Flow**: Connect wallet → sign stats → server broadcast → explorer link
- **Pay-to-Play**: 1 DEM entry fee via native transfer
- **Jackpot System**: Treasury-funded payouts for high scores
- **Server Wallet**: Requires DEMOS_SERVER_MNEMONIC environment variable

## Technical Implementation

### Error Handling
- **Extension Communication**: Sophisticated error filtering in main.js
- **Suppressed Errors**: Extension internal errors, postMessage issues
- **Debug Logging**: Suppressed errors logged at debug level

### Environment Configuration
Required `.env` variables:
```
DEMOS_SERVER_MNEMONIC="twelve or twenty-four words"     # Server wallet
DEMOS_TREASURY_MNEMONIC="twelve or twenty-four words"   # Treasury wallet
TREASURY_MIN_RESERVE="3"                               # DEM reserve
PAYOUT_MIN_PRIZE="1"                                   # Minimum payout
TELEGRAM_BOT_TOKEN=123456789:AA...                     # Optional announcements
TELEGRAM_CHAT_ID=-1001234567890                        # Optional announcements
```

### API Endpoints
- `POST /blockchain/submit` - Transaction submission
- `GET /pay/info` - Payment information
- `POST /pay/verify` - Payment verification
- WebSocket `/mp` - Multiplayer real-time sync

## Development Setup
```bash
npm install
python3 -m http.server 8000    # Frontend
npm run server                 # Backend (port 8787)
```

## Current State Analysis
- **Project Structure**: Well-organized with clear separation of concerns
- **Dependencies**: Modern stack with Three.js, Demos SDK v2.4.16
- **Blockchain Integration**: Comprehensive wallet and payment system
- **Multiplayer**: Production-ready with WebSocket implementation
- **Error Handling**: Robust extension communication handling

## Notable Files
- `main.js` - Core game logic with extension error handling
- `server/index.js` - Backend with blockchain integration
- `demos-extension-detector.js` - Wallet connection detection
- `package.json` - Dependencies and scripts
- `README.md` - Comprehensive documentation

## Development Notes
- Uses ES modules via importmap in index.html
- Cache-busting for main.js in development
- Background tab throttling considerations for multiplayer
- Same-origin hosting recommended for production
- Telegram integration for high score announcements

## Security & Architecture
- Server-authoritative multiplayer simulation
- Client-side input validation
- Treasury safety mechanisms (minimum reserves)
- Environment-based configuration management
- CORS enabled for cross-origin requests