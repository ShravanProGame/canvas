const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- STATE ---
const users = {};
// Banned IPs stored as an array for easier management by Owner
let bannedIPs = []; 
const bannedUsernames = new Set();
// Message history per channel
const channelHistory = {
    'bridge': [],
    'holodeck': [],
    'simulation': []
};
let bannedWords = ['badword', 'spam'];

function getIp(socket) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) return forwarded.split(',')[0].trim();
    return socket.handshake.address;
}

function getTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

io.on('connection', (socket) => {
    const clientIp = getIp(socket);

    // IP Ban Check
    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'TERMINAL LOCKED: IP BLACKLISTED.');
        socket.disconnect(true);
        return;
    }

    // --- LOGIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        if (!name) return socket.emit('loginError', 'Identity required.');
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Identity banned.');
        
        // Duplicate Check
        if (Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase())) {
            return socket.emit('loginError', 'Identity already active.');
        }

        // Role Logic
        let role = 'User';
        if (data.password === 'owner999') role = 'Owner';
        else if (data.password === 'admin123') role = 'Admin';
        else if (data.password === 'very-important-person') role = 'VIP';

        users[socket.id] = {
            id: socket.id,
            name: name,
            role: role,
            ip: clientIp, // Stored for Owner to see
            status: 'Active'
        };

        socket.emit('loginSuccess', { user: users[socket.id] });
        
        // Load history for the default channel (Bridge)
        socket.emit('loadHistory', channelHistory['bridge']);
        
        // Send ban list to Owner immediately if applicable
        if (role === 'Owner') socket.emit('updateBanList', bannedIPs);

        io.emit('userList', Object.values(users));
        
        // System Welcome
        io.emit('message', {
            channel: 'bridge',
            user: 'SYSTEM',
            text: `${name} has linked to the Neural Net.`,
            role: 'System',
            timestamp: getTime()
        });
    });

    // --- CHAT & TYPING ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        const { text, channel } = data;
        let finalText = text;

        // Filter
        bannedWords.forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            finalText = finalText.replace(regex, '***');
        });

        const msgObj = {
            user: user.name,
            text: finalText,
            role: user.role,
            channel: channel,
            timestamp: getTime()
        };

        // Save History per channel
        if (channelHistory[channel]) {
            channelHistory[channel].push(msgObj);
            if (channelHistory[channel].length > 50) channelHistory[channel].shift();
        }

        io.emit('message', msgObj);
    });

    socket.on('typing', (channel) => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('userTyping', { user: user.name, channel: channel });
    });

    socket.on('stopTyping', (channel) => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('userStopTyping', { user: user.name, channel: channel });
    });

    socket.on('switchChannel', (channel) => {
        // Send history for the new channel
        if (channelHistory[channel]) {
            socket.emit('loadHistory', channelHistory[channel]);
        }
    });

    // --- DM SYSTEM ---
    socket.on('dmRequest', (targetId) => {
        const sender = users[socket.id];
        if (users[targetId]) {
            io.to(targetId).emit('incomingDMRequest', { fromId: socket.id, name: sender.name });
        }
    });

    socket.on('dmAccepted', (targetId) => {
        const me = users[socket.id];
        const them = users[targetId];
        if (me && them) {
            io.to(targetId).emit('dmStart', { withId: socket.id, name: me.name });
            socket.emit('dmStart', { withId: targetId, name: them.name });
        }
    });

    socket.on('privateMessage', ({ to, text }) => {
        const sender = users[socket.id];
        if (users[to]) {
            const msgData = { fromId: socket.id, name: sender.name, text, timestamp: getTime() };
            io.to(to).emit('privateMsgReceive', msgData);
            socket.emit('privateMsgReceive', msgData);
        }
    });

    // --- OWNER & ADMIN ACTIONS ---
    socket.on('ownerAction', (data) => {
        const owner = users[socket.id];
        if (!owner || owner.role !== 'Owner') return;

        if (data.type === 'getDetails') {
            const targetUser = users[data.targetId];
            if (targetUser) {
                socket.emit('userDetails', targetUser);
            }
        }
        if (data.type === 'unbanIP') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            socket.emit('updateBanList', bannedIPs); // Refresh owner list
            socket.emit('adminMessage', `IP ${data.ip} removed from blacklist.`);
        }
    });

    socket.on('adminAction', (data) => {
        const admin = users[socket.id];
        if (!admin || (admin.role !== 'Admin' && admin.role !== 'Owner')) return;

        if (data.type === 'ban_user') {
            const targetId = Object.keys(users).find(id => users[id].name === data.targetName);
            if (targetId) {
                const targetUser = users[targetId];
                bannedUsernames.add(targetUser.name.toLowerCase());
                if (!bannedIPs.includes(targetUser.ip)) {
                    bannedIPs.push(targetUser.ip);
                }
                
                io.sockets.sockets.get(targetId)?.disconnect(true);
                io.emit('userList', Object.values(users));
                io.emit('message', { channel: 'bridge', user: 'SYSTEM', text: `JUDGMENT: ${data.targetName} exiled.`, role: 'System', timestamp: getTime() });
                
                // Update owner lists if connected
                Object.values(users).forEach(u => {
                    if (u.role === 'Owner') {
                        io.to(u.id).emit('updateBanList', bannedIPs);
                    }
                });
            }
        }
        if (data.type === 'announce') {
            io.emit('announcement', { text: data.text, sender: admin.name });
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            io.emit('userList', Object.values(users));
        }
    });
});

server.listen(3000, () => {
    console.log('Galactic Node Online: http://localhost:3000');
});
