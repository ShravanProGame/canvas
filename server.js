// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(express.json());
app.use(express.static('public'));

// In-memory storage
const channels = {
  general: [],
  random: [],
  gaming: []
};

const users = new Map();            // WebSocket -> { username, id }
const userSocketMap = new Map();    // username -> WebSocket
const privateChats = new Map();     // chatId -> messages array

// Admin moderation state
const bannedUsers = new Set();      // permanently banned usernames
const timeouts = new Map();         // username -> timeoutExpiry (ms since epoch)

// WebSocket connection handler
wss.on('connection', (ws) => {
  // Initial handshake
  safeSend(ws, { type: 'connected', message: 'Connected to server' });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      safeSend(ws, { type: 'error', message: 'Error parsing message' });
      return;
    }
    handleMessage(ws, message);
  });

  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      userSocketMap.delete(user.username);
      users.delete(ws);
      broadcastUserList();
    }
  });

  ws.on('error', () => {
    // Avoid noisy logs; production would log this
  });
});

// Safe send helper
function safeSend(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// Message router
function handleMessage(ws, message) {
  switch (message.type) {
    case 'join':               return handleJoin(ws, message);
    case 'message':            return handleChatMessage(ws, message);
    case 'getHistory':         return handleGetHistory(ws, message);
    case 'typing':             return handleTyping(ws, message);
    case 'privateChatRequest': return handlePrivateChatRequest(ws, message);
    case 'privateChatResponse':return handlePrivateChatResponse(ws, message);
    case 'privateMessage':     return handlePrivateMessage(ws, message);
    case 'getPrivateHistory':  return handleGetPrivateHistory(ws, message);
    // Admin commands from front-end panel
    case 'timeout':            return handleTimeoutCommand(message);
    case 'ban':                return handleBanCommand(message);
    default:
      // Unknown type; ignore to keep server resilient
      return;
  }
}

// Join handler with ban/timeout enforcement
function handleJoin(ws, message) {
  const { username } = message;
  if (!username || typeof username !== 'string') {
    safeSend(ws, { type: 'error', message: 'Invalid username' });
    ws.close();
    return;
  }

  // Enforce ban
  if (bannedUsers.has(username)) {
    safeSend(ws, { type: 'error', message: 'You are banned.' });
    ws.close();
    return;
  }

  // Enforce active timeout
  const timeoutExpiry = timeouts.get(username);
  if (timeoutExpiry && Date.now() < timeoutExpiry) {
    const remainingMs = timeoutExpiry - Date.now();
    safeSend(ws, { type: 'error', message: `You are timed out for ${(remainingMs / 1000).toFixed(0)}s.` });
    ws.close();
    return;
  } else if (timeoutExpiry && Date.now() >= timeoutExpiry) {
    timeouts.delete(username); // cleanup expired timeout
  }

  // Register user socket
  users.set(ws, { username, id: generateId() });
  userSocketMap.set(username, ws);

  // Acknowledge join and send channel list
  safeSend(ws, { type: 'joined', username, channels: Object.keys(channels) });

  // Broadcast user list
  broadcastUserList();
}

// Channel message handler
function handleChatMessage(ws, message) {
  const user = users.get(ws);
  if (!user) return;

  const { channel, text } = message;
  if (!channel || typeof text !== 'string') return;

  const chatMessage = {
    id: generateId(),
    author: user.username,
    text,
    channel,
    timestamp: new Date().toISOString()
  };

  if (!channels[channel]) channels[channel] = [];
  channels[channel].push(chatMessage);
  if (channels[channel].length > 100) channels[channel].shift();

  broadcast({ type: 'message', message: chatMessage });
}

// Typing handler (channel broadcast or private direct)
function handleTyping(ws, message) {
  const user = users.get(ws);
  if (!user) return;
  const { channel, isTyping, isPrivate, targetUsername } = message;

  if (isPrivate && targetUsername) {
    const targetWs = userSocketMap.get(targetUsername);
    safeSend(targetWs, { type: 'typing', username: user.username, channel, isTyping, isPrivate: true });
  } else {
    broadcast({ type: 'typing', username: user.username, channel, isTyping }, ws);
  }
}

// History handlers
function handleGetHistory(ws, message) {
  const { channel } = message;
  const msgs = channels[channel] || [];
  safeSend(ws, { type: 'history', channel, messages: msgs });
}

function handleGetPrivateHistory(ws, message) {
  const { chatId } = message;
  const msgs = privateChats.get(chatId) || [];
  safeSend(ws, { type: 'privateHistory', chatId, messages: msgs });
}

// Private chat setup
function handlePrivateChatRequest(ws, message) {
  const sender = users.get(ws);
  if (!sender) return;
  const { targetUsername } = message;
  const targetWs = userSocketMap.get(targetUsername);
  if (!targetWs) {
    safeSend(ws, { type: 'error', message: 'User not found or offline' });
    return;
  }
  safeSend(targetWs, { type: 'privateChatRequest', from: sender.username, requestId: generateId() });
}

function handlePrivateChatResponse(ws, message) {
  const responder = users.get(ws);
  if (!responder) return;
  const { accepted, from } = message;
  const requesterWs = userSocketMap.get(from);
  if (!requesterWs) {
    safeSend(ws, { type: 'error', message: 'User no longer online' });
    return;
  }

  if (accepted) {
    const pair = [from, responder.username].sort();
    const chatId = `private_${pair[0]}_${pair[1]}`;
    if (!privateChats.has(chatId)) privateChats.set(chatId, []);

    safeSend(requesterWs, { type: 'privateChatAccepted', chatId, with: responder.username });
    safeSend(ws, { type: 'privateChatAccepted', chatId, with: from });
  } else {
    safeSend(requesterWs, { type: 'privateChatRejected', by: responder.username });
  }
}

// Private message
function handlePrivateMessage(ws, message) {
  const sender = users.get(ws);
  if (!sender) return;
  const { chatId, text, targetUsername } = message;
  if (!chatId || typeof text !== 'string' || !targetUsername) return;

  const pm = {
    id: generateId(),
    author: sender.username,
    text,
    chatId,
    timestamp: new Date().toISOString()
  };

  if (!privateChats.has(chatId)) privateChats.set(chatId, []);
  const list = privateChats.get(chatId);
  list.push(pm);
  if (list.length > 100) list.shift();

  const targetWs = userSocketMap.get(targetUsername);

  // Echo to sender and deliver to target
  safeSend(ws, { type: 'privateMessage', message: pm });
  safeSend(targetWs, { type: 'privateMessage', message: pm });
}

// Admin: timeout command (disconnect + prevent rejoin until expiry)
function handleTimeoutCommand(message) {
  const { targetUsername, durationMs } = message;
  if (!targetUsername || typeof durationMs !== 'number' || durationMs < 0) return;

  const now = Date.now();
  const expiry = now + durationMs;
  timeouts.set(targetUsername, expiry);

  const targetWs = userSocketMap.get(targetUsername);
  if (targetWs) {
    safeSend(targetWs, { type: 'error', message: durationMs === 0 ? 'You have been kicked.' : `You are timed out for ${(durationMs / 1000).toFixed(0)}s.` });
    targetWs.close();
  }
}

// Admin: ban command (disconnect + permanently block rejoin)
function handleBanCommand(message) {
  const { targetUsername } = message;
  if (!targetUsername) return;

  bannedUsers.add(targetUsername);

  const targetWs = userSocketMap.get(targetUsername);
  if (targetWs) {
    safeSend(targetWs, { type: 'error', message: 'You are banned.' });
    targetWs.close();
  }
}

// Broadcast helpers
function broadcastUserList() {
  const list = Array.from(users.values()).map(u => u.username);
  broadcast({ type: 'userList', users: list });
}

function broadcast(payload, excludeWs = null) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// REST API (optional convenience)
app.get('/api/channels', (_req, res) => {
  res.json({ channels: Object.keys(channels) });
});

app.get('/api/channels/:channel/messages', (req, res) => {
  const { channel } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const msgs = channels[channel] || [];
  res.json({ messages: msgs.slice(-limit) });
});

app.post('/api/channels', (req, res) => {
  const { name } = req.body;
  if (!name || channels[name]) return res.status(400).json({ error: 'Invalid or duplicate channel name' });
  channels[name] = [];
  broadcast({ type: 'channelCreated', channel: name });
  res.json({ success: true, channel: name });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    users: users.size,
    channels: Object.keys(channels).length,
    privateChats: privateChats.size,
    banned: bannedUsers.size,
    timeouts: timeouts.size
  });
});

// Server start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('=================================');
  console.log(`Server running on port ${PORT}`);
  console.log('WebSocket server ready');
  console.log(`Open http://localhost:${PORT}`);
  console.log('=================================');
});

// Utilities
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
