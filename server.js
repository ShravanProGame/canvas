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

const users = new Map(); // WebSocket -> user info
const privateChats = new Map(); // chatId -> messages array
const userSocketMap = new Map(); // username -> WebSocket
const bannedUsers = new Set(); // Set of banned usernames
const timedOutUsers = new Map(); // username -> timeout end timestamp

// Admin configuration
const ADMIN_PASSWORD = 'classicclassic';

// WebSocket connection handler
wss.on('connection', (ws) => {
    console.log('New client connected');
    
    ws.send(JSON.stringify({
        type: 'connected',
        message: 'Connected to server'
    }));
    
    ws.on('message', (data) => {
        try {
            console.log('Received message:', data.toString());
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Error parsing message:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Error parsing message'
            }));
        }
    });

    ws.on('close', () => {
        const user = users.get(ws);
        if (user) {
            console.log(`User ${user.username} disconnected`);
            userSocketMap.delete(user.username);
            users.delete(ws);
            broadcastUserList();
        }
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Handle different message types
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
        // Admin actions
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

// User joins
function handleJoin(ws, message) {
    const { username, isAdmin } = message;
    console.log(`User joining: ${username}`);
    
    // Check if user is banned
    if (bannedUsers.has(username)) {
        ws.send(JSON.stringify({
            type: 'banned',
            message: 'You have been banned from this server'
        }));
        ws.close();
        return;
    }
    
    users.set(ws, {
        username,
        id: generateId(),
        isAdmin: isAdmin || false
    });
    
    userSocketMap.set(username, ws);

    ws.send(JSON.stringify({
        type: 'joined',
        username,
        channels: Object.keys(channels)
    }));

    broadcastUserList();
    console.log(`User ${username} joined. Total users: ${users.size}`);
}

// Handle chat messages
function handleChatMessage(ws, message) {
    const user = users.get(ws);
    if (!user) {
        console.log('Message from unknown user, ignoring');
        return;
    }

    // Check if user is timed out
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
        timestamp: new Date().toISOString()
    };

    if (channels[channel]) {
        channels[channel].push(chatMessage);
        
        if (channels[channel].length > 100) {
            channels[channel].shift();
        }
        
        console.log(`Message stored. Channel ${channel} now has ${channels[channel].length} messages`);
    } else {
        console.log(`Channel ${channel} not found`);
    }

    const broadcastData = {
        type: 'message',
        message: chatMessage
    };
    
    console.log('Broadcasting message to all clients');
    broadcast(broadcastData);
}

// Handle private chat request
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

    console.log(`Private chat request from ${sender.username} to ${targetUsername}`);

    targetWs.send(JSON.stringify({
        type: 'privateChatRequest',
        from: sender.username,
        requestId: generateId()
    }));
}

// Handle private chat response
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
        const users = [from, responder.username].sort();
        const chatId = `private_${users[0]}_${users[1]}`;

        console.log(`Private chat accepted: ${chatId}`);

        if (!privateChats.has(chatId)) {
            privateChats.set(chatId, []);
        }

        const chatData = {
            type: 'privateChatAccepted',
            chatId: chatId,
            with: responder.username
        };

        requesterWs.send(JSON.stringify(chatData));

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

// Handle private message
function handlePrivateMessage(ws, message) {
    const sender = users.get(ws);
    if (!sender) return;

    // Check if user is timed out
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
        timestamp: new Date().toISOString()
    };

    if (!privateChats.has(chatId)) {
        privateChats.set(chatId, []);
    }
    
    const chatMessages = privateChats.get(chatId);
    chatMessages.push(privateMessage);

    if (chatMessages.length > 100) {
        chatMessages.shift();
    }

    console.log(`Private message from ${sender.username} in ${chatId}`);

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

// Get private chat history
function handleGetPrivateHistory(ws, message) {
    const { chatId } = message;
    console.log(`Private history requested for: ${chatId}`);
    
    const messages = privateChats.get(chatId) || [];
    
    ws.send(JSON.stringify({
        type: 'privateHistory',
        chatId,
        messages
    }));
}

// Get channel history
function handleGetHistory(ws, message) {
    const { channel } = message;
    console.log(`History requested for channel: ${channel}`);
    
    if (channels[channel]) {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: channels[channel]
        }));
        console.log(`Sent ${channels[channel].length} messages for #${channel}`);
    } else {
        ws.send(JSON.stringify({
            type: 'history',
            channel,
            messages: []
        }));
    }
}

// Handle typing indicator
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

// Admin: Kick user
function handleAdminKick(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized'
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
        }, 100);
    }

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'kick',
        target: targetUsername
    }));
}

// Admin: Timeout user
function handleAdminTimeout(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized'
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
    }, duration * 1000);

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'timeout',
        target: targetUsername,
        duration: duration
    }));
}

// Admin: Ban user
function handleAdminBan(ws, message) {
    const admin = users.get(ws);
    if (!admin || !admin.isAdmin) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Unauthorized'
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
        }, 100);
    }

    ws.send(JSON.stringify({
        type: 'adminActionSuccess',
        action: 'ban',
        target: targetUsername
    }));
}

// Helper: Check if user is timed out
function isUserTimedOut(username) {
    if (!timedOutUsers.has(username)) return false;
    
    const timeoutEnd = timedOutUsers.get(username);
    if (Date.now() > timeoutEnd) {
        timedOutUsers.delete(username);
        return false;
    }
    
    return true;
}

// Broadcast user list
function broadcastUserList() {
    const userList = Array.from(users.values()).map(u => u.username);
    
    console.log('Broadcasting user list:', userList);
    
    broadcast({
        type: 'userList',
        users: userList
    });
}

// Broadcast to all clients (except sender if specified)
function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    let sentCount = 0;
    
    wss.clients.forEach((client) => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(data);
            sentCount++;
        }
    });
    
    console.log(`Broadcast sent to ${sentCount} clients`);
}

// Generate unique ID
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// REST API endpoints
app.get('/api/channels', (req, res) => {
    res.json({
        channels: Object.keys(channels)
    });
});

app.get('/api/channels/:channel/messages', (req, res) => {
    const { channel } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    if (channels[channel]) {
        const messages = channels[channel].slice(-limit);
        res.json({ messages });
    } else {
        res.status(404).json({ error: 'Channel not found' });
    }
});

app.post('/api/channels', (req, res) => {
    const { name } = req.body;
    
    if (!name || channels[name]) {
        return res.status(400).json({ error: 'Invalid or duplicate channel name' });
    }
    
    channels[name] = [];
    
    broadcast({
        type: 'channelCreated',
        channel: name
    });
    
    res.json({ success: true, channel: name });
});

// Admin API endpoints
app.get('/api/admin/stats', (req, res) => {
    res.json({
        totalUsers: users.size,
        activeUsers: users.size,
        totalMessages: Object.values(channels).reduce((sum, msgs) => sum + msgs.length, 0),
        totalChannels: Object.keys(channels).length,
        privateChats: privateChats.size,
        bannedUsers: bannedUsers.size,
        timedOutUsers: timedOutUsers.size
    });
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        users: users.size,
        channels: Object.keys(channels).length,
        privateChats: privateChats.size,
        bannedUsers: bannedUsers.size,
        timedOutUsers: timedOutUsers.size
    });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`=================================`);
    console.log(`Server running on port ${PORT}`);
    console.log(`WebSocket server is ready`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
    console.log(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});
