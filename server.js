const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const channels = { announcements: [], general: [], gaming: [], memes: [] };
const users = new Map();
const privateChats = new Map();
const userSocketMap = new Map();
const bannedUsers = new Set();
const timedOutUsers = new Map();
const bannedIPs = new Set();
const tempBannedIPs = new Map();
const ipBanMap = new Map();
const lastMessageTime = new Map();
const spamTracker = new Map();
const mutedUsers = new Map();
const userWarnings = new Map();
const userCoins = new Map();
const activeGames = new Map();
const gameBets = new Map();
const persistentAnnouncements = [];
const adminUsers = new Set();
const vipUsers = new Set();
const ownerUsers = new Set();
const adminActions = [];
const userStats = new Map();

const ADMIN_PASSWORD = 'classic-admin-76';
const VIP_PASSWORD = 'very-important-person';
const OWNER_PASSWORD = '6shravan';
const MESSAGE_LIMIT = 100;
const USERNAME_LIMIT = 30;
const SPAM_THRESHOLD = 5;
const SPAM_WINDOW = 10000;
const SPAM_COOLDOWN = 30000;

let serverSettings = { autoModEnabled: false, slowModeEnabled: false, slowModeDuration: 5, serverMotd: '', maintenanceMode: false };
const badWords = ['fuck','shit','bitch','ass','damn','nigga','bastard','crap','piss','dick','pussy','cock','fck','fuk','sht','btch','dmn','nigger','vagina'];

const DATA_FILE = path.join(__dirname, 'casino_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (data.coins) Object.entries(data.coins).forEach(([k, v]) => userCoins.set(k, v));
      if (data.announcements) persistentAnnouncements.push(...data.announcements);
      if (data.stats) Object.entries(data.stats).forEach(([k, v]) => userStats.set(k, v));
    }
  } catch (e) { console.error('Load error:', e); }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      coins: Object.fromEntries(userCoins),
      announcements: persistentAnnouncements,
      stats: Object.fromEntries(userStats)
    }));
  } catch (e) { console.error('Save error:', e); }
}

loadData();
setInterval(saveData, 30000);

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = (Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();
  if (!ip) ip = req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2); }
function generateUUID() { return crypto.randomUUID(); }

function broadcast(message, excludeWs = null) {
  const data = JSON.stringify(message);
  wss.clients.forEach(client => { if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(data); });
}

function sendToUser(username, message) {
  const ws = userSocketMap.get(username);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function getUserCoins(uuid) {
  if (!userCoins.has(uuid)) userCoins.set(uuid, { coins: 100, lastDaily: 0, lastBeg: 0, lastWork: 0, lastRob: 0, lastGamble: 0, peaceMode: false, wins: 0, losses: 0, totalWon: 0, totalLost: 0 });
  return userCoins.get(uuid);
}

function getUserStats(uuid) {
  if (!userStats.has(uuid)) userStats.set(uuid, { gamesPlayed: 0, gamesWon: 0, betsPlaced: 0, betsWon: 0, totalEarned: 0, totalLost: 0, biggestWin: 0, currentStreak: 0, bestStreak: 0 });
  return userStats.get(uuid);
}

function updateCoins(uuid, amount, username) {
  const data = getUserCoins(uuid);
  data.coins = Math.max(0, data.coins + amount);
  if (amount > 0) data.totalWon = (data.totalWon || 0) + amount;
  else data.totalLost = (data.totalLost || 0) + Math.abs(amount);
  saveData();
  sendToUser(username, { type: 'coinsUpdate', coins: data.coins });
}

function getLeaderboard() {
  const allUsers = Array.from(users.values());
  return Array.from(userCoins.entries())
    .map(([uuid, data]) => {
      const user = allUsers.find(u => u.uuid === uuid);
      return { username: user?.username || null, coins: data.coins, uuid, wins: data.wins || 0 };
    })
    .filter(u => u.username)
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 10);
}

function broadcastLeaderboard() {
  broadcast({ type: 'leaderboard', leaderboard: getLeaderboard() });
}

function isIpBanned(ip) {
  if (!ip || ip === 'unknown') return { banned: false };
  if (bannedIPs.has(ip)) return { banned: true, kind: 'permanent' };
  const meta = tempBannedIPs.get(ip);
  if (meta) {
    if (Date.now() < meta.until) return { banned: true, kind: 'temporary', until: meta.until };
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
    timedOutUsers.set(username, now + SPAM_COOLDOWN);
    spamTracker.delete(username);
    return { spam: true };
  }
  return { spam: false };
}

function checkSlowMode(username) {
  if (!serverSettings.slowModeEnabled || adminUsers.has(username)) return { allowed: true };
  const lastTime = lastMessageTime.get(username);
  if (!lastTime) { lastMessageTime.set(username, Date.now()); return { allowed: true }; }
  const timeSince = (Date.now() - lastTime) / 1000;
  if (timeSince < serverSettings.slowModeDuration) return { allowed: false, waitTime: Math.ceil(serverSettings.slowModeDuration - timeSince) };
  lastMessageTime.set(username, Date.now());
  return { allowed: true };
}

function containsBadWords(text) {
  const lower = text.toLowerCase();
  for (const word of badWords) { if (new RegExp(`\\b${word}\\b`, 'i').test(lower)) return { found: true, word }; }
  return { found: false };
}

function broadcastUserList() {
  const userList = Array.from(users.values()).map(u => ({ username: u.username, isVIP: u.isVIP || false, isAdmin: u.isAdmin || false, isOwner: u.isOwner || false }));
  broadcast({ type: 'userList', users: userList });
}

function requireAdmin(ws) {
  const admin = users.get(ws);
  if (!admin || !admin.isAdmin) { ws?.send(JSON.stringify({ type: 'error', message: 'Unauthorized' })); return null; }
  return admin;
}

function requireOwner(ws) {
  const owner = users.get(ws);
  if (!owner || !owner.isOwner) { ws?.send(JSON.stringify({ type: 'error', message: 'Owner only' })); return null; }
  return owner;
}

