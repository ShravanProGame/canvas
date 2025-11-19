// server.js
// ================================================
// Real-time chat server with ephemeral storage,
// role verification, moderation (kick/timeout/ban),
// and IP ban support.
// ================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

// --------------------------------
// App and WebSocket initialization
// --------------------------------
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// -----------------
// Middleware / static
// -----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// -----------------
// Ephemeral in-memory storage
// -----------------
const channels = {
    general: [],
    random: [],
    gaming: [],
    memes: []
};

const users = new Map();               // ws -> { username, id, isAdmin, isVIP, ip }
const privateChats = new Map();        // chatId -> messages[]
const userSocketMap = new Map();       // username -> ws
const bannedUsers = new Set();         // username bans (ephemeral)
const timedOutUsers = new Map();       // username -> timeoutEnd (ms)

// IP moderation
const bannedIPs = new Set();           // permanent IP bans (ephemeral)
const tempBannedIPs = new Map();       // ip -> { until: ms, reason?: string }

// Admin/VIP tracking
const ADMIN_PASSWORD = 'classicclassic';
const VIP_PASSWORD = 'very-important-person';
const adminUsers = new Set();          // usernames with admin role (session only)
const vipUsers = new Set();            // usernames with VIP role (session only)

// Admin action audit (ephemeral)
const adminActions = [];               // { type, by, target?, ip?, duration?, timestamp }

// -----------------
// Utility helpers
// -----------------

/**
 * Normalize IP to a consistent format:
 * - strips IPv6 mapped prefix ::ffff:
 * - for proxies, uses the first IP in x-forwarded-for
 */
function getClientIp(req) {
    // Check X-Forwarded-For for real client IP if behind a proxy/reverse proxy
    const xff = req.headers['x-forwarded-for'];
    let ip = (Array.isArray(xff) ? xff[0] : (xff || '')).split(',')[0].trim();

    if (!ip) {
        ip = req.socket?.remoteAddress || '';
    }

    // Normalize IPv6-mapped IPv4 (e.g., ::ffff:127.0.0.1)
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return ip || 'unknown';
}

/** Mask IP for logs/UI (privacy-friendly) */
function maskIp(ip) {
    if (!ip || ip === 'unknown') return 'unknown';
    // Simple mask: keep first and last segment
    const parts = ip.split('.');
    if (parts.length === 4) {
        return `${parts[0]}.***.${parts[2]}.${parts[3]}`;
    }
    // IPv6: keep first group then mask
    const v6 = ip.split(':');
    if (v6.length > 1) {
        return `${v6[0]}:*:${v6[v6.length - 1]}`;
    }
    return ip;
}

/** Generate a compact unique id */
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

/** Broadcast helper */
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

/** Check and clear expired temporary IP bans */
function sweepTempIpBans() {
    const now = Date.now();
    for (const [ip, meta] of tempBannedIPs.entries()) {
        if (now >= meta.until) {
            tempBannedIPs.delete(ip);
            adminActions.push({
                type: 'tempIpBanExpired',
                ip,
                timestamp: new Date().toISOString()
            });
        }
    }
}

/** Determine if IP is currently banned (perm or temp) */
function isIpBanned(ip) {
    if (!ip || ip === 'unknown') return false;
    if (bannedIPs.has(ip)) return { banned: true, kind: 'permanent' };
    const meta = tempBannedIPs.get(ip);
    if (meta) {
        if (Date.now() < meta.until) return { banned: true, kind: 'temporary', until: meta.until, reason: meta.reason };
        // Expired temp ban; cleanup will remove it eventually
        tempBannedIPs.delete(ip);
    }
    return { banned: false };
}

/** Check timeout status for a username */
function isUserTimedOut(username) {
    if (!timedOutUsers.has(username)) return false;
    const timeoutEnd = timedOutUsers.get(username);
    if (Date.now() > timeoutEnd) {
        timedOutUsers.delete(username);
        return false;
    }
    return true;
}

/** Broadcast latest user list (with admin/vip flags) */
function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        isVIP: u.isVIP || false,
        isAdmin: u.isAdmin || false
    }));
    broadcast({ type: 'userList', users: userList });
}

