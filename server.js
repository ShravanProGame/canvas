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
let bannedWords = ['spam', 'virus']; // Example filtered words

// Helper: Get Client IP
function getIp(socket) {
    // Check for proxy headers first (common in hosting), then fall back to connection address
    return socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
}

io.on('connection', (socket) => {
  const clientIp = getIp(socket);

  // 1. SECURITY CHECK: IP BAN
  if (bannedIPs.has(clientIp)) {
      socket.emit('banAlert', 'CONNECTION TERMINATED: TERMINAL BLACKLISTED.');
      socket.disconnect(true);
      return;
  }

  console.log('A user connected:', socket.id);

  // Handle Login
  socket.on('join', (data) => {
    let role = 'User';

    // 2. SECURITY CHECK: USERNAME BAN
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
        ip: clientIp
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

    // Send updated user list for Admin dropdowns
    io.emit('userList', Object.values(users));
  });

  // Handle Chat Messages
  socket.on('chatMessage', (msg) => {
    const user = users[socket.id];
    if (user) {
        // 3. WORD FILTER
        let filteredText = msg;
        bannedWords.forEach(word => {
            // Case-insensitive regex to replace whole words
            // Escape special regex chars in the word just in case
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

  // --- ADMIN COMMANDS ---
  socket.on('adminAction', (action) => {
      const adminUser = users[socket.id];
      // Strict Role Check
      if (!adminUser || (adminUser.role !== 'Admin' && adminUser.role !== 'Owner')) {
          return; // Ignore unauthorized requests
      }

      switch(action.type) {
          case 'ban_user':
              // Find target by name
              const targetId = Object.keys(users).find(id => users[id].name === action.targetName);
              if (targetId) {
                  const targetUser = users[targetId];
                  
                  // Add to Blacklists
                  bannedUsernames.add(targetUser.name.toLowerCase());
                  bannedIPs.add(targetUser.ip);

                  // Public Shaming Message
                  io.emit('message', {
                      user: 'SYSTEM',
                      text: `JUDGMENT: ${targetUser.name} has been exiled by ${adminUser.name}.`,
                      role: 'System',
                      timestamp: new Date().toLocaleTimeString()
                  });

                  // Kick the user
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