wss.on('connection', (ws, req) => {
  const ip = getClientIp(req);
  ws.ip = ip;
  const ipStatus = isIpBanned(ip);
  if (ipStatus.banned) {
    ws.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned' }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  if (serverSettings.maintenanceMode) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server maintenance' }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  ws.send(JSON.stringify({ type: 'connected' }));
  ws.on('message', data => { try { handleMessage(ws, JSON.parse(data.toString())); } catch (e) {} });
  ws.on('close', () => {
    const user = users.get(ws);
    if (user) {
      userSocketMap.delete(user.username);
      adminUsers.delete(user.username);
      vipUsers.delete(user.username);
      ownerUsers.delete(user.username);
      users.delete(ws);
      broadcastUserList();
    }
  });
});

function handleMessage(ws, msg) {
  const handlers = {
    join: handleJoin, message: handleChatMessage, getHistory: handleGetHistory, typing: handleTyping,
    privateChatRequest: handlePrivateChatRequest, privateChatResponse: handlePrivateChatResponse,
    privateMessage: handlePrivateMessage, getPrivateHistory: handleGetPrivateHistory,
    addReaction: handleAddReaction, removeReaction: handleRemoveReaction,
    getLeaderboard: (ws) => ws.send(JSON.stringify({ type: 'leaderboard', leaderboard: getLeaderboard() })),
    challengeUser: handleChallengeUser, challengeResponse: handleChallengeResponse,
    playerChoice: handlePlayerChoice, placeBet: handlePlaceBet,
    getStealableUsers: handleGetStealableUsers,
    adminKick: handleAdminKick, adminTimeout: handleAdminTimeout, adminBan: handleAdminBan,
    adminUnban: handleAdminUnban, adminUnbanIP: handleAdminUnbanIP, adminWarning: handleAdminWarning,
    adminFakeMessage: handleAdminFakeMessage, adminForceMute: handleAdminForceMute,
    adminSpinScreen: handleAdminSpinScreen, adminInvertColors: handleAdminInvertColors,
    adminShakeScreen: handleAdminShakeScreen, adminEmojiSpam: handleAdminEmojiSpam,
    adminRickRoll: handleAdminRickRoll, adminForceDisconnect: handleAdminForceDisconnect,
    adminFlipScreen: handleAdminFlipScreen, adminBroadcast: handleAdminBroadcast,
    adminUpdateSettings: handleAdminUpdateSettings, adminClearChat: handleAdminClearChat,
    adminDeleteMessage: handleAdminDeleteMessage, adminTempBanIP: handleAdminTempBanIP,
    adminGetBanList: handleAdminGetBanList, adminGlobalMute: handleAdminGlobalMute,
    adminRainbow: handleAdminRainbow, adminBlur: handleAdminBlur, adminMatrix: handleAdminMatrix,
    adminConfetti: handleAdminConfetti, adminSlowMode: handleAdminSlowMode,
    ownerGiveCoins: handleOwnerGiveCoins, ownerTakeCoins: handleOwnerTakeCoins,
    ownerSwapCoins: handleOwnerSwapCoins, ownerSetCoins: handleOwnerSetCoins,
    ownerResetUser: handleOwnerResetUser, ownerAnnouncement: handleOwnerAnnouncement,
    ownerGlobalReset: handleOwnerGlobalReset, ownerMultiplyCoins: handleOwnerMultiplyCoins
  };
  if (handlers[msg.type]) handlers[msg.type](ws, msg);
}

function handleJoin(ws, msg) {
  let { username, uuid, adminPassword, vipPassword, ownerPassword } = msg;
  if (!username) username = 'Guest' + Math.floor(Math.random() * 1000);
  username = username.slice(0, USERNAME_LIMIT).trim();
  if (!uuid) uuid = generateUUID();
  if (bannedUsers.has(username)) {
    ws.send(JSON.stringify({ type: 'banned', message: 'Banned' }));
    setTimeout(() => ws.close(), 250);
    return;
  }
  const isVerifiedOwner = ownerPassword === OWNER_PASSWORD;
  const isVerifiedAdmin = adminPassword === ADMIN_PASSWORD || isVerifiedOwner;
  const isVerifiedVIP = vipPassword === VIP_PASSWORD;
  if (isVerifiedOwner) ownerUsers.add(username);
  if (isVerifiedAdmin) adminUsers.add(username);
  if (isVerifiedVIP) vipUsers.add(username);
  users.set(ws, { username, uuid, isAdmin: isVerifiedAdmin, isVIP: isVerifiedVIP, isOwner: isVerifiedOwner, ip: ws.ip, joinedAt: Date.now() });
  userSocketMap.set(username, ws);
  ipBanMap.set(username, ws.ip);
  const coinData = getUserCoins(uuid);
  const now = Date.now();
  if (now - coinData.lastDaily > 86400000) { coinData.lastDaily = now; coinData.coins += 10; saveData(); }
  ws.send(JSON.stringify({
    type: 'joined', username, uuid, channels: Object.keys(channels),
    isAdmin: isVerifiedAdmin, isVIP: isVerifiedVIP, isOwner: isVerifiedOwner,
    coins: coinData.coins, peaceMode: coinData.peaceMode,
    limits: { message: MESSAGE_LIMIT }, persistentAnnouncements
  }));
  if (serverSettings.serverMotd) ws.send(JSON.stringify({ type: 'broadcast', message: `📢 ${serverSettings.serverMotd}` }));
  broadcastUserList();
  broadcastLeaderboard();
}

