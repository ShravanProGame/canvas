const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- SERVER STATE ---
const users = {};
const bannedIPs = new Set();
const bannedUsernames = new Set();
let bannedWords = ['spam', 'virus']; 

function getIp(socket) {
    return socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
}

io.on('connection', (socket) => {
  const clientIp = getIp(socket);

  // 1. IP BAN CHECK
  if (bannedIPs.has(clientIp)) {
      socket.emit('banAlert', 'CONNECTION TERMINATED: TERMINAL BLACKLISTED.');
      socket.disconnect(true);
      return;
  }

  console.log('A user connected:', socket.id);

  // Handle Login
  socket.on('join', (data) => {
    let role = 'User';

    // 2. USERNAME BAN CHECK
    if (bannedUsernames.has(data.name.toLowerCase())) {
        socket.emit('loginError', 'ACCESS DENIED: IDENTITY BLACKLISTED.');
        return;
    }

    if (data.password === 'owner999') {
        role = 'Owner';
    } else if (data.password === 'admin123') {
        role = 'Admin';
    } else if (data.password !== '') {
        role = 'User'; 
    }

    users[socket.id] = {
        id: socket.id,
        name: data.name || `Cadet-${socket.id.substr(0,4)}`,
        role: role,
        ip: clientIp,
        status: 'In Comms' // Default status upon joining
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

  // Handle Chat Messages
  socket.on('chatMessage', (msg) => {
    const user = users[socket.id];
    if (user) {
        let filteredText = msg;
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

  // Handle Status Updates (User switching tabs)
  socket.on('updateStatus', (newStatus) => {
      if (users[socket.id]) {
          users[socket.id].status = newStatus;
          // Broadcast new list so sidebar updates for everyone
          io.emit('userList', Object.values(users));
      }
  });

  // Admin Actions
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
      io.emit('userList', Object.values(users));
  });
// --- PRIVATE MESSAGING SYSTEM ---
  
  // 1. Handle Request
  socket.on('dmRequest', (targetSocketId) => {
      const sender = users[socket.id];
      const target = users[targetSocketId];

      if (target) {
          // Send request to target
          io.to(targetSocketId).emit('incomingDMRequest', { 
              fromId: socket.id, 
              name: sender.name 
          });
      }
  });

  // 2. Handle Acceptance
  socket.on('dmAccepted', (targetSocketId) => {
      const me = users[socket.id];
      const them = users[targetSocketId];

      // Tell both to start chat
      io.to(targetSocketId).emit('dmStart', { withId: socket.id, name: me.name }); // Tell requester
      socket.emit('dmStart', { withId: targetSocketId, name: them.name }); // Tell acceptor
  });

  // 3. Handle Rejection
  socket.on('dmRejected', (targetSocketId) => {
      io.to(targetSocketId).emit('banAlert', 'SECURE LINK REQUEST DENIED.'); // Reusing ban alert for dramatic effect, or use standard msg
  });

  // 4. Handle Private Message
  socket.on('privateMessage', ({ to, text }) => {
      const sender = users[socket.id];
      // Send to target
      io.to(to).emit('privateMsgReceive', { fromId: socket.id, text: text, name: sender.name });
      // Send back to sender (so they see it too)
      socket.emit('privateMsgReceive', { fromId: socket.id, text: text, name: sender.name });
  });
  
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