// ----------------------------------------
// WebSocket: connection lifecycle & routing
// ----------------------------------------
wss.on('connection', (ws, req) => {
    // Capture and attach client IP to socket
    const ip = getClientIp(req);
    ws.ip = ip;

    // IP ban gating (perm or temp)
    const ipStatus = isIpBanned(ip);
    if (ipStatus.banned) {
        const msgBase = ipStatus.kind === 'permanent'
            ? 'Your IP is banned from this server'
            : `Your IP is temporarily banned until ${new Date(ipStatus.until).toLocaleString()}` +
              (ipStatus.reason ? ` (Reason: ${ipStatus.reason})` : '');

        ws.send(JSON.stringify({
            type: 'banned',
            message: msgBase
        }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    console.log(`New client connected from ${maskIp(ip)}`);

    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));

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
            console.log(`User ${user.username} disconnected (${maskIp(user.ip)})`);
            userSocketMap.delete(user.username);
            adminUsers.delete(user.username);
            vipUsers.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// -----------------
// Message router
// -----------------
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
        case 'adminBanIp': // optional direct IP ban action
            handleAdminBanIp(ws, message);
            break;
        case 'adminTempBanIp': // optional temporary IP ban
            handleAdminTempBanIp(ws, message);
            break;
        case 'adminUnban':
            handleAdminUnban(ws, message);
            break;
        case 'adminUnbanIp':
            handleAdminUnbanIp(ws, message);
            break;
        default:
            console.log('Unknown message type:', message.type);
    }
}

// -----------------
// Handlers
// -----------------
function handleJoin(ws, message) {
    const { username, isAdmin, isVIP, adminPassword, vipPassword } = message;

    // Username ban gate
    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({
            type: 'banned',
            message: 'You have been banned from this server'
        }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    // IP gate (double-check here to cover reconnect after initial connection)
    const ipStatus = isIpBanned(ws.ip);
    if (ipStatus.banned) {
        const msgBase = ipStatus.kind === 'permanent'
            ? 'Your IP is banned from this server'
            : `Your IP is temporarily banned until ${new Date(ipStatus.until).toLocaleString()}` +
              (ipStatus.reason ? ` (Reason: ${ipStatus.reason})` : '');
        ws.send(JSON.stringify({ type: 'banned', message: msgBase }));
        setTimeout(() => ws.close(), 250);
        return;
    }

    // Server-side role verification
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

    // Register user session
    users.set(ws, {
        username,
        id: generateId(),
        isAdmin: isVerifiedAdmin,
        isVIP: isVerifiedVIP,
        ip: ws.ip
    });
    userSocketMap.set(username, ws);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels),
        isAdmin: isVerifiedAdmin,
        isVIP: isVerifiedVIP
    }));

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
    if (channels[channel]) {
        ws.send(JSON.stringify({ type: 'history', channel, messages: channels[channel] }));
    } else {
        ws.send(JSON.stringify({ type: 'history', channel, messages: [] }));
    }
}

function handleTyping(ws, message) {
    const user = users.get(ws);
    if (!user) return;

    const { channel, isTyping, isPrivate, targetUsername } = message;

    if (isPrivate && targetUsername) {
        const targetWs = userSocketMap.get(targetUsername);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
                type: 'typing',
                username: user.username,
                channel,
                isTyping,
                isPrivate: true
            }));
        }
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
    const targetWs = userSocketMap.get(targetUsername);
    if (!targetWs) {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found or offline' }));
        return;
    }

    targetWs.send(JSON.stringify({
        type: 'privateChatRequest',
        from: sender.username,
        requestId: generateId()
    }));
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

    const targetWs = userSocketMap.get(targetUsername);
    const payload = { type: 'privateMessage', message: privateMessage };

    ws.send(JSON.stringify(payload));
    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(payload));
    }
}

function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    const messages = privateChats.get(chatId) || [];
    ws.send(JSON.stringify({ type: 'privateHistory', chatId, messages }));
}

// -----------------
// Admin actions
// -----------------
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

function handleAdminKick(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, redirectUrl } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (targetWs) {
        console.log(`[ADMIN] ${admin.username} kicked ${targetUsername}`);
        adminActions.push({
            type: 'kick',
            by: admin.username,
            target: targetUsername,
            ip: maskIp(targetWs.ip),
            timestamp: new Date().toISOString()
        });

        targetWs.send(JSON.stringify({
            type: 'kicked',
            message: 'You have been kicked from the server',
            redirectUrl: redirectUrl || 'https://google.com'
        }));
        setTimeout(() => targetWs.close(), 1000);
    }

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'kick', target: targetUsername }));
}