function handleChatMessage(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  if (isUserTimedOut(user.username)) return ws.send(JSON.stringify({ type: 'error', message: 'Timed out' }));
  if (isUserMuted(user.username)) return ws.send(JSON.stringify({ type: 'error', message: 'Muted' }));
  let { channel, text, replyTo } = msg;
  if (!channel || typeof text !== 'string' || !text.trim()) return;
  if (channel === 'announcements' && !user.isOwner) return ws.send(JSON.stringify({ type: 'error', message: 'Owner only' }));
  if (text.startsWith('/')) { handleCommand(ws, user, text.trim()); return; }
  if (!user.isAdmin && text.length > MESSAGE_LIMIT) return ws.send(JSON.stringify({ type: 'error', message: 'Too long' }));
  if (!user.isAdmin && checkSpam(user.username).spam) return ws.send(JSON.stringify({ type: 'timedOut', duration: 30, message: 'Spam' }));
  const slowCheck = checkSlowMode(user.username);
  if (!slowCheck.allowed) return ws.send(JSON.stringify({ type: 'error', message: `Wait ${slowCheck.waitTime}s` }));
  if (serverSettings.autoModEnabled && !user.isAdmin) {
    const badCheck = containsBadWords(text);
    if (badCheck.found) { timedOutUsers.set(user.username, Date.now() + 30000); return ws.send(JSON.stringify({ type: 'timedOut', duration: 30, message: 'Bad word' })); }
  }
  const chatMsg = { id: generateId(), author: user.username, text, channel, timestamp: new Date().toISOString(), isVIP: user.isVIP, isAdmin: user.isAdmin, isOwner: user.isOwner, replyTo: replyTo || null, reactions: {} };
  if (channels[channel]) { channels[channel].push(chatMsg); if (channels[channel].length > 200) channels[channel].shift(); }
  broadcast({ type: 'message', message: chatMsg });
}

