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
    gaming: [],
    memes: []
};

const users = new Map();
const privateChats = new Map();
const userSocketMap = new Map();
const bannedUsers = new Set();
const timedOutUsers = new Map();

// Server-side admin and VIP tracking
const ADMIN_PASSWORD = 'classicclassic';
const VIP_PASSWORD = 'very-important-person';
const adminUsers = new Set();
const vipUsers = new Set();

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
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
            console.log(`User ${user.username} disconnected`);
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

function handleMessage(ws, message) {
    console.log('Handling message type:', message.type);
    
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
        default:
            console.log('Unknown message type:', message.type);
    }
}

function handleJoin(ws, message) {
    const { username, isAdmin, isVIP, adminPassword, vipPassword } = message;
    
    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({
            type: 'banned',
            message: 'You have been banned from this server'
        }));
        ws.close();
        return;
    }
    
    // Verify admin status on server side
    const isVerifiedAdmin = isAdmin && adminPassword === ADMIN_PASSWORD;
    
    // Verify VIP status on server side
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
        isVIP: isVerifiedVIP
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
    console.log(`User ${username} joined. Total users: ${users.size}`);
}

function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) {
        console.log('Message from unknown user');
        return;
    }

    if (isUserTimedOut(user.username)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You are currently timed out'
        }));
        return;
    }

    const { channel, text } = message;
    console.log(`Message from ${user.username} in #${channel}: ${text}`);
    
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
        
        if (channels[channel].length > 100) {
            channels[channel].shift();
        }
    }

    broadcast({
        type: 'message',
        message: chatMessage
    });
}

function handlePrivateChatRequest(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    const { targetUsername } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (!targetWs) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'User not found or offline'
        }));
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
        ws.send(JSON.stringify({
            type: 'error',
            message: 'User no longer online'
        }));
        return;
    }

    if (accepted) {
        const usernames = [from, responder.username].sort();
        const chatId = `private_${usernames[0]}_${usernames[1]}`;

        if (!privateChats.has(chatId)) {
            privateChats.set(chatId, []);
        }

        requesterWs.send(JSON.stringify({
            type: 'privateChatAccepted',
            chatId: chatId,
            with: responder.username
        }));

        ws.send(JSON.stringify({
            type: 'privateChatAccepted',
            chatId: chatId,
            with: from
        }));
    } else {
        requesterWs.send(JSON.stringify({
            type: 'privateChatRejected',
            by: responder.username
        }));
    }
}

function handlePrivateMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    if (isUserTimedOut(sender.username)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'You are currently timed out'
        }));
        return;
    }

    const { chatId, text, targetUsername } = message;
    
    const privateMessage = {
        id: generateId(),
        author: sender.username,
        text,
        chatId,
        timestamp: new Date().toISOString(),
        isVIP: sender.isVIP,
        isAdmin: sender.isAdmin
    };

    if (!privateChats.has(chatId)) {
        privateChats.set(chatId, []);
    }
    
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);

    if (chatMessages.length > 100) {
        chatMessages.shift();
    }

    const targetWs = userSocketMap.get(targetUsername);
    const messageData = {
        type: 'privateMessage',
        message: privateMessage
    };

    ws.send(JSON.stringify(messageData));

    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify(messageData));
    }
}

function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    const messages = privateChats.get(chatId) || [];
    
    ws.send(JSON.stringify({
        type: 'privateHistory',
        chatId,
        messages
    }));
}

function handleGetHistory(ws, message) {
    const { channel } = message;
    
    if (channels[channel]) {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: channels[channel]
        }));
    } else {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: []
        }));
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

function handleAdminKick(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        console.log(`[ADMIN] Unauthorized kick attempt by ${admin ? admin.username : 'unknown'}`);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized: You are not an admin'
        }));
        return;
    }

    const { targetUsername, redirectUrl } = message;
    const targetWs = userSocketMap.get(targetUsername);

    if (targetWs) {
        console.log(`[ADMIN] ${admin.username} kicked ${targetUsername}`);
        
        targetWs.send(JSON.stringify({
            type: 'kicked',
            message: 'You have been kicked from the server',
            redirectUrl: redirectUrl || 'https://google.com'
        }));

        setTimeout(() => {
            targetWs.close();
        }, 1000);
    }

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'kick',
        target: targetUsername
    }));
}

function handleAdminTimeout(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        console.log(`[ADMIN] Unauthorized timeout attempt by ${admin ? admin.username : 'unknown'}`);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized: You are not an admin'
        }));
        return;
    }

    const { targetUsername, duration } = message;
    const timeoutEnd = Date.now() + (duration * 1000);
    
    timedOutUsers.set(targetUsername, timeoutEnd);
    console.log(`[ADMIN] ${admin.username} timed out ${targetUsername} for ${duration} seconds`);

    const targetWs = userSocketMap.get(targetUsername);
    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'timedOut',
            duration: duration,
            message: `You have been timed out for ${duration} seconds`
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
    }, duration * 1000);

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'timeout',
        target: targetUsername,
        duration: duration
    }));
}

function handleAdminBan(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        console.log(`[ADMIN] Unauthorized ban attempt by ${admin ? admin.username : 'unknown'}`);
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized: You are not an admin'
        }));
        return;
    }

    const { targetUsername } = message;
    bannedUsers.add(targetUsername);
    console.log(`[ADMIN] ${admin.username} banned ${targetUsername}`);

    const targetWs = userSocketMap.get(targetUsername);
    if (targetWs) {
        targetWs.send(JSON.stringify({
            type: 'banned',
            message: 'You have been permanently banned from this server'
        }));

        setTimeout(() => {
            targetWs.close();
        }, 1000);
    }

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'ban',
        target: targetUsername
    }));
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

function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => ({
        username: u.username,
        isVIP: u.isVIP || false,
        isAdmin: u.isAdmin || false
    }));
    
    broadcast({
        type: 'userList',
        users: userList
    });
}

function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
        }
    });
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST API endpoints
app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        privateChats: privateChats.size,
        bannedUsers: bannedUsers.size,
        timedOutUsers: timedOutUsers.size,
        adminUsers: adminUsers.size,
        vipUsers: vipUsers.size
    });
});

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

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
