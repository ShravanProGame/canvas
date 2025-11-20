// server.js
// Enhanced Real-time chat server with comprehensive admin controls

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Ephemeral in-memory storage
const channels = {
    general: [],
    random: [],
    gaming: [],
    memes: []
};

const users = new Map();
const privateChats = new Map();
const userSocketMap = new Map();
const bannedUsers = new Set();
const timedOutUsers = new Map();
const bannedIPs = new Set();
const tempBannedIPs = new Map();
const ipBanMap = new Map(); // username -> ip for ban tracking
const lastMessageTime = new Map(); // username -> timestamp for slow mode

const ADMIN_PASSWORD = 'classicclassic';
const VIP_PASSWORD = 'very-important-person';
const adminUsers = new Set();
const vipUsers = new Set();

const adminActions = [];
let serverSettings = {
    autoModEnabled: false,
    slowModeEnabled: false,
    slowModeDuration: 5, // seconds between messages
    serverMotd: ''
};

// Bad words list for auto-moderation
const badWords = [
    'fuck', 'shit', 'bitch', 'ass', 'damn', 'nigga', 
    'bastard', 'crap', 'piss', 'dick', 'pussy', 'cock',
    'fck', 'fuk', 'sht', 'btch', 'dmn', 'nigger', 'vagina', 
];

// Utility functions
function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    let ip = (Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();
    if (!ip) {
        ip = req.socket?.remoteAddress || '';
    }
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip || 'unknown';
}

function maskIp(ip) {
    if (!ip || ip === 'unknown') return 'unknown';
    const parts = ip.split('.');
    if (parts.length === 4) {
        return `${parts[0]}.***.${parts[2]}.${parts[3]}`;
    }
    const v6 = ip.split(':');
    if (v6.length > 1) {
        return `${v6[0]}:*:${v6[v6.length - 1]}`;
    }
    return ip;
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function sendToUser(username, message) {
    const ws = userSocketMap.get(username);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

function sweepTempIpBans() {
    const now = Date.now();
    for (const [ip, meta] of tempBannedIPs.entries()) {
        if (now >= meta.until) {
            tempBannedIPs.delete(ip);
        }
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
    const timeoutEnd = timedOutUsers.get(username);
    if (Date.now() > timeoutEnd) {
        timedOutUsers.delete(username);
        return false;
    }
    return true;
}

function checkSlowMode(username) {
    if (!serverSettings.slowModeEnabled) return { allowed: true };
    
    // Admins bypass slow mode
    if (adminUsers.has(username)) return { allowed: true };
    
    const lastTime = lastMessageTime.get(username);
    if (!lastTime) {
        lastMessageTime.set(username, Date.now());
        return { allowed: true };
    }
    
    const timeSince = (Date.now() - lastTime) / 1000;
    if (timeSince < serverSettings.slowModeDuration) {
        const waitTime = Math.ceil(serverSettings.slowModeDuration - timeSince);
        return { allowed: false, waitTime };
    }
    
    lastMessageTime.set(username, Date.now());
    return { allowed: true };
}

function containsBadWords(text) {
    const lowerText = text.toLowerCase();
    for (const word of badWords) {
        // Check for the word with word boundaries
        const regex = new RegExp(`\\b${word}\\b`, 'i');
        if (regex.test(lowerText)) {
            return { found: true, word };
        }
    }
    return { found: false };
}

function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        isVIP: u.isVIP || false,
        isAdmin: u.isAdmin || false
    }));
    broadcast({ type: 'userList', users: userList });
}

