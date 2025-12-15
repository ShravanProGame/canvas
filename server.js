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

// --- DATA ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];
const channelHistory = { 'general': [] };

// --- ROLES ---
const ROLES = {
    OWNER: { pass: "`10owna12", name: "Owner" },
    ADMIN: { pass: "admin-tuff-knuckles", name: "Admin" },
    VIP:   { pass: "very-important-person", name: "VIP" }
};

io.on('connection', (socket) => {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    if (bannedIPs.includes(clientIp)) {
        socket.emit('forceRedirect', { url: 'https://google.com', by: 'SYSTEM_FIREWALL' });
        socket.disconnect(true);
        return;
    }

    // --- JOIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim().substring(0, 15);
        if (!name) return socket.emit('toast', {type:'error', msg:'Name required.'});
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('toast', {type:'error', msg:'Name banned.'});
        
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) return socket.emit('toast', {type:'error', msg:'Name taken.'});

        let role = 'User';
        if (data.password === ROLES.OWNER.pass) role = 'Owner';
        else if (data.password === ROLES.ADMIN.pass) role = 'Admin';
        else if (data.password === ROLES.VIP.pass) role = 'VIP';

        users[socket.id] = { id: socket.id, name: name, role: role, ip: clientIp, isMuted: false };

        socket.emit('loginSuccess', { user: sanitize(users[socket.id]) });
        socket.emit('loadHistory', channelHistory['general']);
        broadcastUserList();

        if (role === 'Owner') socket.emit('ownerData', { bannedIPs, bannedWords });
    });

    // --- TYPING ---
    socket.on('typing', (isTyping) => {
        const u = users[socket.id];
        if(u) socket.broadcast.emit('typingUpdate', { user: u.name, isTyping });
    });

    // --- CHAT ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;
        if (user.isMuted) return socket.emit('toast', {type:'error', msg:'You are muted.'});

        let text = filterWords(data.text);
        const msg = { 
            id: Date.now(), 
            user: user.name, 
            text, 
            role: user.role, 
            timestamp: new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) 
        };
        
        channelHistory['general'].push(msg);
        if(channelHistory['general'].length > 50) channelHistory['general'].shift();
        io.emit('message', msg);
    });

    // --- DMS ---
    socket.on('dmMessage', (data) => {
        const sender = users[socket.id];
        const target = users[data.targetId];
        if(sender && target && data.text) {
             const payload = { from: sender.name, fromId: sender.id, text: filterWords(data.text), timestamp: new Date().toLocaleTimeString() };
             io.to(target.id).emit('dmReceived', payload);
             socket.emit('dmSent', { ...payload, toId: target.id });
        }
    });

    // --- ADMIN ---
    socket.on('adminAction', (data) => {
        const actor = users[socket.id];
        const target = users[data.targetId];
        if (!actor || !target) return;
        if (actor.role !== 'Admin' && actor.role !== 'Owner') return;
        if (target.role === 'Owner') return socket.emit('toast', {type:'error', msg:'Cannot touch Owner.'});

        switch(data.type) {
            case 'kick':
                io.to(target.id).emit('forceRedirect', { url: 'https://google.com', by: actor.name });
                io.sockets.sockets.get(target.id)?.disconnect(true);
                break;
            case 'mute':
                target.isMuted = !target.isMuted;
                socket.emit('toast', {type:'info', msg: `User ${target.isMuted ? 'Muted' : 'Unmuted'}`});
                break;
            case 'ban': 
                bannedIPs.push(target.ip);
                bannedUsernames.add(target.name.toLowerCase());
                io.to(target.id).emit('forceRedirect', { url: 'https://google.com', by: actor.name + ' (BAN)' });
                io.sockets.sockets.get(target.id)?.disconnect(true);
                updateOwner();
                break;
            case 'redirect':
                if (actor.role === 'Owner' && data.url) {
                    io.to(target.id).emit('forceRedirect', { url: data.url, by: actor.name });
                }
                break;
        }
    });

    socket.on('getIp', (id) => {
        if(users[socket.id]?.role === 'Owner' && users[id]) {
            socket.emit('ipResult', { name: users[id].name, ip: users[id].ip });
        }
    });

    function broadcastUserList() { io.emit('userList', Object.values(users).map(sanitize)); }
    function sanitize(u) { return { id: u.id, name: u.name, role: u.role }; }
    function filterWords(t) { return bannedWords.reduce((acc, w) => acc.replace(new RegExp(`\\b${w}\\b`,'gi'), '***'), t); }
    function updateOwner() { Object.values(users).forEach(u => { if(u.role==='Owner') socket.emit('ownerData', { bannedIPs, bannedWords }); }); }

    socket.on('disconnect', () => { if(users[socket.id]) { delete users[socket.id]; broadcastUserList(); } });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Onyx Server: ${PORT}`));
