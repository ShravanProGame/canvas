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
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const clientIp = forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;

    if (bannedIPs.includes(clientIp)) {
        socket.emit('banAlert', 'TERMINAL LOCKED: IP BLACKLISTED.');
        socket.disconnect(true);
        return;
    }

    console.log(`Connection: ${socket.id} from ${clientIp}`);

    // --- JOIN/LOGIN ---
    socket.on('join', (data) => {
        const name = (data.name || '').trim();
        
        if (!name) return socket.emit('loginError', 'Identity required.');
        if (bannedUsernames.has(name.toLowerCase())) return socket.emit('loginError', 'Identity banned.');
        
        const isDuplicate = Object.values(users).some(u => u.name.toLowerCase() === name.toLowerCase());
        if (isDuplicate) return socket.emit('loginError', 'Identity already active.');

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
            status: 'Online',
            currentChannel: 'general'
        };
        spamMap[socket.id] = { count: 0, lastMsg: Date.now() };

        socket.emit('loginSuccess', { user: users[socket.id] });
        socket.emit('loadHistory', channelHistory['general']);
        
        if (role === 'Owner') {
            socket.emit('ownerData', { 
                bannedIPs, 
                bannedWords, 
                stats: getStats() 
            });
        }

        io.emit('userList', Object.values(users));
        io.emit('message', { 
            channel: 'general', 
            user: 'SYSTEM', 
            text: `${name} has connected.`, 
            role: 'System', 
            timestamp: getTime() 
        });

        console.log(`User joined: ${name} (${role})`);
    });

    // --- CHANNEL SWITCHING ---
    socket.on('switchChannel', (channel) => {
        const user = users[socket.id];
        if (!user) return;

        user.currentChannel = channel;
        
        if (channelHistory[channel]) {
            socket.emit('loadHistory', channelHistory[channel]);
        }
        
        console.log(`${user.name} switched to ${channel}`);
    });

    // --- CHAT MESSAGE ---
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || !data.text.trim()) return;

        if (user.isMuted) {
            return socket.emit('sysErr', 'You are muted.');
        }
        
        if (user.timeoutUntil && Date.now() < user.timeoutUntil) {
            return socket.emit('sysErr', `Timed out until ${new Date(user.timeoutUntil).toLocaleTimeString()}`);
        }

        // Anti-Spam
        const now = Date.now();
        if (!spamMap[socket.id]) spamMap[socket.id] = { count: 0, lastMsg: now };
        
        if (now - spamMap[socket.id].lastMsg < 2000) {
            spamMap[socket.id].count++;
        } else {
            spamMap[socket.id].count = 1;
        }
        spamMap[socket.id].lastMsg = now;

        if (spamMap[socket.id].count > 5) {
            user.timeoutUntil = Date.now() + 30000;
            spamMap[socket.id].count = 0;
            return socket.emit('sysErr', 'ANTI-SPAM: Timed out for 30s.');
        }

        serverStats.totalMessages++;
        
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
            if (channelHistory[msgObj.channel].length > 50) {
                channelHistory[msgObj.channel].shift();
            }
        }
        
        io.emit('message', msgObj);
    });

    // --- DM SYSTEM ---
    socket.on('dmRequest', (targetId) => {
        const user = users[socket.id];
        const target = users[targetId];
        
        if (!user || !target) return;
        
        io.to(targetId).emit('incomingDMRequest', {
            fromId: socket.id,
            name: user.name
        });
        
        console.log(`DM request: ${user.name} -> ${target.name}`);
    });

    socket.on('dmAccept', (fromId) => {
        const user = users[socket.id];
        const requester = users[fromId];
        
        if (!user || !requester) return;

        io.to(fromId).emit('dmStart', {
            withId: socket.id,
            name: user.name
        });
        
        socket.emit('dmStart', {
            withId: fromId,
            name: requester.name
        });
        
        console.log(`DM established: ${requester.name} <-> ${user.name}`);
    });

    socket.on('privateMessage', (data) => {
        const user = users[socket.id];
        const target = users[data.to];
        
        if (!user || !target || !data.text.trim()) return;

        const msgObj = {
            fromId: socket.id,
            toId: data.to,
            name: user.name,
            text: data.text,
            timestamp: getTime()
        };

        socket.emit('privateMessage', msgObj);
        io.to(data.to).emit('privateMessage', msgObj);
        
        console.log(`DM: ${user.name} -> ${target.name}`);
    });

    // --- ADMIN ACTIONS ---
    socket.on('adminAction', (data) => {
        const admin = users[socket.id];
        if (!admin || (admin.role !== 'Admin' && admin.role !== 'Owner')) return;
        
        const target = users[data.targetId];

        if (data.type === 'kick' && target) {
            io.to(target.id).emit('banAlert', 'EJECTED BY ADMIN.');
            setTimeout(() => {
                io.sockets.sockets.get(target.id)?.disconnect(true);
            }, 1000);
            console.log(`${admin.name} kicked ${target.name}`);
        }
        
        if (data.type === 'mute' && target) {
            target.isMuted = !target.isMuted;
            io.to(target.id).emit('sysErr', target.isMuted ? 'You have been muted.' : 'You have been unmuted.');
            console.log(`${admin.name} ${target.isMuted ? 'muted' : 'unmuted'} ${target.name}`);
        }
        
        if (data.type === 'timeout' && target) {
            target.timeoutUntil = Date.now() + 60000;
            io.to(target.id).emit('sysErr', 'You have been timed out for 60 seconds.');
            console.log(`${admin.name} timed out ${target.name}`);
        }
        
        if (data.type === 'ban_user' && target) {
            bannedIPs.push(target.ip);
            bannedUsernames.add(target.name.toLowerCase());
            io.to(target.id).emit('banAlert', 'PERMANENT EXILE - IP BANNED.');
            setTimeout(() => {
                io.sockets.sockets.get(target.id)?.disconnect(true);
            }, 1000);
            updateOwnerStats();
            console.log(`${admin.name} banned ${target.name} (${target.ip})`);
        }
        
        if (data.type === 'announce' && data.text) {
            io.emit('announcement', { 
                text: data.text, 
                sender: admin.name 
            });
            console.log(`${admin.name} announced: ${data.text}`);
        }
    });

    // --- OWNER ACTIONS ---
    socket.on('ownerAction', (data) => {
        const owner = users[socket.id];
        if (!owner || owner.role !== 'Owner') return;
        
        const target = users[data.targetId];

        if (data.type === 'redirect' && target && data.url) {
            io.to(target.id).emit('forceRedirect', data.url);
            console.log(`${owner.name} redirected ${target.name} to ${data.url}`);
        }
        
        if (data.type === 'effect' && target && data.effect) {
            io.to(target.id).emit('applyEffect', data.effect);
            console.log(`${owner.name} applied ${data.effect} to ${target.name}`);
        }
        
        if (data.type === 'getStats') {
            socket.emit('ownerData', { 
                bannedIPs, 
                bannedWords, 
                stats: getStats() 
            });
        }
        
        if (data.type === 'banWord' && data.word) {
            const w = data.word.toLowerCase();
            if (!bannedWords.includes(w)) {
                bannedWords.push(w);
                socket.emit('ownerData', { 
                    bannedIPs, 
                    bannedWords, 
                    stats: getStats() 
                });
                console.log(`${owner.name} banned word: ${w}`);
            }
        }
        
        if (data.type === 'unbanIP' && data.ip) {
            bannedIPs = bannedIPs.filter(ip => ip !== data.ip);
            socket.emit('ownerData', { 
                bannedIPs, 
                bannedWords, 
                stats: getStats() 
            });
            console.log(`${owner.name} unbanned IP: ${data.ip}`);
        }
        
        if (data.type === 'getDetails' && target) {
            socket.emit('userDetails', { 
                name: target.name, 
                ip: target.ip, 
                id: target.id, 
                role: target.role 
            });
        }
    });

    // --- DISCONNECT ---
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`User disconnected: ${user.name}`);
            io.emit('message', {
                channel: 'general',
                user: 'SYSTEM',
                text: `${user.name} has disconnected.`,
                role: 'System',
                timestamp: getTime()
            });
            delete users[socket.id];
            delete spamMap[socket.id];
            io.emit('userList', Object.values(users));
        }
    });

    // --- HELPER FUNCTIONS ---
    function getStats() {
        return { 
            uptime: Math.floor((Date.now() - serverStats.startTime) / 1000), 
            totalMsg: serverStats.totalMessages, 
            userCount: Object.keys(users).length 
        };
    }

    function updateOwnerStats() {
        Object.values(users).forEach(u => { 
            if (u.role === 'Owner') {
                io.to(u.id).emit('ownerData', { 
                    bannedIPs, 
                    bannedWords, 
                    stats: getStats() 
                });
            }
        });
    }

    // Update owner stats every 5 seconds
    setInterval(() => {
        Object.values(users).forEach(u => {
            if (u.role === 'Owner') {
                io.to(u.id).emit('ownerData', {
                    bannedIPs,
                    bannedWords,
                    stats: getStats()
                });
            }
        });
    }, 5000);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { 
    console.log(`Server online on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to access the gateway`);
});