function handleCommand(ws, user, text) {
  const parts = text.split(' ');
  const cmd = parts[0].toLowerCase();
  const coinData = getUserCoins(user.uuid);
  const stats = getUserStats(user.uuid);
  const now = Date.now();

  const commands = {
    '/help': () => {
      const helpText = `📋 Commands:
/daily - Claim 100 coins (24h cooldown)
/beg - Beg for coins (10s cooldown, 10% chance)
/work - Work for coins (30s cooldown)
/rob <user> - Rob someone (60s cooldown)
/steal <user> - Steal coins (peace mode blocks)
/coinflip <amount> <heads/tails> - Flip a coin
/dice <amount> <odd/even> - Roll dice
/slots <amount> - Play slots
/blackjack <amount> - Play blackjack
/give <user> <amount> - Give coins
/balance - Check balance
/stats - View your stats
/leaderboard - Top 10 players
/peace - Toggle peace mode
/profile <user> - View profile`;
      ws.send(JSON.stringify({ type: 'broadcast', message: helpText }));
    },
    '/daily': () => {
      if (now - coinData.lastDaily < 86400000) {
        const wait = Math.ceil((86400000 - (now - coinData.lastDaily)) / 3600000);
        return ws.send(JSON.stringify({ type: 'error', message: `Wait ${wait}h` }));
      }
      coinData.lastDaily = now;
      const streak = Math.floor((now - (coinData.dailyStreak || 0)) / 86400000) <= 1 ? (coinData.dailyStreakCount || 0) + 1 : 1;
      coinData.dailyStreak = now;
      coinData.dailyStreakCount = streak;
      const bonus = Math.min(streak * 10, 100);
      updateCoins(user.uuid, 100 + bonus, user.username);
      ws.send(JSON.stringify({ type: 'broadcast', message: `💰 Daily: +${100 + bonus} coins! (Streak: ${streak} days)` }));
    },
    '/beg': () => {
      if (now - coinData.lastBeg < 10000) return ws.send(JSON.stringify({ type: 'error', message: 'Wait 10s' }));
      coinData.lastBeg = now;
      if (Math.random() < 0.1) {
        const amount = Math.floor(Math.random() * 91) + 10;
        updateCoins(user.uuid, amount, user.username);
        ws.send(JSON.stringify({ type: 'broadcast', message: `🙏 Someone gave you ${amount} coins!` }));
      } else ws.send(JSON.stringify({ type: 'broadcast', message: '😔 No one helped...' }));
    },
    '/work': () => {
      if (now - coinData.lastWork < 30000) return ws.send(JSON.stringify({ type: 'error', message: 'Wait 30s' }));
      coinData.lastWork = now;
      const jobs = ['delivered packages', 'washed cars', 'mowed lawns', 'walked dogs', 'fixed computers', 'sold lemonade'];
      const job = jobs[Math.floor(Math.random() * jobs.length)];
      const amount = Math.floor(Math.random() * 50) + 25;
      updateCoins(user.uuid, amount, user.username);
      ws.send(JSON.stringify({ type: 'broadcast', message: `💼 You ${job} and earned ${amount} coins!` }));
    },
    '/rob': () => {
      const target = parts[1];
      if (!target) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /rob <user>' }));
      if (now - coinData.lastRob < 60000) return ws.send(JSON.stringify({ type: 'error', message: 'Wait 60s' }));
      const targetUser = Array.from(users.values()).find(u => u.username.toLowerCase() === target.toLowerCase());
      if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      if (targetUser.username === user.username) return ws.send(JSON.stringify({ type: 'error', message: "Can't rob yourself" }));
      coinData.lastRob = now;
      const targetCoins = getUserCoins(targetUser.uuid);
      if (targetCoins.peaceMode) return ws.send(JSON.stringify({ type: 'error', message: 'Target in peace mode' }));
      if (Math.random() < 0.4) {
        const amount = Math.floor(Math.min(targetCoins.coins * 0.3, 200));
        if (amount > 0) {
          updateCoins(targetUser.uuid, -amount, targetUser.username);
          updateCoins(user.uuid, amount, user.username);
          ws.send(JSON.stringify({ type: 'broadcast', message: `🔫 Robbed ${amount} from ${targetUser.username}!` }));
          sendToUser(targetUser.username, { type: 'broadcast', message: `🔫 ${user.username} robbed ${amount} from you!` });
        }
      } else {
        const fine = Math.floor(coinData.coins * 0.1);
        updateCoins(user.uuid, -fine, user.username);
        ws.send(JSON.stringify({ type: 'broadcast', message: `👮 Caught! Fined ${fine} coins` }));
      }
    },
    '/steal': () => {
      if (coinData.peaceMode) return ws.send(JSON.stringify({ type: 'error', message: 'You are in peace mode' }));
      const target = parts.slice(1).join(' ');
      if (!target) return ws.send(JSON.stringify({ type: 'showStealList' }));
      const targetUser = Array.from(users.values()).find(u => u.username.toLowerCase() === target.toLowerCase());
      if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      const targetCoins = getUserCoins(targetUser.uuid);
      if (targetCoins.peaceMode) return ws.send(JSON.stringify({ type: 'error', message: 'Peace mode' }));
      if (targetCoins.coins === 0) return ws.send(JSON.stringify({ type: 'error', message: 'No coins' }));
      if (Math.random() < 0.3) {
        const amount = Math.floor(targetCoins.coins * (Math.random() * 0.4 + 0.1));
        updateCoins(targetUser.uuid, -amount, targetUser.username);
        updateCoins(user.uuid, amount, user.username);
        ws.send(JSON.stringify({ type: 'broadcast', message: `💰 Stole ${amount} from ${targetUser.username}!` }));
        sendToUser(targetUser.username, { type: 'broadcast', message: `😱 ${user.username} stole ${amount}!` });
      } else ws.send(JSON.stringify({ type: 'broadcast', message: `❌ Failed to steal` }));
    },
    '/coinflip': () => {
      const amount = parseInt(parts[1]);
      const choice = parts[2]?.toLowerCase();
      if (!amount || amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /coinflip <amount> <heads/tails>' }));
      if (!['heads', 'tails'].includes(choice)) return ws.send(JSON.stringify({ type: 'error', message: 'Choose heads or tails' }));
      if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
      const result = Math.random() < 0.5 ? 'heads' : 'tails';
      const won = result === choice;
      updateCoins(user.uuid, won ? amount : -amount, user.username);
      stats.gamesPlayed++;
      if (won) { stats.gamesWon++; stats.currentStreak++; stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak); stats.biggestWin = Math.max(stats.biggestWin, amount); }
      else stats.currentStreak = 0;
      saveData();
      ws.send(JSON.stringify({ type: 'broadcast', message: `🪙 ${result.toUpperCase()}! ${won ? `Won ${amount}!` : `Lost ${amount}`}` }));
    },
    '/dice': () => {
      const amount = parseInt(parts[1]);
      const choice = parts[2]?.toLowerCase();
      if (!amount || amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /dice <amount> <odd/even>' }));
      if (!['odd', 'even'].includes(choice)) return ws.send(JSON.stringify({ type: 'error', message: 'Choose odd or even' }));
      if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
      const roll = Math.floor(Math.random() * 6) + 1;
      const isOdd = roll % 2 === 1;
      const won = (choice === 'odd' && isOdd) || (choice === 'even' && !isOdd);
      updateCoins(user.uuid, won ? amount : -amount, user.username);
      stats.gamesPlayed++;
      if (won) { stats.gamesWon++; stats.currentStreak++; stats.bestStreak = Math.max(stats.bestStreak, stats.currentStreak); }
      else stats.currentStreak = 0;
      saveData();
      ws.send(JSON.stringify({ type: 'broadcast', message: `🎲 Rolled ${roll} (${isOdd ? 'odd' : 'even'})! ${won ? `Won ${amount}!` : `Lost ${amount}`}` }));
    },
    '/slots': () => {
      const amount = parseInt(parts[1]);
      if (!amount || amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /slots <amount>' }));
      if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
      const symbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '7️⃣'];
      const s1 = symbols[Math.floor(Math.random() * symbols.length)];
      const s2 = symbols[Math.floor(Math.random() * symbols.length)];
      const s3 = symbols[Math.floor(Math.random() * symbols.length)];
      let mult = 0;
      if (s1 === s2 && s2 === s3) mult = s1 === '7️⃣' ? 10 : s1 === '💎' ? 7 : 5;
      else if (s1 === s2 || s2 === s3 || s1 === s3) mult = 2;
      const winnings = amount * mult - amount;
      updateCoins(user.uuid, winnings, user.username);
      ws.send(JSON.stringify({ type: 'broadcast', message: `🎰 [${s1}|${s2}|${s3}] ${mult > 0 ? `Won ${amount * mult}! (${mult}x)` : 'No match'}` }));
    },
    '/blackjack': () => {
      const amount = parseInt(parts[1]);
      if (!amount || amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /blackjack <amount>' }));
      if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
      const playerHand = Math.floor(Math.random() * 11) + 12;
      const dealerHand = Math.floor(Math.random() * 11) + 12;
      let result;
      if (playerHand > 21) result = 'bust';
      else if (dealerHand > 21 || playerHand > dealerHand) result = 'win';
      else if (playerHand < dealerHand) result = 'lose';
      else result = 'push';
      const winnings = result === 'win' ? amount : result === 'lose' || result === 'bust' ? -amount : 0;
      updateCoins(user.uuid, winnings, user.username);
      ws.send(JSON.stringify({ type: 'broadcast', message: `🃏 You: ${playerHand} | Dealer: ${dealerHand} - ${result.toUpperCase()}! ${winnings > 0 ? `+${winnings}` : winnings < 0 ? winnings : 'Push'}` }));
    },
    '/give': () => {
      const target = parts[1];
      const amount = parseInt(parts[2]);
      if (!target || !amount || amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Usage: /give <user> <amount>' }));
      if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
      const targetUser = Array.from(users.values()).find(u => u.username.toLowerCase() === target.toLowerCase());
      if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      updateCoins(user.uuid, -amount, user.username);
      updateCoins(targetUser.uuid, amount, targetUser.username);
      ws.send(JSON.stringify({ type: 'broadcast', message: `💸 Gave ${amount} to ${targetUser.username}` }));
      sendToUser(targetUser.username, { type: 'broadcast', message: `💸 ${user.username} gave you ${amount}!` });
    },
    '/balance': () => ws.send(JSON.stringify({ type: 'broadcast', message: `💰 Balance: ${coinData.coins} coins` })),
    '/stats': () => ws.send(JSON.stringify({ type: 'broadcast', message: `📊 Games: ${stats.gamesPlayed} | Wins: ${stats.gamesWon} | Streak: ${stats.currentStreak} | Best: ${stats.bestStreak} | Biggest Win: ${stats.biggestWin}` })),
    '/leaderboard': () => ws.send(JSON.stringify({ type: 'leaderboard', leaderboard: getLeaderboard() })),
    '/peace': () => {
      coinData.peaceMode = !coinData.peaceMode;
      saveData();
      ws.send(JSON.stringify({ type: 'broadcast', message: `🕊️ Peace mode: ${coinData.peaceMode ? 'ON' : 'OFF'}` }));
      ws.send(JSON.stringify({ type: 'peaceModeUpdate', peaceMode: coinData.peaceMode }));
    },
    '/profile': () => {
      const target = parts[1] || user.username;
      const targetUser = Array.from(users.values()).find(u => u.username.toLowerCase() === target.toLowerCase());
      if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
      const tCoins = getUserCoins(targetUser.uuid);
      const tStats = getUserStats(targetUser.uuid);
      ws.send(JSON.stringify({ type: 'broadcast', message: `👤 ${targetUser.username}\n💰 ${tCoins.coins} coins\n🎮 ${tStats.gamesPlayed} games (${tStats.gamesWon} wins)\n🔥 Best streak: ${tStats.bestStreak}` }));
    }
  };
  if (commands[cmd]) commands[cmd]();
  else ws.send(JSON.stringify({ type: 'error', message: 'Unknown command. Try /help' }));
}

function handleGetStealableUsers(ws) {
  const user = users.get(ws);
  if (!user) return;
  const stealable = Array.from(users.values())
    .filter(u => u.username !== user.username)
    .map(u => { const c = getUserCoins(u.uuid); return { username: u.username, coins: c.coins, peaceMode: c.peaceMode }; })
    .filter(u => !u.peaceMode && u.coins > 0);
  ws.send(JSON.stringify({ type: 'stealableUsers', users: stealable }));
}

function handleChallengeUser(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { targetUsername, game, wager, choice } = msg;
  const coinData = getUserCoins(user.uuid);
  if (coinData.coins < wager) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
  if (wager < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Minimum wager is 1' }));
  const targetWs = userSocketMap.get(targetUsername);
  if (!targetWs) return ws.send(JSON.stringify({ type: 'error', message: 'User offline' }));
  const gameId = generateId();
  activeGames.set(gameId, {
    id: gameId, game, players: [user.username, targetUsername], wager,
    status: 'pending', creator: user.username, creatorChoice: choice,
    creatorUuid: user.uuid, bettingOpen: false, readyPlayers: []
  });
  sendToUser(targetUsername, { type: 'gameChallenge', from: user.username, game, wager, gameId, opponentChoice: choice });
  ws.send(JSON.stringify({ type: 'broadcast', message: `⏳ Challenge sent to ${targetUsername}` }));
}

function handleChallengeResponse(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { gameId, accepted, choice } = msg;
  const game = activeGames.get(gameId);
  if (!game) return ws.send(JSON.stringify({ type: 'error', message: 'Game expired' }));
  if (!accepted) {
    activeGames.delete(gameId);
    sendToUser(game.creator, { type: 'broadcast', message: `❌ ${user.username} declined` });
    return;
  }
  const targetCoins = getUserCoins(user.uuid);
  if (targetCoins.coins < game.wager) {
    activeGames.delete(gameId);
    sendToUser(game.creator, { type: 'error', message: 'Opponent has insufficient coins' });
    return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
  }
  game.acceptorChoice = choice;
  game.acceptorUuid = user.uuid;
  game.status = 'betting';
  game.bettingOpen = true;
  gameBets.set(gameId, []);
  broadcast({
    type: 'gameBettingOpen', gameId, game: game.game, wager: game.wager,
    player1: game.creator, player2: user.username, bettingEndsIn: 15
  });
  setTimeout(() => {
    const g = activeGames.get(gameId);
    if (g && g.status === 'betting') {
      g.status = 'ready';
      g.bettingOpen = false;
      broadcast({ type: 'gameBettingClosed', gameId });
      game.players.forEach(p => sendToUser(p, { type: 'gameReady', gameId, game: g.game, wager: g.wager, opponent: g.players.find(x => x !== p) }));
    }
  }, 15000);
}

function handlePlayerChoice(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { gameId } = msg;
  const game = activeGames.get(gameId);
  if (!game || game.status !== 'ready') return;
  if (!game.readyPlayers) game.readyPlayers = [];
  if (!game.readyPlayers.includes(user.username)) game.readyPlayers.push(user.username);
  if (game.readyPlayers.length === 2) executeGame(game);
}

function executeGame(game) {
  const [p1, p2] = game.players;
  const p1User = Array.from(users.values()).find(u => u.username === p1);
  const p2User = Array.from(users.values()).find(u => u.username === p2);
  if (!p1User || !p2User) { activeGames.delete(game.id); return; }
  let winner, loser, resultMsg;
  if (game.game === 'coinflip') {
    const result = Math.random() < 0.5 ? 'heads' : 'tails';
    winner = game.creatorChoice === result ? p1 : p2;
    loser = winner === p1 ? p2 : p1;
    resultMsg = `🪙 Coin landed on ${result.toUpperCase()}!`;
  } else if (game.game === 'dice') {
    const roll = Math.floor(Math.random() * 6) + 1;
    const isOdd = roll % 2 === 1;
    const creatorWins = (game.creatorChoice === 'odd' && isOdd) || (game.creatorChoice === 'even' && !isOdd);
    winner = creatorWins ? p1 : p2;
    loser = winner === p1 ? p2 : p1;
    resultMsg = `🎲 Dice rolled ${roll} (${isOdd ? 'odd' : 'even'})!`;
  }
  const winnerUser = winner === p1 ? p1User : p2User;
  const loserUser = winner === p1 ? p2User : p1User;
  updateCoins(winnerUser.uuid, game.wager, winnerUser.username);
  updateCoins(loserUser.uuid, -game.wager, loserUser.username);
  const bets = gameBets.get(game.id) || [];
  bets.forEach(bet => {
    const betUser = Array.from(users.values()).find(u => u.username === bet.username);
    if (!betUser) return;
    if (bet.betOn === winner) {
      updateCoins(betUser.uuid, bet.amount, betUser.username);
      sendToUser(bet.username, { type: 'broadcast', message: `🎉 Won ${bet.amount * 2} on bet! (${bet.amount} profit)` });
    } else {
      sendToUser(bet.username, { type: 'broadcast', message: `😢 Lost ${bet.amount} on bet` });
    }
  });
  broadcast({ type: 'gameResult', gameId: game.id, winner, loser, game: game.game, wager: game.wager, resultMsg });
  game.players.forEach(p => sendToUser(p, { type: 'gameEnd', winner, loser, wager: game.wager, isWinner: p === winner }));
  activeGames.delete(game.id);
  gameBets.delete(game.id);
  broadcastLeaderboard();
}

function handlePlaceBet(ws, msg) {
  const user = users.get(ws);
  if (!user) return;
  const { gameId, betOn, amount } = msg;
  const game = activeGames.get(gameId);
  if (!game || !game.bettingOpen) return ws.send(JSON.stringify({ type: 'error', message: 'Betting closed' }));
  if (game.players.includes(user.username)) return ws.send(JSON.stringify({ type: 'error', message: "Can't bet on own game" }));
  const coinData = getUserCoins(user.uuid);
  if (coinData.coins < amount) return ws.send(JSON.stringify({ type: 'error', message: 'Insufficient coins' }));
  if (amount < 1) return ws.send(JSON.stringify({ type: 'error', message: 'Minimum bet is 1' }));
  updateCoins(user.uuid, -amount, user.username);
  const bets = gameBets.get(gameId) || [];
  bets.push({ username: user.username, uuid: user.uuid, amount, betOn });
  gameBets.set(gameId, bets);
  ws.send(JSON.stringify({ type: 'broadcast', message: `🎲 Bet ${amount} on ${betOn}` }));
}

// Owner commands
function handleOwnerGiveCoins(ws, msg) {
  if (!requireOwner(ws)) return;
  const { targetUsername, amount } = msg;
  const targetUser = Array.from(users.values()).find(u => u.username === targetUsername);
  if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
  updateCoins(targetUser.uuid, amount, targetUser.username);
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Gave ${amount} to ${targetUsername}` }));
  sendToUser(targetUsername, { type: 'broadcast', message: `👑 Owner gave you ${amount} coins!` });
  broadcastLeaderboard();
}

function handleOwnerTakeCoins(ws, msg) {
  if (!requireOwner(ws)) return;
  const { targetUsername, amount } = msg;
  const targetUser = Array.from(users.values()).find(u => u.username === targetUsername);
  if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
  updateCoins(targetUser.uuid, -amount, targetUser.username);
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Took ${amount} from ${targetUsername}` }));
  sendToUser(targetUsername, { type: 'broadcast', message: `👑 Owner took ${amount} coins from you!` });
  broadcastLeaderboard();
}

function handleOwnerSwapCoins(ws, msg) {
  if (!requireOwner(ws)) return;
  const { user1, user2 } = msg;
  const u1 = Array.from(users.values()).find(u => u.username === user1);
  const u2 = Array.from(users.values()).find(u => u.username === user2);
  if (!u1 || !u2) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
  const c1 = getUserCoins(u1.uuid);
  const c2 = getUserCoins(u2.uuid);
  const temp = c1.coins;
  c1.coins = c2.coins;
  c2.coins = temp;
  saveData();
  sendToUser(user1, { type: 'coinsUpdate', coins: c1.coins });
  sendToUser(user2, { type: 'coinsUpdate', coins: c2.coins });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Swapped coins between ${user1} and ${user2}` }));
  sendToUser(user1, { type: 'broadcast', message: `👑 Your coins were swapped with ${user2}!` });
  sendToUser(user2, { type: 'broadcast', message: `👑 Your coins were swapped with ${user1}!` });
  broadcastLeaderboard();
}

function handleOwnerSetCoins(ws, msg) {
  if (!requireOwner(ws)) return;
  const { targetUsername, amount } = msg;
  const targetUser = Array.from(users.values()).find(u => u.username === targetUsername);
  if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
  const coinData = getUserCoins(targetUser.uuid);
  coinData.coins = Math.max(0, amount);
  saveData();
  sendToUser(targetUsername, { type: 'coinsUpdate', coins: coinData.coins });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Set ${targetUsername}'s coins to ${amount}` }));
  broadcastLeaderboard();
}

