/**
 * 2D Chameleon: Camouflage Hide & Seek
 * Client-Side Game Engine and Network Controller
 */

(function () {
  // ==========================================================================
  // CONFIGURATION & GAME CONSTANTS
  // ==========================================================================
  const CANVAS_WIDTH = 900;
  const CANVAS_HEIGHT = 600;
  const PLAYER_RADIUS = 28;
  const PLAYER_SPEED = 3.5;
  const SYNC_RATE = 1000 / 30; // 30 updates per second for movement
  const SEEKER_CLICK_COOLDOWN = 2000; // 2 seconds

  // ==========================================================================
  // STATE VARIABLES
  // ==========================================================================
  let socket = null;
  let localPlayerId = null;
  let lobbyCode = null;
  let isHost = false;
  let localRole = 'hider'; // 'hider' or 'seeker'
  let lobbyState = null;
  let gameActive = false;

  // Local game loop variables
  let animationFrameId = null;
  let lastUpdateSent = 0;
  
  // Game assets and rendering
  let bgCanvas = null;
  let bgCtx = null;
  let bgImageLoaded = false;
  let customMapImage = null; // Image object for custom maps
  let currentMapType = 'forest'; // 'forest', 'industrial', 'cyber', 'custom'

  // Hider paint settings
  let hiderBrushMode = 'camo'; // 'camo' or 'solid'
  let hiderBrushColor = '#ff4a5a';
  let eyedropperActive = false;

  // Seeded Random Generator for procedural maps
  let seedRand = Math.random;
  function setMapSeed(seed) {
    seedRand = function() {
      let t = seed += 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Input state
  const keys = { w: false, a: false, s: false, d: false, ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false };
  let mouse = { x: 0, y: 0, isDown: false };

  // Seeker specific variables
  let seekerLastClickTime = 0;
  let thermalActive = false;
  let thermalEndTime = 0;
  let activePerks = []; // Holds the names of our 3 perks
  let wetPaintTrails = []; // Array of { x, y, time }
  let spyCameras = []; // Array of { x, y, id }
  let activeRadarPulse = null; // { x, y, radius, startTime }

  // Hider paint offscreen textures
  // Map of playerId -> { canvas, ctx }
  const playerTextures = {};

  // Audio synthesizers (using Web Audio API for native sound effects without files)
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  function playSound(type) {
    if (!audioCtx) return;
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);

      if (type === 'click_fail') {
        // Low buzzer sound
        osc.frequency.setValueAtTime(150, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.3);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.3);
      } else if (type === 'click_success') {
        // High alert sound
        osc.frequency.setValueAtTime(600, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(900, audioCtx.currentTime + 0.4);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.45);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.45);
      } else if (type === 'stamp') {
        // Spray/swoosh sound
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(100, audioCtx.currentTime + 0.15);
        gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.15);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.15);
      } else if (type === 'radar') {
        // Sonar ping
        osc.frequency.setValueAtTime(1200, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1200, audioCtx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.8);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.8);
      } else if (type === 'camera_alert') {
        // Beep beep!
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.1);
        
        setTimeout(() => {
          const osc2 = audioCtx.createOscillator();
          const gain2 = audioCtx.createGain();
          osc2.connect(gain2);
          gain2.connect(audioCtx.destination);
          osc2.frequency.setValueAtTime(880, audioCtx.currentTime);
          gain2.gain.setValueAtTime(0.2, audioCtx.currentTime);
          gain2.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
          osc2.start();
          osc2.stop(audioCtx.currentTime + 0.1);
        }, 150);
      }
    } catch (e) {
      console.warn("Audio Context error:", e);
    }
  }

  // ==========================================================================
  // DOM ELEMENTS
  // ==========================================================================
  const viewMenu = document.getElementById('view-menu');
  const viewLobby = document.getElementById('view-lobby');
  const viewGame = document.getElementById('view-game');
  const viewGameOver = document.getElementById('view-gameover');

  const inputNickname = document.getElementById('input-nickname');
  const btnCreateLobby = document.getElementById('btn-create-lobby');
  const inputLobbyCode = document.getElementById('input-lobby-code');
  const btnJoinLobby = document.getElementById('btn-join-lobby');

  const lobbyCodeVal = document.getElementById('lobby-code-val');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnLeaveLobby = document.getElementById('btn-leave-lobby');
  const lobbyPlayerCount = document.getElementById('lobby-player-count');
  const lobbyPlayersList = document.getElementById('lobby-players-list');

  const roleHider = document.getElementById('role-hider');
  const roleSeeker = document.getElementById('role-seeker');
  const btnReady = document.getElementById('btn-ready');
  
  const hostSettingsPanel = document.getElementById('host-settings');
  const selectMap = document.getElementById('select-map');
  const customMapUpload = document.getElementById('custom-map-upload');
  const mapFile = document.getElementById('map-file');
  const uploadPreviewContainer = document.getElementById('upload-preview-container');
  const uploadPreview = document.getElementById('upload-preview');
  const btnStartGame = document.getElementById('btn-start-game');

  const chatMessages = document.getElementById('chat-messages');
  const inputChat = document.getElementById('input-chat');
  const btnSendChat = document.getElementById('btn-send-chat');

  const gameLobbyCode = document.getElementById('game-lobby-code');
  const gamePhaseName = document.getElementById('game-phase-name');
  const gameTimer = document.getElementById('game-timer');
  const gameHidersLeft = document.getElementById('game-hiders-left');
  const gameCanvas = document.getElementById('game-canvas');
  const seekerBlackout = document.getElementById('seeker-blackout');
  const clickCooldownOverlay = document.getElementById('click-cooldown-overlay');
  
  const hiderHud = document.getElementById('hider-hud');
  const btnBrushCamo = document.getElementById('btn-brush-camo');
  const btnBrushColor = document.getElementById('btn-brush-color');
  const pickerPaintColor = document.getElementById('picker-paint-color');
  const btnEyedropper = document.getElementById('btn-eyedropper');
  
  const seekerHud = document.getElementById('seeker-hud');
  const seekerPerksList = document.getElementById('seeker-perks-list');
  const spectatorHud = document.getElementById('spectator-hud');

  const gameOverTitle = document.getElementById('gameover-title');
  const gameOverWinnerBanner = document.getElementById('gameover-winner-banner');
  const gameOverLobbyCode = document.getElementById('gameover-lobby-code');
  const gameOverHidersLeft = document.getElementById('gameover-hiders-left');
  const btnBackToLobby = document.getElementById('btn-back-to-lobby');

  const mainCanvasCtx = gameCanvas.getContext('2d');

  // Load nickname from local storage if available
  if (localStorage.getItem('chameleon_nick')) {
    inputNickname.value = localStorage.getItem('chameleon_nick');
  }

  // Set up offscreen background canvas
  bgCanvas = document.createElement('canvas');
  bgCanvas.width = CANVAS_WIDTH;
  bgCanvas.height = CANVAS_HEIGHT;
  bgCtx = bgCanvas.getContext('2d');

  // ==========================================================================
  // PROCEDURAL MAP GENERATORS
  // ==========================================================================
  function generateProceduralMap(type, seed) {
    if (seed !== undefined && seed !== null) {
      setMapSeed(seed);
    } else {
      seedRand = Math.random;
    }
    currentMapType = type;
    bgCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    bgImageLoaded = false;

    if (type === 'forest') {
      // 1. Forest backdrop (rich moss green)
      bgCtx.fillStyle = '#1e3f20';
      bgCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Noise/Grass speckles
      for (let i = 0; i < 400; i++) {
        bgCtx.fillStyle = i % 2 === 0 ? '#27522a' : '#173018';
        bgCtx.fillRect(seedRand() * CANVAS_WIDTH, seedRand() * CANVAS_HEIGHT, 4, 4);
      }

      // 2. Large grass patches
      for (let i = 0; i < 15; i++) {
        const patchX = seedRand() * CANVAS_WIDTH;
        const patchY = seedRand() * CANVAS_HEIGHT;
        const radius = 60 + seedRand() * 80;
        const grad = bgCtx.createRadialGradient(patchX, patchY, 10, patchX, patchY, radius);
        grad.addColorStop(0, '#2e6132');
        grad.addColorStop(1, 'rgba(30, 63, 32, 0)');
        bgCtx.fillStyle = grad;
        bgCtx.beginPath();
        bgCtx.arc(patchX, patchY, radius, 0, Math.PI * 2);
        bgCtx.fill();
      }

      // 3. Ancient logs (textures & details)
      for (let i = 0; i < 6; i++) {
        const logX = 100 + seedRand() * (CANVAS_WIDTH - 200);
        const logY = 100 + seedRand() * (CANVAS_HEIGHT - 200);
        const logW = 70 + seedRand() * 80;
        const logH = 24 + seedRand() * 8;
        
        bgCtx.fillStyle = '#5c4033'; // Wood brown
        bgCtx.fillRect(logX, logY, logW, logH);
        
        // Bark lines
        bgCtx.strokeStyle = '#3d2b22';
        bgCtx.lineWidth = 2;
        bgCtx.beginPath();
        bgCtx.moveTo(logX, logY + logH/3);
        bgCtx.lineTo(logX + logW, logY + logH/3);
        bgCtx.moveTo(logX, logY + 2*logH/3);
        bgCtx.lineTo(logX + logW, logY + 2*logH/3);
        bgCtx.stroke();

        // End rings
        bgCtx.fillStyle = '#8b5a2b';
        bgCtx.beginPath();
        bgCtx.arc(logX, logY + logH/2, logH/2, 0, Math.PI * 2);
        bgCtx.fill();
        bgCtx.stroke();
      }

      // 4. Wild mushrooms
      for (let i = 0; i < 35; i++) {
        const mushX = seedRand() * CANVAS_WIDTH;
        const mushY = seedRand() * CANVAS_HEIGHT;
        
        // Cap (Red)
        bgCtx.fillStyle = '#cc3333';
        bgCtx.beginPath();
        bgCtx.arc(mushX, mushY, 6, Math.PI, 0);
        bgCtx.fill();
        
        // Spots (White)
        bgCtx.fillStyle = '#ffffff';
        bgCtx.fillRect(mushX - 3, mushY - 4, 1.5, 1.5);
        bgCtx.fillRect(mushX + 1, mushY - 3, 1.5, 1.5);
        bgCtx.fillRect(mushX, mushY - 5, 1.5, 1.5);

        // Stem
        bgCtx.fillStyle = '#eeeeee';
        bgCtx.fillRect(mushX - 1.5, mushY, 3, 5);
      }

      // 5. Some grey stones
      for (let i = 0; i < 10; i++) {
        const stoneX = seedRand() * CANVAS_WIDTH;
        const stoneY = seedRand() * CANVAS_HEIGHT;
        const sizeX = 15 + seedRand() * 20;
        const sizeY = 10 + seedRand() * 15;
        
        bgCtx.fillStyle = '#7a7a7a';
        bgCtx.beginPath();
        bgCtx.ellipse(stoneX, stoneY, sizeX, sizeY, seedRand() * Math.PI, 0, Math.PI * 2);
        bgCtx.fill();
        
        // Highlight
        bgCtx.fillStyle = '#9c9c9c';
        bgCtx.beginPath();
        bgCtx.ellipse(stoneX - sizeX/4, stoneY - sizeY/4, sizeX/3, sizeY/3, 0, 0, Math.PI * 2);
        bgCtx.fill();
      }
      bgImageLoaded = true;

    } else if (type === 'industrial') {
      // Dark slate background
      bgCtx.fillStyle = '#2b2b2b';
      bgCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Draw grid tiles
      const tileSize = 60;
      bgCtx.strokeStyle = '#1e1e1e';
      bgCtx.lineWidth = 3;
      for (let x = 0; x < CANVAS_WIDTH; x += tileSize) {
        for (let y = 0; y < CANVAS_HEIGHT; y += tileSize) {
          bgCtx.strokeRect(x, y, tileSize, tileSize);
          
          // Random rust patches on tiles
          if (seedRand() < 0.15) {
            bgCtx.fillStyle = 'rgba(139, 69, 19, 0.25)'; // Rust color
            bgCtx.fillRect(x + 5, y + 5, tileSize - 10, tileSize - 10);
          }
        }
      }

      // Industrial Hazard stripes
      bgCtx.save();
      bgCtx.fillStyle = '#d4af37'; // Dull hazard yellow
      bgCtx.fillRect(0, 0, CANVAS_WIDTH, 15);
      bgCtx.fillRect(0, CANVAS_HEIGHT - 15, CANVAS_WIDTH, 15);
      
      // Black stripe slashes
      bgCtx.fillStyle = '#111';
      for (let x = 0; x < CANVAS_WIDTH; x += 40) {
        bgCtx.beginPath();
        bgCtx.moveTo(x, 0);
        bgCtx.lineTo(x + 20, 0);
        bgCtx.lineTo(x + 5, 15);
        bgCtx.lineTo(x - 15, 15);
        bgCtx.closePath();
        bgCtx.fill();

        bgCtx.beginPath();
        bgCtx.moveTo(x, CANVAS_HEIGHT - 15);
        bgCtx.lineTo(x + 20, CANVAS_HEIGHT - 15);
        bgCtx.lineTo(x + 5, CANVAS_HEIGHT);
        bgCtx.lineTo(x - 15, CANVAS_HEIGHT);
        bgCtx.closePath();
        bgCtx.fill();
      }
      bgCtx.restore();

      // Big metallic pipes
      bgCtx.lineWidth = 14;
      bgCtx.strokeStyle = '#4f5d65';
      bgCtx.beginPath();
      // Pipe 1 (Across top)
      bgCtx.moveTo(-50, 100);
      bgCtx.lineTo(CANVAS_WIDTH + 50, 100);
      // Pipe 2 (Across right)
      bgCtx.moveTo(750, -50);
      bgCtx.lineTo(750, CANVAS_HEIGHT + 50);
      bgCtx.stroke();

      // Pipe Highlights (Gives metallic 3D feel)
      bgCtx.lineWidth = 3;
      bgCtx.strokeStyle = '#ffffff';
      bgCtx.beginPath();
      bgCtx.moveTo(-50, 96);
      bgCtx.lineTo(CANVAS_WIDTH + 50, 96);
      bgCtx.moveTo(746, -50);
      bgCtx.lineTo(746, CANVAS_HEIGHT + 50);
      bgCtx.stroke();
      
      // Steam Grates
      for (let i = 0; i < 3; i++) {
        const gx = 100 + i * 300;
        const gy = 300;
        bgCtx.fillStyle = '#1a1a1a';
        bgCtx.fillRect(gx, gy, 80, 50);
        bgCtx.fillStyle = '#0a0a0a';
        // Slots
        for (let j = 5; j < 80; j += 15) {
          bgCtx.fillRect(gx + j, gy + 5, 8, 40);
        }
      }
      bgImageLoaded = true;

    } else if (type === 'cyber') {
      // Deep space canvas
      bgCtx.fillStyle = '#05070f';
      bgCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

      // Draw cyber grid network
      bgCtx.strokeStyle = '#0d2b45';
      bgCtx.lineWidth = 1;
      const gridSize = 50;
      for (let x = 0; x < CANVAS_WIDTH; x += gridSize) {
        bgCtx.beginPath();
        bgCtx.moveTo(x, 0);
        bgCtx.lineTo(x, CANVAS_HEIGHT);
        bgCtx.stroke();
      }
      for (let y = 0; y < CANVAS_HEIGHT; y += gridSize) {
        bgCtx.beginPath();
        bgCtx.moveTo(0, y);
        bgCtx.lineTo(CANVAS_WIDTH, y);
        bgCtx.stroke();
      }

      // Circuit tracks
      bgCtx.strokeStyle = '#20b2aa';
      bgCtx.lineWidth = 2;
      for (let i = 0; i < 5; i++) {
        const startX = seedRand() * CANVAS_WIDTH;
        const startY = seedRand() * CANVAS_HEIGHT;
        bgCtx.beginPath();
        bgCtx.moveTo(startX, startY);
        bgCtx.lineTo(startX + 80, startY + 80);
        bgCtx.lineTo(startX + 180, startY + 80);
        bgCtx.stroke();
        
        // Node intersections
        bgCtx.fillStyle = '#00ffff';
        bgCtx.beginPath();
        bgCtx.arc(startX, startY, 4, 0, Math.PI * 2);
        bgCtx.arc(startX + 80, startY + 80, 4, 0, Math.PI * 2);
        bgCtx.arc(startX + 180, startY + 80, 4, 0, Math.PI * 2);
        bgCtx.fill();
      }

      // Neon glowing columns
      const cols = [
        { x: 150, y: 150, r: 25 },
        { x: 750, y: 150, r: 25 },
        { x: 450, y: 450, r: 35 }
      ];
      cols.forEach(c => {
        const grad = bgCtx.createRadialGradient(c.x, c.y, 2, c.x, c.y, c.r);
        grad.addColorStop(0, '#00ffff');
        grad.addColorStop(0.3, '#ff00ff');
        grad.addColorStop(1, 'rgba(5, 7, 15, 0)');
        bgCtx.fillStyle = grad;
        bgCtx.beginPath();
        bgCtx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
        bgCtx.fill();
      });
      bgImageLoaded = true;
    }
  }

  // Load default Forest map immediately
  generateProceduralMap('forest');

  // Set up custom uploaded image background
  function loadCustomMap(base64Data) {
    customMapImage = new Image();
    customMapImage.onload = function () {
      currentMapType = 'custom';
      bgCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      // Scale image to fill canvas
      bgCtx.drawImage(customMapImage, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      bgImageLoaded = true;
    };
    customMapImage.src = base64Data;
  }

  // ==========================================================================
  // CHAMELEON SPRITE SILHOUETTE DEFINITION
  // ==========================================================================
  function defineChameleonPath(ctx) {
    // Draws a beautiful stylized lizard silhouette centered at (0, 0)
    // Horizontal length: ~60px, width: ~40px
    ctx.beginPath();
    
    // Head / Nose (Front)
    ctx.moveTo(30, -5);
    ctx.quadraticCurveTo(35, 0, 30, 5);
    
    // Bottom jaw to front leg joint
    ctx.quadraticCurveTo(20, 10, 12, 10);
    
    // Front Leg (Right side / Bottom)
    ctx.lineTo(15, 20);
    ctx.lineTo(8, 20);
    ctx.lineTo(6, 10);
    
    // Belly / Body
    ctx.quadraticCurveTo(-5, 14, -14, 9);
    
    // Back Leg (Right side / Bottom)
    ctx.lineTo(-18, 20);
    ctx.lineTo(-24, 20);
    ctx.lineTo(-20, 9);
    
    // Tail attachment and dynamic curl loop
    ctx.quadraticCurveTo(-28, 5, -30, -2);
    ctx.quadraticCurveTo(-28, -12, -22, -12);
    ctx.quadraticCurveTo(-18, -8, -21, -3);
    ctx.quadraticCurveTo(-24, 0, -21, 3);
    ctx.quadraticCurveTo(-17, 4, -15, -4);
    
    // Back leg (Left side / Top)
    ctx.lineTo(-18, -16);
    ctx.lineTo(-12, -16);
    ctx.lineTo(-11, -5);
    
    // Spine
    ctx.quadraticCurveTo(0, -11, 10, -7);
    
    // Front leg (Left side / Top)
    ctx.lineTo(12, -18);
    ctx.lineTo(6, -18);
    ctx.lineTo(8, -6);
    
    // Neck / Head joint
    ctx.quadraticCurveTo(18, -8, 30, -5);
    
    ctx.closePath();
  }

  // ==========================================================================
  // PLAYER TEXTURE MANAGEMENT
  // ==========================================================================
  function getPlayerTexture(playerId) {
    if (!playerTextures[playerId]) {
      const texCanvas = document.createElement('canvas');
      texCanvas.width = 80;
      texCanvas.height = 80;
      const texCtx = texCanvas.getContext('2d');
      
      // Initialize with solid neon green/pink gradient so they stand out until painted
      const grad = texCtx.createLinearGradient(0, 0, 80, 80);
      grad.addColorStop(0, '#ff00ff');
      grad.addColorStop(1, '#00ffff');
      texCtx.fillStyle = grad;
      texCtx.fillRect(0, 0, 80, 80);
      
      playerTextures[playerId] = {
        canvas: texCanvas,
        ctx: texCtx
      };
    }
    return playerTextures[playerId];
  }

  // Action to stamp background pixels directly onto hider canvas
  function stampPlayerTexture(playerId, x, y) {
    const tex = getPlayerTexture(playerId);
    
    // Clear texture
    tex.ctx.clearRect(0, 0, 80, 80);
    
    // Draw background slice onto player's texture canvas
    // Aligning the coordinates so (x, y) on the background centers on the 80x80 texture canvas.
    tex.ctx.drawImage(bgCanvas, x - 40, y - 40, 80, 80, 0, 0, 80, 80);
    
    // Emit spray audio
    playSound('stamp');
  }

  // Brush paint background pixels onto specific local coordinate of player canvas
  function brushPlayerTexture(playerId, localX, localY, brushType, color, radius) {
    const tex = getPlayerTexture(playerId);
    const ctx = tex.ctx;
    
    ctx.save();
    ctx.beginPath();
    ctx.arc(localX, localY, radius, 0, Math.PI * 2);
    ctx.clip();
    
    if (brushType === 'camo') {
      // Find the screen position matching this local offset.
      // Wait: Since brush updates are local, how do we know the player's screen coordinate?
      // During active gameplay, we track player coordinates in lobbyState.
      // If we are replicating another player's brush strokes, we retrieve their current position:
      const pState = lobbyState?.players[playerId];
      if (pState) {
        // Local (localX, localY) maps to Screen (pState.x - 40 + localX, pState.y - 40 + localY)
        const screenX = pState.x - 40 + localX;
        const screenY = pState.y - 40 + localY;
        
        ctx.drawImage(bgCanvas, screenX - radius, screenY - radius, radius*2, radius*2, localX - radius, localY - radius, radius*2, radius*2);
      }
    } else {
      // Draw solid color
      ctx.fillStyle = color || '#ffffff';
      ctx.fill();
    }
    
    ctx.restore();
  }

  // ==========================================================================
  // WEBSOCKET & NETWORKING
  // ==========================================================================
  function connectToServer() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socketUrl = `${protocol}//${window.location.host}`;
    
    socket = new WebSocket(socketUrl);

    socket.onopen = () => {
      console.log('Connected to game server.');
    };

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }

      switch (msg.type) {
        case 'PING':
          socket.send(JSON.stringify({ type: 'PONG' }));
          break;

        case 'LOBBY_CREATED':
          lobbyCode = msg.code;
          localPlayerId = msg.playerId;
          lobbyState = msg.lobbyState;
          isHost = true;
          localRole = 'hider';
          setupLobbyUI();
          break;

        case 'LOBBY_JOINED':
          lobbyCode = msg.code;
          localPlayerId = msg.playerId;
          lobbyState = msg.lobbyState;
          isHost = false;
          
          // Set role based on what was preassigned
          const self = lobbyState.players[localPlayerId];
          localRole = self.role;
          
          setupLobbyUI();
          break;

        case 'PLAYER_JOINED':
          lobbyState = msg.lobbyState;
          addChatMessage('System', `${msg.player.name} joined the room!`);
          updatePlayersList();
          updateStartButtonState();
          break;

        case 'PLAYER_LEFT':
          lobbyState = msg.lobbyState;
          delete playerTextures[msg.playerId];
          const leftName = lobbyState.players[msg.playerId]?.name || 'A player';
          addChatMessage('System', `${leftName} left the room.`);
          
          // Check if we became the host
          if (lobbyState.hostId === localPlayerId) {
            isHost = true;
            hostSettingsPanel.classList.remove('hidden');
          }

          updatePlayersList();
          updateStartButtonState();
          break;

        case 'LOBBY_UPDATE':
          lobbyState = msg.lobbyState;
          
          // Update roles if changed
          if (lobbyState.players[localPlayerId]) {
            localRole = lobbyState.players[localPlayerId].role;
            updateRoleSelectorButtons();
          }

          updatePlayersList();
          updateStartButtonState();
          break;

        case 'MAP_UPDATED':
          if (lobbyState) {
            lobbyState.mapName = msg.mapName;
          }
          if (msg.mapData) {
            loadCustomMap(msg.mapData);
            // Update map selector to custom if it's not host
            if (!isHost) {
              selectMap.value = 'custom';
              uploadPreview.src = msg.mapData;
              customMapUpload.classList.remove('hidden');
              uploadPreviewContainer.classList.remove('hidden');
            }
          } else {
            // Generate seeded procedural map
            generateProceduralMap(msg.mapType, msg.mapSeed);
            if (!isHost) {
              selectMap.value = msg.mapType;
              customMapUpload.classList.add('hidden');
              uploadPreviewContainer.classList.add('hidden');
            }
          }
          break;

        case 'GAME_STARTED':
          initAudio();
          lobbyState = msg.lobbyState;
          
          // Reset local textures for a clean game
          Object.keys(playerTextures).forEach(key => delete playerTextures[key]);
          wetPaintTrails = [];
          spyCameras = [];
          activeRadarPulse = null;

          startGameLevel();
          break;

        case 'TIMER_TICK':
          if (lobbyState) {
            lobbyState.timer = msg.timer;
            updateTimerDisplay();
          }
          break;

        case 'PLAYER_MOVED':
          if (lobbyState && lobbyState.players[msg.playerId]) {
            const p = lobbyState.players[msg.playerId];
            
            // For movement ripple perk
            if (lobbyState.gameState === 'seeking' && localRole === 'seeker' && activePerks.includes('movement_ripple')) {
              const dx = p.x - msg.x;
              const dy = p.y - msg.y;
              const moveDist = Math.sqrt(dx*dx + dy*dy);
              if (moveDist > 1.5 && Math.random() < 0.25) {
                // Drop particle trail
                wetPaintTrails.push({
                  x: p.x,
                  y: p.y,
                  color: 'rgba(102, 252, 241, 0.4)',
                  time: Date.now() - 6000 // Lasts for only 2 seconds instead of 10s
                });
              }
            }

            p.x = msg.x;
            p.y = msg.y;
          }
          break;

        case 'PLAYER_STAMPED':
          stampPlayerTexture(msg.playerId, msg.x, msg.y);
          
          // For wet paint perk: hiders leave a marker when stamping
          if (lobbyState?.gameState === 'seeking') {
            wetPaintTrails.push({
              x: msg.x,
              y: msg.y,
              color: 'rgba(255, 74, 90, 0.7)',
              time: Date.now()
            });
          }
          break;

        case 'PLAYER_BRUSHED':
          brushPlayerTexture(msg.playerId, msg.localX, msg.localY, msg.brushType, msg.color, msg.radius);
          break;

        case 'PHASE_CHANGED':
          lobbyState.gameState = msg.gameState;
          lobbyState.timer = msg.timer;
          
          if (msg.lobbyState) {
            lobbyState = msg.lobbyState;
          }

          // Transition UI
          gamePhaseName.textContent = msg.gameState === 'seeking' ? 'Seeking Phase' : 'Hiding Phase';
          updateTimerDisplay();

          if (msg.gameState === 'seeking') {
            // Hide blackout for seekers
            seekerBlackout.classList.add('hidden');
            addChatMessage('System', 'The hunting phase has begun! Find the hiders!');
            
            // Setup perks if seeker
            if (localRole === 'seeker') {
              setupSeekerPerksHUD();
            }
          }
          break;

        case 'SEEKER_CLICKED':
          // Render click ripple visual
          createClickRipple(msg.x, msg.y);
          break;

        case 'HIDER_EXPOSED':
          lobbyState.hidersLeft = msg.hidersLeft;
          gameHidersLeft.textContent = msg.hidersLeft;
          
          if (lobbyState.players[msg.playerId]) {
            lobbyState.players[msg.playerId].isExposed = true;
          }

          const hiderName = lobbyState.players[msg.playerId]?.name || 'Hider';
          const seekerName = lobbyState.players[msg.seekerId]?.name || 'Seeker';
          addChatMessage('System', `💥 ${hiderName} has been EXPOSED by ${seekerName}!`);
          playSound('click_success');

          if (msg.playerId === localPlayerId) {
            localRole = 'spectator';
            hiderHud.classList.add('hidden');
            spectatorHud.classList.remove('hidden');
          }
          break;

        case 'PERK_ACTIVATED':
          triggerPerkAnimation(msg.perkName, msg.x, msg.y);
          break;

        case 'CHAT_MSG':
          addChatMessage(msg.sender, msg.message);
          break;

        case 'GAME_OVER':
          lobbyState = msg.lobbyState;
          showGameOverScreen(msg.winner);
          break;

        case 'ERROR':
          alert(msg.message);
          break;
      }
    };

    socket.onclose = () => {
      console.log('Disconnected from server. Returning to menu.');
      gameActive = false;
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      
      // Go back to main menu
      viewMenu.classList.add('active');
      viewLobby.classList.remove('active');
      viewGame.classList.remove('active');
      viewGameOver.classList.remove('active');
    };
  }

  // ==========================================================================
  // NAVIGATION & UI FLOW
  // ==========================================================================
  
  // 1. MAIN MENU ACTIONS
  btnCreateLobby.addEventListener('click', () => {
    initAudio();
    const name = inputNickname.value.trim();
    if (!name) {
      alert('Please enter a nickname!');
      return;
    }
    localStorage.setItem('chameleon_nick', name);
    
    if (!socket || socket.readyState !== WebSocket.OPEN) connectToServer();
    
    // Wait for connection to open before sending
    const checkOpen = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        clearInterval(checkOpen);
        socket.send(JSON.stringify({
          type: 'CREATE_LOBBY',
          playerName: name
        }));
      }
    }, 50);
  });

  btnJoinLobby.addEventListener('click', () => {
    initAudio();
    const name = inputNickname.value.trim();
    const code = inputLobbyCode.value.trim().toUpperCase();
    
    if (!name) {
      alert('Please enter a nickname!');
      return;
    }
    if (code.length !== 4) {
      alert('Lobby code must be 4 characters!');
      return;
    }
    localStorage.setItem('chameleon_nick', name);
    
    if (!socket || socket.readyState !== WebSocket.OPEN) connectToServer();
    
    const checkOpen = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        clearInterval(checkOpen);
        socket.send(JSON.stringify({
          type: 'JOIN_LOBBY',
          code: code,
          playerName: name
        }));
      }
    }, 50);
  });

  // Copy Lobby Code button
  btnCopyCode.addEventListener('click', () => {
    if (lobbyCode) {
      navigator.clipboard.writeText(lobbyCode).then(() => {
        alert('Lobby Code copied to clipboard: ' + lobbyCode);
      });
    }
  });

  // Leave Lobby button
  btnLeaveLobby.addEventListener('click', () => {
    if (socket) {
      socket.close();
    }
  });

  // Return to Lobby after Game Over
  btnBackToLobby.addEventListener('click', () => {
    viewGameOver.classList.remove('active');
    viewLobby.classList.add('active');
    
    // Re-trigger visual updates
    updatePlayersList();
    updateStartButtonState();
    
    // Re-verify roles and host settings
    const self = lobbyState.players[localPlayerId];
    localRole = self.role;
    updateRoleSelectorButtons();
  });

  // ==========================================================================
  // LOBBY CONFIGURATION & CHAT UI
  // ==========================================================================
  function setupLobbyUI() {
    viewMenu.classList.remove('active');
    viewLobby.classList.add('active');
    
    lobbyCodeVal.textContent = lobbyCode;
    chatMessages.innerHTML = '';
    
    // Show host panel if host
    if (isHost) {
      hostSettingsPanel.classList.remove('hidden');
    } else {
      hostSettingsPanel.classList.add('hidden');
    }

    updateRoleSelectorButtons();
    updatePlayersList();
    updateStartButtonState();
  }

  // Toggle roles
  roleHider.addEventListener('click', () => {
    if (localRole === 'hider') return;
    sendLobbyRoleChange('hider');
  });

  roleSeeker.addEventListener('click', () => {
    if (localRole === 'seeker') return;
    sendLobbyRoleChange('seeker');
  });

  function sendLobbyRoleChange(role) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'SET_ROLE',
        role: role
      }));
    }
  }

  function updateRoleSelectorButtons() {
    if (localRole === 'hider') {
      roleHider.classList.add('active');
      roleSeeker.classList.remove('active');
    } else if (localRole === 'seeker') {
      roleSeeker.classList.add('active');
      roleHider.classList.remove('active');
    }
  }

  // Ready button toggle
  btnReady.addEventListener('click', () => {
    const self = lobbyState.players[localPlayerId];
    if (!self) return;

    const newReady = !self.ready;
    
    // Toggle button style locally
    if (newReady) {
      btnReady.textContent = 'CANCEL READY';
      btnReady.classList.replace('btn-secondary', 'btn-primary');
    } else {
      btnReady.textContent = 'TOGGLE READY';
      btnReady.classList.replace('btn-primary', 'btn-secondary');
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'SET_READY',
        ready: newReady
      }));
    }
  });

  // Map settings selector
  selectMap.addEventListener('change', (e) => {
    const mapType = e.target.value;
    
    if (mapType === 'custom') {
      customMapUpload.classList.remove('hidden');
    } else {
      customMapUpload.classList.add('hidden');
      const seed = Math.random();
      generateProceduralMap(mapType, seed);
      
      // Update other players in lobby
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'UPLOAD_MAP',
          mapType: mapType,
          mapSeed: seed,
          mapData: null
        }));
      }
    }
  });

  // Custom background file drag & drop upload
  mapFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
      const dataUrl = event.target.result;
      
      // Show upload previews locally
      uploadPreview.src = dataUrl;
      uploadPreviewContainer.classList.remove('hidden');
      
      // Paint locally
      loadCustomMap(dataUrl);

      // Distribute to all clients
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'UPLOAD_MAP',
          mapType: 'custom',
          mapSeed: Math.random(),
          mapData: dataUrl
        }));
      }
    };
    reader.readAsDataURL(file);
  });

  // Host Start Game action
  btnStartGame.addEventListener('click', () => {
    if (isHost && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'START_GAME'
      }));
    }
  });

  // Hider HUD: Toggle Camo Brush Mode
  btnBrushCamo.addEventListener('click', () => {
    hiderBrushMode = 'camo';
    btnBrushCamo.classList.add('active');
    btnBrushColor.classList.remove('active');
    eyedropperActive = false;
    gameCanvas.style.cursor = 'default';
    btnEyedropper.classList.remove('active');
  });

  // Hider HUD: Toggle Solid Color Brush Mode
  btnBrushColor.addEventListener('click', () => {
    hiderBrushMode = 'solid';
    btnBrushColor.classList.add('active');
    btnBrushCamo.classList.remove('active');
    eyedropperActive = false;
    gameCanvas.style.cursor = 'default';
    btnEyedropper.classList.remove('active');
  });

  // Hider HUD: Color Picker Input Change
  pickerPaintColor.addEventListener('change', (e) => {
    hiderBrushColor = e.target.value;
    // Automatically switch to Solid Brush mode when selecting color
    hiderBrushMode = 'solid';
    btnBrushColor.classList.add('active');
    btnBrushCamo.classList.remove('active');
  });

  // Hider HUD: Eyedropper Button Toggle
  btnEyedropper.addEventListener('click', toggleEyedropperMode);

  function toggleEyedropperMode() {
    if (!gameActive || localRole !== 'hider') return;
    eyedropperActive = !eyedropperActive;
    if (eyedropperActive) {
      btnEyedropper.classList.add('active');
      gameCanvas.style.cursor = 'crosshair';
    } else {
      btnEyedropper.classList.remove('active');
      gameCanvas.style.cursor = 'default';
    }
  }

  // Players list synchronization UI
  function updatePlayersList() {
    if (!lobbyState) return;

    const playersArray = Object.values(lobbyState.players);
    lobbyPlayerCount.textContent = playersArray.length;
    
    lobbyPlayersList.innerHTML = '';
    
    playersArray.forEach(p => {
      const isSelf = p.id === localPlayerId;
      
      const card = document.createElement('div');
      card.className = `player-card ${isSelf ? 'is-self' : ''}`;
      
      // Role Icon selection
      let roleIcon = '🦎';
      if (p.role === 'seeker') roleIcon = '👁️';
      if (p.role === 'spectator') roleIcon = '👻';
      
      card.innerHTML = `
        <div class="player-info">
          <span class="player-role-indicator" title="${p.role}">${roleIcon}</span>
          <span class="player-name">${p.name}</span>
          ${p.isHost ? '<span class="player-badge badge-host">Host</span>' : ''}
          ${p.role === 'spectator' ? '<span class="player-badge badge-spectator">Spectator</span>' : ''}
        </div>
        <div class="player-status">
          <span class="status-dot ${p.ready ? 'ready' : ''}"></span>
          <span class="status-text">${p.ready ? 'Ready' : 'Not Ready'}</span>
        </div>
      `;
      
      lobbyPlayersList.appendChild(card);
    });
  }

  // Update validation checks for Start button (Ready states & role numbers)
  function updateStartButtonState() {
    if (!isHost) return;

    const playersArray = Object.values(lobbyState.players);
    let allReady = true;
    let hiders = 0;
    let seekers = 0;

    playersArray.forEach(p => {
      if (!p.isHost && !p.ready && p.role !== 'spectator') {
        allReady = false;
      }
      if (p.role === 'hider') hiders++;
      if (p.role === 'seeker') seekers++;
    });

    const meetsRoleRequirements = hiders > 0 && seekers > 0;
    
    if (allReady && meetsRoleRequirements) {
      btnStartGame.disabled = false;
      btnStartGame.classList.remove('btn-disabled');
    } else {
      btnStartGame.disabled = true;
      btnStartGame.classList.add('btn-disabled');
    }
  }

  // Chat triggers
  btnSendChat.addEventListener('click', sendChatMessage);
  inputChat.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendChatMessage();
  });

  function sendChatMessage() {
    const text = inputChat.value.trim();
    if (!text) return;

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'CHAT_MESSAGE',
        message: text
      }));
    }
    inputChat.value = '';
  }

  function addChatMessage(sender, text) {
    const row = document.createElement('div');
    row.className = 'chat-msg-row';
    
    if (sender === 'System') {
      row.innerHTML = `<span class="chat-sender" style="color: var(--color-warning-coral)">[SYS]</span> ${text}`;
    } else {
      row.innerHTML = `<span class="chat-sender">${sender}:</span> ${text}`;
    }
    
    chatMessages.appendChild(row);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Helper timer display conversion
  function updateTimerDisplay() {
    const secs = lobbyState.timer;
    const mins = Math.floor(secs / 60);
    const rem = secs % 60;
    gameTimer.textContent = `${mins.toString().padStart(2, '0')}:${rem.toString().padStart(2, '0')}`;
  }

  // ==========================================================================
  // GAME ENGINE LEVEL: RENDERING & CONTROLS LOOP
  // ==========================================================================
  
  function startGameLevel() {
    viewLobby.classList.remove('active');
    viewGame.classList.add('active');

    gameLobbyCode.textContent = lobbyCode;
    gameHidersLeft.textContent = lobbyState.hidersLeft;
    gamePhaseName.textContent = lobbyState.gameState === 'seeking' ? 'Seeking Phase' : 'Hiding Phase';
    updateTimerDisplay();

    // Reset controls
    Object.keys(keys).forEach(k => keys[k] = false);

    // Dynamic HUD setup
    hiderHud.classList.add('hidden');
    seekerHud.classList.add('hidden');
    spectatorHud.classList.add('hidden');
    seekerBlackout.classList.add('hidden');

    const self = lobbyState.players[localPlayerId];
    localRole = self.role;

    if (localRole === 'hider') {
      hiderHud.classList.remove('hidden');
      
      // Auto stamp on game start at initial position
      setTimeout(() => {
        sendStampCommand(self.x, self.y);
      }, 500);

    } else if (localRole === 'seeker') {
      seekerHud.classList.remove('hidden');
      // If still in hiding phase, show blackout
      if (lobbyState.gameState === 'hiding') {
        seekerBlackout.classList.remove('hidden');
      }

    } else {
      spectatorHud.classList.remove('hidden');
    }

    gameActive = true;
    
    // Start game rendering loops
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    animationFrameId = requestAnimationFrame(gameLoop);
  }

  // Main Canvas Rendering Loop (60 FPS)
  function gameLoop(timestamp) {
    if (!gameActive) return;

    updateLocalMovement();
    renderGameCanvas(timestamp);

    animationFrameId = requestAnimationFrame(gameLoop);
  }

  // Render game scene
  function renderGameCanvas(timestamp) {
    mainCanvasCtx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Apply thermal visual filter if perk is active
    if (localRole === 'seeker' && thermalActive) {
      if (Date.now() > thermalEndTime) {
        thermalActive = false;
      } else {
        // High contrast glowing thermal view
        mainCanvasCtx.filter = 'contrast(220%) saturate(300%) hue-rotate(190deg)';
      }
    }

    // 1. Draw environmental background map
    if (bgImageLoaded) {
      mainCanvasCtx.drawImage(bgCanvas, 0, 0);
    } else {
      mainCanvasCtx.fillStyle = '#111';
      mainCanvasCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }

    // 2. Draw wet paint trails (if Seeker has wet paint perk active)
    if (localRole === 'seeker' && activePerks.includes('wet_paint')) {
      const now = Date.now();
      // Retain paints under 10 seconds old
      wetPaintTrails = wetPaintTrails.filter(wp => now - wp.time < 10000);
      
      wetPaintTrails.forEach(wp => {
        const age = now - wp.time;
        const opacity = Math.max(0, 1 - age / 10000);
        
        mainCanvasCtx.save();
        mainCanvasCtx.fillStyle = wp.color;
        mainCanvasCtx.globalAlpha = opacity;
        
        // Render a small splash
        mainCanvasCtx.beginPath();
        mainCanvasCtx.arc(wp.x, wp.y, 8, 0, Math.PI * 2);
        mainCanvasCtx.arc(wp.x - 5, wp.y + 4, 4, 0, Math.PI * 2);
        mainCanvasCtx.arc(wp.x + 6, wp.y - 2, 5, 0, Math.PI * 2);
        mainCanvasCtx.fill();
        mainCanvasCtx.restore();
      });
    }

    // Reset filters after drawing background effects
    mainCanvasCtx.filter = 'none';

    // 3. Draw Spy Cameras (Seeker specific perk)
    spyCameras.forEach(cam => {
      mainCanvasCtx.save();
      
      // Pulse animation if hiders are close
      let alertMode = false;
      if (lobbyState) {
        Object.values(lobbyState.players).forEach(p => {
          if (p.role === 'hider' && !p.isExposed) {
            const dx = p.x - cam.x;
            const dy = p.y - cam.y;
            if (Math.sqrt(dx*dx + dy*dy) < 100) {
              alertMode = true;
            }
          }
        });
      }

      if (alertMode && Math.floor(Date.now() / 150) % 2 === 0) {
        mainCanvasCtx.fillStyle = 'rgba(255, 74, 90, 0.4)';
        mainCanvasCtx.beginPath();
        mainCanvasCtx.arc(cam.x, cam.y, 100, 0, Math.PI*2);
        mainCanvasCtx.fill();
        mainCanvasCtx.strokeStyle = 'var(--color-warning-coral)';
        mainCanvasCtx.stroke();
        
        // Alert beep
        if (Math.random() < 0.05) playSound('camera_alert');
      }

      // Camera base
      mainCanvasCtx.fillStyle = alertMode ? '#ff4a5a' : '#66fcf1';
      mainCanvasCtx.strokeStyle = '#fff';
      mainCanvasCtx.lineWidth = 2;
      mainCanvasCtx.beginPath();
      mainCanvasCtx.arc(cam.x, cam.y, 12, 0, Math.PI * 2);
      mainCanvasCtx.fill();
      mainCanvasCtx.stroke();
      
      // Lens
      mainCanvasCtx.fillStyle = '#000';
      mainCanvasCtx.beginPath();
      mainCanvasCtx.arc(cam.x, cam.y, 5, 0, Math.PI * 2);
      mainCanvasCtx.fill();
      
      // Glow dot
      mainCanvasCtx.fillStyle = alertMode ? '#ff0000' : '#39ff14';
      mainCanvasCtx.beginPath();
      mainCanvasCtx.arc(cam.x - 3, cam.y - 3, 2, 0, Math.PI * 2);
      mainCanvasCtx.fill();
      
      mainCanvasCtx.restore();
    });

    // 4. Draw players
    if (lobbyState) {
      const players = Object.values(lobbyState.players);
      
      players.forEach(p => {
        // Conditionals: Seeker cannot see Hiders during Hiding Phase, and normally invisible during Seeking Phase unless exposed
        const isSelf = p.id === localPlayerId;
        
        if (p.role === 'hider') {
          let shouldDraw = false;
          
          if (localRole === 'hider' || localRole === 'spectator') {
            shouldDraw = true; // Hiders/Spectators see everyone
          } else if (localRole === 'seeker') {
            // During seeking phase, hiders are drawn (their camouflage naturally hides them)
            if (lobbyState.gameState === 'seeking') {
              shouldDraw = true;
            }
          }

          if (shouldDraw) {
            renderHiderSprite(p, isSelf);
          }
        } else if (p.role === 'seeker') {
          // Draw seekers (Cursors or small icons)
          // Hide seekers from hiders unless they click, or draw a seeker cursor representation
          if (lobbyState.gameState === 'seeking') {
            renderSeekerCursor(p);
          }
        }
      });
    }

    // 5. Draw Sonar / Radar Pulse effect animations
    if (activeRadarPulse) {
      const elapsed = Date.now() - activeRadarPulse.startTime;
      const duration = 1500; // 1.5 seconds pulse duration
      if (elapsed > duration) {
        activeRadarPulse = null;
      } else {
        const progress = elapsed / duration;
        const radius = 220 * progress;
        
        mainCanvasCtx.save();
        mainCanvasCtx.strokeStyle = 'rgba(102, 252, 241, ' + (1 - progress) + ')';
        mainCanvasCtx.lineWidth = 3;
        mainCanvasCtx.beginPath();
        mainCanvasCtx.arc(activeRadarPulse.x, activeRadarPulse.y, radius, 0, Math.PI * 2);
        mainCanvasCtx.stroke();
        
        // Subtle glow inside sonar ripple
        mainCanvasCtx.fillStyle = 'rgba(102, 252, 241, ' + (0.1 * (1 - progress)) + ')';
        mainCanvasCtx.fill();
        mainCanvasCtx.restore();

        // Check if expanding sonar wavefront passes over any hider
        if (lobbyState) {
          Object.values(lobbyState.players).forEach(p => {
            if (p.role === 'hider' && !p.isExposed) {
              const dx = p.x - activeRadarPulse.x;
              const dy = p.y - activeRadarPulse.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              // Trigger a 1.5-second reveal if the wavefront hits the hider
              if (Math.abs(dist - radius) < 15) {
                p.radarRevealUntil = Date.now() + 1500;
              }
            }
          });
        }
      }
    }

    // 6. Draw click cooldown wheel on cursor if seeker is on cooldown
    if (localRole === 'seeker' && lobbyState.gameState === 'seeking') {
      const now = Date.now();
      const elapsed = now - seekerLastClickTime;
      
      if (elapsed < SEEKER_CLICK_COOLDOWN) {
        const progress = elapsed / SEEKER_CLICK_COOLDOWN;
        
        // Cooldown container visual HUD display
        clickCooldownOverlay.classList.remove('hidden');
        
        // Render small cooldown wheel around mouse coordinates
        mainCanvasCtx.save();
        mainCanvasCtx.strokeStyle = 'var(--color-warning-coral)';
        mainCanvasCtx.lineWidth = 4;
        mainCanvasCtx.beginPath();
        // Cooldown slice arc
        mainCanvasCtx.arc(mouse.x, mouse.y, 16, -Math.PI/2, (-Math.PI/2) + (Math.PI * 2 * progress));
        mainCanvasCtx.stroke();
        mainCanvasCtx.restore();
      } else {
        clickCooldownOverlay.classList.add('hidden');
      }
    }
  }

  // Renders the Hider chameleon with its texture mapping
  function renderHiderSprite(p, isSelf) {
    const tex = getPlayerTexture(p.id);
    
    // Draw Hider Chameleon shape
    mainCanvasCtx.save();
    mainCanvasCtx.translate(p.x, p.y);
    
    // Rotation based on angle or static
    // (Could calculate movement angle in update if needed, default to 0 for now)
    
    mainCanvasCtx.save();
    defineChameleonPath(mainCanvasCtx);
    mainCanvasCtx.clip();
    
    // Draw 80x80 local texture centered
    mainCanvasCtx.drawImage(tex.canvas, -40, -40);
    mainCanvasCtx.restore();

    // Reset translation to draw outlines
    mainCanvasCtx.restore();

    // Outlines:
    // Exposed hiders get solid red outlines
    // Pinged hiders get neon orange radar highlights
    // Self hider gets a glowing neon cyan outline
    // Other hiders get faint green outlines to hider clients
    let drawOutline = false;
    let strokeColor = '';
    let glow = false;

    if (p.isExposed) {
      drawOutline = true;
      strokeColor = 'var(--color-warning-coral)';
    } else if (p.radarRevealUntil && Date.now() < p.radarRevealUntil) {
      drawOutline = true;
      strokeColor = '#ff8c00'; // Radar orange
      glow = true;
    } else if (isSelf) {
      drawOutline = true;
      strokeColor = 'var(--color-neon-cyan)';
      glow = true;
    } else if (localRole === 'hider' || localRole === 'spectator') {
      drawOutline = true;
      strokeColor = 'rgba(69, 162, 158, 0.4)';
    }

    if (drawOutline) {
      mainCanvasCtx.save();
      mainCanvasCtx.translate(p.x, p.y);
      defineChameleonPath(mainCanvasCtx);
      mainCanvasCtx.strokeStyle = strokeColor;
      mainCanvasCtx.lineWidth = isSelf ? 2.5 : 1.5;
      
      if (glow) {
        mainCanvasCtx.shadowColor = strokeColor.startsWith('var') ? 'var(--color-neon-cyan)' : strokeColor;
        mainCanvasCtx.shadowBlur = 10;
      }
      
      mainCanvasCtx.stroke();
      mainCanvasCtx.restore();
    }
  }

  // Seeker cursor visualization on screen
  function renderSeekerCursor(p) {
    // Draw a small crosshair at the seeker's cursor location
    mainCanvasCtx.save();
    mainCanvasCtx.strokeStyle = 'var(--color-warning-coral)';
    mainCanvasCtx.lineWidth = 1.5;
    
    // Crosshair rings
    mainCanvasCtx.beginPath();
    mainCanvasCtx.arc(p.x, p.y, 8, 0, Math.PI * 2);
    mainCanvasCtx.moveTo(p.x - 12, p.y);
    mainCanvasCtx.lineTo(p.x + 12, p.y);
    mainCanvasCtx.moveTo(p.x, p.y - 12);
    mainCanvasCtx.lineTo(p.x, p.y + 12);
    mainCanvasCtx.stroke();
    
    // Draw seeker tag
    mainCanvasCtx.fillStyle = 'rgba(255, 74, 90, 0.7)';
    mainCanvasCtx.font = '9px var(--font-family-title)';
    mainCanvasCtx.fillText(p.name, p.x + 15, p.y + 4);
    
    mainCanvasCtx.restore();
  }

  // Create temporary clicking ripples on coordinates
  const clickRipples = [];
  function createClickRipple(x, y) {
    clickRipples.push({
      x: x,
      y: y,
      startTime: Date.now()
    });
  }

  // Render click rings on the canvas
  // (We append this logic at the end of rendering)
  const oldRender = renderGameCanvas;
  renderGameCanvas = function(timestamp) {
    oldRender(timestamp);
    
    const now = Date.now();
    const duration = 600;
    
    mainCanvasCtx.save();
    for (let i = clickRipples.length - 1; i >= 0; i--) {
      const rip = clickRipples[i];
      const elapsed = now - rip.startTime;
      if (elapsed > duration) {
        clickRipples.splice(i, 1);
      } else {
        const progress = elapsed / duration;
        mainCanvasCtx.strokeStyle = `rgba(255, 74, 90, ${1 - progress})`;
        mainCanvasCtx.lineWidth = 2;
        mainCanvasCtx.beginPath();
        mainCanvasCtx.arc(rip.x, rip.y, 30 * progress, 0, Math.PI * 2);
        mainCanvasCtx.stroke();
      }
    }
    mainCanvasCtx.restore();
  };

  // Local movement calculator based on keys pressed
  function updateLocalMovement() {
    if (!lobbyState || lobbyState.gameState === 'gameover') return;

    const self = lobbyState.players[localPlayerId];
    // Spectators, exposed players, and seekers do not move hider avatars
    if (!self || self.role !== 'hider' || self.isExposed) return;

    let dx = 0;
    let dy = 0;

    if (keys.w || keys.ArrowUp) dy -= 1;
    if (keys.s || keys.ArrowDown) dy += 1;
    if (keys.a || keys.ArrowLeft) dx -= 1;
    if (keys.d || keys.ArrowRight) dx += 1;

    if (dx !== 0 || dy !== 0) {
      // Normalize vector
      const len = Math.sqrt(dx * dx + dy * dy);
      const moveX = (dx / len) * PLAYER_SPEED;
      const moveY = (dy / len) * PLAYER_SPEED;

      let newX = self.x + moveX;
      let newY = self.y + moveY;

      // Keep within bounds
      newX = Math.max(PLAYER_RADIUS, Math.min(CANVAS_WIDTH - PLAYER_RADIUS, newX));
      newY = Math.max(PLAYER_RADIUS, Math.min(CANVAS_HEIGHT - PLAYER_RADIUS, newY));

      self.x = newX;
      self.y = newY;

      // Send to server throttled
      const now = Date.now();
      if (now - lastUpdateSent > SYNC_RATE) {
        socket.send(JSON.stringify({
          type: 'MOVE_PLAYER',
          x: self.x,
          y: self.y
        }));
        lastUpdateSent = now;
      }
      
      // Auto camo brush painting while moving if mouse is down
      if (mouse.isDown && lobbyState.gameState === 'hiding') {
        if (eyedropperActive) return;
        const localX = mouse.x - (self.x - 40);
        const localY = mouse.y - (self.y - 40);
        if (localX >= 0 && localX <= 80 && localY >= 0 && localY <= 80) {
          sendBrushCommand(localX, localY, hiderBrushMode, hiderBrushColor, 8);
        }
      }
    }
  }

  // Keyboard hooks
  window.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = true;
    if (keys.hasOwnProperty(e.key)) keys[e.key] = true;

    // Spacebar to stamp texture on hider position
    if (e.key === ' ' || e.code === 'Space') {
      if (gameActive && localRole === 'hider' && lobbyState?.gameState === 'hiding') {
        e.preventDefault();
        const self = lobbyState.players[localPlayerId];
        if (self && !self.isExposed) {
          sendStampCommand(self.x, self.y);
        }
      }
    }

    // E or C keys to toggle eyedropper for hider
    if (gameActive && localRole === 'hider' && lobbyState?.gameState === 'hiding') {
      if (e.key === 'e' || e.key === 'c') {
        e.preventDefault();
        toggleEyedropperMode();
      }
    }

    // Seeker Perk quick hotkeys (R, T, C, or 1, 2, 3)
    if (gameActive && localRole === 'seeker' && lobbyState?.gameState === 'seeking') {
      if (e.key === '1' || key === 'r') usePerk('radar_pulse');
      if (e.key === '2' || key === 't') usePerk('thermal_goggles');
      if (e.key === '3' || key === 'c') usePerk('spy_camera');
    }
  });

  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase();
    if (keys.hasOwnProperty(key)) keys[key] = false;
    if (keys.hasOwnProperty(e.key)) keys[e.key] = false;
  });

  // Stamp request sender
  function sendStampCommand(x, y) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'PAINT_STAMP',
        x: x,
        y: y
      }));
    }
  }

  // Brush paint request sender
  function sendBrushCommand(localX, localY, brushType, color, radius) {
    // Replicate locally instantly
    brushPlayerTexture(localPlayerId, localX, localY, brushType, color, radius);
    
    // Sync
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'PAINT_BRUSH',
        localX: localX,
        localY: localY,
        brushType: brushType,
        color: color,
        radius: radius
      }));
    }
  }

  // Mouse drag & click event hooks for game canvas
  gameCanvas.addEventListener('mousemove', (e) => {
    const rect = gameCanvas.getBoundingClientRect();
    mouse.x = (e.clientX - rect.left) * (CANVAS_WIDTH / rect.width);
    mouse.y = (e.clientY - rect.top) * (CANVAS_HEIGHT / rect.height);
    
    // Sync Seeker's mouse position to other players
    if (gameActive && localRole === 'seeker' && lobbyState?.gameState === 'seeking') {
      const now = Date.now();
      if (now - lastUpdateSent > SYNC_RATE) {
        socket.send(JSON.stringify({
          type: 'MOVE_PLAYER',
          x: mouse.x,
          y: mouse.y
        }));
        lastUpdateSent = now;
      }
    }

    // Brush painting on hider canvas
    if (mouse.isDown && gameActive && localRole === 'hider' && lobbyState?.gameState === 'hiding') {
      if (eyedropperActive) return;
      const self = lobbyState.players[localPlayerId];
      if (self) {
        const localX = mouse.x - (self.x - 40);
        const localY = mouse.y - (self.y - 40);
        if (localX >= 0 && localX <= 80 && localY >= 0 && localY <= 80) {
          sendBrushCommand(localX, localY, hiderBrushMode, hiderBrushColor, 8);
        }
      }
    }
  });

  gameCanvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { // Left click
      mouse.isDown = true;
      
      if (!gameActive || !lobbyState) return;

      // 1. Eyedropper click sampling
      if (localRole === 'hider' && eyedropperActive) {
        const imgData = bgCtx.getImageData(Math.floor(mouse.x), Math.floor(mouse.y), 1, 1).data;
        const colorHex = '#' + ((1 << 24) + (imgData[0] << 16) + (imgData[1] << 8) + imgData[2]).toString(16).slice(1);
        
        pickerPaintColor.value = colorHex;
        hiderBrushColor = colorHex;
        
        // Auto-switch to solid color brush
        hiderBrushMode = 'solid';
        btnBrushColor.classList.add('active');
        btnBrushCamo.classList.remove('active');
        
        // Reset eyedropper states
        eyedropperActive = false;
        btnEyedropper.classList.remove('active');
        gameCanvas.style.cursor = 'default';
        
        playSound('stamp');
        return; // Don't paint/seek on sample click
      }

      // 2. Seeker clicking to expose
      if (localRole === 'seeker' && lobbyState.gameState === 'seeking') {
        const now = Date.now();
        if (now - seekerLastClickTime >= SEEKER_CLICK_COOLDOWN) {
          seekerLastClickTime = now;
          
          // Play a guess chime
          playSound('click_fail');

          // Send click command to server
          socket.send(JSON.stringify({
            type: 'SEEKER_CLICK',
            x: mouse.x,
            y: mouse.y
          }));
        }
      }

      // 3. Hider manual brush clicks
      if (localRole === 'hider' && lobbyState.gameState === 'hiding') {
        const self = lobbyState.players[localPlayerId];
        if (self) {
          const localX = mouse.x - (self.x - 40);
          const localY = mouse.y - (self.y - 40);
          if (localX >= 0 && localX <= 80 && localY >= 0 && localY <= 80) {
            sendBrushCommand(localX, localY, hiderBrushMode, hiderBrushColor, 8);
          }
        }
      }
    }
  });

  window.addEventListener('mouseup', () => {
    mouse.isDown = false;
  });

  // ==========================================================================
  // SEEKER PERK MECHANICS
  // ==========================================================================
  function setupSeekerPerksHUD() {
    // Obtain active perks from server state
    const self = lobbyState.players[localPlayerId];
    if (!self || !self.perks) return;

    activePerks = self.perks;
    seekerPerksList.innerHTML = '';

    const perkDetails = {
      radar_pulse: { name: 'Radar Pulse (R)', icon: '📡', desc: 'Sonar ping scans nearby hiders [R]' },
      thermal_goggles: { name: 'Thermal Goggles (T)', icon: '👓', desc: 'Highlights outline mismatches [T]' },
      wet_paint: { name: 'Wet Paint', icon: '🎨', desc: 'Sees recently painted paint splats (Passive)' },
      movement_ripple: { name: 'Movement Ripple', icon: '👣', desc: 'Hiders leave a dust trace trail (Passive)' },
      spy_camera: { name: 'Spy Camera (C)', icon: '📷', desc: 'Planted camera alerts player if hider moves past [C]' }
    };

    activePerks.forEach((pName, index) => {
      const detail = perkDetails[pName];
      const button = document.createElement('div');
      button.className = 'perk-button';
      button.id = `perk-btn-${pName}`;
      button.title = detail.desc;
      
      let statusText = 'READY';
      if (pName === 'wet_paint' || pName === 'movement_ripple') {
        statusText = 'PASSIVE';
        button.classList.add('active'); // Passive perks are always active
      }

      button.innerHTML = `
        <span class="perk-btn-icon">${detail.icon}</span>
        <span class="perk-btn-name">${detail.name}</span>
        <span class="perk-btn-status" id="perk-status-${pName}">${statusText}</span>
      `;

      // Event handlers to activate active slot perks
      if (pName !== 'wet_paint' && pName !== 'movement_ripple') {
        button.addEventListener('click', () => usePerk(pName));
      }

      seekerPerksList.appendChild(button);
    });
  }

  function usePerkSlot(index) {
    if (activePerks && activePerks[index]) {
      usePerk(activePerks[index]);
    }
  }

  // Activate Perk Logic
  function usePerk(perkName) {
    if (!gameActive || lobbyState.gameState !== 'seeking') return;
    const btn = document.getElementById(`perk-btn-${perkName}`);
    if (!btn || btn.classList.contains('on-cooldown') || btn.classList.contains('disabled')) return;

    if (perkName === 'radar_pulse') {
      // Trigger radar pulse ping
      socket.send(JSON.stringify({
        type: 'USE_PERK',
        perkName: 'radar_pulse',
        x: mouse.x,
        y: mouse.y
      }));

      // Apply cooldown
      applyPerkCooldown(perkName, 15000); // 15 seconds cooldown

    } else if (perkName === 'thermal_goggles') {
      // Activate Thermal Goggles locally
      thermalActive = true;
      thermalEndTime = Date.now() + 5000; // 5 seconds duration
      
      socket.send(JSON.stringify({
        type: 'USE_PERK',
        perkName: 'thermal_goggles',
        x: mouse.x,
        y: mouse.y
      }));

      applyPerkCooldown(perkName, 20000); // 20 seconds cooldown

    } else if (perkName === 'spy_camera') {
      // Drop spy camera at mouse pointer location
      const camId = 'cam_' + Math.random().toString(36).substr(2, 5);
      
      spyCameras.push({
        id: camId,
        x: mouse.x,
        y: mouse.y
      });

      socket.send(JSON.stringify({
        type: 'USE_PERK',
        perkName: 'spy_camera',
        x: mouse.x,
        y: mouse.y
      }));

      // Charges: only allow 1 camera
      btn.classList.add('disabled');
      const statusText = document.getElementById(`perk-status-${perkName}`);
      if (statusText) statusText.textContent = 'PLANTED';
    }
  }

  function applyPerkCooldown(perkName, ms) {
    const btn = document.getElementById(`perk-btn-${perkName}`);
    const statusText = document.getElementById(`perk-status-${perkName}`);
    if (!btn) return;

    btn.classList.add('on-cooldown');
    let timeLeft = Math.ceil(ms / 1000);
    statusText.textContent = `${timeLeft}s`;

    const timer = setInterval(() => {
      timeLeft--;
      if (timeLeft <= 0) {
        clearInterval(timer);
        btn.classList.remove('on-cooldown');
        statusText.textContent = 'READY';
      } else {
        statusText.textContent = `${timeLeft}s`;
      }
    }, 1000);
  }

  // Visual effects and cues when perks trigger
  function triggerPerkAnimation(perkName, x, y) {
    if (perkName === 'radar_pulse') {
      playSound('radar');
      
      // Initialize sonar ripple effect
      activeRadarPulse = {
        x: x,
        y: y,
        startTime: Date.now()
      };

      // Seeker side scan check
      if (localRole === 'seeker') {
        let detected = false;
        Object.values(lobbyState.players).forEach(p => {
          if (p.role === 'hider' && !p.isExposed) {
            const dx = p.x - x;
            const dy = p.y - y;
            if (Math.sqrt(dx*dx + dy*dy) < 180) { // Sonar scan threshold
              detected = true;
            }
          }
        });

        if (detected) {
          addChatMessage('System', '📡 Sonar Ping: HIDER DETECTED NEARBY!');
        } else {
          addChatMessage('System', '📡 Sonar Ping: No hiders detected in radius.');
        }
      }
    } else if (perkName === 'thermal_goggles') {
      // Other players hear glasses adjustment sound or hum
    }
  }

  // ==========================================================================
  // GAME OVER & RESET SYSTEM
  // ==========================================================================
  function showGameOverScreen(winner) {
    gameActive = false;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);

    viewGame.classList.remove('active');
    viewGameOver.classList.add('active');

    gameOverLobbyCode.textContent = lobbyCode;
    gameOverHidersLeft.textContent = lobbyState.hidersLeft;

    if (winner === 'hiders') {
      gameOverWinnerBanner.textContent = 'Hiders Won!';
      gameOverWinnerBanner.className = 'winner-banner';
    } else {
      gameOverWinnerBanner.textContent = 'Seekers Won!';
      gameOverWinnerBanner.className = 'winner-banner seekers-won';
    }
  }

  // ==========================================================================
  // LOBBY GLOW DECORATIONS (WOW AESTHETICS)
  // ==========================================================================
  function setupDecorativeParticles() {
    const container = document.getElementById('particles');
    if (!container) return;
    
    container.innerHTML = '';
    const numParticles = 40;
    
    for (let i = 0; i < numParticles; i++) {
      const particle = document.createElement('div');
      
      const size = Math.random() * 4 + 2;
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const duration = Math.random() * 20 + 10;
      const delay = -Math.random() * duration;
      
      particle.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        background: ${i % 2 === 0 ? 'var(--color-neon-cyan)' : 'var(--color-neon-green)'};
        opacity: ${Math.random() * 0.4 + 0.1};
        border-radius: 50%;
        top: ${y}%;
        left: ${x}%;
        animation: floatParticles ${duration}s linear infinite;
        animation-delay: ${delay}s;
        pointer-events: none;
      `;
      
      container.appendChild(particle);
    }
  }

  // Inject floating CSS keyframes programmatically
  const style = document.createElement('style');
  style.innerHTML = `
    @keyframes floatParticles {
      0% { transform: translateY(0) translateX(0); }
      33% { transform: translateY(-50px) translateX(20px); }
      66% { transform: translateY(-20px) translateX(-20px); }
      100% { transform: translateY(-100px) translateX(0); opacity: 0; }
    }
  `;
  document.head.appendChild(style);

  // Trigger floating canvas sparkles on startup
  setupDecorativeParticles();

})();
