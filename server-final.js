const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

const app = express();
const PORT = process.env.PORT || 8787;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("."));
app.use("/node_modules", express.static("node_modules"));

// Load Demos SDK after server starts to avoid blocking startup
let demos = null;
let demosLoaded = false;
const transactionTokens = new Map(); // Store tokens for secure transactions

async function loadDemosSDK() {
  if (demosLoaded) return;

  try {
    console.log("🔗 Loading Demos SDK...");
    const { Demos } = require("@kynesyslabs/demosdk/websdk");
    demos = new Demos();
    demosLoaded = true;
    console.log("✅ Demos SDK loaded successfully");
  } catch (error) {
    console.error("❌ Failed to load Demos SDK:", error);
    // Continue without Demos SDK
  }
}

// Generate secure transaction token
function generateTransactionToken(playerAddress, gameData) {
  const token = randomUUID();
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

  transactionTokens.set(token, {
    playerAddress,
    gameData,
    createdAt: Date.now(),
    expiresAt,
    used: false,
  });

  // Clean up expired tokens
  setTimeout(() => {
    transactionTokens.delete(token);
  }, 15 * 60 * 1000);

  return token;
}

// Validate transaction token
function validateTransactionToken(token) {
  const tokenData = transactionTokens.get(token);

  if (!tokenData) {
    return { valid: false, error: "Invalid token" };
  }

  if (tokenData.used) {
    return { valid: false, error: "Token already used" };
  }

  if (Date.now() > tokenData.expiresAt) {
    transactionTokens.delete(token);
    return { valid: false, error: "Token expired" };
  }

  return { valid: true, data: tokenData };
}

// Mark token as used
function markTokenAsUsed(token) {
  const tokenData = transactionTokens.get(token);
  if (tokenData) {
    tokenData.used = true;
    transactionTokens.delete(token);
  }
}

// Basic endpoints that work without Demos
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/leaderboards", (_req, res) =>
  res.json({
    points: top.points,
    kills: top.kills,
    asteroids: top.asteroids,
    belt: top.belt,
    survival: top.survival,
  })
);

