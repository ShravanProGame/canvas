// server.js - Enhanced Real-time Chat Server
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

// In-memory storage
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
const ipBanMap = new Map();
const userMessageTimes = new Map(); // For spam detection
const userMessageCounts = new Map(); // For message counting

const ADMIN_PASSWORD = 'classic-admin-76';
const VIP_PASSWORD = 'very-important-person';
const MAX_MESSAGE_LENGTH = 100;
const MAX_USERNAME_LENGTH = 30;
const SPAM_THRESHOLD = 5; // messages
const SPAM_TIME_WINDOW = 3000; // 3 seconds
const SPAM_COOLDOWN = 30000; // 30 seconds

const adminUsers = new Set();
const vipUsers = new Set();
const adminActions = [];

let serverSettings = {
    redirectUrl: 'https://google.com',
    serverMotd: ''
};

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
        return `${parts[0]}.***. ${parts[2]}.${parts[3]}`;
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

function isUserTimedOut(username) {
    if (!timedOutUsers.has(username)) return false;
    const timeoutEnd = timedOutUsers.get(username);
    if (Date.now() > timeoutEnd) {
        timedOutUsers.delete(username);
        return false;
    }
    return true;
}

function checkSpam(username) {
    const now = Date.now();
    
    // Check if user is in cooldown
    const cooldownEnd = userMessageCounts.get(username);
    if (cooldownEnd && now < cooldownEnd) {
        const remainingSeconds = Math.ceil((cooldownEnd - now) / 1000);
        return {
            isSpam: true,
            cooldown: true,
            remainingSeconds
        };
    }
    
    // Get user's recent message times
    if (!userMessageTimes.has(username)) {
        userMessageTimes.set(username, []);
    }
    
    const messageTimes = userMessageTimes.get(username);
    
    // Remove old messages outside the time window
    const recentMessages = messageTimes.filter(time => now - time < SPAM_TIME_WINDOW);
    
    // Check if spam threshold exceeded
    if (recentMessages.length >= SPAM_THRESHOLD) {
        // Put user in cooldown
        userMessageCounts.set(username, now + SPAM_COOLDOWN);
        userMessageTimes.set(username, []);
        
        return {
            isSpam: true,
            cooldown: false,
            newCooldown: true
        };
    }
    
    // Add current message time
    recentMessages.push(now);
    userMessageTimes.set(username, recentMessages);
    
    return { isSpam: false };
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

    if (bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned from this server' }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    console.log(`New client connected from ${maskIp(ip)}`);

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
            userMessageTimes.delete(user.username);
            userMessageCounts.delete(user.username);
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
        case 'addReaction':
            handleAddReaction(ws, message);
            break;
        case 'getBanList':
            handleGetBanList(ws, message);
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
        case 'adminUnban':
            handleAdminUnban(ws, message);
            break;
        case 'adminUnbanIP':
            handleAdminUnbanIP(ws, message);
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
        case 'adminClearTimeouts':
            handleAdminClearTimeouts(ws, message);
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
    let { username, isAdmin, isVIP, adminPassword, vipPassword } = message;

    // Enforce username length limit
    if (username.length > MAX_USERNAME_LENGTH) {
        username = username.substring(0, MAX_USERNAME_LENGTH);
    }

    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({ type: 'banned', message: 'You have been banned from this server' }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    if (bannedIPs.has(ws.ip)) {
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

    if (serverSettings.serverMotd) {
        ws.send(JSON.stringify({
            type: 'broadcast',
            message: `📢 Server MOTD: ${serverSettings.serverMotd}`
        }));
    }

    broadcastUserList();
    console.log(`User ${username} joined. Total users: ${users.size}`);
}

function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    if (isUserTimedOut(user.username)) {
        ws.send(JSON.stringify({ type: 'error', message: 'You are currently timed out' }));
        return;
    }

    const { channel, text, replyTo } = message;
    if (!channel || typeof text !== 'string' || !text.trim()) return;

    // Check message length (admins can bypass)
    if (!user.isAdmin && text.length > MAX_MESSAGE_LENGTH) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Message too long! Maximum ${MAX_MESSAGE_LENGTH} characters.` 
        }));
        return;
    }

    // Check for spam (admins bypass)
    if (!user.isAdmin) {
        const spamCheck = checkSpam(user.username);
        if (spamCheck.isSpam) {
            if (spamCheck.cooldown) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Spam cooldown active! Please wait ${spamCheck.remainingSeconds} more second(s).`
                }));
                return;
            } else if (spamCheck.newCooldown) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Spam detected! You have been put on cooldown for 30 seconds.`
                }));
                
                // Auto-timeout for 30 seconds
                const timeoutEnd = Date.now() + SPAM_COOLDOWN;
                timedOutUsers.set(user.username, timeoutEnd);
                
                setTimeout(() => {
                    timedOutUsers.delete(user.username);
                    sendToUser(user.username, {
                        type: 'timeoutEnded',
                        message: 'Your spam timeout has ended'
                    });
                }, SPAM_COOLDOWN);
                
                return;
            }
        }
    }

    const chatMessage = {
        id: generateId(),
        author: user.username,
        text,
        channel,
        timestamp: new Date().toISOString(),
        isVIP: user.isVIP,
        isAdmin: user.isAdmin,
        replyTo: replyTo || null,
        reactions: {}
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

function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

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

function handleAdminClearTimeouts(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const clearedUsers = Array.from(timedOutUsers.keys());
    timedOutUsers.clear();
    userMessageCounts.clear();
    userMessageTimes.clear();

    clearedUsers.forEach(username => {
        sendToUser(username, {
            type: 'timeoutEnded',
            message: 'Your timeout has been cleared by an admin'
        });
    });

    adminActions.push({
        type: 'clearTimeouts',
        by: admin.username,
        cleared: clearedUsers.length,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ 
        type: 'adminActionSuccess', 
        action: 'clearTimeouts',
        message: `Cleared ${clearedUsers.length} active timeout(s)`
    }));
}

function handleAdminUpdateSettings(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { settings } = message;
    
    if (settings.redirectUrl) {
        serverSettings.redirectUrl = settings.redirectUrl;
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
    res.json({
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        privateChats: privateChats.size,
        bannedUsers: bannedUsers.size,
        bannedIPs: bannedIPs.size,
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
    res.json({
        usernames: Array.from(bannedUsers.values()),
        ipBans: Array.from(bannedIPs.values()).map(maskIp),
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
    adminActions.push({ 
        type: 'unban', 
        by: 'REST', 
        target: username, 
        timestamp: new Date().toISOString() 
    });
    res.json({ ok: true, username });
});

app.post('/admin/unban-ip', adminAuth, (req, res) => {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    
    // Find actual IP from masked version
    let actualIP = null;
    for (const bannedIP of bannedIPs) {
        if (maskIp(bannedIP) === ip) {
            actualIP = bannedIP;
            break;
        }
    }
    
    if (actualIP) {
        bannedIPs.delete(actualIP);
    }
    
    adminActions.push({ 
        type: 'unbanIp', 
        by: 'REST', 
        ip: maskIp(actualIP || ip), 
        timestamp: new Date().toISOString() 
    });
    res.json({ ok: true, ip: maskIp(actualIP || ip) });
});

app.post('/admin/settings', adminAuth, (req, res) => {
    const { settings } = req.body || {};
    if (!settings) return res.status(400).json({ error: 'settings required' });
    
    serverSettings = { ...serverSettings, ...settings };
    
    adminActions.push({ 
        type: 'settingsUpdate', 
        by: 'REST', 
        timestamp: new Date().toISOString() 
    });
    
    res.json({ ok: true, settings: serverSettings });
});

app.post('/admin/clear-timeouts', adminAuth, (req, res) => {
    const clearedUsers = Array.from(timedOutUsers.keys());
    timedOutUsers.clear();
    userMessageCounts.clear();
    userMessageTimes.clear();
    
    clearedUsers.forEach(username => {
        sendToUser(username, {
            type: 'timeoutEnded',
            message: 'Your timeout has been cleared by an admin'
        });
    });
    
    adminActions.push({ 
        type: 'clearTimeouts', 
        by: 'REST',
        cleared: clearedUsers.length,
        timestamp: new Date().toISOString() 
    });
    
    res.json({ ok: true, cleared: clearedUsers.length });
});

// Serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Server lifecycle
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT}`);
    console.log(`=================================`);
    console.log(`Passwords:`);
    console.log(`- Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`- VIP Password: ${VIP_PASSWORD}`);
    console.log(`- Regular Password: classic`);
    console.log(`=================================`);
    console.log(`Features:`);
    console.log(`- Message Length Limit: ${MAX_MESSAGE_LENGTH} characters (admins bypass)`);
    console.log(`- Username Length Limit: ${MAX_USERNAME_LENGTH} characters`);
    console.log(`- Spam Protection: ${SPAM_THRESHOLD} messages in ${SPAM_TIME_WINDOW/1000}s = ${SPAM_COOLDOWN/1000}s cooldown`);
    console.log(`- Message Reactions: Enabled`);
    console.log(`- Reply to Messages: Enabled`);
    console.log(`- Ban Management: Enabled`);
    console.log(`- Admin Panel: Full Featured`);
    console.log(`=================================`);
});

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

// Periodic cleanup
setInterval(() => {
    // Clean up expired timeouts
    const now = Date.now();
    for (const [username, endTime] of timedOutUsers.entries()) {
        if (now > endTime) {
            timedOutUsers.delete(username);
        }
    }
    
    // Clean up expired cooldowns
    for (const [username, endTime] of userMessageCounts.entries()) {
        if (now > endTime) {
            userMessageCounts.delete(username);
        }
    }
}, 30000); // Every 30 secondstargetUsername, {
        type: 'privateChatRequest',
        from: sender.username
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

    const { chatId, text, targetUsername, replyTo } = message;
    if (!chatId || !targetUsername || typeof text !== 'string' || !text.trim()) return;

    // Check message length
    if (!sender.isAdmin && text.length > MAX_MESSAGE_LENGTH) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: `Message too long! Maximum ${MAX_MESSAGE_LENGTH} characters.` 
        }));
        return;
    }

    // Check for spam
    if (!sender.isAdmin) {
        const spamCheck = checkSpam(sender.username);
        if (spamCheck.isSpam) {
            if (spamCheck.cooldown) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Spam cooldown active! Please wait ${spamCheck.remainingSeconds} more second(s).`
                }));
                return;
            } else if (spamCheck.newCooldown) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: `Spam detected! You have been put on cooldown for 30 seconds.`
                }));
                return;
            }
        }
    }

    const privateMessage = {
        id: generateId(),
        author: sender.username,
        text,
        chatId,
        timestamp: new Date().toISOString(),
        isVIP: sender.isVIP,
        isAdmin: sender.isAdmin,
        replyTo: replyTo || null,
        reactions: {}
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

function handleAddReaction(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { messageId, emoji, channel, isPrivate, chatId } = message;
    
    let targetMessages;
    if (isPrivate) {
        targetMessages = privateChats.get(chatId) || [];
    } else {
        targetMessages = channels[channel] || [];
    }

    const targetMessage = targetMessages.find(msg => msg.id === messageId);
    if (!targetMessage) return;

    if (!targetMessage.reactions) targetMessage.reactions = {};
    if (!targetMessage.reactions[emoji]) targetMessage.reactions[emoji] = [];

    const userIndex = targetMessage.reactions[emoji].indexOf(user.username);
    if (userIndex === -1) {
        // Add reaction
        targetMessage.reactions[emoji].push(user.username);
    } else {
        // Remove reaction (toggle)
        targetMessage.reactions[emoji].splice(userIndex, 1);
        if (targetMessage.reactions[emoji].length === 0) {
            delete targetMessage.reactions[emoji];
        }
    }

    // Broadcast reaction update
    if (isPrivate) {
        const chatParticipants = chatId.replace('private_', '').split('_');
        chatParticipants.forEach(username => {
            sendToUser(username, {
                type: 'reactionAdded',
                messageId,
                reactions: targetMessage.reactions
            });
        });
    } else {
        broadcast({
            type: 'reactionAdded',
            messageId,
            reactions: targetMessage.reactions
        });
    }
}

function handleGetBanList(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    ws.send(JSON.stringify({
        type: 'banList',
        users: Array.from(bannedUsers),
        ips: Array.from(bannedIPs).map(maskIp)
    }));
}

// Admin handlers
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
            redirectUrl: redirectUrl || serverSettings.redirectUrl
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
    }, seconds * 1000);

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'timeout',
        target: targetUsername
    }));
}

