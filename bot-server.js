const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));

/* ================= CONFIG ================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'Pinku@2026Secret';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const JSONBIN_BIN = process.env.JSONBIN_BIN || '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const JSONBIN_API = 'https://api.jsonbin.io/v3/b';

/* ================= STORAGE ================= */
let messages = [];
let users = {};
let blockedIPs = new Set();
let blockedDevices = new Set();
let leaderboard = {};
let dailyStats = {};
let dailyQuizRecords = {};
let dataLoaded = false;
const MAX_MSG = 2000;

/* ================= HELPERS ================= */
async function tgAPI(method, params = {}) {
    try {
        const res = await fetch(`${API_BASE}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        return await res.json();
    } catch(e) {
        console.error('TG Error:', e);
        return { ok: false };
    }
}

function genId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0].trim()
        || req.headers['x-real-ip']
        || req.connection?.remoteAddress
        || req.socket?.remoteAddress
        || 'unknown';
}

/* ================= BAD WORDS ================= */
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'gaali', 'bhosdi', 'madarchod', 'bhenchod'];
function hasBadWord(text) {
    const l = (text || '').toLowerCase();
    return BAD_WORDS.some(w => l.includes(w));
}

/* ================= IMGBB UPLOAD ================= */
async function uploadToImgBB(base64Image) {
    if (!IMGBB_API_KEY) return null;
    try {
        const formData = new URLSearchParams();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64Image.replace(/^data:[^;]+;base64,/, ''));
        const res = await fetch('https://api.imgbb.com/1/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        return data.success ? data.data.url : null;
    } catch(e) {
        console.error('ImgBB error:', e);
        return null;
    }
}

/* ================= JSONBIN LOAD/SAVE ================= */
async function loadLeaderboard() {
    if (!JSONBIN_KEY || !JSONBIN_BIN) {
        console.log('⚠️ JSONBin not configured');
        dataLoaded = true;
        return;
    }
    try {
        const res = await fetch(`${JSONBIN_API}/${JSONBIN_BIN}/latest`, {
            headers: { 'X-Master-Key': JSONBIN_KEY }
        });
        const data = await res.json();
        if (data.record) {
            leaderboard = data.record.leaderboard || {};
            dailyStats = data.record.dailyStats || {};
            dailyQuizRecords = data.record.dailyQuizRecords || {};
        }
        dataLoaded = true;
        console.log('✅ Leaderboard loaded:', Object.keys(leaderboard).length, 'users');
    } catch(e) {
        console.error('Load failed:', e.message);
        dataLoaded = true;
    }
}

async function saveLeaderboard() {
    if (!JSONBIN_KEY || !JSONBIN_BIN) return;
    try {
        await fetch(`${JSONBIN_API}/${JSONBIN_BIN}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY
            },
            body: JSON.stringify({
                leaderboard,
                dailyStats,
                dailyQuizRecords,
                savedAt: Date.now()
            })
        });
    } catch(e) {
        console.error('Save failed:', e.message);
    }
}

setInterval(() => {
    if (dataLoaded) saveLeaderboard();
}, 30000);

loadLeaderboard();

/* ================= CLEANUP OLD MESSAGES ================= */
function cleanupOldMessages() {
    const threeDaysAgo = Date.now() - (3 * 24 * 60 * 60 * 1000);
    messages = messages.filter(m => m.timestamp > threeDaysAgo);
}
setInterval(cleanupOldMessages, 60 * 60 * 1000);

/* ================= HEALTH CHECK ================= */
app.get('/', (req, res) => {
    res.json({
        ok: true,
        status: 'Group Chat Server Running',
        messages: messages.length,
        users: Object.keys(users).length,
        blockedIPs: blockedIPs.size,
        leaderboardUsers: Object.keys(leaderboard).length
    });
});