function handleAdminTimeout(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername, duration } = message;
    const seconds = Math.max(1, parseInt(duration, 10) || 60);
    const timeoutEnd = Date.now() + (seconds * 1000);

    timedOutUsers.set(targetUsername, timeoutEnd);
    console.log(`[ADMIN] ${admin.username} timed out ${targetUsername} for ${seconds} seconds`);
    adminActions.push({
        type: 'timeout',
        by: admin.username,
        target: targetUsername,
        duration: seconds,
        timestamp: new Date().toISOString()
    });

    const targetWs = userSocketMap.get(targetUsername);
    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'timedOut',
            duration: seconds,
            message: `You have been timed out for ${seconds} seconds`
        }));
    }

    setTimeout(() => {
        timedOutUsers.delete(targetUsername);
        if (targetWs && targetWs.readyState === WebSocket.OPEN) {
            targetWs.send(JSON.stringify({
                type: 'timeoutEnded',
                message: 'Your timeout has ended'
            }));
        }
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

    const { targetUsername } = message;
    const targetWs = userSocketMap.get(targetUsername);

    bannedUsers.add(targetUsername);

    // If online, also ban IP immediately
    let ipBanned = false;
    if (targetWs && targetWs.ip) {
        bannedIPs.add(targetWs.ip);
        ipBanned = true;
    }

    console.log(`[ADMIN] ${admin.username} banned ${targetUsername}${ipBanned ? ` (IP: ${maskIp(targetWs?.ip)})` : ''}`);
    adminActions.push({
        type: 'ban',
        by: admin.username,
        target: targetUsername,
        ip: ipBanned ? maskIp(targetWs.ip) : undefined,
        timestamp: new Date().toISOString()
    });

    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'banned',
            message: 'You have been permanently banned from this server'
        }));
        setTimeout(() => targetWs.close(), 1000);
    }

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'ban', target: targetUsername }));
}

function handleAdminBanIp(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    let { ip, targetUsername } = message;

    // If username provided, resolve IP
    if (!ip && targetUsername) {
        const targetWs = userSocketMap.get(targetUsername);
        ip = targetWs?.ip;
    }
    if (!ip) {
        ws.send(JSON.stringify({ type: 'error', message: 'No IP found for ban' }));
        return;
    }

    bannedIPs.add(ip);
    console.log(`[ADMIN] ${admin.username} IP-banned ${maskIp(ip)}`);
    adminActions.push({
        type: 'banIp',
        by: admin.username,
        ip: maskIp(ip),
        timestamp: new Date().toISOString()
    });

    // Disconnect any active sockets matching IP
    wss.clients.forEach((client) => {
        if (client.ip === ip && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned from this server' }));
            setTimeout(() => client.close(), 250);
        }
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'banIp', target: maskIp(ip) }));
}

function handleAdminTempBanIp(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    let { ip, duration, reason } = message;
    const seconds = Math.max(1, parseInt(duration, 10) || 600);

    if (!ip) {
        ws.send(JSON.stringify({ type: 'error', message: 'IP required for temporary ban' }));
        return;
    }

    const until = Date.now() + seconds * 1000;
    tempBannedIPs.set(ip, { until, reason });

    console.log(`[ADMIN] ${admin.username} temp IP-banned ${maskIp(ip)} for ${seconds}s${reason ? ` (Reason: ${reason})` : ''}`);
    adminActions.push({
        type: 'tempBanIp',
        by: admin.username,
        ip: maskIp(ip),
        duration: seconds,
        timestamp: new Date().toISOString()
    });

    // Disconnect any active sockets matching IP
    wss.clients.forEach((client) => {
        if (client.ip === ip && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'banned',
                message: `Your IP is temporarily banned for ${seconds} seconds` + (reason ? ` (Reason: ${reason})` : '')
            }));
            setTimeout(() => client.close(), 250);
        }
    });

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'tempBanIp',
        target: maskIp(ip),
        duration: seconds
    }));
}

