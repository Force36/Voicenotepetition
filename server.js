// server.js

// --- Import necessary libraries ---
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const ffmpeg = require('fluent-ffmpeg');
const archiver = require('archiver');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
require('dotenv').config();


// --- Basic Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { /* ... */ });

// Use the PORT environment variable Render provides, or 3000 for local development
const port = process.env.PORT || 3000; 

// Render provides a persistent disk at '/var/data'. We'll use a 'data' subfolder.
const dataDir = process.env.RENDER_DISK_PATH || __dirname; 
const uploadDir = path.join(dataDir, 'uploads');
const sentDir = path.join(dataDir, 'sent_to_spotify');
const dbFile = path.join(dataDir, 'database.sqlite');
const sessionsDir = path.join(dataDir, 'sessions');

// --- Middleware ---
app.use(cors({
    origin: ['http://localhost:3000', 'http://127.0.0.1:5500', "http://localhost:5500"],
    credentials: true
}));
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(uploadDir));
app.use('/images', express.static(path.join(__dirname, 'images')));

const sessionMiddleware = session({
    store: new FileStore({
        path: sessionsDir,
        logFn: function(){}
    }),
    name: 'voicenote_project.sid',
    secret: process.env.SESSION_SECRET || 'a-very-strong-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 1000 * 60 * 60 * 24,
        httpOnly: true,
        sameSite: 'lax'
    }
});
app.use(sessionMiddleware);


// --- Initialize Directories and Database ---
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(sentDir)) fs.mkdirSync(sentDir);
if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir);

const db = new sqlite3.Database(dbFile, (err) => {
    if (err) console.error('Error opening database', err.message);
    else {
        console.log('Connected to the SQLite database.');
        db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE, password TEXT)`);
        db.run(`CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, status TEXT DEFAULT 'Needs Reviewing', approved_by TEXT, assignee_email TEXT, submitted_at TEXT, sent_at TEXT)`);
    }
});

// --- Multer Configuration (File Upload Handling) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `temp-${Date.now()}.wav`)
});
const upload = multer({ storage }).single('audio');


// --- Real-time Logic ---
io.on('connection', (socket) => {
    console.log(`A staff member connected. Socket ID: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`A staff member disconnected. Socket ID: ${socket.id}`);
    });
});

function broadcastUpdate() {
    io.emit('submissions_updated');
    console.log('Broadcasted submissions_updated event to all clients.');
}


// --- Authentication Middleware ---
const requireLogin = (req, res, next) => {
    if (req.session && req.session.userId) {
        return next();
    } else {
        return res.status(401).json({ message: 'Unauthorized. Please log in.' });
    }
};


// --- Page Serving Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'staff.html')));


// --- API Routes ---

// USER AUTHENTICATION
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hashedPassword], function(err) {
        if (err) return res.status(400).json({ message: 'This email is already registered.' });
        res.status(201).json({ message: 'User registered successfully.' });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (!user) return res.status(401).json({ message: 'Invalid credentials.' });
        
        const match = await bcrypt.compare(password, user.password);
        
        if (match) {
            req.session.regenerate((regenErr) => {
                if (regenErr) return res.status(500).json({ message: "Error starting session." });
                
                req.session.userId = user.id;
                req.session.userEmail = user.email;
                
                req.session.save((saveErr) => {
                    if (saveErr) return res.status(500).json({ message: "Error saving session." });
                    console.log(`[Login Success] Session regenerated and saved for user: ${req.session.userEmail}`);
                    res.status(200).json({ message: 'Login successful.' });
                });
            });
        } else {
            res.status(401).json({ message: 'Invalid credentials.' });
        }
    });
});

app.post('/api/logout', (req, res) => {
    const userEmail = req.session.userEmail;
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ message: 'Could not log out.' });
        res.clearCookie('voicenote_project.sid');
        console.log(`[Logout Success] Session destroyed for user: ${userEmail}`);
        res.status(200).json({ message: 'Logout successful.' });
    });
});

app.get('/api/users', requireLogin, (req, res) => {
    db.all('SELECT id, email FROM users', [], (err, users) => {
        if (err) {
            return res.status(500).json({ message: 'Failed to retrieve users.' });
        }
        res.json(users);
    });
});


// STAFF DASHBOARD API
// UPDATED: Get submissions with optional filtering by assignee
app.get('/api/submissions', requireLogin, (req, res) => {
    const { assignee } = req.query;
    let query = 'SELECT * FROM submissions';
    const params = [];

    // Filter only the "Needs Reviewing" submissions if an assignee is selected
    if (assignee && assignee !== 'all') {
        query += ' WHERE assignee_email = ? AND status = "Needs Reviewing"';
        params.push(assignee);
    }
    
    query += ' ORDER BY submitted_at DESC';

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ message: 'Failed to retrieve submissions.' });
        
        // If the filter is active, we still need to get the other categories unfiltered
        if (assignee && assignee !== 'all') {
             db.all("SELECT * FROM submissions WHERE status != 'Needs Reviewing' ORDER BY submitted_at DESC", [], (err2, otherRows) => {
                if (err2) return res.status(500).json({ message: 'Failed to retrieve submissions.' });
                res.json([...rows, ...otherRows]);
             });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/submission/status', requireLogin, (req, res) => {
    const { filename, status } = req.body;
    const approved_by = status === 'Approved' ? req.session.userEmail : null;

    db.run(
        'UPDATE submissions SET status = ?, approved_by = ? WHERE filename = ?', 
        [status, approved_by, filename], 
        function(err) {
            if (err) return res.status(500).json({ message: 'Failed to update status.' });
            console.log(`[Action] Status for ${filename} updated to ${status} by user: ${req.session.userEmail}`);
            broadcastUpdate();
            res.status(200).json({ message: 'Status updated successfully.' });
        }
    );
});