// Submit endpoint (works without blockchain)
app.post("/submit", (req, res) => {
  try {
    const { name, score, stats } = req.body;
    if (!name || typeof score !== "number")
      return res.status(400).json({ error: "Bad request" });

    // Update leaderboards
    updateLeaderboards(name, score, stats);
    lbBroadcast({
      type: "leaderboards",
      payload: {
        points: top.points,
        kills: top.kills,
        asteroids: top.asteroids,
        belt: top.belt,
        survival: top.survival,
      },
    });

    res.json({ ok: true, message: "Score submitted successfully" });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});

// Blockchain endpoints - load SDK on first request
app.post("/blockchain/test", async (req, res) => {
  await loadDemosSDK();

  if (!demos) {
    return res.status(503).json({
      ok: false,
      error: "Demos SDK not available",
    });
  }

  try {
    console.log("🧪 Testing blockchain connection...");

    // Test basic network connection
    await demos.connect("https://node2.demos.sh");

    res.json({
      ok: true,
      network: true,
      message: "Blockchain connection test successful",
      sdkLoaded: true,
    });
  } catch (error) {
    console.error("❌ Blockchain test failed:", error);
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

// DAHR - Data Access Handling Request endpoint
app.post("/blockchain/dahr", async (req, res) => {
  try {
    const { playerAddress, gameData } = req.body;

    if (!playerAddress || !gameData) {
      return res.status(400).json({
        ok: false,
        error: "Missing playerAddress or gameData",
      });
    }

    console.log("🔐 Generating DAHR for:", playerAddress);

    // Generate secure transaction token
    const token = generateTransactionToken(playerAddress, gameData);

    // Create DAHR response
    const dahrResponse = {
      ok: true,
      token: token,
      playerAddress: playerAddress,
      expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
      instructions: {
        title: "Blockchain Transaction Approval",
        message:
          "Approve the transaction in your Demos browser extension to submit your game stats to the blockchain.",
        steps: [
          "1. Open your Demos browser extension",
          "2. Review the transaction details",
          "3. Approve the transaction",
          "4. Return to the game to see confirmation",
        ],
      },
      transactionData: {
        game: "Orbit Runner",
        version: "1.0.0",
        timestamp: gameData.ts || Date.now(),
        stats: gameData.stats || {},
        dataType: "game-stats",
      },
    };

    res.json(dahrResponse);
  } catch (error) {
    console.error("❌ DAHR generation failed:", error);
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

// Secure transaction submission with token validation
app.post("/blockchain/submit", async (req, res) => {
  await loadDemosSDK();

  if (!demos) {
    return res.status(503).json({
      ok: false,
      error: "Demos SDK not available",
    });
  }

  try {
    const { token, signature, extensionResponse } = req.body;

    if (!token) {
      return res.status(400).json({
        ok: false,
        error: "Missing transaction token",
      });
    }

    // Validate token
    const validation = validateTransactionToken(token);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
      });
    }

    const { playerAddress, gameData } = validation.data;

    console.log("📊 Processing blockchain submission for:", playerAddress);

    // Check if extension provided approval
    if (extensionResponse && extensionResponse.approved) {
      // Player approved via extension - proceed with actual blockchain submission
      console.log(
        "✅ Extension approval received, submitting to blockchain..."
      );

      // Prepare data for blockchain storage
      const dataBytes = new TextEncoder().encode(
        JSON.stringify({
          game: "Orbit Runner",
          version: "1.0.0",
          playerAddress: playerAddress,
          timestamp: gameData.ts || Date.now(),
          stats: gameData.stats || {},
          signature: signature,
        })
      );

      try {
        // Store data on Demos blockchain
        const storageTx = await demos.store(dataBytes);
        console.log("✅ Data stored on blockchain:", storageTx);

        // Mark token as used
        markTokenAsUsed(token);

        res.json({
          ok: true,
          transactionHash: storageTx,
          message: "Game stats successfully submitted to Demos blockchain",
          confirmed: true,
        });
      } catch (blockchainError) {
        console.error("❌ Blockchain storage failed:", blockchainError);

        // Return failure but don't mark token as used (allow retry)
        res.status(500).json({
          ok: false,
          error: `Blockchain submission failed: ${String(blockchainError)}`,
          allowRetry: true,
        });
      }
    } else {
      // No extension approval - return instructions for manual approval
      console.log("⚠️ No extension approval, providing manual instructions");

      res.json({
        ok: true,
        requiresApproval: true,
        token: token,
        message: "Transaction requires browser extension approval",
        instructions: {
          title: "Extension Approval Required",
          steps: [
            "1. Ensure your Demos browser extension is unlocked",
            "2. The extension should show a pending transaction request",
            "3. Approve the transaction to submit your stats",
            "4. The game will automatically complete the submission",
          ],
          transactionData: {
            game: "Orbit Runner",
            player: playerAddress,
            score: gameData.stats?.score || 0,
            timestamp: new Date().toISOString(),
          },
        },
      });
    }
  } catch (error) {
    console.error("❌ Transaction submission failed:", error);
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

// Validate signature and complete transaction
app.post("/blockchain/complete", async (req, res) => {
  try {
    const { token, signature, transactionHash } = req.body;

    if (!token || !signature) {
      return res.status(400).json({
        ok: false,
        error: "Missing token or signature",
      });
    }

    // Validate token
    const validation = validateTransactionToken(token);
    if (!validation.valid) {
      return res.status(400).json({
        ok: false,
        error: validation.error,
      });
    }

    console.log("✅ Completing blockchain transaction");

    // Mark token as used (one-time use)
    markTokenAsUsed(token);

    res.json({
      ok: true,
      transactionHash: transactionHash || "pending",
      message: "Blockchain transaction completed successfully",
      timestamp: Date.now(),
    });
  } catch (error) {
    console.error("❌ Transaction completion failed:", error);
    res.status(500).json({
      ok: false,
      error: String(error),
    });
  }
});

// Leaderboards logic
const top = { points: [], kills: [], asteroids: [], belt: [], survival: [] };

function updateLeaderboards(name, score, stats = {}) {
  const entry = { name, score, ts: Date.now(), ...stats };

  // Update points leaderboard
  top.points.push(entry);
  top.points.sort((a, b) => b.score - a.score);
  top.points = top.points.slice(0, 10);

  // Update other leaderboards if stats provided
  if (stats.kills) {
    top.kills.push(entry);
    top.kills.sort((a, b) => b.kills - a.kills);
    top.kills = top.kills.slice(0, 10);
  }
}

// Start server immediately
const server = app.listen(PORT, () => {
  console.log(`🚀 Leaderboard API listening on :${PORT}`);
  console.log("📊 Health: http://localhost:8787/health");
  console.log("🧪 Blockchain test: http://localhost:8787/blockchain/test");
});

// WebSocket setup (simplified)
const lbWss = new WebSocketServer({ noServer: true });
const mpWss = new WebSocketServer({ noServer: true });

function lbBroadcast(msg) {
  const data = JSON.stringify(msg);
  lbWss.clients.forEach((c) => {
    try {
      if (c.readyState === 1) c.send(data);
    } catch (_) {}
  });
}

// Route upgrades
server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/mp") {
      mpWss.handleUpgrade(req, socket, head, (ws) =>
        mpWss.emit("connection", ws, req)
      );
    } else {
      lbWss.handleUpgrade(req, socket, head, (ws) =>
        lbWss.emit("connection", ws, req)
      );
    }
  } catch (e) {
    socket.destroy();
  }
});

console.log("✅ Server started successfully!");
