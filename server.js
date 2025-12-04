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

// Store connected users
const users = {};

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Handle Login
  socket.on('join', (data) => {
    let role = 'User';

    // Simple password check
    if (data.password === 'owner999') {
        role = 'Owner';
    } else if (data.password === 'admin123') {
        role = 'Admin';
    } else if (data.password !== '') {
        // Default to User if password is incorrectly entered
        role = 'User'; 
    }

    users[socket.id] = {
        id: socket.id,
        name: data.name || `Cadet-${socket.id.substr(0,4)}`,
        role: role
    };

    // Confirm login to client
    socket.emit('loginSuccess', {
        user: users[socket.id]
    });

    // Broadcast system message
    io.emit('message', {
        user: 'SYSTEM',
        text: `${users[socket.id].name} has entered the frequency.`,
        role: 'System',
        timestamp: new Date().toLocaleTimeString()
    });

    // Update user list
    io.emit('userList', Object.values(users));
  });

  // Handle Chat Messages
  socket.on('chatMessage', (msg) => {
    const user = users[socket.id];
    if (user) {
        io.emit('message', {
            user: user.name,
            text: msg,
            role: user.role,
            timestamp: new Date().toLocaleTimeString()
        });
    }
  });

  // Handle Disconnect
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