function requireAdmin(ws) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized: You are not an admin' }));
        }
        return null;
    }
    return admin;
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
    const ip = getClientIp(req);
    ws.ip = ip;

    const ipStatus = isIpBanned(ip);
    if (ipStatus.banned) {
        const msgBase = ipStatus.kind === 'permanent'
            ? 'Your IP is banned from this server'
            : `Your IP is temporarily banned until ${new Date(ipStatus.until).toLocaleString()}`;
        ws.send(JSON.stringify({ type: 'banned', message: msgBase }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    console.log(`New client connected from ${maskIp(ip)}`);
    ws.send(JSON.stringify({ type: 'connected', message: 'Connected to server' }));

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            userSocketMap.delete(user.username);
            adminUsers.delete(user.username);
            vipUsers.delete(user.username);
            lastMessageTime.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Message router
function handleMessage(ws, message) {
    switch (message.type) {
        case 'join':
            handleJoin(ws, message);
            break;
        case 'message':
            handleChatMessage(ws, message);
            break;
        case 'getHistory':
            handleGetHistory(ws, message);
            break;
        case 'typing':
            handleTyping(ws, message);
            break;
        case 'privateChatRequest':
            handlePrivateChatRequest(ws, message);
            break;
        case 'privateChatResponse':
            handlePrivateChatResponse(ws, message);
            break;
        case 'privateMessage':
            handlePrivateMessage(ws, message);
            break;
        case 'getPrivateHistory':
            handleGetPrivateHistory(ws, message);
            break;
        case 'adminKick':
            handleAdminKick(ws, message);
            break;
        case 'adminTimeout':
            handleAdminTimeout(ws, message);
            break;
        case 'adminBan':
            handleAdminBan(ws, message);
            break;
        case 'adminWarning':
            handleAdminWarning(ws, message);
            break;
        case 'adminFakeMessage':
            handleAdminFakeMessage(ws, message);
            break;
        case 'adminForceMute':
            handleAdminForceMute(ws, message);
            break;
        case 'adminSpinScreen':
            handleAdminSpinScreen(ws, message);
            break;
        case 'adminSlowMode':
            handleAdminSlowMode(ws, message);
            break;
        case 'adminInvertColors':
            handleAdminInvertColors(ws, message);
            break;
        case 'adminShakeScreen':
            handleAdminShakeScreen(ws, message);
            break;
        case 'adminEmojiSpam':
            handleAdminEmojiSpam(ws, message);
            break;
        case 'adminRickRoll':
            handleAdminRickRoll(ws, message);
            break;
        case 'adminForceDisconnect':
            handleAdminForceDisconnect(ws, message);
            break;
        case 'adminFlipScreen':
            handleAdminFlipScreen(ws, message);
            break;
        case 'adminBroadcast':
            handleAdminBroadcast(ws, message);
            break;
        case 'adminUpdateSettings':
            handleAdminUpdateSettings(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// Core handlers
function handleJoin(ws, message) {
    const { username, isAdmin, isVIP, adminPassword, vipPassword } = message;

    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({ type: 'banned', message: 'You have been banned from this server' }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    const ipStatus = isIpBanned(ws.ip);
    if (ipStatus.banned) {
        ws.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned from this server' }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    const isVerifiedAdmin = isAdmin && adminPassword === ADMIN_PASSWORD;
    const isVerifiedVIP = isVIP && vipPassword === VIP_PASSWORD;

    if (isVerifiedAdmin) {
        adminUsers.add(username);
        console.log(`[ADMIN] ${username} joined as admin`);
    }
    if (isVerifiedVIP) {
        vipUsers.add(username);
        console.log(`[VIP] ${username} joined as VIP`);
    }

    users.set(ws, {
        username,
        id: generateId(),
        isAdmin: isVerifiedAdmin,
        isVIP: isVerifiedVIP,
        ip: ws.ip
    });
    userSocketMap.set(username, ws);
    ipBanMap.set(username, ws.ip);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels),
        isAdmin: isVerifiedAdmin,
        isVIP: isVerifiedVIP
    }));

    // Send MOTD if set
    if (serverSettings.serverMotd) {
        ws.send(JSON.stringify({
            type: 'broadcast',
            message: `📢 Server MOTD: ${serverSettings.serverMotd}`
        }));
    }

    broadcastUserList();
    console.log(`User ${username} joined from ${maskIp(ws.ip)}. Total users: ${users.size}`);
}

function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    if (isUserTimedOut(user.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are currently timed out' }));
        return;
    }

    const { channel, text } = message;
    if (!channel || typeof text !== 'string' || !text.trim()) return;

    // Check slow mode
    const slowModeCheck = checkSlowMode(user.username);
    if (!slowModeCheck.allowed) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Slow mode active. Please wait ${slowModeCheck.waitTime} more second(s)` 
        }));
        return;
    }

    // Check auto-moderation for bad words
    if (serverSettings.autoModEnabled && !user.isAdmin) {
        const badWordCheck = containsBadWords(text);
        if (badWordCheck.found) {
            // Auto-timeout for 30 seconds
            const timeoutEnd = Date.now() + 30000;
            timedOutUsers.set(user.username, timeoutEnd);
            
            ws.send(JSON.stringify({
                type: 'timedOut',
                duration: 30,
                message: `Auto-moderation: Timed out for 30 seconds (Bad word detected: "${badWordCheck.word}")`
            }));

            console.log(`[AUTO-MOD] ${user.username} timed out for bad word: ${badWordCheck.word}`);
            adminActions.push({
                type: 'autoMod',
                target: user.username,
                word: badWordCheck.word,
                timestamp: new Date().toISOString()
            });

            setTimeout(() => {
                timedOutUsers.delete(user.username);
                sendToUser(user.username, {
                    type: 'timeoutEnded',
                    message: 'Your auto-moderation timeout has ended'
                });
            }, 30000);

            return;
        }
    }

    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString(),
        isVIP: user.isVIP,
        isAdmin: user.isAdmin
    };

    if (channels[channel]) {
        channels[channel].push(chatMessage);
        if (channels[channel].length > 100) channels[channel].shift();
    }

    broadcast({ type: 'message', message: chatMessage });
}

function handleGetHistory(ws, message) {
    const { channel } = message;
    ws.send(JSON.stringify({ 
        type: 'history', 
        channel, 
        messages: channels[channel] || [] 
    }));
}

function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, isTyping, isPrivate, targetUsername } = message;

    if (isPrivate && targetUsername) {
        sendToUser(targetUsername, {
            type: 'typing',
            username: user.username,
            channel,
            isTyping,
            isPrivate: true
        });
    } else {
        broadcast({
            type: 'typing',
            username: user.username,
            channel,
            isTyping
        }, ws);
    }
}

function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, {
        type: 'privateChatRequest',
        from: sender.username,
        requestId: generateId()
    });
}

function handlePrivateChatResponse(ws, message) {
    const responder = users.get(ws);
    if (!responder) return;

    const { accepted, from } = message;
    const requesterWs = userSocketMap.get(from);
    
    if (!requesterWs) {
        ws.send(JSON.stringify({ type: 'error', message: 'User no longer online' }));
        return;
    }

    if (accepted) {
        const usernames = [from, responder.username].sort();
        const chatId = `private_${usernames[0]}_${usernames[1]}`;
        if (!privateChats.has(chatId)) privateChats.set(chatId, []);

        requesterWs.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: responder.username }));
        ws.send(JSON.stringify({ type: 'privateChatAccepted', chatId, with: from }));
    } else {
        requesterWs.send(JSON.stringify({ type: 'privateChatRejected', by: responder.username }));
    }
}

function handlePrivateMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    if (isUserTimedOut(sender.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are currently timed out' }));
        return;
    }

    const { chatId, text, targetUsername } = message;
    if (!chatId || !targetUsername || typeof text !== 'string' || !text.trim()) return;

    // Check slow mode for private messages too
    const slowModeCheck = checkSlowMode(sender.username);
    if (!slowModeCheck.allowed) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Slow mode active. Please wait ${slowModeCheck.waitTime} more second(s)` 
        }));
        return;
    }

    // Check auto-moderation for private messages
    if (serverSettings.autoModEnabled && !sender.isAdmin) {
        const badWordCheck = containsBadWords(text);
        if (badWordCheck.found) {
            const timeoutEnd = Date.now() + 30000;
            timedOutUsers.set(sender.username, timeoutEnd);
            
            ws.send(JSON.stringify({
                type: 'timedOut',
                duration: 30,
                message: `Auto-moderation: Timed out for 30 seconds (Bad word detected: "${badWordCheck.word}")`
            }));

            setTimeout(() => {
                timedOutUsers.delete(sender.username);
                sendToUser(sender.username, {
                    type: 'timeoutEnded',
                    message: 'Your auto-moderation timeout has ended'
                });
            }, 30000);

            return;
        }
    }

    const privateMessage = {
        id: generateId(),
        author: sender.username,
        text,
        chatId,
        timestamp: new Date().toISOString(),
        isVIP: sender.isVIP,
        isAdmin: sender.isAdmin
    };

    if (!privateChats.has(chatId)) privateChats.set(chatId, []);
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);
    if (chatMessages.length > 100) chatMessages.shift();

    const payload = { type: 'privateMessage', message: privateMessage };
    ws.send(JSON.stringify(payload));
    sendToUser(targetUsername, payload);
}