function handleOwnerResetUser(ws, msg) {
  if (!requireOwner(ws)) return;
  const { targetUsername } = msg;
  const targetUser = Array.from(users.values()).find(u => u.username === targetUsername);
  if (!targetUser) return ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
  userCoins.set(targetUser.uuid, { coins: 100, lastDaily: 0, lastBeg: 0, lastWork: 0, lastRob: 0, peaceMode: false, wins: 0, losses: 0 });
  userStats.set(targetUser.uuid, { gamesPlayed: 0, gamesWon: 0, betsPlaced: 0, betsWon: 0, totalEarned: 0, totalLost: 0, biggestWin: 0, currentStreak: 0, bestStreak: 0 });
  saveData();
  sendToUser(targetUsername, { type: 'coinsUpdate', coins: 100 });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Reset ${targetUsername}'s data` }));
  sendToUser(targetUsername, { type: 'broadcast', message: '👑 Your account was reset by owner!' });
  broadcastLeaderboard();
}

function handleOwnerGlobalReset(ws) {
  if (!requireOwner(ws)) return;
  userCoins.clear();
  userStats.clear();
  saveData();
  broadcast({ type: 'broadcast', message: '👑 GLOBAL RESET! All coins and stats wiped!' });
  users.forEach((u, uws) => {
    const newData = getUserCoins(u.uuid);
    uws.send(JSON.stringify({ type: 'coinsUpdate', coins: newData.coins }));
  });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'Global reset complete' }));
  broadcastLeaderboard();
}

