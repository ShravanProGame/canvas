// server.js - Enhanced Real-time chat server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Storage
const channels = { general: [], random: [], gaming: [], memes: [], announcements: [] };
const users = new Map();
const privateChats = new Map();
const userSocketMap = new Map();
const bannedUsers = new Set();
const timedOutUsers = new Map();
const bannedIPs = new Set();
const tempBannedIPs = new Map();
const ipBanMap = new Map();
const lastMessageTime = new Map();
const spamTracker = new Map(); // {username: {count, firstMsgTime}}
const messageReactions = new Map(); // {messageId: {emoji: [usernames]}}
const mutedUsers = new Map(); // {username: unmutetime}
const userWarnings = new Map(); // {username: count}

const ADMIN_PASSWORD = 'classic-admin-76';
const VIP_PASSWORD = 'very-important-person';
const adminUsers = new Set();
const vipUsers = new Set();
const adminActions = [];

// Limits
const MESSAGE_LIMIT = 100;
const USERNAME_LIMIT = 30;
const SPAM_THRESHOLD = 5; // messages
const SPAM_WINDOW = 10000; // 10 seconds
const SPAM_COOLDOWN = 30000; // 30 seconds

let serverSettings = {
  autoModEnabled: false,
  slowModeEnabled: false,
  slowModeDuration: 5,
  serverMotd: '',
  maintenanceMode: false,
  maxUsers: 100,
  allowGuests: true,
  profanityFilter: true
};

const badWords = ['fuck','shit','bitch','ass','damn','nigga','bastard','crap','piss','dick','pussy','cock','fck','fuk','sht','btch','dmn','nigger','vagina'];

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = (Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();
  if (!ip) ip = req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

function maskIp(ip) {
  if (!ip || ip === 'unknown') return 'unknown';
  const parts = ip.split('.');
  if (parts.length === 4) return `${parts[0]}.***.${parts[2]}.${parts[3]}`;
  const v6 = ip.split(':');
  if (v6.length > 1) return `${v6[0]}:*:${v6[v6.length-1]}`;
  return ip;
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(data);
  });
}

function sendToUser(username, message) {
  const ws = userSocketMap.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function sweepTempIpBans() {
  const now = Date.now();
  for (const [ip, meta] of tempBannedIPs.entries()) {
    if (now >= meta.until) tempBannedIPs.delete(ip);
  }
}

function isIpBanned(ip) {
  if (!ip || ip === 'unknown') return { banned: false };
  if (bannedIPs.has(ip)) return { banned: true, kind: 'permanent' };
  const meta = tempBannedIPs.get(ip);
  if (meta) {
    if (Date.now() < meta.until) return { banned: true, kind: 'temporary', until: meta.until, reason: meta.reason };
    tempBannedIPs.delete(ip);
  }
  return { banned: false };
}

function isUserTimedOut(username) {
  if (!timedOutUsers.has(username)) return false;
  if (Date.now() > timedOutUsers.get(username)) { timedOutUsers.delete(username); return false; }
  return true;
}

function isUserMuted(username) {
  if (!mutedUsers.has(username)) return false;
  if (Date.now() > mutedUsers.get(username)) { mutedUsers.delete(username); return false; }
  return true;
}

function checkSpam(username) {
  const now = Date.now();
  let tracker = spamTracker.get(username);
  if (!tracker || now - tracker.firstMsgTime > SPAM_WINDOW) {
    spamTracker.set(username, { count: 1, firstMsgTime: now });
    return { spam: false };
  }
  tracker.count++;
  if (tracker.count > SPAM_THRESHOLD) {
    const cooldownEnd = now + SPAM_COOLDOWN;
    timedOutUsers.set(username, cooldownEnd);
    spamTracker.delete(username);
    return { spam: true, cooldownEnd };
  }
  return { spam: false };
}

function checkSlowMode(username) {
  if (!serverSettings.slowModeEnabled) return { allowed: true };
  if (adminUsers.has(username)) return { allowed: true };
  const lastTime = lastMessageTime.get(username);
  if (!lastTime) { lastMessageTime.set(username, Date.now()); return { allowed: true }; }
  const timeSince = (Date.now() - lastTime) / 1000;
  if (timeSince < serverSettings.slowModeDuration) return { allowed: false, waitTime: Math.ceil(serverSettings.slowModeDuration - timeSince) };
  lastMessageTime.set(username, Date.now());
  return { allowed: true };
}

function containsBadWords(text) {
  const lower = text.toLowerCase();
  for (const word of badWords) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return { found: true, word };
  }
  return { found: false };
}

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({
    username: u.username, isVIP: u.isVIP || false, isAdmin: u.isAdmin || false
  }));
  broadcast({ type: 'userList', users: userList });
}

