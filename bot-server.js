const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;
const ADMIN_USER_ID = process.env.ADMIN_USER_ID;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY || 'Pinku@2026';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

let messages = [];
let users = {};
const MAX_MSG = 500;

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

const BAD_WORDS = ['fuck', 'shit', 'bitch'];
function hasBadWord(text) {
    const l = (text || '').toLowerCase();
    return BAD_WORDS.some(w => l.includes(w));
}

app.post('/webhook', async (req, res) => {
    res.sendStatus(200);
    const update = req.body;

    try {
        if (!update.message) return;
        const msg = update.message;
        if (msg.chat.id.toString() !== GROUP_CHAT_ID) return;
        if (msg.from.is_bot) return;

        const text = msg.text || msg.caption || '';
        if (!text) return;

        if (hasBadWord(text)) {
            await tgAPI('deleteMessage', {
                chat_id: GROUP_CHAT_ID,
                message_id: msg.message_id
            });
            return;
        }

        const isAdmin = msg.from.id.toString() === ADMIN_USER_ID;
        let replyToUserId = null;
        if (isAdmin && msg.reply_to_message) {
            const originalMsgId = msg.reply_to_message.message_id;
            const original = messages.find(m => m.tgMessageId === originalMsgId);
            if (original) replyToUserId = original.userId;
        }

        const stored = {
            id: genId(),
            tgMessageId: msg.message_id,
            userId: isAdmin ? (replyToUserId || 'admin') : msg.from.id.toString(),
            userName: isAdmin ? 'Admin (Pinku Kumar)' : `${msg.from.first_name || 'User'}${msg.from.last_name ? ' ' + msg.from.last_name : ''}`,
            text: text,
            isAdmin: isAdmin,
            timestamp: msg.date * 1000,
            date: new Date(msg.date * 1000).toISOString()
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

app.post('/api/register', (req, res) => {
    const { name, deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ ok: false });
    if (!users[deviceId]) {
        users[deviceId] = { id: deviceId, name: name || 'Anonymous', lastSeen: Date.now(), isAppUser: true };
    } else {
        users[deviceId].lastSeen = Date.now();
        if (name) users[deviceId].name = name;
    }
    res.json({ ok: true, user: users[deviceId] });
});

app.post('/api/user/send', async (req, res) => {
    const { deviceId, text, name } = req.body;
    if (!deviceId || !text) return res.status(400).json({ ok: false });
    if (hasBadWord(text)) return res.status(400).json({ ok: false, error: 'Bad words' });

    const userName = name || users[deviceId]?.name || 'App User';
    const tgText = `💬 <b>Question from ${userName}</b>\n\n${text}\n\n<i>— App User | Reply to this</i>`;

    const result = await tgAPI('sendMessage', {
        chat_id: GROUP_CHAT_ID,
        text: tgText,
        parse_mode: 'HTML'
    });

    if (!result.ok) return res.status(500).json({ ok: false });

    const stored = {
        id: genId(),
        tgMessageId: result.result.message_id,
        userId: deviceId,
        userName: userName,
        text: text,
        isAdmin: false,
        fromApp: true,
        timestamp: Date.now()
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();
    res.json({ ok: true, message: stored });
});

app.get('/api/user/messages/:deviceId', (req, res) => {
    const { deviceId } = req.params;
    const since = parseInt(req.query.since || '0');
    let userMessages = messages.filter(m => m.userId === deviceId);
    if (since > 0) userMessages = userMessages.filter(m => m.timestamp > since);
    res.json({ ok: true, messages: userMessages.reverse() });
});

app.get('/api/admin/messages', (req, res) => {
    const { key } = req.query;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    res.json({ ok: true, messages, users: Object.values(users) });
});

app.post('/api/admin/reply', async (req, res) => {
    const { key, userId, text } = req.body;
    if (key !== ADMIN_SECRET_KEY) return res.status(401).json({ ok: false });
    if (!userId || !text) return res.status(400).json({ ok: false });

    const user = users[userId];
    const userName = user ? user.name : 'User';

    const result = await tgAPI('sendMessage', {
        chat_id: GROUP_CHAT_ID,
        text: `👑 <b>Admin Reply to ${userName}</b>\n\n${text}`,
        parse_mode: 'HTML'
    });

    if (!result.ok) return res.status(500).json({ ok: false });

    const stored = {
        id: genId(),
        tgMessageId: result.result.message_id,
        userId: userId,
        userName: 'Admin',
        text: text,
        isAdmin: true,
        timestamp: Date.now()
    };

    messages.unshift(stored);
    if (messages.length > MAX_MSG) messages.pop();
    res.json({ ok: true, message: stored });
});

app.get('/', (req, res) => {
    res.json({ ok: true, status: 'Running', messages: messages.length });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Port ${PORT}`));

module.exports = app;
