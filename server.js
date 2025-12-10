const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Initialize Socket.IO with CORS for easy local/remote testing
const io = new Server(server, {
    cors: {
        origin: "*", // Allow all origins for flexibility
        methods: ["GET", "POST"]
    }
});

// --- Configuration and State ---
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = 'admin';
const OWNER_PASS = 'owner';
const VIP_PASS = 'vip';

// Store all connected users and their data (socketId -> userObject)
const users = {}; 

// --- Express Setup ---
// Serve static files from the current directory (where index.html is)
app.use(express.static(path.join(__dirname)));

// Fallback route for index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Helper Functions ---
function broadcastUserList() {
    const userList = Object.values(users).map(u => ({
        id: u.id,
        name: u.name,
        role: u.role,
        isMuted: u.isMuted,
        isBanned: u.isBanned // Not fully implemented on client, but tracked
    }));
    io.emit('userList', userList);
}

function getUserRoleLevel(role) {
    if (role === 'owner') return 3;
    if (role === 'admin') return 2;
    if (role === 'vip') return 1;
    return 0;
}

// --- Socket.io Handlers ---
io.on('connection', (socket) => {
    console.log(`[CONNECT] User connected: ${socket.id}`);
    
    // 1. Handle User Login
    socket.on('login', (data) => {
        const { name, role, password } = data;
        let authPassed = true;

        if (role === 'vip' && password !== VIP_PASS) authPassed = false;
        if (role === 'admin' && password !== ADMIN_PASS) authPassed = false;
        if (role === 'owner' && password !== OWNER_PASS) authPassed = false;

        // Check if username is already taken
        const existingUser = Object.values(users).find(u => u.name === name);
        if (existingUser) {
             return socket.emit('loginResponse', { success: false, message: 'Designation already in use.' });
        }

        if (authPassed) {
            // Create user object
            users[socket.id] = {
                id: socket.id,
                name: name,
                role: role,
                isMuted: false,
                isBanned: false,
                roleLevel: getUserRoleLevel(role)
            };
            
            // Join the general channel by default
            socket.join('general');
            
            socket.emit('loginResponse', { success: true, user: users[socket.id] });
            
            // Broadcast system message and update list
            socket.broadcast.emit('message', {
                user: 'System',
                text: `${name} has established uplink [${role.toUpperCase()}]`,
                channel: 'general',
                role: 'system'
            });
            broadcastUserList();
        } else {
            socket.emit('loginResponse', { success: false, message: 'Invalid Clearance Code.' });
        }
    });

    // 2. Handle Channel Switching
    socket.on('joinChannel', (newChannel) => {
        const user = users[socket.id];
        if (!user) return; // User not logged in

        // Leave all previous channels and join the new one
        Object.keys(socket.rooms).filter(room => room !== socket.id).forEach(room => {
            socket.leave(room);
        });
        socket.join(newChannel);
    });

    // 3. Handle Public Chat Messages
    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user || user.isMuted) return; // Ignore muted users
        
        // Broadcast the message to all clients in the specific channel
        io.to(data.channel).emit('message', {
            user: user.name,
            userId: user.id,
            role: user.role,
            text: data.text,
            channel: data.channel
        });
    });
    
    // 4. Handle Direct Messages (DMs)
    socket.on('dmMessage', (data) => {
        const sender = users[socket.id];
        const recipientSocketId = data.recipientId;
        
        if (!sender || !users[recipientSocketId]) {
            return socket.emit('systemMessage', { text: 'Target agent not found or offline.' });
        }
        
        // Send DM to recipient
        io.to(recipientSocketId).emit('dmReceived', {
            fromId: sender.id,
            fromName: sender.name,
            text: data.text
        });
        
        // Send a copy back to the sender for display
        socket.emit('dmReceived', {
            fromId: sender.id,
            fromName: sender.name,
            text: data.text,
            isSent: true // Flag to show it on the sender's side
        });
    });

    // 5. Admin and Owner Commands
    socket.on('adminCommand', (data) => {
        const commander = users[socket.id];
        const target = users[data.targetId];

        if (!commander || commander.roleLevel < 2 || !target) { // Must be admin/owner
            return socket.emit('systemMessage', { text: 'Insufficient clearance for this action.' });
        }
        
        // Cannot target users with higher or equal role level
        if (commander.roleLevel <= target.roleLevel && commander.id !== target.id) {
             return socket.emit('systemMessage', { text: 'Cannot target agent with equal or higher clearance.' });
        }
        
        const targetSocket = io.sockets.sockets.get(data.targetId);

        if (data.command === 'kick' && targetSocket) {
            targetSocket.emit('systemMessage', { text: 'Admin Kick: Connection severed.' });
            targetSocket.disconnect(true);
        } else if (data.command === 'ban') {
            target.isBanned = true;
            target.isMuted = true;
            if (targetSocket) {
                targetSocket.emit('systemMessage', { text: 'Admin Ban: Access permanently revoked.' });
                targetSocket.disconnect(true);
            }
        } else if (data.command === 'mute') {
            target.isMuted = !target.isMuted;
            socket.emit('systemMessage', { text: `${target.name} is now ${target.isMuted ? 'MUTED' : 'UNMUTED'}.` });
            broadcastUserList();
        } else if (data.command === 'timeout') {
            target.isMuted = true;
            targetSocket.emit('systemMessage', { text: 'Admin Timeout (60s): Commencing system lock.' });
            
            setTimeout(() => {
                target.isMuted = false;
                targetSocket.emit('systemMessage', { text: 'Admin Timeout: System lock released. You may speak.' });
                broadcastUserList();
            }, 60000);
        }
    });
    
    socket.on('ownerCommand', (data) => {
        const commander = users[socket.id];
        if (!commander || commander.role !== 'owner') {
            return socket.emit('systemMessage', { text: 'OWNER clearance required.' });
        }
        
        if (data.command === 'systemEffect') {
            // Broadcast the effect globally
            io.emit('systemEffect', { effect: data.effect });
            socket.emit('systemMessage', { text: `System visual effect '${data.effect}' broadcast.` });
        } else if (data.command === 'forceRedirect' && data.url) {
            // Broadcast the redirect globally
            io.emit('forceRedirect', { url: data.url });
            socket.emit('systemMessage', { text: `System-wide redirect initiated to ${data.url}.` });
        }
    });

    // 6. Handle Disconnection
    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            console.log(`[DISCONNECT] User disconnected: ${user.name} (${user.id})`);
            
            // Broadcast system message
            socket.broadcast.emit('message', {
                user: 'System',
                text: `${user.name} has terminated uplink.`,
                channel: 'general',
                role: 'system'
            });
            
            // Remove user and update list
            delete users[socket.id];
            broadcastUserList();
        } else {
            console.log(`[DISCONNECT] Unknown user disconnected: ${socket.id}`);
        }
    });
});

// --- Start Server ---
server.listen(PORT, () => {
    console.log(`Secure Uplink Server operational on port ${PORT}`);
});
