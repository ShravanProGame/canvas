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
    let authSuccess = true;

    // Simple password check (In production, use hashed passwords/DB)
    if (data.password === 'owner999') {
        role = 'Owner';
    } else if (data.password === 'admin123') {
        role = 'Admin';
    } else if (data.password !== '') {
        // If password provided but wrong, default to User or could reject
        // For this demo, we'll allow them as User but warn, or just ignore
        // Let's strict mode it slightly: if pass exists but wrong -> error
        // But prompt says "prompted to put in a password or continue as a user"
        // so we assume wrong password = join as user for simplicity here
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