function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    ws.send(JSON.stringify({ 
        type: 'privateHistory', 
        chatId, 
        messages: privateChats.get(chatId) || [] 
    }));
}

// Admin moderation handlers
function handleAdminKick(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, redirectUrl, reason } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (targetWs) {
        console.log(`[ADMIN] ${admin.username} kicked ${targetUsername}`);
        adminActions.push({
            type: 'kick',
            by: admin.username,
            target: targetUsername,
            reason,
            timestamp: new Date().toISOString()
        });

        targetWs.send(JSON.stringify({
            type: 'kicked',
            message: reason ? `Kicked: ${reason}` : 'You have been kicked from the server',
            redirectUrl: redirectUrl || 'https://google.com'
        }));
        setTimeout(() => targetWs.close(), 1000);
    }

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'kick', target: targetUsername }));
}

function handleAdminTimeout(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, duration, reason } = message;
    const seconds = Math.max(1, parseInt(duration, 10) || 60);
    const timeoutEnd = Date.now() + (seconds * 1000);

    timedOutUsers.set(targetUsername, timeoutEnd);
    console.log(`[ADMIN] ${admin.username} timed out ${targetUsername} for ${seconds} seconds`);
    
    adminActions.push({
        type: 'timeout',
        by: admin.username,
        target: targetUsername,
        duration: seconds,
        reason,
        timestamp: new Date().toISOString()
    });

    sendToUser(targetUsername, {
        type: 'timedOut',
        duration: seconds,
        message: reason ? `Timed out for ${seconds}s: ${reason}` : `You have been timed out for ${seconds} seconds`
    });

    setTimeout(() => {
        timedOutUsers.delete(targetUsername);
        sendToUser(targetUsername, {
            type: 'timeoutEnded',
            message: 'Your timeout has ended'
        });
        console.log(`[ADMIN] Timeout ended for ${targetUsername}`);
    }, seconds * 1000);

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'timeout',
        target: targetUsername,
        duration: seconds
    }));
}

