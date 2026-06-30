const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Game lobbies state
// Key: lobby code (4-char uppercase, e.g., 'ABCD')
const lobbies = {};

// Helper to generate a unique lobby code
function generateLobbyCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (lobbies[code]);
  return code;
}

// Helper to get local network IP addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const k in interfaces) {
    for (const k2 in interfaces[k]) {
      const address = interfaces[k][k2];
      if (address.family === 'IPv4' && !address.internal) {
        addresses.push(address.address);
      }
    }
  }
  return addresses;
}

// WebSocket connection handler
wss.on('connection', (ws) => {
  let playerLobby = null;
  let playerId = null;

  // Send initial ping to client
  ws.send(JSON.stringify({ type: 'PING' }));

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      console.error('Invalid JSON received:', message);
      return;
    }

    switch (data.type) {
      case 'CREATE_LOBBY': {
        const code = generateLobbyCode();
        playerId = 'player_' + Math.random().toString(36).substr(2, 9);
        
        lobbies[code] = {
          code: code,
          hostId: playerId,
          gameState: 'lobby', // 'lobby', 'hiding', 'seeking', 'gameover'
          players: {},
          mapData: null, // Custom Base64 image
          mapName: 'Verdant Forest (Default)',
          mapType: 'forest',
          mapSeed: Math.random(),
          timer: 0,
          timerDuration: 0,
          maxHidingTime: 40,  // seconds hiders get to paint
          maxSeekingTime: 120, // seconds seekers get to seek
          hidersLeft: 0
        };

        const player = {
          id: playerId,
          name: data.playerName || 'Host',
          role: 'hider', // Default to hider
          ready: false,
          isHost: true,
          x: 400,
          y: 300,
          camoCanvasData: null, // Store if needed, but we replicate stamp events
          isExposed: false,
          perks: []
        };

        lobbies[code].players[playerId] = player;
        playerLobby = code;
        
        ws.playerId = playerId;
        ws.lobbyCode = code;

        ws.send(JSON.stringify({
          type: 'LOBBY_CREATED',
          code: code,
          playerId: playerId,
          lobbyState: getSanitizedLobbyState(code)
        }));
        break;
      }

      case 'JOIN_LOBBY': {
        const code = data.code ? data.code.toUpperCase() : '';
        const lobby = lobbies[code];
        
        if (!lobby) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Lobby not found!' }));
          return;
        }

        playerId = 'player_' + Math.random().toString(36).substr(2, 9);
        ws.playerId = playerId;
        ws.lobbyCode = code;
        playerLobby = code;

        // If game is in progress, the joining player becomes a spectator
        const isSpectator = lobby.gameState !== 'lobby';
        const player = {
          id: playerId,
          name: data.playerName || 'Player',
          role: isSpectator ? 'spectator' : 'hider',
          ready: false,
          isHost: false,
          x: 400,
          y: 300,
          isExposed: isSpectator,
          perks: []
        };

        lobby.players[playerId] = player;

        ws.send(JSON.stringify({
          type: 'LOBBY_JOINED',
          code: code,
          playerId: playerId,
          lobbyState: getSanitizedLobbyState(code)
        }));

        // Send current map state to joining client immediately
        ws.send(JSON.stringify({
          type: 'MAP_UPDATED',
          mapName: lobby.mapName,
          mapType: lobby.mapType,
          mapSeed: lobby.mapSeed,
          mapData: lobby.mapData
        }));

        broadcastToLobby(code, {
          type: 'PLAYER_JOINED',
          player: player,
          lobbyState: getSanitizedLobbyState(code)
        });
        break;
      }

      case 'SET_ROLE': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'lobby') return;

        const player = lobby.players[playerId];
        if (!player) return;

        player.role = data.role; // 'hider' or 'seeker'
        broadcastToLobby(playerLobby, {
          type: 'LOBBY_UPDATE',
          lobbyState: getSanitizedLobbyState(playerLobby)
        });
        break;
      }

      case 'SET_READY': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'lobby') return;

        const player = lobby.players[playerId];
        if (!player) return;

        player.ready = data.ready;
        broadcastToLobby(playerLobby, {
          type: 'LOBBY_UPDATE',
          lobbyState: getSanitizedLobbyState(playerLobby)
        });
        break;
      }

      case 'UPLOAD_MAP': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'lobby') return;

        lobby.mapData = data.mapData; // Base64 representation of custom map image
        lobby.mapType = data.mapType || 'custom';
        lobby.mapSeed = data.mapSeed || Math.random();
        
        if (lobby.mapType === 'custom') {
          lobby.mapName = 'Custom Map';
        } else {
          const names = { forest: 'Verdant Forest (Default)', industrial: 'Industrial Tiles', cyber: 'Cyber Grid' };
          lobby.mapName = names[lobby.mapType] || 'Procedural Map';
        }

        broadcastToLobby(playerLobby, {
          type: 'MAP_UPDATED',
          mapName: lobby.mapName,
          mapType: lobby.mapType,
          mapSeed: lobby.mapSeed,
          mapData: lobby.mapData
        });
        break;
      }

      case 'START_GAME': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'lobby') return;
        
        const player = lobby.players[playerId];
        if (!player || !player.isHost) return;

        // Count seekers and hiders
        let hidersCount = 0;
        let seekersCount = 0;
        
        Object.values(lobby.players).forEach(p => {
          if (p.role === 'hider') hidersCount++;
          if (p.role === 'seeker') seekersCount++;
          // Reset states
          p.isExposed = false;
          p.x = 100 + Math.random() * 600;
          p.y = 100 + Math.random() * 400;
          p.perks = [];
        });

        if (hidersCount === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Need at least one Hider to start!' }));
          return;
        }
        if (seekersCount === 0) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Need at least one Seeker to start!' }));
          return;
        }

        // Initialize Seeker Perks
        // Available perks: radar_pulse, thermal_goggles, wet_paint, movement_ripple, spy_camera
        const availablePerks = ['radar_pulse', 'thermal_goggles', 'wet_paint', 'movement_ripple', 'spy_camera'];
        Object.values(lobby.players).forEach(p => {
          if (p.role === 'seeker') {
            // Select 3 random perks
            const shuffled = [...availablePerks].sort(() => 0.5 - Math.random());
            p.perks = shuffled.slice(0, 3);
          }
        });

        lobby.gameState = 'hiding';
        lobby.timer = lobby.maxHidingTime;
        lobby.hidersLeft = hidersCount;
        lobby.winner = null;

        broadcastToLobby(playerLobby, {
          type: 'GAME_STARTED',
          lobbyState: getSanitizedLobbyState(playerLobby)
        });

        startLobbyTimer(playerLobby);
        break;
      }

      case 'MOVE_PLAYER': {
        const lobby = lobbies[playerLobby];
        if (!lobby || (lobby.gameState !== 'hiding' && lobby.gameState !== 'seeking')) return;

        const player = lobby.players[playerId];
        if (!player || player.isExposed) return;

        player.x = data.x;
        player.y = data.y;

        // Broadcast player movement to other hiders (so they don't collide/overlap invisibly)
        // and to spectators. Seekers DO NOT receive this movement update during hiding phase.
        // During seeking phase, hiders' positions are synced but normally invisible unless exposed or moving.
        // To be safe, we broadcast movement to all clients. The client renders hiders depending on their state and role.
        broadcastToLobby(playerLobby, {
          type: 'PLAYER_MOVED',
          playerId: playerId,
          x: player.x,
          y: player.y
        });
        break;
      }

      case 'PAINT_STAMP': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'hiding') return; // Can only paint during hiding phase

        const player = lobby.players[playerId];
        if (!player || player.role !== 'hider' || player.isExposed) return;

        // Broadcast stamp action to all clients in the lobby.
        // They will replicate this stamp onto this player's visual model.
        broadcastToLobby(playerLobby, {
          type: 'PLAYER_STAMPED',
          playerId: playerId,
          x: data.x,
          y: data.y
        });
        break;
      }

      case 'PAINT_BRUSH': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'hiding') return;

        const player = lobby.players[playerId];
        if (!player || player.role !== 'hider' || player.isExposed) return;

        // Broadcast brush stroke to replication.
        broadcastToLobby(playerLobby, {
          type: 'PLAYER_BRUSHED',
          playerId: playerId,
          localX: data.localX,
          localY: data.localY,
          brushType: data.brushType, // 'camo' or 'solid'
          color: data.color,
          radius: data.radius
        });
        break;
      }

      case 'SEEKER_CLICK': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'seeking') return;

        const player = lobby.players[playerId];
        if (!player || player.role !== 'seeker') return;

        // Validate seeker click at coordinate (data.x, data.y)
        // Send click event to everyone to draw seeker click effect
        broadcastToLobby(playerLobby, {
          type: 'SEEKER_CLICKED',
          seekerId: playerId,
          x: data.x,
          y: data.y
        });

        // Check if it hits any hider
        let hitPlayerId = null;
        Object.values(lobby.players).forEach(p => {
          if (p.role === 'hider' && !p.isExposed) {
            // Determine distance
            // Chameleon radius is approx 30px
            const dx = p.x - data.x;
            const dy = p.y - data.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < 28) { // Hit!
              p.isExposed = true;
              hitPlayerId = p.id;
            }
          }
        });

        if (hitPlayerId) {
          lobby.hidersLeft = Object.values(lobby.players).filter(p => p.role === 'hider' && !p.isExposed).length;
          
          broadcastToLobby(playerLobby, {
            type: 'HIDER_EXPOSED',
            playerId: hitPlayerId,
            seekerId: playerId,
            hidersLeft: lobby.hidersLeft,
            lobbyState: getSanitizedLobbyState(playerLobby)
          });

          // Check win condition
          if (lobby.hidersLeft === 0) {
            endGame(playerLobby, 'seekers');
          }
        }
        break;
      }

      // Seeker Perk activations
      case 'USE_PERK': {
        const lobby = lobbies[playerLobby];
        if (!lobby || lobby.gameState !== 'seeking') return;

        const player = lobby.players[playerId];
        if (!player || player.role !== 'seeker') return;

        // Broadcast perk usage so all clients render animations/pulses
        broadcastToLobby(playerLobby, {
          type: 'PERK_ACTIVATED',
          seekerId: playerId,
          perkName: data.perkName,
          x: data.x, // Origin of activation
          y: data.y
        });
        break;
      }

      case 'CHAT_MESSAGE': {
        const lobby = lobbies[playerLobby];
        if (!lobby) return;

        const player = lobby.players[playerId];
        if (!player) return;

        broadcastToLobby(playerLobby, {
          type: 'CHAT_MSG',
          sender: player.name,
          message: data.message
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerLobby && playerId) {
      const lobby = lobbies[playerLobby];
      if (lobby) {
        const player = lobby.players[playerId];
        delete lobby.players[playerId];

        // Clean up empty lobbies
        if (Object.keys(lobby.players).length === 0) {
          if (lobby.timerInterval) clearInterval(lobby.timerInterval);
          delete lobbies[playerLobby];
        } else {
          // If the host disconnected, designate a new host
          if (player && player.isHost) {
            const remainingPlayers = Object.values(lobby.players);
            if (remainingPlayers.length > 0) {
              remainingPlayers[0].isHost = true;
              lobby.hostId = remainingPlayers[0].id;
            }
          }

          // Update active hiders count
          lobby.hidersLeft = Object.values(lobby.players).filter(p => p.role === 'hider' && !p.isExposed).length;

          broadcastToLobby(playerLobby, {
            type: 'PLAYER_LEFT',
            playerId: playerId,
            lobbyState: getSanitizedLobbyState(playerLobby)
          });

          // Check win conditions if game was in progress
          if (lobby.gameState === 'seeking') {
            if (lobby.hidersLeft === 0) {
              endGame(playerLobby, 'seekers');
            }
          }
        }
      }
    }
  });
});

