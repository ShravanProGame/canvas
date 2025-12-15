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

// --- DATA STORE ---
const users = {};
let bannedIPs = []; 
const bannedUsernames = new Set();
let bannedWords = ['badword', 'spam'];
const logs = [];

// Chat History
const generalHistory = []; // Stores general chat
const dmRequests = {}; // { targetId: [senderId, senderId...] }
const activeDMs = {}; // { userId: [friendId, friendId...] }

const SPAM_LIMIT = 5;
const SPAM_WINDOW = 3000;

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
        socket.emit('forceRedirect', { url: 'https://google.com', by: 'FIREWALL' });
        socket.disconnect(true);
        return;
    }

    socket.msgCount = 0;
    socket.lastMsgTime = Date.now();

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
        activeDMs[socket.id] = []; 
        dmRequests[socket.id] = [];

        socket.emit('loginSuccess', { user: sanitize(users[socket.id]) });
        socket.emit('loadGeneral', generalHistory); // Send history on login
        broadcastUserList();
        
        addLog('JOIN', `${name} joined [${role}]`, clientIp);

        if (role === 'Owner') socket.emit('ownerData', { bannedIPs, bannedWords, logs });
    });

    // --- CHAT (GENERAL) ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;
        if (user.isMuted) return socket.emit('toast', {type:'error', msg:'You are muted.'});
        if (checkSpam(socket)) return;

        let text = filterWords(data.text);
        const msg = { 
            id: Date.now(), 
            user: user.name, 
            text, 
            role: user.role, 
            timestamp: getTime() 
        };
        
        generalHistory.push(msg);
        if(generalHistory.length > 100) generalHistory.shift();
        
        io.emit('message', msg);
    });

    // --- DM LOGIC (REQUEST SYSTEM) ---
    socket.on('requestDM', (targetId) => {
        const sender = users[socket.id];
        const target = users[targetId];
        if(!sender || !target) return;

        // If already friends, just open it
        if(activeDMs[socket.id].includes(targetId)) {
            socket.emit('dmOpen', { targetId: targetId, name: target.name });
            return;
        }

        // Send Request
        if(!dmRequests[targetId]) dmRequests[targetId] = [];
        if(!dmRequests[targetId].includes(socket.id)) {
            dmRequests[targetId].push(socket.id);
            io.to(targetId).emit('dmRequestReceived', { fromId: socket.id, name: sender.name });
            socket.emit('toast', {type:'info', msg: `Request sent to ${target.name}`});
        }
    });

    socket.on('respondDM', (data) => {
        // data = { targetId, accept: true/false }
        const responder = users[socket.id];
        const requester = users[data.targetId];
        
        // Remove from pending
        if(dmRequests[socket.id]) {
            dmRequests[socket.id] = dmRequests[socket.id].filter(id => id !== data.targetId);
        }

        if(data.accept) {
            // Add to active lists for BOTH
            if(!activeDMs[socket.id].includes(data.targetId)) activeDMs[socket.id].push(data.targetId);
            if(!activeDMs[data.targetId]) activeDMs[data.targetId] = [];
            if(!activeDMs[data.targetId].includes(socket.id)) activeDMs[data.targetId].push(socket.id);

            // Notify both
            socket.emit('dmAccepted', { withId: data.targetId, name: requester.name });
            io.to(data.targetId).emit('dmAccepted', { withId: socket.id, name: responder.name });
        } else {
            io.to(data.targetId).emit('toast', { type:'error', msg: `${responder.name} declined your DM.` });
        }
    });

    socket.on('dmMessage', (data) => {
        const sender = users[socket.id];
        const target = users[data.targetId];
        
        // Security: Ensure they are "friends" (accepted DM)
        if(!activeDMs[socket.id]?.includes(data.targetId)) {
            return socket.emit('toast', {type:'error', msg:'DM not accepted.'});
        }

        if(sender && target && data.text) {
             const payload = { from: sender.name, fromId: sender.id, text: filterWords(data.text), timestamp: getTime() };
             io.to(target.id).emit('dmReceived', payload);
             socket.emit('dmSent', { ...payload, toId: target.id });
        }
    });

    // --- ADMIN / OWNER ACTIONS ---
    socket.on('adminAction', (data) => {
        const actor = users[socket.id];
        if (!actor || (actor.role !== 'Admin' && actor.role !== 'Owner')) return;

        if (data.type === 'manualBan' && actor.role === 'Owner') {
            bannedIPs.push(data.ip);
            addLog('BAN', `Manual IP Ban by ${actor.name}`, data.ip);
            updateOwner();
            Object.values(users).forEach(u => {
                if(u.ip === data.ip) {
                    io.to(u.id).emit('forceRedirect', { url: 'https://google.com', by: 'Owner' });
                    io.sockets.sockets.get(u.id)?.disconnect(true);
                }
            });
            return;
        }

        if (data.type === 'unbanIP' && actor.role === 'Owner') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            addLog('UNBAN', `IP Unbanned by ${actor.name}`, data.ip);
            updateOwner();
            return;
        }

        const target = users[data.targetId];
        if (!target) return;
        if (target.role === 'Owner') return socket.emit('toast', {type:'error', msg:'Cannot touch Owner.'});

        switch(data.type) {
            case 'kick':
                io.to(target.id).emit('forceRedirect', { url: 'https://google.com', by: actor.name });
                io.sockets.sockets.get(target.id)?.disconnect(true);
                addLog('KICK', `${target.name} kicked by ${actor.name}`, target.ip);
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
                addLog('BAN', `${target.name} banned by ${actor.name}`, target.ip);
                updateOwner();
                break;
            case 'redirect':
                if (actor.role === 'Owner' && data.url) {
                    io.to(target.id).emit('forceRedirect', { url: data.url, by: actor.name });
                    addLog('REDIR', `${target.name} redirected by ${actor.name}`, target.ip);
                }
                break;
        }
    });

    socket.on('getIp', (id) => {
        if(users[socket.id]?.role === 'Owner' && users[id]) {
            socket.emit('ipResult', { name: users[id].name, ip: users[id].ip });
        }
    });

    socket.on('disconnect', () => {
        const u = users[socket.id];
        if(u) {
            addLog('LEAVE', `${u.name} disconnected`, u.ip);
            delete users[socket.id];
            delete activeDMs[socket.id];
            delete dmRequests[socket.id];
            broadcastUserList();
        }
    });

    function broadcastUserList() { io.emit('userList', Object.values(users).map(sanitize)); }
    function sanitize(u) { return { id: u.id, name: u.name, role: u.role }; }
    function filterWords(t) { return bannedWords.reduce((acc, w) => acc.replace(new RegExp(`\\b${w}\\b`,'gi'), '***'), t); }
    function getTime() { return new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }
    
    function checkSpam(socket) {
        const now = Date.now();
        if (now - socket.lastMsgTime < SPAM_WINDOW) {
            socket.msgCount++;
            if (socket.msgCount > SPAM_LIMIT) {
                users[socket.id].isMuted = true;
                socket.emit('toast', {type:'error', msg:'Spam mute (20s).'});
                setTimeout(() => { users[socket.id].isMuted = false; }, 20000);
                return true;
            }
        } else {
            socket.msgCount = 1;
            socket.lastMsgTime = now;
        }
        return false;
    }

    function addLog(type, text, ip) {
        logs.unshift({ type, text, ip, time: getTime() });
        if(logs.length > 50) logs.pop();
        updateOwner();
    }

    function updateOwner() { 
        Object.values(users).forEach(u => { 
            if(u.role==='Owner') io.to(u.id).emit('ownerData', { bannedIPs, bannedWords, logs }); 
        }); 
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`iOS Node: ${PORT}`));