function handleAdminBan(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, banType, reason } = message;
    const targetWs = userSocketMap.get(targetUsername);
    const targetIp = ipBanMap.get(targetUsername);

    // Ban username
    if (banType === 'username' || banType === 'both') {
        bannedUsers.add(targetUsername);
    }

    // Ban IP
    if ((banType === 'ip' || banType === 'both') && targetIp) {
        bannedIPs.add(targetIp);
    }

    console.log(`[ADMIN] ${admin.username} banned ${targetUsername} (${banType})`);
    adminActions.push({
        type: 'ban',
        by: admin.username,
        target: targetUsername,
        banType,
        reason,
        timestamp: new Date().toISOString()
    });

    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'banned',
            message: reason ? `Banned: ${reason}` : 'You have been permanently banned from this server'
        }));
        setTimeout(() => targetWs.close(), 1000);
    }

    ws.send(JSON.stringify({ 
        type: 'adminActionSuccess', 
        action: 'ban', 
        target: targetUsername,
        message: `Banned ${targetUsername} (${banType})`
    }));
}

function handleAdminWarning(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, reason } = message;
    
    sendToUser(targetUsername, {
        type: 'warning',
        message: reason || 'You have received a warning from an admin'
    });

    adminActions.push({
        type: 'warning',
        by: admin.username,
        target: targetUsername,
        reason,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ 
        type: 'adminActionSuccess', 
        action: 'warning', 
        target: targetUsername 
    }));
}

// Admin trolling handlers
function handleAdminFakeMessage(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, fakeText } = message;
    
    sendToUser(targetUsername, {
        type: 'fakeMessage',
        fakeText
    });

    adminActions.push({
        type: 'fakeMessage',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'fakeMessage' }));
}

function handleAdminForceMute(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, duration } = message;
    
    sendToUser(targetUsername, {
        type: 'forceMute',
        duration: duration || 30
    });

    adminActions.push({
        type: 'forceMute',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'forceMute' }));
}

function handleAdminSpinScreen(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'spinScreen' });
    
    adminActions.push({
        type: 'spinScreen',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'spinScreen' }));
}

function handleAdminSlowMode(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { enabled } = message;
    serverSettings.slowModeEnabled = enabled;
    
    // Clear all last message times when toggling
    if (!enabled) {
        lastMessageTime.clear();
    }

    broadcast({
        type: 'broadcast',
        message: enabled 
            ? `🐌 Slow mode enabled: ${serverSettings.slowModeDuration} second delay between messages` 
            : '⚡ Slow mode disabled'
    });

    adminActions.push({
        type: 'slowMode',
        by: admin.username,
        enabled,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'slowMode' }));
}

function handleAdminInvertColors(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'invertColors' });
    
    adminActions.push({
        type: 'invertColors',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'invertColors' }));
}

function handleAdminShakeScreen(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'shakeScreen' });
    
    adminActions.push({
        type: 'shakeScreen',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'shakeScreen' }));
}

function handleAdminEmojiSpam(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'emojiSpam' });
    
    adminActions.push({
        type: 'emojiSpam',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'emojiSpam' }));
}

function handleAdminRickRoll(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'rickRoll' });
    
    adminActions.push({
        type: 'rickRoll',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'rickRoll' }));
}

function handleAdminForceDisconnect(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'forceDisconnect' });
    
    adminActions.push({
        type: 'forceDisconnect',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'forceDisconnect' }));
}