function handleOwnerMultiplyCoins(ws, msg) {
  if (!requireOwner(ws)) return;
  const { multiplier } = msg;
  if (!multiplier || multiplier <= 0) return ws.send(JSON.stringify({ type: 'error', message: 'Invalid multiplier' }));
  userCoins.forEach(data => { data.coins = Math.floor(data.coins * multiplier); });
  saveData();
  users.forEach((u, uws) => {
    const data = getUserCoins(u.uuid);
    uws.send(JSON.stringify({ type: 'coinsUpdate', coins: data.coins }));
  });
  broadcast({ type: 'broadcast', message: `👑 All coins multiplied by ${multiplier}x!` });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Multiplied all coins by ${multiplier}` }));
  broadcastLeaderboard();
}

function handleOwnerAnnouncement(ws, msg) {
  if (!requireOwner(ws)) return;
  const announcement = { id: generateId(), text: msg.text, timestamp: new Date().toISOString(), author: 'SYSTEM' };
  persistentAnnouncements.push(announcement);
  if (persistentAnnouncements.length > 50) persistentAnnouncements.shift();
  saveData();
  const chatMsg = { ...announcement, channel: 'announcements', isSystem: true };
  channels.announcements.push(chatMsg);
  broadcast({ type: 'announcement', message: chatMsg });
  ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'Announcement posted' }));
}

// Standard handlers
function handleGetHistory(ws, msg) { ws.send(JSON.stringify({ type: 'history', channel: msg.channel, messages: channels[msg.channel] || [] })); }
function handleTyping(ws, msg) { const user = users.get(ws); if (!user) return; if (msg.isPrivate) sendToUser(msg.targetUsername, { type: 'typing', username: user.username, isTyping: msg.isTyping, isPrivate: true }); else broadcast({ type: 'typing', username: user.username, channel: msg.channel, isTyping: msg.isTyping }, ws); }
function handlePrivateChatRequest(ws, msg) { const sender = users.get(ws); if (sender) sendToUser(msg.targetUsername, { type: 'privateChatRequest', from: sender.username }); }
function handlePrivateChatResponse(ws, msg) { const responder = users.get(ws); if (!responder) return; const reqWs = userSocketMap.get(msg.from); if (!reqWs) return; if (msg.accepted) { const chatId = `dm_${[msg.from, responder.username].sort().join('_')}`; if (!privateChats.has(chatId)) privateChats.set(chatId, []); reqWs.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: responder.username })); ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: msg.from })); } else reqWs.send(JSON.stringify({ type: 'privateChatRejected', by: responder.username })); }
function handlePrivateMessage(ws, msg) { const sender = users.get(ws); if (!sender) return; const { chatId, text, targetUsername, replyTo } = msg; if (!chatId || !text?.trim()) return; const pm = { id: generateId(), author: sender.username, text, chatId, timestamp: new Date().toISOString(), isVIP: sender.isVIP, isAdmin: sender.isAdmin, replyTo, reactions: {} }; if (!privateChats.has(chatId)) privateChats.set(chatId, []); privateChats.get(chatId).push(pm); ws.send(JSON.stringify({ type: 'privateMessage', message: pm })); sendToUser(targetUsername, { type: 'privateMessage', message: pm }); }
function handleGetPrivateHistory(ws, msg) { ws.send(JSON.stringify({ type: 'privateHistory', chatId: msg.chatId, messages: privateChats.get(msg.chatId) || [] })); }
function handleAddReaction(ws, msg) { const user = users.get(ws); if (!user) return; const { messageId, emoji, channel, isPrivate, chatId } = msg; const msgList = isPrivate ? privateChats.get(chatId) : channels[channel]; const message = msgList?.find(m => m.id === messageId); if (!message) return; if (!message.reactions) message.reactions = {}; if (!message.reactions[emoji]) message.reactions[emoji] = []; if (!message.reactions[emoji].includes(user.username)) { message.reactions[emoji].push(user.username); broadcast({ type: 'reactionUpdate', messageId, reactions: message.reactions, channel, isPrivate, chatId }); } }
function handleRemoveReaction(ws, msg) { const user = users.get(ws); if (!user) return; const { messageId, emoji, channel, isPrivate, chatId } = msg; const msgList = isPrivate ? privateChats.get(chatId) : channels[channel]; const message = msgList?.find(m => m.id === messageId); if (!message?.reactions?.[emoji]) return; message.reactions[emoji] = message.reactions[emoji].filter(u => u !== user.username); if (!message.reactions[emoji].length) delete message.reactions[emoji]; broadcast({ type: 'reactionUpdate', messageId, reactions: message.reactions, channel, isPrivate, chatId }); }

// Admin handlers
function handleAdminKick(ws, msg) { const admin = requireAdmin(ws); if (!admin) return; const targetWs = userSocketMap.get(msg.targetUsername); if (targetWs) { targetWs.send(JSON.stringify({ type: 'kicked', message: msg.reason || 'Kicked', redirectUrl: msg.redirectUrl || 'https://google.com' })); setTimeout(() => targetWs.close(), 1000); } ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Kicked ${msg.targetUsername}` })); }
function handleAdminTimeout(ws, msg) { const admin = requireAdmin(ws); if (!admin) return; timedOutUsers.set(msg.targetUsername, Date.now() + (msg.duration || 60) * 1000); sendToUser(msg.targetUsername, { type: 'timedOut', duration: msg.duration || 60, message: msg.reason || 'Timed out' }); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Timed out ${msg.targetUsername}` })); }
function handleAdminBan(ws, msg) { const admin = requireAdmin(ws); if (!admin) return; const { targetUsername, banType } = msg; if (banType === 'username' || banType === 'both') bannedUsers.add(targetUsername); if ((banType === 'ip' || banType === 'both') && ipBanMap.get(targetUsername)) bannedIPs.add(ipBanMap.get(targetUsername)); const targetWs = userSocketMap.get(targetUsername); if (targetWs) { targetWs.send(JSON.stringify({ type: 'banned', message: 'Banned' })); setTimeout(() => targetWs.close(), 1000); } ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Banned ${targetUsername}` })); }
function handleAdminUnban(ws, msg) { if (!requireAdmin(ws)) return; bannedUsers.delete(msg.username); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Unbanned ${msg.username}` })); }
function handleAdminUnbanIP(ws, msg) { if (!requireAdmin(ws)) return; bannedIPs.delete(msg.ip); tempBannedIPs.delete(msg.ip); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'IP unbanned' })); }
function handleAdminTempBanIP(ws, msg) { if (!requireAdmin(ws)) return; const ip = ipBanMap.get(msg.targetUsername); if (ip) { tempBannedIPs.set(ip, { until: Date.now() + (msg.duration || 60) * 60000, reason: msg.reason }); const targetWs = userSocketMap.get(msg.targetUsername); if (targetWs) { targetWs.send(JSON.stringify({ type: 'banned', message: 'Temp IP banned' })); setTimeout(() => targetWs.close(), 1000); } } ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Temp banned ${msg.targetUsername}` })); }
function handleAdminGetBanList(ws) { if (!requireAdmin(ws)) return; ws.send(JSON.stringify({ type: 'banList', bannedUsers: Array.from(bannedUsers), bannedIPs: Array.from(bannedIPs), tempBannedIPs: Array.from(tempBannedIPs.entries()).map(([ip, m]) => ({ ip, until: m.until })) })); }
function handleAdminWarning(ws, msg) { if (!requireAdmin(ws)) return; const count = (userWarnings.get(msg.targetUsername) || 0) + 1; userWarnings.set(msg.targetUsername, count); sendToUser(msg.targetUsername, { type: 'warning', message: msg.reason || 'Warning', count }); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Warned ${msg.targetUsername} (${count})` })); }
function handleAdminFakeMessage(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'fakeMessage', fakeText: msg.fakeText }); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'Fake message sent' })); }
function handleAdminForceMute(ws, msg) { if (!requireAdmin(ws)) return; mutedUsers.set(msg.targetUsername, Date.now() + (msg.duration || 30) * 1000); sendToUser(msg.targetUsername, { type: 'forceMute', duration: msg.duration || 30 }); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Muted ${msg.targetUsername}` })); }
function handleAdminGlobalMute(ws, msg) { if (!requireAdmin(ws)) return; const dur = (msg.duration || 60) * 1000; users.forEach((u, uws) => { if (!u.isAdmin) { mutedUsers.set(u.username, Date.now() + dur); uws.send(JSON.stringify({ type: 'forceMute', duration: msg.duration || 60 })); } }); broadcast({ type: 'broadcast', message: `🔇 Global mute for ${msg.duration || 60}s` }); ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'Global mute' })); }
function handleAdminSpinScreen(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'spinScreen' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminInvertColors(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'invertColors' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminShakeScreen(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'shakeScreen' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminEmojiSpam(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'emojiSpam' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminRickRoll(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'rickRoll' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminForceDisconnect(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'forceDisconnect' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminFlipScreen(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'flipScreen' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminRainbow(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'rainbow' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminBlur(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'blur' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminMatrix(ws, msg) { if (!requireAdmin(ws)) return; sendToUser(msg.targetUsername, { type: 'matrix' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminConfetti(ws, msg) { if (!requireAdmin(ws)) return; if (msg.targetUsername) sendToUser(msg.targetUsername, { type: 'confetti' }); else broadcast({ type: 'confetti' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminBroadcast(ws, msg) { if (!requireAdmin(ws)) return; broadcast({ type: 'broadcast', message: msg.message }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminUpdateSettings(ws, msg) { if (!requireAdmin(ws)) return; serverSettings = { ...serverSettings, ...msg.settings }; ws.send(JSON.stringify({ type: 'adminActionSuccess', message: 'Settings updated' })); }
function handleAdminClearChat(ws, msg) { if (!requireAdmin(ws)) return; if (channels[msg.channel]) { channels[msg.channel] = []; broadcast({ type: 'chatCleared', channel: msg.channel }); } ws.send(JSON.stringify({ type: 'adminActionSuccess', message: `Cleared #${msg.channel}` })); }
function handleAdminDeleteMessage(ws, msg) { if (!requireAdmin(ws)) return; if (channels[msg.channel]) { channels[msg.channel] = channels[msg.channel].filter(m => m.id !== msg.messageId); broadcast({ type: 'messageDeleted', messageId: msg.messageId, channel: msg.channel }); } ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }
function handleAdminSlowMode(ws, msg) { if (!requireAdmin(ws)) return; serverSettings.slowModeEnabled = msg.enabled; if (!msg.enabled) lastMessageTime.clear(); broadcast({ type: 'broadcast', message: msg.enabled ? `🐌 Slow mode ON (${serverSettings.slowModeDuration}s)` : '⚡ Slow mode OFF' }); ws.send(JSON.stringify({ type: 'adminActionSuccess' })); }

app.get('/health', (req, res) => res.json({ status: 'ok', users: users.size }));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on port ${PORT}`));
process.on('SIGINT', () => { saveData(); process.exit(); });