app.post('/api/submission/delete', requireLogin, (req, res) => {
    const { filename } = req.body;
    const filePath = path.join(uploadDir, filename);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.run('DELETE FROM submissions WHERE filename = ?', [filename], function(err) {
        if (err) {
            console.error("DB Delete Error:", err.message);
            return res.status(500).json({ message: 'Failed to delete submission record.' });
        }
        console.log(`[Action] Permanently deleted ${filename} by user: ${req.session.userEmail}`);
        broadcastUpdate();
        res.status(200).json({ message: 'Submission permanently deleted.' });
    });
});

app.post('/api/submissions/assign-bulk', requireLogin, (req, res) => {
    const { filenames, assigneeEmail } = req.body;
    if (!filenames || !Array.isArray(filenames) || filenames.length === 0 || !assigneeEmail) {
        return res.status(400).json({ message: 'Filenames and assignee are required.' });
    }
    const placeholders = filenames.map(() => '?').join(',');
    const query = `UPDATE submissions SET assignee_email = ? WHERE filename IN (${placeholders})`;
    const params = [assigneeEmail, ...filenames];
    db.run(query, params, function(err) {
        if (err) {
            console.error("Bulk assign error:", err.message);
            return res.status(500).json({ message: 'Failed to assign submissions.' });
        }
        console.log(`[Action] ${filenames.length} files assigned to ${assigneeEmail} by ${req.session.userEmail}`);
        broadcastUpdate();
        res.status(200).json({ message: 'Submissions assigned successfully.' });
    });
});

app.post('/api/download-approved', requireLogin, (req, res) => {
    const filenames = JSON.parse(req.body.filenames);
    if (!filenames || filenames.length === 0) return res.status(400).json({ message: 'No filenames provided.' });
    res.attachment('approved-voicenotes.zip');
    const archive = archiver('zip');
    archive.pipe(res);
    filenames.forEach(filename => {
        const filePath = path.join(uploadDir, filename);
        if (fs.existsSync(filePath)) archive.file(filePath, { name: filename });
    });
    archive.finalize();

    res.on('finish', () => {
        const userEmail = req.session.userEmail;
        const placeholders = filenames.map(() => '?').join(',');
        const query = `UPDATE submissions SET status = 'Downloaded', sent_at = ? WHERE filename IN (${placeholders})`;
        const params = [new Date().toISOString(), ...filenames];
        
        db.run(query, params, function(err) {
            if (err) {
                console.error("Bulk download status update error:", err.message);
                return;
            }
            broadcastUpdate();
            console.log(`[Action] ${filenames.length} files marked as Downloaded by user: ${userEmail}`);
        });
    });
});


// PUBLIC UPLOAD PAGE API
app.get('/suggest-topic', async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ message: 'Server configuration error.' });
    const prompt = "Please suggest a short, interesting, and open-ended topic for a one-minute voice message...";
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
        });
        if (!response.ok) throw new Error('API request failed');
        const result = await response.json();
        res.json({ suggestion: result.candidates[0].content.parts[0].text });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch suggestion.' });
    }
});

app.post('/upload', (req, res) => {
    upload(req, res, function (err) {
        if (err || !req.file) {
            console.error("Upload Error:", err);
            return res.status(400).json({ message: "Upload failed." });
        }
        
        const sanitize = (str) => str.replace(/[^a-zA-Z0-9-]/g, '_');
        const baseFilename = `${sanitize(req.body.firstName || 'user')}-${sanitize(req.body.postcode || 'local')}`;
        let finalFilename = `${baseFilename}.mp3`;
        let outputPath = path.join(uploadDir, finalFilename);
        let counter = 1;

        while (fs.existsSync(outputPath)) {
            finalFilename = `${baseFilename}-${counter}.mp3`;
            outputPath = path.join(uploadDir, finalFilename);
            counter++;
        }
        
        ffmpeg(req.file.path)
            .toFormat('mp3')
            .audioBitrate('192k')
            .on('end', () => {
                fs.unlink(req.file.path, () => {});
                db.run('INSERT INTO submissions (filename, submitted_at) VALUES (?, ?)', 
                    [finalFilename, new Date().toISOString()], (dbErr) => {
                        if (dbErr) {
                            console.error("DB Insert Error:", dbErr);
                            return res.status(200).json({ message: 'Upload successful (with DB error)!'});
                        }
                        broadcastUpdate();
                        console.log(`New submission saved to DB: ${finalFilename}`);
                        res.status(200).json({ message: 'Upload successful!'});
                    });
            })
            .on('error', (ffmpegErr) => {
                fs.unlink(req.file.path, () => {});
                res.status(500).json({ message: 'File conversion failed.' });
            })
            .save(outputPath);
    });
});


// --- Start the Server ---
server.listen(port, () => {
    console.log(`Server is running at http://localhost:${port}`);
});
