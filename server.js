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
const serverStats = { startTime: Date.now(), totalMessages: 0 };
const channelHistory = { 'general': [], 'gaming': [], 'memes': [] };

// --- CONFIG ---
const ROLES = {
    OWNER: { pass: "`10owna12", name: "Owner" },
    ADMIN: { pass: "admin-tuff-knuckles", name: "Admin" },
    VIP:   { pass: "very-important-person", name: "VIP" }
};

function getTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

io.on('connection', (socket) => {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'TERMINAL LOCKED: IP BLACKLISTED.');
        socket.disconnect(true);
        return;
    }

    console.log(`Connection: ${socket.id} from ${clientIp}`);

    // --- JOIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        
        if (!name) return socket.emit('loginError', 'Identity required.');
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Identity banned.');
        
        // Check duplicate name
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) return socket.emit('loginError', 'Identity already active.');

        // Determine Role
        let role = 'User';
        if (data.password === ROLES.OWNER.pass) role = 'Owner';
        else if (data.password === ROLES.ADMIN.pass) role = 'Admin';
        else if (data.password === ROLES.VIP.pass) role = 'VIP';

        users[socket.id] = { 
            id: socket.id, 
            name: name, 
            role: role, 
            ip: clientIp, 
            isMuted: false, 
            timeoutUntil: null, 
            currentChannel: 'general'
        };

        socket.emit('loginSuccess', { user: users[socket.id] });
        socket.emit('loadHistory', channelHistory['general']);
        
        // Send Owner Data immediately if Owner
        if (role === 'Owner') {
            socket.emit('ownerDataUpdate', { bannedIPs, bannedWords, stats: getStats() });
        }

        io.emit('userList', Object.values(users));
        
        // System Message
        io.emit('message', { 
            channel: 'general', user: 'SYSTEM', text: `${name} detected. Access Level: ${role}`, 
            role: 'System', timestamp: getTime() 
        });
    });

    // --- TYPING INDICATOR ---
    socket.on('typing', (isTyping) => {
        const user = users[socket.id];
        if(user) socket.broadcast.emit('typingUpdate', { user: user.name, isTyping });
    });

    // --- CHAT MESSAGE ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        if (user.isMuted) return socket.emit('sysErr', 'You are muted.');
        if (user.timeoutUntil && Date.now() < user.timeoutUntil) {
            return socket.emit('sysErr', `Timed out until ${new Date(user.timeoutUntil).toLocaleTimeString()}`);
        }

        serverStats.totalMessages++;
        
        // Filter Banned Words
        let finalText = data.text;
        bannedWords.forEach(word => {
            const regex = new RegExp(`\\b${word}\\b`, 'gi');
            finalText = finalText.replace(regex, '***');
        });

        const msgObj = { 
            user: user.name, 
            text: finalText, 
            role: user.role, 
            channel: data.channel || 'general', 
            timestamp: getTime() 
        };
        
        if (channelHistory[msgObj.channel]) {
            channelHistory[msgObj.channel].push(msgObj);
            if (channelHistory[msgObj.channel].length > 50) channelHistory[msgObj.channel].shift();
        }
        
        io.emit('message', msgObj);
    });

    // --- ADMIN / OWNER ACTIONS ---
    socket.on('adminAction', (data) => {
        const actor = users[socket.id];
        // Security Check: Must be Admin or Owner
        if (!actor || (actor.role !== 'Admin' && actor.role !== 'Owner')) return;
        
        const target = users[data.targetId];
        if (!target && data.type !== 'unbanIP' && data.type !== 'banWord') return;

        switch(data.type) {
            case 'kick':
                io.to(target.id).emit('banAlert', 'EJECTED BY COMMAND.');
                io.sockets.sockets.get(target.id)?.disconnect(true);
                break;
            case 'mute':
                target.isMuted = !target.isMuted;
                io.to(target.id).emit('sysErr', target.isMuted ? 'Muted.' : 'Unmuted.');
                break;
            case 'timeout':
                target.timeoutUntil = Date.now() + 60000; // 1 min
                io.to(target.id).emit('sysErr', 'Timeout: 60s.');
                break;
            case 'ban': // IP Ban
                bannedIPs.push(target.ip);
                bannedUsernames.add(target.name.toLowerCase());
                io.to(target.id).emit('banAlert', 'PERMANENT EXILE (IP).');
                io.sockets.sockets.get(target.id)?.disconnect(true);
                updateOwnerData();
                break;
            case 'redirect':
                if(data.url) io.to(target.id).emit('forceRedirect', data.url);
                break;
        }
    });

    socket.on('ownerAction', (data) => {
        const actor = users[socket.id];
        if (!actor || actor.role !== 'Owner') return;

        if (data.type === 'unbanIP') {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            updateOwnerData();
        }
        if (data.type === 'addWord') {
            if(!bannedWords.includes(data.word)) bannedWords.push(data.word.toLowerCase());
            updateOwnerData();
        }
        if (data.type === 'removeWord') {
            bannedWords = bannedWords.filter(w => w !== data.word);
            updateOwnerData();
        }
    });

    // --- HELPERS ---
    function getStats() {
        return { 
            uptime: Math.floor((Date.now() - serverStats.startTime) / 1000), 
            totalMsg: serverStats.totalMessages, 
            userCount: Object.keys(users).length 
        };
    }

    function updateOwnerData() {
        Object.values(users).forEach(u => {
            if (u.role === 'Owner') {
                io.to(u.id).emit('ownerDataUpdate', { bannedIPs, bannedWords, stats: getStats() });
            }
        });
    }
    
    // Periodically sync stats
    setInterval(updateOwnerData, 5000);

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            delete users[socket.id];
            io.emit('userList', Object.values(users));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secure Node Active on ${PORT}`));
