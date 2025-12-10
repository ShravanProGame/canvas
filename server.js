const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enable CORS so the 'about:blank' window can connect
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000
});

// Serve files from the 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// --- DATA STORE ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];
const spamMap = {}; 
const serverStats = { startTime: Date.now(), totalMessages: 0 };
const channelHistory = { 'general': [], 'gaming': [], 'memes': [] };

function getTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

io.on('connection', (socket) => {
    // Basic IP Handling
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    // Check Ban
    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'TERMINAL LOCKED: IP BLACKLISTED.');
        socket.disconnect(true);
        return;
    }

    console.log(`Connection attempt: ${socket.id}`);

    // --- LOGIN LOGIC ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        
        if (!name) return socket.emit('loginError', 'Identity required.');
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Identity banned.');
        
        // Duplicate check
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) return socket.emit('loginError', 'Identity already active.');

        // Role Check
        let role = 'User';
        if (data.password === 'owner999') role = 'Owner';
        else if (data.password === 'admin123') role = 'Admin';
        else if (data.password === 'very-important-person') role = 'VIP';

        // Create User
        users[socket.id] = { id: socket.id, name: name, role: role, ip: clientIp, isMuted: false, timeoutUntil: null, status: 'Online' };
        spamMap[socket.id] = { count: 0, lastMsg: Date.now() };

        // Send success to client
        socket.emit('loginSuccess', { user: users[socket.id] });
        socket.emit('loadHistory', channelHistory['general']);
        
        // If Owner, send admin data
        if (role === 'Owner') socket.emit('ownerData', { bannedIPs, bannedWords, stats: getStats() });

        // Broadcast join
        io.emit('userList', Object.values(users));
        io.emit('message', { channel: 'general', user: 'SYSTEM', text: `${name} has connected.`, role: 'System', timestamp: getTime() });
    });

    // --- CHAT LOGIC ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        if (user.isMuted) return socket.emit('sysErr', 'You are muted.');
        if (user.timeoutUntil) {
            if (Date.now() < user.timeoutUntil) return socket.emit('sysErr', `Timed out.`);
            user.timeoutUntil = null;
        }

        // Anti-Spam
        const now = Date.now();
        if (!spamMap[socket.id]) spamMap[socket.id] = { count: 0, lastMsg: now };
        
        if (now - spamMap[socket.id].lastMsg < 2000) spamMap[socket.id].count++;
        else spamMap[socket.id].count = 1;
        spamMap[socket.id].lastMsg = now;

        if (spamMap[socket.id].count > 5) {
            user.timeoutUntil = Date.now() + 30000;
            spamMap[socket.id].count = 0;
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

    // --- OWNER/ADMIN ACTIONS ---
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

    // --- HELPERS ---
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
