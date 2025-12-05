const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);

// --- 1. Robust Connection Settings ---
const io = new Server(server, {
    pingTimeout: 60000,
    pingInterval: 25000,
    connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: true,
    }
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SERVER STATE (In-Memory) ---
const users = {};
const bannedIPs = new Set();
const bannedUsernames = new Set();
let bannedWords = ['spam', 'virus', 'badword']; 

// Helper: Get Client IP (FIXED for proxies)
function getIp(socket) {
    // Safely parse the 'x-forwarded-for' header (comma-separated list)
    const forwardedIp = socket.handshake.headers['x-forwarded-for'];
    if (forwardedIp) {
        // Use the first IP in the list (the actual client IP)
        return forwardedIp.split(',')[0].trim();
    }
    return socket.handshake.address;
}

io.on('connection', (socket) => {
  const clientIp = getIp(socket);

  // 1. IP BAN CHECK
  if (bannedIPs.has(clientIp)) {
      socket.emit('banAlert', 'CONNECTION TERMINATED: TERMINAL BLACKLISTED.');
      socket.disconnect(true);
      return;
  }

  console.log(`Uplink established: ${socket.id}`);

  // --- LOGIN LOGIC (FIXED) ---
  socket.on('join', (data) => {
    let role = 'User';
    
    // --- IMPORTANT FIX: Normalize name immediately ---
    const userName = (data.name || '').trim();
    if (!userName) {
        socket.emit('loginError', 'ACCESS DENIED: Codename cannot be empty.');
        return;
    }

    // 2. USERNAME BAN CHECK
    if (bannedUsernames.has(userName.toLowerCase())) {
        socket.emit('loginError', 'ACCESS DENIED: IDENTITY BLACKLISTED.');
        return;
    }

    // Check for duplicate names (prevent hijacking or confusion)
    const existingUser = Object.values(users).find(u => u.name.toLowerCase() === userName.toLowerCase());
    if (existingUser) {
        socket.emit('loginError', `ACCESS DENIED: Codename '${userName}' is already active.`);
        return;
    }

    // Role assignment logic (Pass through)
    if (data.password === 'owner999') {
        role = 'Owner';
    } else if (data.password === 'admin123') {
        role = 'Admin';
    } else if (data.password !== '' && data.password !== 'owner999' && data.password !== 'admin123') {
        // If a password was provided but it was incorrect, still join as a normal User
        role = 'User'; 
    }

    users[socket.id] = {
        id: socket.id,
        name: userName, // Use the trimmed name
        role: role,
        ip: clientIp,
        status: 'In Comms' 
    };

    socket.emit('loginSuccess', {
        user: users[socket.id]
    });

    io.emit('message', {
        user: 'SYSTEM',
        text: `${users[socket.id].name} has entered the frequency.`,
        role: 'System',
        timestamp: new Date().toLocaleTimeString()
    });

    io.emit('userList', Object.values(users));
  });

  // --- CHAT LOGIC ---
  socket.on('chatMessage', (msg) => {
    const user = users[socket.id];
    if (user) {
        let filteredText = msg;
        // Word Filter
        bannedWords.forEach(word => {
            const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${safeWord}\\b`, 'gi');
            filteredText = filteredText.replace(regex, '[REDACTED]');
        });

        io.emit('message', {
            user: user.name,
            text: filteredText,
            role: user.role,
            timestamp: new Date().toLocaleTimeString()
        });
    }
  });

  // --- STATUS UPDATES ---
  socket.on('updateStatus', (newStatus) => {
      if (users[socket.id]) {
          users[socket.id].status = newStatus;
          io.emit('userList', Object.values(users));
      }
  });

  // --- PRIVATE MESSAGING (DM) SYSTEM ---
  
  // A. Request
  socket.on('dmRequest', (targetSocketId) => {
      const sender = users[socket.id];
      // Only send if target exists
      if (users[targetSocketId]) {
          io.to(targetSocketId).emit('incomingDMRequest', { 
              fromId: socket.id, 
              name: sender.name 
          });
      }
  });

  // B. Accept
  socket.on('dmAccepted', (targetSocketId) => {
      const me = users[socket.id];
      const them = users[targetSocketId];
      if (me && them) {
          // Tell requester (them) it started
          io.to(targetSocketId).emit('dmStart', { withId: socket.id, name: me.name }); 
          // Tell acceptor (me) it started
          socket.emit('dmStart', { withId: targetSocketId, name: them.name }); 
      }
  });

  // C. Reject
  socket.on('dmRejected', (targetSocketId) => {
      if (users[targetSocketId]) {
          io.to(targetSocketId).emit('dmRejectedAlert', 'SECURE LINK REQUEST DENIED.'); 
      }
  });

  // D. Message
  socket.on('privateMessage', ({ to, text }) => {
      const sender = users[socket.id];
      if (users[to] && sender) {
        // Send to target
        io.to(to).emit('privateMsgReceive', { fromId: socket.id, text: text, name: sender.name });
        // Send back to sender (so they see it in their bubble)
        socket.emit('privateMsgReceive', { fromId: socket.id, text: text, name: sender.name });
      }
  });

  // --- ADMIN ACTIONS ---
  socket.on('adminAction', (action) => {
      const adminUser = users[socket.id];
      if (!adminUser || (adminUser.role !== 'Admin' && adminUser.role !== 'Owner')) return;

      switch(action.type) {
          case 'ban_user':
              const targetId = Object.keys(users).find(id => users[id].name === action.targetName);
              if (targetId) {
                  const targetUser = users[targetId];
                  bannedUsernames.add(targetUser.name.toLowerCase());
                  bannedIPs.add(targetUser.ip);
                  
                  io.emit('message', {
                      user: 'SYSTEM',
                      text: `JUDGMENT: ${targetUser.name} has been exiled by ${adminUser.name}.`,
                      role: 'System',
                      timestamp: new Date().toLocaleTimeString()
                  });
                  
                  const targetSocket = io.sockets.sockets.get(targetId);
                  if (targetSocket) {
                      targetSocket.emit('banAlert', 'YOU HAVE BEEN BANNED BY ADMINISTRATOR.');
                      targetSocket.disconnect(true);
                  }
              }
              break;

          case 'ban_word':
              if (action.word && !bannedWords.includes(action.word.toLowerCase())) {
                  bannedWords.push(action.word.toLowerCase());
                  io.emit('message', {
                      user: 'SYSTEM',
                      text: `PROTOCOL UPDATE: The word "${action.word}" is now prohibited.`,
                      role: 'System',
                      timestamp: new Date().toLocaleTimeString()
                  });
              }
              break;

          case 'announce':
              io.emit('announcement', {
                  text: action.text,
                  sender: adminUser.name
              });
              break;
      }
      // Refresh list to remove banned user
      io.emit('userList', Object.values(users));
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    const user = users[socket.id];
    if (user) {
        io.emit('message', {
            user: 'SYSTEM',
            text: `${user.name} lost connection.`,
            role: 'System',
            timestamp: new Date().toLocaleTimeString()
        });
        delete users[socket.id];
        io.emit('userList', Object.values(users));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Command Link Established on http://localhost:${PORT}`);
});