// Helper to sanitize lobby state before sending to clients
// (removes raw ws references or socket objects)
function getSanitizedLobbyState(code) {
  const lobby = lobbies[code];
  if (!lobby) return null;

  const sanitizedPlayers = {};
  Object.keys(lobby.players).forEach(id => {
    const p = lobby.players[id];
    sanitizedPlayers[id] = {
      id: p.id,
      name: p.name,
      role: p.role,
      ready: p.ready,
      isHost: p.isHost,
      x: p.x,
      y: p.y,
      isExposed: p.isExposed,
      perks: p.perks
    };
  });

  return {
    code: lobby.code,
    hostId: lobby.hostId,
    gameState: lobby.gameState,
    players: sanitizedPlayers,
    mapName: lobby.mapName,
    timer: lobby.timer,
    hidersLeft: lobby.hidersLeft,
    winner: lobby.winner
  };
}

// Broadcast JSON data to all clients in a specific lobby
function broadcastToLobby(code, messageData) {
  const payload = JSON.stringify(messageData);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.lobbyCode === code) {
      client.send(payload);
    }
  });
}

// Timer loops for lobbies
function startLobbyTimer(code) {
  const lobby = lobbies[code];
  if (!lobby) return;

  if (lobby.timerInterval) clearInterval(lobby.timerInterval);

  lobby.timerInterval = setInterval(() => {
    const currentLobby = lobbies[code];
    if (!currentLobby) {
      clearInterval(lobby.timerInterval);
      return;
    }

    currentLobby.timer--;

    broadcastToLobby(code, {
      type: 'TIMER_TICK',
      timer: currentLobby.timer
    });

    if (currentLobby.timer <= 0) {
      if (currentLobby.gameState === 'hiding') {
        // Transition to seeking phase
        currentLobby.gameState = 'seeking';
        currentLobby.timer = currentLobby.maxSeekingTime;
        broadcastToLobby(code, {
          type: 'PHASE_CHANGED',
          gameState: 'seeking',
          timer: currentLobby.timer,
          lobbyState: getSanitizedLobbyState(code)
        });
      } else if (currentLobby.gameState === 'seeking') {
        // Hiders win (timer ran out and at least one hider is unexposed)
        endGame(code, 'hiders');
      }
    }
  }, 1000);
}

function endGame(code, winner) {
  const lobby = lobbies[code];
  if (!lobby) return;

  if (lobby.timerInterval) {
    clearInterval(lobby.timerInterval);
    lobby.timerInterval = null;
  }

  lobby.gameState = 'gameover';
  lobby.winner = winner;

  // Set all players to ready=false for next round
  Object.values(lobby.players).forEach(p => {
    p.ready = false;
  });

  broadcastToLobby(code, {
    type: 'GAME_OVER',
    winner: winner,
    lobbyState: getSanitizedLobbyState(code)
  });
}

// Start HTTP server
server.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(`2D Chameleon Hide & Seek server listening on port ${PORT}`);
  console.log(`Local address: http://localhost:${PORT}`);
  
  const IPs = getLocalIPs();
  if (IPs.length > 0) {
    console.log(`Network Join addresses:`);
    IPs.forEach(ip => {
      console.log(`  http://${ip}:${PORT}`);
    });
  }
  console.log(`===================================================`);
});
