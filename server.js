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
const bannedWords = ['badword', 'spam'];

// Logs & History
let logs = []; 
let generalHistory = [];
const dmRequests = {}; 
const activeDMs = {}; 

// Owner Settings
let spyMode = false;

// --- ROLES ---
const ROLES = {
    OWNER: { pass: "`10owna12", name: "Owner" },
    ADMIN: { pass: "admin-tuff-knuckles", name: "Admin" }
};

io.on('connection', (socket) => {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    if (bannedIPs.includes(clientIp)) {
        socket.emit('forceRedirect', { url: 'https://google.com' });
        socket.disconnect(true);
        return;
    }

    // --- JOIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim().substring(0, 15);
        if (!name || bannedUsernames.has(name.toLowerCase())) return socket.emit('toast', 'Invalid Name');
        
        let role = 'User';
        if (data.password === ROLES.OWNER.pass) role = 'Owner';
        else if (data.password === ROLES.ADMIN.pass) role = 'Admin';

        users[socket.id] = { id: socket.id, name, role, ip: clientIp, isMuted: false };
        activeDMs[socket.id] = []; 
        dmRequests[socket.id] = [];

        socket.emit('loginSuccess', { user: sanitize(users[socket.id]) });
        socket.emit('loadGeneral', generalHistory);
        broadcastUserList();
        
        addLog('JOIN', `${name} joined as ${role}`, clientIp);
        if (role === 'Owner') syncOwner();
    });

    // --- CHAT ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim() || user.isMuted) return;

        const msg = { 
            id: Date.now(), 
            user: user.name, 
            text: filterWords(data.text), 
            role: user.role, // VITAL: Sending role with message
            timestamp: getTime() 
        };
        
        generalHistory.push(msg);
        if(generalHistory.length > 200) generalHistory.shift();
        
        io.emit('message', msg);
    });

    // --- DM HANDLING ---
    socket.on('requestDM', (targetId) => {
        const sender = users[socket.id];
        if(!sender) return;
        
        // Auto-add to lists (Simplified flow per request)
        if(!activeDMs[socket.id]) activeDMs[socket.id] = [];
        if(!activeDMs[targetId]) activeDMs[targetId] = [];

        if(!activeDMs[socket.id].includes(targetId)) activeDMs[socket.id].push(targetId);
        
        // Notify target
        io.to(targetId).emit('dmRequest', { fromId: socket.id, name: sender.name });
    });

    socket.on('dmMessage', (data) => {
        const sender = users[socket.id];
        const target = users[data.targetId];
        
        if(!sender || !target) return;

        const payload = { 
            from: sender.name, 
            fromId: sender.id, 
            text: filterWords(data.text), 
            role: sender.role, // Send role in DMs too
            timestamp: getTime() 
        };

        io.to(target.id).emit('dmReceived', payload);
        socket.emit('dmSent', { ...payload, toId: target.id });

        if(spyMode) {
            const spyMsg = `[SPY] ${sender.name} (${sender.role}) -> ${target.name}: ${data.text}`;
            Object.values(users).forEach(u => {
                if(u.role === 'Owner') io.to(u.id).emit('spyMessage', spyMsg);
            });
        }
    });

    // --- ADMIN ---
    socket.on('adminAction', (data) => {
        const actor = users[socket.id];
        if (!actor || (actor.role !== 'Admin' && actor.role !== 'Owner')) return;

        if (data.type === 'nuke' && actor.role === 'Owner') {
            generalHistory = [];
            io.emit('chatNuked');
            addLog('NUKE', `Chat wiped by ${actor.name}`, actor.ip);
        }
        else if (data.type === 'toggleSpy' && actor.role === 'Owner') {
            spyMode = !spyMode;
            syncOwner();
        }
        else if (data.type === 'manualBan' && actor.role === 'Owner') {
            bannedIPs.push(data.ip);
            addLog('BAN', `Manual Ban: ${data.ip}`, actor.ip);
            syncOwner();
        }
        else if (data.type === 'unbanIP' && actor.role === 'Owner') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            syncOwner();
        }
    });

    socket.on('disconnect', () => {
        if(users[socket.id]) {
            delete users[socket.id];
            delete activeDMs[socket.id];
            broadcastUserList();
        }
    });

    function broadcastUserList() { io.emit('userList', Object.values(users).map(sanitize)); }
    function sanitize(u) { return { id: u.id, name: u.name, role: u.role }; }
    function filterWords(t) { return bannedWords.reduce((acc, w) => acc.replace(new RegExp(`\\b${w}\\b`,'gi'), '***'), t); }
    function getTime() { return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
    
    function addLog(type, text, ip) {
        logs.unshift({ id: Date.now(), type, text, ip, time: getTime() });
        if(logs.length > 50) logs.pop();
        syncOwner();
    }

    function syncOwner() { 
        Object.values(users).forEach(u => { 
            if(u.role==='Owner') io.to(u.id).emit('ownerData', { bannedIPs, logs, spyMode }); 
        }); 
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Onyx V4: ${PORT}`));