function handleAdminFlipScreen(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    sendToUser(targetUsername, { type: 'flipScreen' });
    
    adminActions.push({
        type: 'flipScreen',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'flipScreen' }));
}

function handleAdminBroadcast(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { message: broadcastMsg } = message;
    
    broadcast({
        type: 'broadcast',
        message: broadcastMsg
    });

    adminActions.push({
        type: 'broadcast',
        by: admin.username,
        message: broadcastMsg,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'broadcast' }));
}

function handleAdminUpdateSettings(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { settings } = message;
    
    // Update settings
    if (settings.autoModEnabled !== undefined) {
        serverSettings.autoModEnabled = settings.autoModEnabled;
        console.log(`[ADMIN] ${admin.username} ${settings.autoModEnabled ? 'enabled' : 'disabled'} auto-moderation`);
    }
    
    if (settings.slowModeEnabled !== undefined) {
        serverSettings.slowModeEnabled = settings.slowModeEnabled;
        if (!settings.slowModeEnabled) {
            lastMessageTime.clear();
        }
        console.log(`[ADMIN] ${admin.username} ${settings.slowModeEnabled ? 'enabled' : 'disabled'} slow mode`);
    }
    
    if (settings.redirectUrl) {
        serverSettings.redirectUrl = settings.redirectUrl;
    }
    
    if (settings.timeoutDuration) {
        serverSettings.timeoutDuration = settings.timeoutDuration;
    }
    
    if (settings.serverMotd !== undefined) {
        serverSettings.serverMotd = settings.serverMotd;
    }

    adminActions.push({
        type: 'settingsUpdate',
        by: admin.username,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'updateSettings' }));
}

// REST API endpoints
app.get('/health', (req, res) => {
    sweepTempIpBans();
    res.json({
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        privateChats: privateChats.size,
        bannedUsers: bannedUsers.size,
        bannedIPs: bannedIPs.size,
        tempBannedIPs: tempBannedIPs.size,
        timedOutUsers: timedOutUsers.size,
        adminUsers: adminUsers.size,
        vipUsers: vipUsers.size,
        settings: serverSettings
    });
});

app.get('/api/channels', (req, res) => {
    res.json({ channels: Object.keys(channels) });
});

function adminAuth(req, res, next) {
    const token = req.headers['x-admin-password'];
    if (token && token === ADMIN_PASSWORD) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/admin/bans', adminAuth, (_req, res) => {
    sweepTempIpBans();
    res.json({
        usernames: Array.from(bannedUsers.values()),
        ipBans: Array.from(bannedIPs.values()).map(maskIp),
        tempIpBans: Array.from(tempBannedIPs.entries()).map(([ip, meta]) => ({
            ip: maskIp(ip),
            until: meta.until,
            reason: meta.reason || null
        })),
        audit: adminActions.slice(-100)
    });
});

app.get('/admin/settings', adminAuth, (_req, res) => {
    res.json({
        settings: serverSettings,
        stats: {
            users: users.size,
            adminActions: adminActions.length
        }
    });
});

app.post('/admin/unban', adminAuth, (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    bannedUsers.delete(username);
    adminActions.push({ type: 'unban', by: 'REST', target: username, timestamp: new Date().toISOString() });
    res.json({ ok: true, username });
});

app.post('/admin/unban-ip', adminAuth, (req, res) => {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    bannedIPs.delete(ip);
    tempBannedIPs.delete(ip);
    adminActions.push({ type: 'unbanIp', by: 'REST', ip: maskIp(ip), timestamp: new Date().toISOString() });
    res.json({ ok: true, ip: maskIp(ip) });
});

app.post('/admin/settings', adminAuth, (req, res) => {
    const { settings } = req.body || {};
    if (!settings) return res.status(400).json({ error: 'settings required' });
    
    serverSettings = { ...serverSettings, ...settings };
    
    if (settings.slowModeEnabled === false) {
        lastMessageTime.clear();
    }
    
    adminActions.push({ 
        type: 'settingsUpdate', 
        by: 'REST', 
        timestamp: new Date().toISOString() 
    });
    
    res.json({ ok: true, settings: serverSettings });
});

// Server lifecycle
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT}`);
    console.log(`Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`VIP Password: ${VIP_PASSWORD}`);
    console.log(`=================================`);
    console.log(`Features enabled:`);
    console.log(`- Auto-Moderation: ${serverSettings.autoModEnabled}`);
    console.log(`- Slow Mode: ${serverSettings.slowModeEnabled}`);
    console.log(`=================================`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

setInterval(sweepTempIpBans, 30 * 1000);