function requireAdmin(ws) {
  const admin = users.get(ws);
  if (!admin || !admin.isAdmin) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
    return null;
  }
  return admin;
}

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  ws.ip = ip;
  const ipStatus = isIpBanned(ip);
  if (ipStatus.banned) {
    ws.send(JSON.stringify({ type: 'banned', message: ipStatus.kind === 'permanent' ? 'Your IP is permanently banned' : `IP banned until ${new Date(ipStatus.until).toLocaleString()}` }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  if (serverSettings.maintenanceMode) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server is in maintenance mode' }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to server' }));
  ws.on('message', data => {
    try { handleMessage(ws, JSON.parse(data.toString())); } catch (e) { console.error('Parse error:', e); }
  });
  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      userSocketMap.delete(user.username);
      adminUsers.delete(user.username);
      vipUsers.delete(user.username);
      lastMessageTime.delete(user.username);
      spamTracker.delete(user.username);
      users.delete(ws);
      broadcastUserList();
    }
  });
});

function handleMessage(ws, msg) {
  const handlers = {
    join: handleJoin, message: handleChatMessage, getHistory: handleGetHistory,
    typing: handleTyping, privateChatRequest: handlePrivateChatRequest,
    privateChatResponse: handlePrivateChatResponse, privateMessage: handlePrivateMessage,
    getPrivateHistory: handleGetPrivateHistory, addReaction: handleAddReaction,
    removeReaction: handleRemoveReaction, adminKick: handleAdminKick,
    adminTimeout: handleAdminTimeout, adminBan: handleAdminBan, adminUnban: handleAdminUnban,
    adminUnbanIP: handleAdminUnbanIP, adminWarning: handleAdminWarning,
    adminFakeMessage: handleAdminFakeMessage, adminForceMute: handleAdminForceMute,
    adminUnmute: handleAdminUnmute, adminSpinScreen: handleAdminSpinScreen,
    adminSlowMode: handleAdminSlowMode, adminInvertColors: handleAdminInvertColors,
    adminShakeScreen: handleAdminShakeScreen, adminEmojiSpam: handleAdminEmojiSpam,
    adminRickRoll: handleAdminRickRoll, adminForceDisconnect: handleAdminForceDisconnect,
    adminFlipScreen: handleAdminFlipScreen, adminBroadcast: handleAdminBroadcast,
    adminUpdateSettings: handleAdminUpdateSettings, adminClearChat: handleAdminClearChat,
    adminDeleteMessage: handleAdminDeleteMessage, adminTempBanIP: handleAdminTempBanIP,
    adminGetBanList: handleAdminGetBanList, adminMaintenance: handleAdminMaintenance,
    adminGlobalMute: handleAdminGlobalMute, adminRainbow: handleAdminRainbow,
    adminBlur: handleAdminBlur, adminMatrix: handleAdminMatrix,
    adminConfetti: handleAdminConfetti, adminAnnounce: handleAdminAnnounce
  };
  if (handlers[msg.type]) handlers[msg.type](ws, msg);
}

