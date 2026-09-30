const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

/* ================= CONFIG ================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'Pinku@2026Secret';
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/* ================= STORAGE ================= */
let messages = [];
let users = {};
const MAX_MSG = 1000;

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

/* ================= BAD WORDS ================= */
const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'gaali', 'bhosdi', 'madarchod', 'bhenchod'];
function hasBadWord(text) {
    const l = (text || '').toLowerCase();
    return BAD_WORDS.some(w => l.includes(w));
}

/* ================= IMGBB UPLOAD ================= */
async function uploadToImgBB(base64Image) {
    if (!IMGBB_API_KEY) {
        console.error('No ImgBB key');
        return null;
    }
    try {
        const formData = new URLSearchParams();
        formData.append('key', IMGBB_API_KEY);
        formData.append('image', base64Image.replace(/^data:image\/\w+;base64,/, ''));

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
        if (!text && !msg.photo) return;

        if (text && hasBadWord(text)) {
            await tgAPI('deleteMessage', {
                chat_id: GROUP_CHAT_ID,
                message_id: msg.message_id
            });
            return;
        }

        const isAdmin = msg.from.id.toString() === ADMIN_USER_ID;

        let imageUrl = '';
        if (msg.photo && msg.photo.length > 0) {
            const largest = msg.photo[msg.photo.length - 1];
            const fileInfo = await tgAPI('getFile', { file_id: largest.file_id });
            if (fileInfo.ok) {
                imageUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`;
            }
        }

        const stored = {
            id: genId(),
            tgMessageId: msg.message_id,
            userId: isAdmin ? 'admin' : msg.from.id.toString(),
            userName: isAdmin ? 'Admin (Pinku Kumar)' : `${msg.from.first_name || 'User'}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
            text: text,
            image: imageUrl,
            isAdmin: isAdmin,
            fromTelegram: true,
            timestamp: msg.date * 1000
        };

        messages.unshift(stored);
        if (messages.length > MAX_MSG) messages.pop();

        if (!isAdmin) {
            users[msg.from.id] = {
                id: msg.from.id,
                name: stored.userName,
                username: msg.from.username || '',
                lastSeen: Date.now()
            };
        }
    } catch(e) {
        console.error('Webhook error:', e);
    }
});

/* ================= REGISTER USER ================= */
app.post('/api/register', (req, res) => {
    const { name, deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ ok: false });
    
    if (!users[deviceId]) {
        users[deviceId] = {
            id: deviceId,
            name: name || 'Anonymous',
            registeredAt: Date.now(),
            lastSeen: Date.now(),
            isAppUser: true
        };
    } else {
        users[deviceId].lastSeen = Date.now();
        if (name) users[deviceId].name = name;
    }
    res.json({ ok: true, user: users[deviceId] });
});

/* ================= USER SEND → BROADCAST TO ALL ================= */
app.post('/api/send', async (req, res) => {
    const { deviceId, text, name, image } = req.body;
    
    if (!deviceId || (!text && !image)) {
        return res.status(400).json({ ok: false, error: 'Missing data' });
    }

    if (text && hasBadWord(text)) {
        return res.status(400).json({ ok: false, error: 'Bad words not allowed' });
    }

    const userName = name || users[deviceId]?.name || 'User';
    let imageUrl = '';

    if (image) {
        imageUrl = await uploadToImgBB(image);
        if (!imageUrl) {
            return res.status(500).json({ ok: false, error: 'Image upload failed' });
        }
    }

    // Send to Telegram group (BACKUP + Admin sees it)
    const tgText = `💬 <b>${userName}</b>\n\n${text || ''}`;
    let tgResult;

    if (imageUrl) {
        tgResult = await tgAPI('sendPhoto', {
            chat_id: GROUP_CHAT_ID,
            photo: imageUrl,
            caption: tgText.substring(0, 1024),
            parse_mode: 'HTML'
        });
    } else {
        tgResult = await tgAPI('sendMessage', {
            chat_id: GROUP_CHAT_ID,
            text: tgText,
            parse_mode: 'HTML'
        });
    }

    // Store in memory (all users see this)
    const stored = {
        id: genId(),
        tgMessageId: tgResult.ok ? tgResult.result.message_id : null,
        userId: deviceId,
        userName: userName,
        text: text || '',
        image: imageUrl,
        isAdmin: false,
        fromApp: true,
        timestamp: Date.now()
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();

    res.json({ ok: true, message: stored });
});

/* ================= GET ALL MESSAGES (GROUP FEED) ================= */
app.get('/api/messages', (req, res) => {
    const since = parseInt(req.query.since || '0');
    const limit = parseInt(req.query.limit || '200');
    
    let filtered = messages;
    if (since > 0) {
        filtered = messages.filter(m => m.timestamp > since);
    }
    
    res.json({
        ok: true,
        messages: filtered.slice(0, limit).reverse(),
        count: filtered.length
    });
});

/* ================= ADMIN: GET ALL ================= */
app.get('/api/admin/messages', (req, res) => {
    const { key } = req.query;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    res.json({
        ok: true,
        messages: messages,
        users: Object.values(users),
        count: messages.length
    });
});

/* ================= ADMIN SEND (BROADCAST) ================= */
app.post('/api/admin/send', async (req, res) => {
    const { key, text, image } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    if (!text && !image) return res.status(400).json({ ok: false });

    let imageUrl = '';
    if (image) imageUrl = await uploadToImgBB(image);

    let tgResult;
    if (imageUrl) {
        tgResult = await tgAPI('sendPhoto', {
            chat_id: GROUP_CHAT_ID,
            photo: imageUrl,
            caption: `👑 <b>Admin (Pinku Kumar)</b>\n\n${text || ''}`.substring(0, 1024),
            parse_mode: 'HTML'
        });
    } else {
        tgResult = await tgAPI('sendMessage', {
            chat_id: GROUP_CHAT_ID,
            text: `👑 <b>Admin (Pinku Kumar)</b>\n\n${text}`,
            parse_mode: 'HTML'
        });
    }

    const stored = {
        id: genId(),
        tgMessageId: tgResult.ok ? tgResult.result.message_id : null,
        userId: 'admin',
        userName: 'Admin (Pinku Kumar)',
        text: text || '',
        image: imageUrl,
        isAdmin: true,
        timestamp: Date.now()
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();

    res.json({ ok: true, message: stored });
});

/* ================= ADMIN DELETE ================= */
app.post('/api/admin/delete', async (req, res) => {
    const { key, messageId } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });

    const msg = messages.find(m => m.id === messageId);
    if (msg && msg.tgMessageId) {
        await tgAPI('deleteMessage', {
            chat_id: GROUP_CHAT_ID,
            message_id: msg.tgMessageId
        });
    }

    messages = messages.filter(m => m.id !== messageId);
    res.json({ ok: true });
});

/* ================= HEALTH CHECK ================= */
app.get('/', (req, res) => {
    res.json({
        ok: true,
        status: 'Group Chat Server Running',
        messages: messages.length,
        users: Object.keys(users).length
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));

module.exports = app;
