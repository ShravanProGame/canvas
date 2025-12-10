const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

// --- STATE ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];
const spamMap = {}; 
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

// Serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {
    const clientIp = getIp(socket);

    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'TERMINAL LOCKED: IP BLACKLISTED.');
        socket.disconnect(true);
        return;
    }

    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        if (!name || bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Identity denied.');
        if (Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase())) return socket.emit('loginError', 'Identity active.');

        let role = 'User';
        if (data.password === 'owner999') role = 'Owner';
        else if (data.password === 'admin123') role = 'Admin';
        else if (data.password === 'very-important-person') role = 'VIP';

        users[socket.id] = { id: socket.id, name: name, role: role, ip: clientIp, isMuted: false, timeoutUntil: null, status: 'Online' };
        spamMap[socket.id] = { count: 0, lastMsg: Date.now() };

        socket.emit('loginSuccess', { user: users[socket.id] });
        socket.emit('loadHistory', channelHistory['general']);
        if (role === 'Owner') socket.emit('ownerData', { bannedIPs, bannedWords, stats: getStats() });
        io.emit('userList', Object.values(users));
        
        io.emit('message', { channel: 'general', user: 'SYSTEM', text: `${name} has connected.`, role: 'System', timestamp: getTime() });
    });

    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        if (user.isMuted) return socket.emit('sysErr', 'You are muted.');
        if (user.timeoutUntil) {
            if (Date.now() < user.timeoutUntil) return socket.emit('sysErr', `Timed out.`);
            else user.timeoutUntil = null;
        }

        const now = Date.now();
        const spam = spamMap[socket.id];
        if (now - spam.lastMsg < 2000) spam.count++; else spam.count = 1;
        spam.lastMsg = now;

        if (spam.count > 5) {
            user.timeoutUntil = Date.now() + 30000;
            spam.count = 0;
            io.to(socket.id).emit('sysErr', 'ANTI-SPAM: Timed out for 30s.');
            return;
        }

        serverStats.totalMessages++;
        let finalText = data.text;
        bannedWords.forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            finalText = finalText.replace(regex, '***');
        });

        const msgObj = { user: user.name, text: finalText, role: user.role, channel: data.channel, timestamp: getTime() };
        if (channelHistory[data.channel]) {
            channelHistory[data.channel].push(msgObj);
            if (channelHistory[data.channel].length > 50) channelHistory[data.channel].shift();
        }
        io.emit('message', msgObj);
    });

    socket.on('typing', (data) => {
        const user = users[socket.id];
        if(!user) return;
        if (data.targetId) io.to(data.targetId).emit('dmTyping', { fromId: socket.id });
        else socket.broadcast.emit('userTyping', { user: user.name, channel: data.channel });
    });

    socket.on('stopTyping', (data) => {
        if (data.targetId) io.to(data.targetId).emit('dmStopTyping', { fromId: socket.id });
        else socket.broadcast.emit('userStopTyping', { channel: data.channel });
    });

    socket.on('switchChannel', (channel) => {
        if (channelHistory[channel]) socket.emit('loadHistory', channelHistory[channel]);
    });

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

    socket.on('adminAction', (data) => {
        const admin = users[socket.id];
        if (!admin || (admin.role !== 'Admin' && admin.role !== 'Owner')) return;
        const target = users[data.targetId];

        if (data.type === 'kick' && target) {
            io.to(target.id).emit('banAlert', 'EJECTED.');
            io.sockets.sockets.get(target.id)?.disconnect(true);
        }
        if (data.type === 'mute' && target) {
            target.isMuted = !target.isMuted;
            io.to(target.id).emit('sysErr', target.isMuted ? 'Muted.' : 'Unmuted.');
        }
        if (data.type === 'timeout' && target) {
            target.timeoutUntil = Date.now() + 60000;
            io.to(target.id).emit('sysErr', 'Timeout: 60s.');
        }
        if (data.type === 'ban_user' && target) {
            bannedIPs.push(target.ip);
            bannedUsernames.add(target.name.toLowerCase());
            io.to(target.id).emit('banAlert', 'PERMANENT EXILE.');
            io.sockets.sockets.get(target.id)?.disconnect(true);
            updateOwnerStats();
        }
        if (data.type === 'announce') io.emit('announcement', { text: data.text, sender: admin.name });
    });

    socket.on('ownerAction', (data) => {
        const owner = users[socket.id];
        if (!owner || owner.role !== 'Owner') return;
        const target = users[data.targetId];

        if (data.type === 'redirect' && target) io.to(target.id).emit('forceRedirect', data.url);
        if (data.type === 'effect' && target) io.to(target.id).emit('applyEffect', data.effect);
        if (data.type === 'getStats') socket.emit('ownerData', { bannedIPs, bannedWords, stats: getStats() });
        if (data.type === 'banWord') {
            const w = data.word.toLowerCase();
            if (!bannedWords.includes(w)) bannedWords.push(w);
            socket.emit('ownerData', { bannedIPs, bannedWords, stats: getStats() });
        }
        if (data.type === 'unbanIP') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            socket.emit('ownerData', { bannedIPs, bannedWords, stats: getStats() });
        }
        if (data.type === 'getDetails' && target) {
            socket.emit('userDetails', { name: target.name, ip: target.ip, id: target.id, role: target.role });
        }
    });

    function getStats() {
        return { uptime: Math.floor((Date.now() - serverStats.startTime) / 1000), totalMsg: serverStats.totalMessages, userCount: Object.keys(users).length };
    }
    function updateOwnerStats() {
        Object.values(users).forEach(u => { if (u.role === 'Owner') io.to(u.id).emit('ownerData', { bannedIPs, bannedWords, stats: getStats() }); });
    }
    setInterval(updateOwnerStats, 5000);

    socket.on('disconnect', () => { delete users[socket.id]; io.emit('userList', Object.values(users)); });
});

server.listen(3000, () => { console.log('Server Online on Port 3000'); });