function handleJoin(ws, msg) {
  let { username, isAdmin: reqAdmin, isVIP: reqVIP, adminPassword, vipPassword } = msg;
  if (!username || typeof username !== 'string') username = 'Guest' + Math.floor(Math.random()*1000);
  username = username.slice(0, USERNAME_LIMIT).trim();
  if (bannedUsers.has(username)) {
    ws.send(JSON.stringify({ type: 'banned', message: 'You are banned' }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  const isVerifiedAdmin = reqAdmin && adminPassword === ADMIN_PASSWORD;
  const isVerifiedVIP = reqVIP && vipPassword === VIP_PASSWORD;
  if (isVerifiedAdmin) adminUsers.add(username);
  if (isVerifiedVIP) vipUsers.add(username);
  users.set(ws, { username, id: generateId(), isAdmin: isVerifiedAdmin, isVIP: isVerifiedVIP, ip: ws.ip, joinedAt: Date.now() });
  userSocketMap.set(username, ws);
  ipBanMap.set(username, ws.ip);
  ws.send(JSON.stringify({ type: 'joined', username, channels: Object.keys(channels), isAdmin: isVerifiedAdmin, isVIP: isVerifiedVIP, limits: { message: MESSAGE_LIMIT, username: USERNAME_LIMIT } }));
  if (serverSettings.serverMotd) ws.send(JSON.stringify({ type: 'broadcast', message: `📢 ${serverSettings.serverMotd}` }));
  broadcastUserList();
}

function handleChatMessage(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  if (isUserTimedOut(user.username)) return ws.send(JSON.stringify({ type: 'error', message: 'You are timed out' }));
  if (isUserMuted(user.username)) return ws.send(JSON.stringify({ type: 'error', message: 'You are muted' }));
  let { channel, text, replyTo } = msg;
  if (!channel || typeof text !== 'string' || !text.trim()) return;
  // Message limit (admins bypass)
  if (!user.isAdmin && text.length > MESSAGE_LIMIT) {
    return ws.send(JSON.stringify({ type: 'error', message: `Message exceeds ${MESSAGE_LIMIT} character limit` }));
  }
  // Spam check (admins bypass)
  if (!user.isAdmin) {
    const spamCheck = checkSpam(user.username);
    if (spamCheck.spam) {
      ws.send(JSON.stringify({ type: 'timedOut', duration: 30, message: 'Spam detected. 30 second cooldown.' }));
      return;
    }
  }
  const slowCheck = checkSlowMode(user.username);
  if (!slowCheck.allowed) return ws.send(JSON.stringify({ type: 'error', message: `Slow mode: wait ${slowCheck.waitTime}s` }));
  if (serverSettings.autoModEnabled && !user.isAdmin) {
    const badCheck = containsBadWords(text);
    if (badCheck.found) {
      timedOutUsers.set(user.username, Date.now() + 30000);
      ws.send(JSON.stringify({ type: 'timedOut', duration: 30, message: `Auto-mod: bad word "${badCheck.word}"` }));
      return;
    }
  }
  const chatMsg = { id: generateId(), author: user.username, text, channel, timestamp: new Date().toISOString(), isVIP: user.isVIP, isAdmin: user.isAdmin, replyTo: replyTo || null, reactions: {} };
  if (channels[channel]) {
    channels[channel].push(chatMsg);
    if (channels[channel].length > 200) channels[channel].shift();
  }
  broadcast({ type: 'message', message: chatMsg });
}

function handleGetHistory(ws, msg) {
  ws.send(JSON.stringify({ type: 'history', channel: msg.channel, messages: channels[msg.channel] || [] }));
}

function handleTyping(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  if (msg.isPrivate && msg.targetUsername) {
    sendToUser(msg.targetUsername, { type: 'typing', username: user.username, channel: msg.channel, isTyping: msg.isTyping, isPrivate: true });
  } else {
    broadcast({ type: 'typing', username: user.username, channel: msg.channel, isTyping: msg.isTyping }, ws);
  }
}

function handlePrivateChatRequest(ws, msg) {
  const sender = users.get(ws);
  if (sender) sendToUser(msg.targetUsername, { type: 'privateChatRequest', from: sender.username, requestId: generateId() });
}

function handlePrivateChatResponse(ws, msg) {
  const responder = users.get(ws);
  if (!responder) return;
  const requesterWs = userSocketMap.get(msg.from);
  if (!requesterWs) return ws.send(JSON.stringify({ type: 'error', message: 'User offline' }));
  if (msg.accepted) {
    const usernames = [msg.from, responder.username].sort();
    const chatId = `private_${usernames[0]}_${usernames[1]}`;
    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    requesterWs.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: responder.username }));
    ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: msg.from }));
  } else {
    requesterWs.send(JSON.stringify({ type: 'privateChatRejected', by: responder.username }));
  }
}

