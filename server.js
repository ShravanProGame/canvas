const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
});

app.use(express.static(path.join(__dirname, 'public')));

// --- DATA & CONFIG ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];
const serverStats = { startTime: Date.now(), totalMessages: 0 };
const ROLES = {
    OWNER: { pass: "`10owna12", name: "Owner" },
    ADMIN: { pass: "admin-tuff-knuckles", name: "Admin" },
    VIP:   { pass: "very-important-person", name: "VIP" }
};

io.on('connection', (socket) => {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'CONNECTION REFUSED: IP BANNED.');
        socket.disconnect(true);
        return;
    }

    // --- JOIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        if (!name) return socket.emit('loginError', 'Name required.');
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Name banned.');
        
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) return socket.emit('loginError', 'Name taken.');

        let role = 'User';
        if (data.password === ROLES.OWNER.pass) role = 'Owner';
        else if (data.password === ROLES.ADMIN.pass) role = 'Admin';
        else if (data.password === ROLES.VIP.pass) role = 'VIP';

        users[socket.id] = { 
            id: socket.id, 
            name: name, 
            role: role, 
            ip: clientIp, 
            isMuted: false 
        };

        socket.emit('loginSuccess', { user: sanitizeUser(users[socket.id]) });
        broadcastUserList(); // Update everyone's list
        
        // Owner Data Sync
        if (role === 'Owner') {
            socket.emit('ownerDataUpdate', { bannedIPs, bannedWords, stats: getStats() });
        }
    });

    // --- MESSAGING ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;
        if (user.isMuted) return socket.emit('sysErr', 'You are muted.');

        serverStats.totalMessages++;
        
        let finalText = filterWords(data.text);

        const msgObj = { 
            user: user.name, 
            text: finalText, 
            role: user.role, 
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        io.emit('message', msgObj);
    });

    // --- PRIVATE MESSAGES (DMs) ---
    socket.on('dmMessage', (data) => {
        const sender = users[socket.id];
        const target = users[data.targetId];

        if(sender && target && data.text) {
             const payload = {
                 from: sender.name,
                 fromId: sender.id,
                 text: filterWords(data.text),
                 timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
             };
             // Send to Target
             io.to(target.id).emit('dmReceived', payload);
             // Send back to Sender (so they see it too)
             socket.emit('dmSent', { ...payload, toId: target.id });
        }
    });

    // --- ADMIN / OWNER ACTIONS ---
    socket.on('adminAction', (data) => {
        const actor = users[socket.id];
        if (!actor || (actor.role !== 'Admin' && actor.role !== 'Owner')) return;
        
        const target = users[data.targetId];
        if (!target) return;

        // PROTECTION: Admins cannot ban Admins/Owners. Owners cannot ban Owners.
        if (target.role === 'Owner') return socket.emit('sysErr', 'Access Denied: Target is Owner.');
        if (actor.role === 'Admin' && target.role === 'Admin') return socket.emit('sysErr', 'Access Denied: Target is Admin.');

        switch(data.type) {
            case 'kick':
                io.to(target.id).emit('banAlert', `You were KICKED by ${actor.name}.`);
                io.sockets.sockets.get(target.id)?.disconnect(true);
                break;
            case 'mute':
                target.isMuted = !target.isMuted;
                io.to(target.id).emit('sysErr', target.isMuted ? `Muted by ${actor.name}.` : `Unmuted by ${actor.name}.`);
                break;
            case 'timeout':
                io.to(target.id).emit('sysErr', `Timed out (60s) by ${actor.name}.`);
                break;
            case 'ban': 
                bannedIPs.push(target.ip);
                bannedUsernames.add(target.name.toLowerCase());
                io.to(target.id).emit('banAlert', `You were BANNED by ${actor.name}.`);
                io.sockets.sockets.get(target.id)?.disconnect(true);
                break;
            case 'redirect':
                // RESTRICTION: Only Owner can redirect
                if (actor.role === 'Owner' && data.url) {
                    io.to(target.id).emit('forceRedirect', { url: data.url, by: actor.name });
                } else {
                    socket.emit('sysErr', 'Only Owners can redirect.');
                }
                break;
        }
    });

    // --- OWNER SPECIFIC: GET IP ---
    socket.on('getIp', (targetId) => {
        const requestor = users[socket.id];
        const target = users[targetId];
        if(requestor && requestor.role === 'Owner' && target) {
            socket.emit('ipReveal', { id: target.id, ip: target.ip });
        }
    });

    // --- HELPERS ---
    function broadcastUserList() {
        // Send a sanitized list to everyone (No IPs)
        const safeList = Object.values(users).map(sanitizeUser);
        io.emit('userList', safeList);
    }

    function sanitizeUser(u) {
        return { id: u.id, name: u.name, role: u.role, isMuted: u.isMuted };
    }

    function filterWords(text) {
        let t = text;
        bannedWords.forEach(w => {
            const r = new RegExp(`\\b${w}\\b`, 'gi');
            t = t.replace(r, '***');
        });
        return t;
    }
    
    function getStats() {
        return { uptime: Math.floor((Date.now() - serverStats.startTime)/1000), totalMsg: serverStats.totalMessages };
    }

    socket.on('disconnect', () => {
        if (users[socket.id]) {
            delete users[socket.id];
            broadcastUserList();
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Node Active: ${PORT}`));