function handleAdminBan(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, banType, reason } = message;
    const targetWs = userSocketMap.get(targetUsername);
    const targetIp = ipBanMap.get(targetUsername);

    if (banType === 'username' || banType === 'both') {
        bannedUsers.add(targetUsername);
    }

    if ((banType === 'ip' || banType === 'both') && targetIp) {
        bannedIPs.add(targetIp);
    }

    console.log(`[ADMIN] ${admin.username} banned ${targetUsername} (${banType || 'username'})`);
    adminActions.push({
        type: 'ban',
        by: admin.username,
        target: targetUsername,
        banType: banType || 'username',
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
        message: `Banned ${targetUsername}`
    }));
}

function handleAdminUnban(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    bannedUsers.delete(targetUsername);

    console.log(`[ADMIN] ${admin.username} unbanned ${targetUsername}`);
    adminActions.push({
        type: 'unban',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'unban',
        target: targetUsername,
        message: `${targetUsername} has been unbanned`
    }));
}

function handleAdminUnbanIP(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetIP } = message;
    
    // Find the actual IP from masked version
    let actualIP = null;
    for (const ip of bannedIPs) {
        if (maskIp(ip) === targetIP) {
            actualIP = ip;
            break;
        }
    }

    if (actualIP) {
        bannedIPs.delete(actualIP);
        console.log(`[ADMIN] ${admin.username} unbanned IP ${maskIp(actualIP)}`);
        adminActions.push({
            type: 'unbanIP',
            by: admin.username,
            target: maskIp(actualIP),
            timestamp: new Date().toISOString()
        });
    }

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'unbanIP',
        message: `IP ${targetIP} has been unbanned`
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

function handleAdminFakeMessage(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, fakeText } = message;
    sendToUser(targetUsername, { type: 'fakeMessage', fakeText });
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
    sendToUser(targetUsername, { type: 'forceMute', duration: duration || 30 });
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

    adminActions.push({
        type: 'slowMode',
        by: admin.username,
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
    sendToUser(