function handlePrivateMessage(ws, msg) {
  const sender = users.get(ws);
  if (!sender) return;
  if (isUserTimedOut(sender.username) || isUserMuted(sender.username)) return ws.send(JSON.stringify({ type: 'error', message: 'Cannot send messages' }));
  let { chatId, text, targetUsername, replyTo } = msg;
  if (!chatId || !targetUsername || typeof text !== 'string' || !text.trim()) return;
  if (!sender.isAdmin && text.length > MESSAGE_LIMIT) return ws.send(JSON.stringify({ type: 'error', message: `Message exceeds ${MESSAGE_LIMIT} chars` }));
  const privateMsg = { id: generateId(), author: sender.username, text, chatId, timestamp: new Date().toISOString(), isVIP: sender.isVIP, isAdmin: sender.isAdmin, replyTo: replyTo || null, reactions: {} };
  if (!privateChats.has(chatId)) privateChats.set(chatId, []);
  const chatMsgs = privateChats.get(chatId);
  chatMsgs.push(privateMsg);
  if (chatMsgs.length > 200) chatMsgs.shift();
  ws.send(JSON.stringify({ type: 'privateMessage', message: privateMsg }));
  sendToUser(targetUsername, { type: 'privateMessage', message: privateMsg });
}

function handleGetPrivateHistory(ws, msg) {
  ws.send(JSON.stringify({ type: 'privateHistory', chatId: msg.chatId, messages: privateChats.get(msg.chatId) || [] }));
}

function handleAddReaction(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { messageId, emoji, channel, isPrivate, chatId } = msg;
  let msgList = isPrivate ? privateChats.get(chatId) : channels[channel];
  if (!msgList) return;
  const message = msgList.find(m => m.id === messageId);
  if (!message) return;
  if (!message.reactions) message.reactions = {};
  if (!message.reactions[emoji]) message.reactions[emoji] = [];
  if (!message.reactions[emoji].includes(user.username)) {
    message.reactions[emoji].push(user.username);
    broadcast({ type: 'reactionUpdate', messageId, reactions: message.reactions, channel, isPrivate, chatId });
  }
}

function handleRemoveReaction(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { messageId, emoji, channel, isPrivate, chatId } = msg;
  let msgList = isPrivate ? privateChats.get(chatId) : channels[channel];
  if (!msgList) return;
  const message = msgList.find(m => m.id === messageId);
  if (!message || !message.reactions || !message.reactions[emoji]) return;
  message.reactions[emoji] = message.reactions[emoji].filter(u => u !== user.username);
  if (message.reactions[emoji].length === 0) delete message.reactions[emoji];
  broadcast({ type: 'reactionUpdate', messageId, reactions: message.reactions, channel, isPrivate, chatId });
}

// Admin handlers
function handleAdminKick(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const targetWs = userSocketMap.get(msg.targetUsername);
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'kicked', message: msg.reason || 'Kicked', redirectUrl: msg.redirectUrl || 'https://google.com' }));
    setTimeout(() => targetWs.close(), 1000);
  }
  adminActions.push({ type: 'kick', by: admin.username, target: msg.targetUsername, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'kick', target: msg.targetUsername }));
}

function handleAdminTimeout(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const seconds = Math.max(1, parseInt(msg.duration, 10) || 60);
  timedOutUsers.set(msg.targetUsername, Date.now() + seconds * 1000);
  sendToUser(msg.targetUsername, { type: 'timedOut', duration: seconds, message: msg.reason || `Timed out for ${seconds}s` });
  adminActions.push({ type: 'timeout', by: admin.username, target: msg.targetUsername, duration: seconds, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'timeout', target: msg.targetUsername }));
}

function handleAdminBan(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const { targetUsername, banType } = msg;
  const targetIp = ipBanMap.get(targetUsername);
  if (banType === 'username' || banType === 'both') bannedUsers.add(targetUsername);
  if ((banType === 'ip' || banType === 'both') && targetIp) bannedIPs.add(targetIp);
  const targetWs = userSocketMap.get(targetUsername);
  if (targetWs) {
    targetWs.send(JSON.stringify({ type: 'banned', message: msg.reason || 'Banned' }));
    setTimeout(() => targetWs.close(), 1000);
  }
  adminActions.push({ type: 'ban', by: admin.username, target: targetUsername, banType, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'ban', target: targetUsername }));
}

