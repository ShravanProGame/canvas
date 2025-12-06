const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    cors: { origin: "*" } // Allow connection from about:blank
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- STATE ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];

// Stats
const serverStats = { startTime: Date.now(), totalMessages: 0 };
const channelHistory = { 'general': [], 'gaming': [], 'memes': [] };

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
        
        if (Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase())) {
            return socket.emit('loginError', 'Identity already active.');
        }

        let role = 'User';
        if (data.password === 'owner999') role = 'Owner';
        else if (data.password === 'admin123') role = 'Admin';
        else if (data.password === 'very-important-person') role = 'VIP';

        users[socket.id] = {
            id: socket.id,
            name: name,
            role: role,
            ip: clientIp,
            isMuted: false,
            timeoutUntil: null,
            status: 'Online'
        };

        socket.emit('loginSuccess', { user: users[socket.id] });
        socket.emit('loadHistory', channelHistory['general']); 
        
        if (role === 'Owner') socket.emit('ownerData', { bannedIPs, stats: getStats() });

        io.emit('userList', Object.values(users));
        
        io.emit('message', {
            channel: 'general',
            user: 'SYSTEM',
            text: `${name} has connected.`,
            role: 'System',
            timestamp: getTime()
        });
    });

    // --- CHAT ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        if (user.isMuted) return socket.emit('sysErr', 'You are muted.');
        if (user.timeoutUntil && Date.now() < user.timeoutUntil) {
            return socket.emit('sysErr', `Timeout active.`);
        } else if (user.timeoutUntil) user.timeoutUntil = null;

        serverStats.totalMessages++;
        const { text, channel } = data;
        let finalText = text;

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

        if (channelHistory[channel]) {
            channelHistory[channel].push(msgObj);
            if (channelHistory[channel].length > 50) channelHistory[channel].shift();
        }

        io.emit('message', msgObj);
    });

    socket.on('typing', (channel) => {
        const user = users[socket.id];
        if (user) socket.broadcast.emit('userTyping', { user: user.name, channel });
    });
    socket.on('stopTyping', (channel) => socket.broadcast.emit('userStopTyping', { channel }));
    socket.on('switchChannel', (channel) => {
        if (channelHistory[channel]) socket.emit('loadHistory', channelHistory[channel]);
    });

    // --- DM ---
    socket.on('dmRequest', (targetId) => {
        const sender = users[socket.id];
        if (users[targetId]) io.to(targetId).emit('incomingDMRequest', { fromId: socket.id, name: sender.name });
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

    // --- ADMIN / OWNER ACTIONS ---
    socket.on('adminAction', (data) => {
        const admin = users[socket.id];
        if (!admin || (admin.role !== 'Admin' && admin.role !== 'Owner')) return;
        const target = users[data.targetId];

        switch (data.type) {
            case 'kick':
                if (target) {
                    io.to(target.id).emit('banAlert', 'YOU HAVE BEEN EJECTED.');
                    io.sockets.sockets.get(target.id)?.disconnect(true);
                    sysBroadcast(`User ${target.name} was ejected.`);
                }
                break;
            case 'mute':
                if (target) {
                    target.isMuted = !target.isMuted;
                    socket.emit('sysMsg', `${target.name} mute: ${target.isMuted}`);
                }
                break;
            case 'timeout':
                if (target) {
                    target.timeoutUntil = Date.now() + 60000;
                    io.to(target.id).emit('sysErr', 'Timeout: 60s.');
                    socket.emit('sysMsg', `${target.name} timed out.`);
                }
                break;
            case 'ban_user':
                if (target) {
                    bannedUsernames.add(target.name.toLowerCase());
                    if (!bannedIPs.includes(target.ip)) bannedIPs.push(target.ip);
                    io.to(target.id).emit('banAlert', 'PERMANENT EXILE.');
                    io.sockets.sockets.get(target.id)?.disconnect(true);
                    sysBroadcast(`JUDGMENT: ${target.name} exiled.`);
                    updateOwnerStats();
                }
                break; 
            case 'announce':
                io.emit('announcement', { text: data.text, sender: admin.name });
                break;
        }
        io.emit('userList', Object.values(users));
    });

    socket.on('ownerAction', (data) => {
        const owner = users[socket.id];
        if (!owner || owner.role !== 'Owner') return;
        const target = users[data.targetId];

        if (data.type === 'redirect' && target) {
            io.to(target.id).emit('forceRedirect', data.url);
            socket.emit('sysMsg', `Redirecting ${target.name} to ${data.url}`);
        }
        if (data.type === 'effect' && target) {
            io.to(target.id).emit('applyEffect', data.effect);
            socket.emit('sysMsg', `Applied ${data.effect} to ${target.name}`);
        }
        if (data.type === 'getStats') socket.emit('ownerData', { bannedIPs, stats: getStats() });
        if (data.type === 'unbanIP') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            socket.emit('updateBanList', bannedIPs);
        }
        if (data.type === 'getDetails' && target) socket.emit('userDetails', target);
    });

    function sysBroadcast(text) {
        io.emit('message', { channel: 'general', user: 'SYSTEM', text, role: 'System', timestamp: getTime() });
    }

    function getStats() {
        return { uptime: Math.floor((Date.now() - serverStats.startTime) / 1000), totalMsg: serverStats.totalMessages, userCount: Object.keys(users).length };
    }
    function updateOwnerStats() {
        Object.values(users).forEach(u => { if (u.role === 'Owner') io.to(u.id).emit('ownerData', { bannedIPs, stats: getStats() }); });
    }
    setInterval(updateOwnerStats, 5000);

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) { delete users[socket.id]; io.emit('userList', Object.values(users)); }
    });
});

server.listen(3000, () => { console.log('Galactic Node Online: http://localhost:3000'); });