function handleAdminUnban(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { targetUsername } = message;
    if (!targetUsername) {
        ws.send(JSON.stringify({ type: 'error', message: 'Username required to unban' }));
        return;
    }

    bannedUsers.delete(targetUsername);
    console.log(`[ADMIN] ${admin.username} unbanned ${targetUsername}`);
    adminActions.push({
        type: 'unban',
        by: admin.username,
        target: targetUsername,
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'unban', target: targetUsername }));
}

function handleAdminUnbanIp(ws, message) {
    const admin = requireAdmin(ws);
    if (!admin) return;

    const { ip } = message;
    if (!ip) {
        ws.send(JSON.stringify({ type: 'error', message: 'IP required to unban' }));
        return;
    }

    bannedIPs.delete(ip);
    tempBannedIPs.delete(ip); // clear temp ban if present
    console.log(`[ADMIN] ${admin.username} unbanned IP ${maskIp(ip)}`);
    adminActions.push({
        type: 'unbanIp',
        by: admin.username,
        ip: maskIp(ip),
        timestamp: new Date().toISOString()
    });

    ws.send(JSON.stringify({ type: 'adminActionSuccess', action: 'unbanIp', target: maskIp(ip) }));
}

// -----------------
// REST API endpoints
// -----------------

// Health endpoint (includes IP ban stats)
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
        vipUsers: vipUsers.size
    });
});

// Channels listing
app.get('/api/channels', (req, res) => {
    res.json({ channels: Object.keys(channels) });
});

// Simple admin auth middleware for REST endpoints (using admin password header)
function adminAuth(req, res, next) {
    const token = req.headers['x-admin-password'];
    if (token && token === ADMIN_PASSWORD) return next();
    return res.status(401).json({ error: 'Unauthorized' });
}

// List bans (usernames + IPs)
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
        audit: adminActions.slice(-100) // last 100 actions
    });
});

// Unban username
app.post('/admin/unban', adminAuth, (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: 'username required' });
    bannedUsers.delete(username);
    adminActions.push({ type: 'unban', by: 'REST', target: username, timestamp: new Date().toISOString() });
    res.json({ ok: true, username });
});

// Unban IP (perm or temp)
app.post('/admin/unban-ip', adminAuth, (req, res) => {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    bannedIPs.delete(ip);
    tempBannedIPs.delete(ip);
    adminActions.push({ type: 'unbanIp', by: 'REST', ip: maskIp(ip), timestamp: new Date().toISOString() });
    res.json({ ok: true, ip: maskIp(ip) });
});

// Ban IP via REST
app.post('/admin/ban-ip', adminAuth, (req, res) => {
    const { ip } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    bannedIPs.add(ip);
    adminActions.push({ type: 'banIp', by: 'REST', ip: maskIp(ip), timestamp: new Date().toISOString() });

    // Disconnect live sockets on that IP
    wss.clients.forEach((client) => {
        if (client.ip === ip && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'banned', message: 'Your IP is banned from this server' }));
            setTimeout(() => client.close(), 250);
        }
    });

    res.json({ ok: true, ip: maskIp(ip) });
});

// Temp ban IP via REST
app.post('/admin/temp-ban-ip', adminAuth, (req, res) => {
    const { ip, duration, reason } = req.body || {};
    if (!ip) return res.status(400).json({ error: 'ip required' });
    const seconds = Math.max(1, parseInt(duration, 10) || 600);
    const until = Date.now() + seconds * 1000;
    tempBannedIPs.set(ip, { until, reason });

    adminActions.push({
        type: 'tempBanIp',
        by: 'REST',
        ip: maskIp(ip),
        duration: seconds,
        timestamp: new Date().toISOString()
    });

    wss.clients.forEach((client) => {
        if (client.ip === ip && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'banned',
                message: `Your IP is temporarily banned for ${seconds} seconds` + (reason ? ` (Reason: ${reason})` : '')
            }));
            setTimeout(() => client.close(), 250);
        }
    });

    res.json({ ok: true, ip: maskIp(ip), duration: seconds });
});

// -----------------
// Server lifecycle
// -----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Open http://localhost:${PORT}`);
    console.log(`Admin Password: ${ADMIN_PASSWORD}`);
    console.log(`VIP Password: ${VIP_PASSWORD}`);
    console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

// Periodic housekeeping (sweep temp IP bans)
setInterval(sweepTempIpBans, 30 * 1000);