function handleAdminUnban(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  bannedUsers.delete(msg.username);
  adminActions.push({ type: 'unban', by: admin.username, target: msg.username, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'unban', target: msg.username }));
}

function handleAdminUnbanIP(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  bannedIPs.delete(msg.ip);
  tempBannedIPs.delete(msg.ip);
  adminActions.push({ type: 'unbanIP', by: admin.username, ip: maskIp(msg.ip), timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'unbanIP', ip: msg.ip }));
}

function handleAdminTempBanIP(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const targetIp = ipBanMap.get(msg.targetUsername);
  if (targetIp) {
    const duration = (msg.duration || 60) * 60 * 1000;
    tempBannedIPs.set(targetIp, { until: Date.now() + duration, reason: msg.reason });
    const targetWs = userSocketMap.get(msg.targetUsername);
    if (targetWs) {
      targetWs.send(JSON.stringify({ type: 'banned', message: `Temp IP ban: ${msg.duration || 60} minutes` }));
      setTimeout(() => targetWs.close(), 1000);
    }
  }
  adminActions.push({ type: 'tempBanIP', by: admin.username, target: msg.targetUsername, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'tempBanIP', target: msg.targetUsername }));
}

function handleAdminGetBanList(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sweepTempIpBans();
  ws.send(JSON.stringify({
    type: 'banList',
    bannedUsers: Array.from(bannedUsers),
    bannedIPs: Array.from(bannedIPs),
    tempBannedIPs: Array.from(tempBannedIPs.entries()).map(([ip, meta]) => ({ ip, until: meta.until, reason: meta.reason }))
  }));
}

function handleAdminWarning(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const count = (userWarnings.get(msg.targetUsername) || 0) + 1;
  userWarnings.set(msg.targetUsername, count);
  sendToUser(msg.targetUsername, { type: 'warning', message: msg.reason || 'Warning from admin', count });
  adminActions.push({ type: 'warning', by: admin.username, target: msg.targetUsername, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'warning', target: msg.targetUsername, warningCount: count }));
}

function handleAdminFakeMessage(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'fakeMessage', fakeText: msg.fakeText });
  adminActions.push({ type: 'fakeMessage', by: admin.username, target: msg.targetUsername, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'fakeMessage' }));
}

function handleAdminForceMute(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const duration = (msg.duration || 30) * 1000;
  mutedUsers.set(msg.targetUsername, Date.now() + duration);
  sendToUser(msg.targetUsername, { type: 'forceMute', duration: msg.duration || 30 });
  adminActions.push({ type: 'forceMute', by: admin.username, target: msg.targetUsername, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'forceMute' }));
}

function handleAdminUnmute(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  mutedUsers.delete(msg.targetUsername);
  timedOutUsers.delete(msg.targetUsername);
  sendToUser(msg.targetUsername, { type: 'unmuted', message: 'You have been unmuted' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'unmute', target: msg.targetUsername }));
}

function handleAdminSpinScreen(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'spinScreen' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'spinScreen' }));
}

function handleAdminSlowMode(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  serverSettings.slowModeEnabled = msg.enabled;
  if (!msg.enabled) lastMessageTime.clear();
  broadcast({ type: 'broadcast', message: msg.enabled ? `🐌 Slow mode enabled (${serverSettings.slowModeDuration}s)` : '⚡ Slow mode disabled' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'slowMode' }));
}

function handleAdminInvertColors(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'invertColors' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'invertColors' }));
}

function handleAdminShakeScreen(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'shakeScreen' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'shakeScreen' }));
}

function handleAdminEmojiSpam(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'emojiSpam' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'emojiSpam' }));
}

function handleAdminRickRoll(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'rickRoll' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'rickRoll' }));
}

function handleAdminForceDisconnect(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'forceDisconnect' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'forceDisconnect' }));
}

function handleAdminFlipScreen(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'flipScreen' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'flipScreen' }));
}