/* ================= TELEGRAM WEBHOOK ================= */
app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;
    try {
        if (!update.message) return;
        const msg = update.message;
        if (msg.chat.id.toString() !== GROUP_CHAT_ID) return;
        if (msg.from.is_bot) return;

        const text = msg.text || msg.caption || '';
        if (!text && !msg.photo && !msg.video && !msg.document) return;

        if (text && hasBadWord(text)) {
            await tgAPI('deleteMessage', {
                chat_id: GROUP_CHAT_ID,
                message_id: msg.message_id
            });
            return;
        }

        const isAdmin = msg.from.id.toString() === ADMIN_USER_ID;
        const userId = isAdmin ? 'admin' : msg.from.id.toString();

        if (!isAdmin && blockedDevices.has(userId)) {
            await tgAPI('deleteMessage', {
                chat_id: GROUP_CHAT_ID,
                message_id: msg.message_id
            });
            return;
        }

        let imageUrl = '', videoUrl = '', docUrl = '';

        if (msg.photo && msg.photo.length > 0) {
            const largest = msg.photo[msg.photo.length - 1];
            const fileInfo = await tgAPI('getFile', { file_id: largest.file_id });
            if (fileInfo.ok) imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
        }
        if (msg.video) {
            const fileInfo = await tgAPI('getFile', { file_id: msg.video.file_id });
            if (fileInfo.ok) videoUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
        }
        if (msg.document) {
            const fileInfo = await tgAPI('getFile', { file_id: msg.document.file_id });
            if (fileInfo.ok) docUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
        }

        const stored = {
            id: genId(),
            tgMessageId: msg.message_id,
            userId: userId,
            userName: isAdmin ? 'Admin (Pinku Kumar)' : `${msg.from.first_name || 'User'}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
            text: text, image: imageUrl, video: videoUrl, document: docUrl,
            isAdmin: isAdmin, fromTelegram: true,
            timestamp: msg.date * 1000
        };

        messages.unshift(stored);
        if (messages.length > MAX_MSG) messages.pop();

        if (!isAdmin) {
            users[userId] = {
                id: userId, name: stored.userName,
                username: msg.from.username || '',
                lastSeen: Date.now(),
                ip: users[userId]?.ip || 'unknown'
            };
        }
    } catch(e) {
        console.error('Webhook error:', e);
    }
});

/* ================= REGISTER USER ================= */
app.post('/api/register', (req, res) => {
    const { name, deviceId } = req.body;
    const ip = getClientIP(req);
    if (!deviceId) return res.status(400).json({ ok: false });

    if (blockedIPs.has(ip)) return res.status(403).json({ ok: false, error: 'Blocked', blocked: true });
    if (blockedDevices.has(deviceId)) return res.status(403).json({ ok: false, error: 'Blocked', blocked: true });

    if (!users[deviceId]) {
        users[deviceId] = {
            id: deviceId, name: name || 'Anonymous',
            ip: ip, registeredAt: Date.now(), lastSeen: Date.now(),
            isAppUser: true, messageCount: 0
        };
    } else {
        users[deviceId].lastSeen = Date.now();
        users[deviceId].ip = ip;
        if (name) users[deviceId].name = name;
    }
    res.json({ ok: true, user: users[deviceId] });
});

/* ================= CHECK BLOCKED ================= */
app.get('/api/check-block/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const ip = getClientIP(req);
    const isBlocked = blockedIPs.has(ip) || blockedDevices.has(deviceId);
    res.json({ ok: true, blocked: isBlocked });
});

/* ================= USER SEND MESSAGE ================= */
app.post('/api/send', async (req, res) => {
    const { deviceId, text, name, image } = req.body;
    const ip = getClientIP(req);

    if (blockedIPs.has(ip)) return res.status(403).json({ ok: false, error: 'Blocked', blocked: true });
    if (blockedDevices.has(deviceId)) return res.status(403).json({ ok: false, error: 'Blocked', blocked: true });
    if (!deviceId || (!text && !image)) return res.status(400).json({ ok: false, error: 'Missing data' });
    if (text && hasBadWord(text)) return res.status(400).json({ ok: false, error: 'Bad words' });

    const userName = name || users[deviceId]?.name || 'User';
    let imageUrl = '';

    if (image) {
        imageUrl = await uploadToImgBB(image);
        if (!imageUrl) return res.status(500).json({ ok: false, error: 'Image upload failed' });
    }

    const tgText = `💬 <b>${userName}</b>\n${text || ''}`;
    let tgResult;

    if (imageUrl) {
        tgResult = await tgAPI('sendPhoto', {
            chat_id: GROUP_CHAT_ID, photo: imageUrl,
            caption: tgText.substring(0, 1024), parse_mode: 'HTML'
        });
    } else {
        tgResult = await tgAPI('sendMessage', {
            chat_id: GROUP_CHAT_ID, text: tgText, parse_mode: 'HTML'
        });
    }

    const stored = {
        id: genId(),
        tgMessageId: tgResult.ok ? tgResult.result.message_id : null,
        userId: deviceId, userName: userName,
        text: text || '', image: imageUrl,
        isAdmin: false, fromApp: true,
        timestamp: Date.now(), ip: ip
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();

    if (users[deviceId]) {
        users[deviceId].messageCount = (users[deviceId].messageCount || 0) + 1;
        users[deviceId].lastSeen = Date.now();
        users[deviceId].ip = ip;
    }

    const today = new Date().toISOString().split('T')[0];
    if (!dailyStats[today]) dailyStats[today] = { activeUsers: 0, quizzes: 0, messages: 0 };
    dailyStats[today].messages = (dailyStats[today].messages || 0) + 1;

    res.json({ ok: true, message: stored });
});

/* ================= GET ALL MESSAGES ================= */
app.get('/api/messages', (req, res) => {
    const since = parseInt(req.query.since || '0');
    const limit = parseInt(req.query.limit || '200');
    let filtered = messages;
    if (since > 0) filtered = messages.filter(m => m.timestamp > since);
    res.json({ ok: true, messages: filtered.slice(0, limit).reverse(), count: filtered.length });
});

/* ================= ADMIN: GET ALL ================= */
app.get('/api/admin/messages', (req, res) => {
    const { key } = req.query;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    res.json({
        ok: true, messages: messages,
        users: Object.values(users),
        blockedIPs: Array.from(blockedIPs),
        blockedDevices: Array.from(blockedDevices),
        count: messages.length
    });
});

/* ================= ADMIN SEND ================= */
app.post('/api/admin/send', async (req, res) => {
    const { key, text, image } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    if (!text && !image) return res.status(400).json({ ok: false });

    let imageUrl = '';
    if (image) imageUrl = await uploadToImgBB(image);

    let tgResult;
    if (imageUrl) {
        tgResult = await tgAPI('sendPhoto', {
            chat_id: GROUP_CHAT_ID, photo: imageUrl,
            caption: `👑 <b>Admin</b>\n${text || ''}`.substring(0, 1024),
            parse_mode: 'HTML'
        });
    } else {
        tgResult = await tgAPI('sendMessage', {
            chat_id: GROUP_CHAT_ID,
            text: `👑 <b>Admin</b>\n${text}`,
            parse_mode: 'HTML'
        });
    }

    const stored = {
        id: genId(),
        tgMessageId: tgResult.ok ? tgResult.result.message_id : null,
        userId: 'admin', userName: 'Admin (Pinku Kumar)',
        text: text || '', image: imageUrl,
        isAdmin: true, timestamp: Date.now()
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();
    res.json({ ok: true, message: stored });
});

/* ================= ADMIN: DELETE ================= */
app.post('/api/admin/delete', async (req, res) => {
    const { key, messageId } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });

    const msg = messages.find(m => m.id === messageId);
    if (msg && msg.tgMessageId) {
        await tgAPI('deleteMessage', { chat_id: GROUP_CHAT_ID, message_id: msg.tgMessageId });
    }
    messages = messages.filter(m => m.id !== messageId);
    res.json({ ok: true });
});

/* ================= ADMIN: BLOCK/UNBLOCK ================= */
app.post('/api/admin/block-ip', (req, res) => {
    const { key, ip } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    if (ip) blockedIPs.add(ip);
    res.json({ ok: true });
});

app.post('/api/admin/unblock-ip', (req, res) => {
    const { key, ip } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    blockedIPs.delete(ip);
    res.json({ ok: true });
});

app.post('/api/admin/block-device', (req, res) => {
    const { key, deviceId } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    if (deviceId) blockedDevices.add(deviceId);
    res.json({ ok: true });
});

app.post('/api/admin/unblock-device', (req, res) => {
    const { key, deviceId } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    blockedDevices.delete(deviceId);
    res.json({ ok: true });
});

/* ================= LEADERBOARD: SUBMIT (XP) ================= */
app.post('/api/leaderboard/submit', async (req, res) => {
    const { deviceId, name, xp, correct, wrong, streak } = req.body;
    if (!deviceId) return res.status(400).json({ ok: false });

    if (!leaderboard[deviceId]) {
        leaderboard[deviceId] = {
            id: deviceId, name: name || 'User',
            xp: 0, quizzes: 0, correct: 0, wrong: 0,
            bestStreak: 0, joinedAt: Date.now(), lastPlayed: Date.now()
        };
    }

    const user = leaderboard[deviceId];
    user.xp += xp || 0;
    user.quizzes += 1;
    user.correct += correct || 0;
    user.wrong += wrong || 0;
    user.bestStreak = Math.max(user.bestStreak, streak || 0);
    user.lastPlayed = Date.now();
    if (name) user.name = name;

    const total = user.correct + user.wrong;
    user.accuracy = total > 0 ? Math.round((user.correct / total) * 100) : 0;

    const sorted = Object.values(leaderboard).sort((a, b) => b.xp - a.xp);
    const rank = sorted.findIndex(u => u.id === deviceId) + 1;

    const today = new Date().toISOString().split('T')[0];
    if (!dailyStats[today]) dailyStats[today] = { activeUsers: 0, quizzes: 0 };
    dailyStats[today].quizzes = (dailyStats[today].quizzes || 0) + 1;
    dailyStats[today].activeUsers = Object.keys(leaderboard).length;

    saveLeaderboard();
    res.json({ ok: true, rank, xp: user.xp, totalUsers: sorted.length });
});

/* ================= LEADERBOARD: DAILY SUBMIT (with Time) ================= */
app.post('/api/leaderboard/daily-submit', async (req, res) => {
    const { deviceId, name, correct, wrong, timeTaken, streak, totalQuestions } = req.body;
    if (!deviceId) return res.status(400).json({ ok: false });

    const negativeMark = wrong / 3;
    const score = Math.max(0, correct - negativeMark);
    const scoreRounded = Math.round(score * 100) / 100;

    const today = new Date().toISOString().split('T')[0];
    if (!dailyQuizRecords[today]) dailyQuizRecords[today] = {};

    const existing = dailyQuizRecords[today][deviceId];
    const isBetter = !existing ||
        scoreRounded > existing.score ||
        (scoreRounded === existing.score && timeTaken < existing.timeTaken);

    if (isBetter) {
        dailyQuizRecords[today][deviceId] = {
            id: deviceId, name: name || 'User',
            score: scoreRounded, correct: correct || 0, wrong: wrong || 0,
            timeTaken: timeTaken || 0, streak: streak || 0,
            totalQuestions: totalQuestions || 0,
            accuracy: correct > 0 ? Math.round((correct / (correct + wrong)) * 100) : 0,
            submittedAt: Date.now()
        };

        // Also update main XP leaderboard
        if (!leaderboard[deviceId]) {
            leaderboard[deviceId] = {
                id: deviceId, name: name || 'User',
                xp: 0, quizzes: 0, correct: 0, wrong: 0,
                bestStreak: 0, joinedAt: Date.now(), lastPlayed: Date.now()
            };
        }
        const u = leaderboard[deviceId];
        const xpGained = Math.max(0, correct * 10 - wrong * 3);
        u.xp += xpGained;
        u.quizzes += 1;
        u.correct += correct;
        u.wrong += wrong;
        u.bestStreak = Math.max(u.bestStreak, streak || 0);
        u.lastPlayed = Date.now();
        if (name) u.name = name;
        const tot = u.correct + u.wrong;
        u.accuracy = tot > 0 ? Math.round((u.correct / tot) * 100) : 0;

        saveLeaderboard();
    }

    const sorted = Object.values(dailyQuizRecords[today]).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
    });
    const rank = sorted.findIndex(u => u.id === deviceId) + 1;

    res.json({
        ok: true, rank, score: scoreRounded,
        totalUsers: sorted.length,
        xpGained: Math.max(0, correct * 10 - wrong * 3)
    });
});

/* ================= LEADERBOARD: GET TOP XP ================= */
app.get('/api/leaderboard', (req, res) => {
    const limit = parseInt(req.query.limit || '50');
    const sorted = Object.values(leaderboard)
        .sort((a, b) => {
            if (b.xp !== a.xp) return b.xp - a.xp;
            if (b.accuracy !== a.accuracy) return b.accuracy - a.accuracy;
            return b.bestStreak - a.bestStreak;
        })
        .slice(0, limit)
        .map((u, i) => ({ ...u, rank: i + 1 }));
    res.json({ ok: true, top: sorted, totalUsers: Object.keys(leaderboard).length, updatedAt: Date.now() });
});

/* ================= LEADERBOARD: GET DAILY ================= */
app.get('/api/leaderboard/daily', (req, res) => {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const limit = parseInt(req.query.limit || '50');
    const records = dailyQuizRecords[date] || {};
    const sorted = Object.values(records)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return a.timeTaken - b.timeTaken;
        })
        .slice(0, limit)
        .map((u, i) => ({ ...u, rank: i + 1 }));
    res.json({ ok: true, date, top: sorted, totalUsers: Object.keys(records).length });
});

/* ================= LEADERBOARD: GET STREAK ================= */
app.get('/api/leaderboard/streak', (req, res) => {
    const limit = parseInt(req.query.limit || '50');
    const sorted = Object.values(leaderboard)
        .sort((a, b) => b.bestStreak - a.bestStreak)
        .slice(0, limit)
        .map((u, i) => ({
            rank: i + 1, id: u.id, name: u.name,
            streak: u.bestStreak || 0, xp: u.xp,
            quizzes: u.quizzes, accuracy: u.accuracy
        }));
    res.json({ ok: true, top: sorted, totalUsers: Object.keys(leaderboard).length });
});

/* ================= LEADERBOARD: GET XP ================= */
app.get('/api/leaderboard/xp', (req, res) => {
    const limit = parseInt(req.query.limit || '50');
    const sorted = Object.values(leaderboard)
        .sort((a, b) => b.xp - a.xp)
        .slice(0, limit)
        .map((u, i) => ({
            rank: i + 1, id: u.id, name: u.name,
            xp: u.xp, quizzes: u.quizzes,
            accuracy: u.accuracy, bestStreak: u.bestStreak
        }));
    res.json({ ok: true, top: sorted, totalUsers: Object.keys(leaderboard).length });
});

/* ================= LEADERBOARD: USER RANK ================= */
app.get('/api/leaderboard/rank/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    if (!leaderboard[deviceId]) return res.json({ ok: true, rank: null, user: null });
    const sorted = Object.values(leaderboard).sort((a, b) => b.xp - a.xp);
    const rank = sorted.findIndex(u => u.id === deviceId) + 1;
    const total = sorted.length;
    res.json({
        ok: true, rank,
        user: leaderboard[deviceId],
        totalUsers: total,
        percentile: total > 0 ? Math.round(((total - rank) / total) * 100) : 0
    });
});

/* ================= LEADERBOARD: USER DAILY RANK ================= */
app.get('/api/leaderboard/daily-rank/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const records = dailyQuizRecords[date] || {};
    if (!records[deviceId]) return res.json({ ok: true, rank: null, user: null });
    const sorted = Object.values(records).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.timeTaken - b.timeTaken;
    });
    const rank = sorted.findIndex(u => u.id === deviceId) + 1;
    const total = sorted.length;
    res.json({
        ok: true, rank,
        user: records[deviceId],
        totalUsers: total,
        percentile: total > 0 ? Math.round(((total - rank) / total) * 100) : 0
    });
});

/* ================= STATS: DAILY ================= */
app.get('/api/stats/daily', (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    res.json({
        ok: true,
        today: dailyStats[today] || { activeUsers: 0, quizzes: 0, messages: 0 },
        allTime: {
            totalUsers: Object.keys(leaderboard).length,
            totalQuizzes: Object.values(leaderboard).reduce((s, u) => s + u.quizzes, 0),
            totalXP: Object.values(leaderboard).reduce((s, u) => s + u.xp, 0),
            totalMessages: messages.length
        }
    });
});

/* ================= START SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

module.exports = app;