function handleAdminBroadcast(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  broadcast({ type: 'broadcast', message: msg.message });
  adminActions.push({ type: 'broadcast', by: admin.username, message: msg.message, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'broadcast' }));
}

function handleAdminUpdateSettings(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  serverSettings = { ...serverSettings, ...msg.settings };
  if (msg.settings.slowModeEnabled === false) lastMessageTime.clear();
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'updateSettings', settings: serverSettings }));
}

function handleAdminClearChat(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  if (channels[msg.channel]) {
    channels[msg.channel] = [];
    broadcast({ type: 'chatCleared', channel: msg.channel });
  }
  adminActions.push({ type: 'clearChat', by: admin.username, channel: msg.channel, timestamp: new Date().toISOString() });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'clearChat', channel: msg.channel }));
}

function handleAdminDeleteMessage(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const { messageId, channel } = msg;
  if (channels[channel]) {
    channels[channel] = channels[channel].filter(m => m.id !== messageId);
    broadcast({ type: 'messageDeleted', messageId, channel });
  }
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'deleteMessage' }));
}

function handleAdminMaintenance(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  serverSettings.maintenanceMode = msg.enabled;
  if (msg.enabled) {
    broadcast({ type: 'broadcast', message: '🔧 Server entering maintenance mode...' });
  }
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'maintenance', enabled: msg.enabled }));
}

function handleAdminGlobalMute(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const duration = (msg.duration || 60) * 1000;
  users.forEach((user, userWs) => {
    if (!user.isAdmin) {
      mutedUsers.set(user.username, Date.now() + duration);
      userWs.send(JSON.stringify({ type: 'forceMute', duration: msg.duration || 60 }));
    }
  });
  broadcast({ type: 'broadcast', message: `🔇 Global mute for ${msg.duration || 60} seconds` });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'globalMute' }));
}

function handleAdminRainbow(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'rainbow' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'rainbow' }));
}

function handleAdminBlur(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'blur' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'blur' }));
}

function handleAdminMatrix(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  sendToUser(msg.targetUsername, { type: 'matrix' });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'matrix' }));
}

function handleAdminConfetti(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  if (msg.targetUsername) {
    sendToUser(msg.targetUsername, { type: 'confetti' });
  } else {
    broadcast({ type: 'confetti' });
  }
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'confetti' }));
}

function handleAdminAnnounce(ws, msg) {
  const admin = requireAdmin(ws);
  if (!admin) return;
  const announcement = { id: generateId(), author: 'SYSTEM', text: msg.text, channel: 'announcements', timestamp: new Date().toISOString(), isSystem: true };
  channels.announcements.push(announcement);
  broadcast({ type: 'announcement', message: announcement });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'announce' }));
}

// REST API
app.get('/health', (req, res) => {
  sweepTempIpBans();
  res.json({ status: 'ok', users: users.size, channels: Object.keys(channels).length, settings: serverSettings });
});

app.get('/api/channels', (req, res) => res.json({ channels: Object.keys(channels) }));

function adminAuth(req, res, next) {
  if (req.headers['x-admin-password'] === ADMIN_PASSWORD) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/admin/bans', adminAuth, (req, res) => {
  sweepTempIpBans();
  res.json({ usernames: Array.from(bannedUsers), ipBans: Array.from(bannedIPs).map(maskIp), tempIpBans: Array.from(tempBannedIPs.entries()).map(([ip, meta]) => ({ ip: maskIp(ip), until: meta.until, reason: meta.reason })), audit: adminActions.slice(-100) });
});

app.post('/admin/unban', adminAuth, (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username required' });
  bannedUsers.delete(username);
  res.json({ ok: true, username });
});

app.post('/admin/unban-ip', adminAuth, (req, res) => {
  const { ip } = req.body || {};
  if (!ip) return res.status(400).json({ error: 'ip required' });
  bannedIPs.delete(ip);
  tempBannedIPs.delete(ip);
  res.json({ ok: true, ip: maskIp(ip) });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Admin Password: ${ADMIN_PASSWORD}`);
  console.log(`VIP Password: ${VIP_PASSWORD}`);
});

setInterval(sweepTempIpBans, 30000);

