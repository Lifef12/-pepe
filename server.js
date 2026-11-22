const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '6959332288');
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

if (!BOT_TOKEN || !MONGO_URI || !ADMIN_USERNAME || !ADMIN_PASSWORD || !ADMIN_ID) {
    console.error('❌ Missing env: BOT_TOKEN, MONGO_URI, ADMIN_USERNAME, ADMIN_PASSWORD, ADMIN_ID required.');
    process.exit(1);
}

const WEBHOOK_SECRET = crypto.createHash('sha256').update('wh' + BOT_TOKEN).digest('hex').slice(0, 32);

// ---------- COIN ($PEPE) ----------
// Balance database me INTEGER (whole $PEPE) me rakha jata hai. (Frontend CFG se match hona zaroori hai)
const COIN = '$PEPE';
const BOT_USERNAME = 'PepeRewardsTg_Bot';
const fmtD = n => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });

const TASK_REWARD = 300;              // default per task
const TASK_REWARDS = { tg2: 300, yt1: 300, yt2: 300, wa1: 300 };   // per-task reward
const rewardFor = id => TASK_REWARDS[id] || TASK_REWARD;
const REF_BONUS = 600;                // per verified friend
const JOIN_BONUS = 200;               // pehli baar verify par
const MIN_WITHDRAW = 7000;            // minimum withdraw
const MIN_REFS = 4;                   // withdraw ke liye kam az kam itne VERIFIED referrals
const CHECKIN = [50, 75, 100, 150, 200, 250, 300];   // 7 din ka daily check-in
const WHEEL_BIG = 300, WHEEL_SMALL = 100, WHEEL_BIG_CHANCE = 20;   // % chance of 300

// ---------- TAP SYSTEM (energy + daily cap) ----------
const TAP_BASE = 1;                   // $PEPE per tap
const TAP_CAP = 500;                  // daily tap limit (UTC din)
const MAX_ENERGY = 500;
const REGEN = 0.1;                    // energy / second
const MAX_TPS = 14;                   // insani limit: taps / second

const YT_CLAIM_DELAY = 10 * 1000;     // Submit ke kitni der baad Claim

// ---------- CHANNELS ----------
// id = frontend ke data-id se match (c1 / c3). YouTube / WhatsApp ka server check nahi ho sakta.
const CHANNEL_UPDATES = { key: 'c1', id: '@updatechanneluta', name: 'Official Updates Channel', url: 'https://t.me/updatechanneluta' };
const CHANNEL_PAYOUTS = { key: 'c3', id: '@cryptotech16', name: 'Official Payouts Channel', url: 'https://t.me/cryptotech16' };
const VERIFY_CHANNELS = [CHANNEL_UPDATES, CHANNEL_PAYOUTS];

// Telegram task (bot ko @paymentchanneluta me admin banana zaroori)
const TASK_CHANNEL = { id: '@paymentchanneluta', name: 'Telegram Task Channel' };

// Har paid withdraw yahan auto post hota hai
const PAYMENT_CHANNEL = '@cryptotech16';

// Open -> Submit -> Claim flow wale tasks (YouTube + WhatsApp)
const YT_TASKS = ['yt1', 'yt2', 'wa1'];
const WA_CHANNEL_URL = 'https://whatsapp.com/channel/0029VbD5A2Q3LdQREXOzuk3i';

const WELCOME_IMG = process.env.WELCOME_IMG !== undefined ? process.env.WELCOME_IMG : '';
const WELCOME_TEXT = 'Hello, welcome to <b>$PEPE Rewards</b>! 🐸 Get ready for an exciting earning experience!\n\n' +
    'Tap the frog, spin the daily wheel, complete missions, and invite your friends to earn $PEPE rewards!\n\n' +
    '🔥 <b>Let\'s earn with $PEPE Rewards!</b>';

// ---------- DATABASE ----------
async function connectDB() {
    try {
        await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 15000 });
        console.log('✅ MongoDB connected');
    } catch (err) {
        console.error('❌ MongoDB error:', err.message, '- retrying in 10s');
        setTimeout(connectDB, 10000);
    }
}
connectDB();
const dbReady = () => mongoose.connection.readyState === 1;

const UserSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true },
    username: { type: String, default: 'User' },
    balance: { type: Number, default: 0 },
    total: { type: Number, default: 0 },              // lifetime earned (rank + leaderboard)
    isVerified: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    deviceOk: { type: Boolean, default: false },
    tasks: {
        tg2: { type: Boolean, default: false },
        yt1: { type: Boolean, default: false },
        yt2: { type: Boolean, default: false },
        wa1: { type: Boolean, default: false }
    },
    // tap + energy
    tapDay: { type: String, default: '' },
    tapToday: { type: Number, default: 0 },
    energy: { type: Number, default: MAX_ENERGY },
    energyAt: { type: Number, default: Date.now },
    lastTapAt: { type: Number, default: 0 },
    // daily check-in + wheel (UTC din)
    ciDay: { type: String, default: '' },
    ciStreak: { type: Number, default: 0 },
    spinDay: { type: String, default: '' },
    wallet: { type: String, default: null },
    referredBy: { type: String, default: null },
    refCredited: { type: Boolean, default: false },
    joinBonus: { type: Boolean, default: false },
    referrals: { type: Array, default: [] },
    totalWithdrawn: { type: Number, default: 0 },
    withdrawals: { type: Array, default: [] },
    createdAt: { type: Number, default: Date.now }
});
UserSchema.index({ wallet: 1 }, { unique: true, partialFilterExpression: { wallet: { $type: 'string' } } });
UserSchema.index({ referredBy: 1 });
UserSchema.index({ total: -1 });
const User = mongoose.model('User', UserSchema);

mongoose.connection.on('open', async () => {
    try {
        const a = await User.collection.updateMany({ referrals: { $not: { $type: 'array' } } }, { $set: { referrals: [] } });
        const b = await User.collection.updateMany({ withdrawals: { $not: { $type: 'array' } } }, { $set: { withdrawals: [] } });
        console.log('🛠 Array fields fixed -> referrals:', a.modifiedCount, '| withdrawals:', b.modifiedCount);
    } catch (e) { console.log('Array fix error:', e.message); }
});

const PendingRequest = mongoose.model('PendingRequest', new mongoose.Schema({
    reqId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, unique: true },
    amount: { type: Number, required: true },
    address: { type: String, required: true }
}));

const PendingClaim = mongoose.model('PendingClaim', new mongoose.Schema({
    userId: { type: String, required: true, unique: true },
    task: { type: String, required: true },
    createdAt: { type: Number, default: Date.now }
}));

// ---------- MULTIPLE ACCOUNT DETECTION (1 device = 1 account) ----------
const DEVICE_LOCK = true;
const FP_LOCK = true;

const Device = mongoose.model('Device', new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    fp: { type: String, default: '', index: true },
    fp2: { type: String, default: '', index: true },
    ip: { type: String, default: '' },
    createdAt: { type: Number, default: Date.now },
    lastSeen: { type: Number, default: Date.now }
}));

const conflictLogged = new Set();
function normIp(ip) {
    ip = String(ip || '').replace(/^::ffff:/, '');
    if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':');
    return ip;
}

// returns null (ok) | 'conflict' | 'missing'   ("pehla account jeetta hai")
async function deviceConflict(userId, deviceId, fp, fp2, ip, skipFp) {
    if (!deviceId || deviceId.length < 8 || deviceId.length > 100) return 'missing';
    const or = [{ deviceId }];
    // Fingerprint tabhi match jab fp + fp2 + ip TEENO same hon
    if (FP_LOCK && !skipFp && fp && fp2 && ip) or.push({ fp, fp2, ip });

    const others = await Device.find({ userId: { $ne: userId }, $or: or }, { userId: 1, deviceId: 1, createdAt: 1 });
    const mine = await Device.findOne({ deviceId, userId });

    if (others.length) {
        const oldestOther = Math.min(...others.map(o => o.createdAt));
        if (!mine || mine.createdAt >= oldestOther) {
            const first = others.find(o => o.createdAt === oldestOther) || others[0];
            const lk = userId + '>' + first.userId;
            if (!conflictLogged.has(lk)) {
                if (conflictLogged.size > 5000) conflictLogged.clear();
                conflictLogged.add(lk);
                console.log(`🚫 Multi-account: user ${userId} blocked, matches older user ${first.userId} (${others.some(o => o.deviceId === deviceId) ? 'same deviceId' : 'same fingerprint + IP'})`);
            }
            return 'conflict';
        }
    }

    if (!mine) {
        try { await Device.create({ deviceId, userId, fp, fp2, ip }); }
        catch (e) {
            const d = await Device.findOne({ deviceId });
            if (d && d.userId !== userId) return 'conflict';
        }
    } else if (mine.fp !== fp || mine.fp2 !== fp2 || mine.ip !== ip) {
        await Device.updateOne({ deviceId, userId }, { $set: { fp, fp2, ip, lastSeen: Date.now() } });
    }
    return null;
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrap = fn => (req, res, next) => fn(req, res, next).catch(e => {
    console.log('Error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const earn = n => ({ balance: n, total: n });

// ---------- RATE LIMIT / REPLAY PROTECTION / LOCKS ----------
const rlMap = new Map();
function rl(key, max, win) {
    const now = Date.now();
    let e = rlMap.get(key);
    if (!e || now - e.t > win) { e = { n: 0, t: now }; rlMap.set(key, e); }
    e.n++;
    return e.n <= max;
}

const nonces = new Map();
const guardAt = new Map();
const meCheckAt = new Map();
const NONCE_TTL = 20 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [k, e] of rlMap) if (now - e.t > 120000) rlMap.delete(k);
    for (const [k, t] of nonces) if (t < now) nonces.delete(k);
    for (const [k, t] of guardAt) if (now - t > 3600000) guardAt.delete(k);
    for (const [k, t] of meCheckAt) if (now - t > 3600000) meCheckAt.delete(k);
}, 60000).unref();

const locks = new Map();
async function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    let release;
    const cur = new Promise(r => { release = r; });
    const chain = prev.then(() => cur);
    locks.set(key, chain);
    await prev;
    try { return await fn(); }
    finally { release(); if (locks.get(key) === chain) locks.delete(key); }
}

async function tg(method, body) {
    try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(8000)
        });
        return await r.json();
    } catch (e) {
        console.log('Telegram error:', method, e.message);
        return { ok: false, description: e.message };
    }
}

const sendMsg = (chat_id, text, reply_markup, html = true) =>
    tg('sendMessage', { chat_id, text, reply_markup, ...(html ? { parse_mode: 'HTML' } : {}) });

async function sendWelcome(chatId, reply_markup) {
    if (WELCOME_IMG) {
        const isGif = /\.(gif|mp4)(\?.*)?$/i.test(WELCOME_IMG);
        const r = await tg(isGif ? 'sendAnimation' : 'sendPhoto', {
            chat_id: chatId,
            [isGif ? 'animation' : 'photo']: WELCOME_IMG,
            caption: WELCOME_TEXT,
            parse_mode: 'HTML',
            reply_markup
        });
        if (r.ok) return r;
        console.log('Welcome image failed, sending text only:', r.description || '');
    }
    return sendMsg(chatId, WELCOME_TEXT, reply_markup);
}

// true = member, false = not member, null = Telegram error
async function isMember(channel, userId) {
    const r = await tg('getChatMember', { chat_id: channel, user_id: Number(userId) });
    if (!r.ok) {
        console.log('getChatMember failed for', channel, r.description || '');
        return null;
    }
    const s = r.result.status;
    return ['member', 'administrator', 'creator'].includes(s) || (s === 'restricted' && r.result.is_member === true);
}

// missing = frontend ke data-id (c1 / c3)
async function checkVerifyChannels(userId) {
    const results = await Promise.all(VERIFY_CHANNELS.map(ch => isMember(ch.id, userId)));
    if (results.some(m => m === null)) return { error: 'Channel check failed' };
    const missing = VERIFY_CHANNELS.filter((ch, i) => !results[i]).map(ch => ch.key);
    return { ok: missing.length === 0, missing };
}

async function telegramGuard(user) {
    if (!user.isVerified) return 'Please verify channels first.';
    const c = await checkVerifyChannels(user.id);
    if (c.error) return 'Could not verify right now, please try again shortly';
    if (!c.ok) {
        await User.updateOne({ id: user.id }, { isVerified: false });
        guardAt.delete(user.id);
        return 'Must join all channels and tap Check again.';
    }
    return null;
}

async function guardCached(user) {
    if (Date.now() - (guardAt.get(user.id) || 0) < 5 * 60 * 1000) return null;
    const g = await telegramGuard(user);
    if (!g) guardAt.set(user.id, Date.now());
    return g;
}

function validateInitData(initData) {
    if (!initData || initData.length > 4096) return null;
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
    const a = Buffer.from(calc), b = Buffer.from(hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 86400) return null;
    try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}

function displayName(u) { return u.username ? `@${u.username}` : (u.first_name || 'User'); }

async function auth(req, res, next) {
    try {
        if (!dbReady()) return res.status(503).json({ ok: false, error: 'Server is starting, please try again in a minute' });
        if (!rl('ip:' + req.ip, 600, 60000)) return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });

        const u = validateInitData(req.headers['x-init-data']);
        if (!u || !u.id) return res.status(401).json({ ok: false, error: 'Please open via bot.' });
        const id = String(u.id);

        // Replay protection
        const ts = Number(req.headers['x-ts']);
        const nonce = String(req.headers['x-nonce'] || '');
        if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 15 * 60 * 1000) {
            return res.status(400).json({ ok: false, error: 'Please set your phone date & time to automatic and reopen the app.' });
        }
        if (nonce.length < 8 || nonce.length > 64 || nonces.has(id + ':' + nonce) || nonces.size > 300000) {
            return res.status(400).json({ ok: false, error: 'Invalid request. Please reopen the app.' });
        }
        nonces.set(id + ':' + nonce, Date.now() + NONCE_TTL);

        if (!rl('u:' + id, 150, 60000)) return res.status(429).json({ ok: false, error: 'Too many requests. Please slow down.' });

        let user;
        try {
            user = await User.findOneAndUpdate(
                { id },
                { $set: { username: displayName(u) } },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
        } catch (e) {
            if (e && e.code === 11000) {
                user = await User.findOneAndUpdate({ id }, { $set: { username: displayName(u) } }, { new: true });
            } else throw e;
        }
        if (!user) return res.status(500).json({ ok: false, error: 'Server error' });
        if (user.isBanned) return res.status(403).json({ ok: false, banned: true, error: 'Your account is banned.' });

        if (DEVICE_LOCK) {
            const dev = await deviceConflict(
                id,
                String(req.headers['x-device-id'] || '').trim(),
                String(req.headers['x-device-fp'] || '').trim().slice(0, 64),
                String(req.headers['x-device-fp2'] || '').trim().slice(0, 64),
                normIp(req.ip),
                !!user.deviceOk
            );
            if (dev === 'conflict') {
                return res.status(403).json({ ok: false, code: 'MULTI_ACCOUNT', error: 'Multiple account detected. Only one account per device is allowed.' });
            }
            if (dev === 'missing') {
                return res.status(400).json({ ok: false, error: 'Please reopen the app from the bot.' });
            }
        }

        req.user = user;
        next();
    } catch (e) {
        console.log('Auth error:', e);
        res.status(500).json({ ok: false, error: 'Server error' });
    }
}

// ---------- STATE HELPERS ----------
const curEnergy = (u, now = Date.now()) => {
    const e = Number.isFinite(u.energy) ? u.energy : MAX_ENERGY;
    return Math.max(0, Math.min(MAX_ENERGY, e + Math.max(0, now - (u.energyAt || now)) / 1000 * REGEN));
};
const tapToday = u => (u.tapDay === utcDay() ? u.tapToday : 0);

// check-in: kal claim kiya tha to streak chalti hai, warna 0 se
function ciState(u) {
    const today = utcDay();
    const yest = utcDay(Date.now() - 864e5);
    const claimed = u.ciDay === today;
    const streak = (claimed || u.ciDay === yest) ? (u.ciStreak || 0) : 0;
    return { claimed, streak };
}

function cleanReferrals(list) {
    return (Array.isArray(list) ? list : []).map(r => {
        r = r || {};
        const id = r.id || r.userId || r.uid || r.user;
        if (!id) return null;
        const bonus = Number(r.bonus || r.amount);
        return {
            id: String(id),
            date: r.date || r.createdAt || r.time || null,
            bonus: Number.isFinite(bonus) && bonus > 0 ? bonus : REF_BONUS,
            status: 'COMPLETED'
        };
    }).filter(Boolean);
}

function publicUser(u, pending) {
    const ci = ciState(u);
    return {
        id: u.id,
        username: u.username,
        balance: u.balance,
        total: u.total || 0,
        serverTime: Date.now(),
        isVerified: u.isVerified,
        energy: Math.round(curEnergy(u) * 100) / 100,
        maxEnergy: MAX_ENERGY,
        tapValue: TAP_BASE,
        tapToday: tapToday(u),
        tapCap: TAP_CAP,
        checkin: ci,
        spinDone: u.spinDay === utcDay(),
        rules: { minWithdraw: MIN_WITHDRAW, minRefs: MIN_REFS },
        tasks: {
            tg2: !!(u.tasks && u.tasks.tg2),
            yt1: !!(u.tasks && u.tasks.yt1),
            yt2: !!(u.tasks && u.tasks.yt2),
            wa1: !!(u.tasks && u.tasks.wa1)
        },
        proof: pending ? { task: pending.task, status: 'ready' } : null,
        referrals: cleanReferrals(u.referrals),
        withdrawals: (Array.isArray(u.withdrawals) ? u.withdrawals : []).slice(0, 50),
        leaderboard: []
    };
}

// Top ranking: 60 second cache
let lbCache = { t: 0, list: [] };
async function leaderboardFor(u) {
    if (Date.now() - lbCache.t > 60000) {
        const top = await User.find({ total: { $gt: 0 }, isBanned: false }, { id: 1, username: 1, total: 1 })
            .sort({ total: -1 }).limit(10).lean();
        lbCache = { t: Date.now(), list: top.map(x => ({ id: x.id, name: x.username || 'User', total: x.total })) };
    }
    const out = lbCache.list.map(x => [x.id === u.id ? 'You' : x.name, x.total]);
    if (!lbCache.list.some(x => x.id === u.id) && (u.total || 0) > 0) out.push(['You', u.total]);
    return out.sort((a, b) => b[1] - a[1]);
}

// Team DB se banti hai: sirf VERIFIED friends dikhte hain
async function userView(u) {
    const p = await PendingClaim.findOne({ userId: u.id });
    const view = publicUser(u, p);
    const paid = new Map(cleanReferrals(u.referrals).map(r => [r.id, r]));
    const team = await User.find({ referredBy: u.id, isVerified: true }, { id: 1, createdAt: 1 })
        .sort({ createdAt: -1 }).limit(500).lean();
    const seen = new Set();
    const list = [];
    team.forEach(t => {
        seen.add(t.id);
        const r = paid.get(t.id);
        list.push({ id: t.id, date: r ? r.date : t.createdAt, bonus: r ? r.bonus : 0, status: 'COMPLETED' });
    });
    paid.forEach((r, id) => { if (!seen.has(id)) list.push(r); });
    view.referrals = list;
    try { view.leaderboard = await leaderboardFor(u); } catch (e) { console.log('leaderboard error:', e.message); }
    return view;
}

async function userStats(userId) {
    const id = String(userId);
    const [refs, u] = await Promise.all([
        User.countDocuments({ referredBy: id, isVerified: true }),
        User.findOne({ id }, { totalWithdrawn: 1, withdrawals: 1 }).lean()
    ]);
    const w = Array.isArray(u && u.withdrawals) ? u.withdrawals : [];
    return {
        refs,
        totalWithdrawn: (u && Number(u.totalWithdrawn)) || 0,
        paidCount: w.filter(x => x && String(x.status).toUpperCase() === 'PAID').length
    };
}
const statsLine = s =>
    `👥 Verified Referrals: <b>${s.refs}</b>\n` +
    `📤 Total Withdrawn: <b>${fmtD(s.totalWithdrawn)} ${COIN}</b> (${s.paidCount} paid)`;

// ---------- REFERRAL CREDIT ----------
async function creditReferral(userId) {
    const u = await User.findOne({ id: String(userId) });
    if (!u || !u.isVerified || !u.referredBy || u.referredBy === u.id) return false;
    const refId = u.referredBy;

    await User.collection.updateOne(
        { id: refId, referrals: { $not: { $type: 'array' } } },
        { $set: { referrals: [] } }
    );

    const refDoc = await User.findOne({ id: refId }, { referrals: 1 }).lean();
    if (!refDoc) return false;
    const inList = (Array.isArray(refDoc.referrals) ? refDoc.referrals : []).some(r => r && String(r.id) === u.id);
    if (inList) {
        if (!u.refCredited) await User.updateOne({ id: u.id }, { $set: { refCredited: true } });
        return false;
    }

    // atomic claim: sirf ek request credit kar sakti hai
    const claim = await User.findOneAndUpdate({ id: u.id, refCredited: { $ne: true } }, { $set: { refCredited: true } });
    if (!claim) return false;

    try {
        const ref = await User.findOneAndUpdate({ id: refId }, {
            $inc: earn(REF_BONUS),
            $push: { referrals: { id: u.id, date: new Date().toISOString(), bonus: REF_BONUS, status: 'COMPLETED' } }
        }, { new: true });
        if (!ref) throw new Error('referrer not found');
        console.log(`✅ Referral credited: ${u.id} -> ${ref.id}`);

        sendMsg(ref.id,
            `🎉 <b>New Referral Joined!</b>\n\n` +
            `👥 A new user has successfully joined through your referral link.\n\n` +
            `💰 <b>${fmtD(REF_BONUS)} ${COIN}</b> has been added to your balance!\n\n` +
            `🚀 Keep inviting friends and earn more ${COIN}!`
        ).then(r => { if (!r.ok) console.log('Referral notify failed:', r.description || ''); });
        return true;
    } catch (e) {
        await User.updateOne({ id: u.id }, { $set: { refCredited: false } });
        throw e;
    }
}

async function creditPendingForReferrer(refId) {
    const kids = await User.find({ referredBy: String(refId), isVerified: true }, { id: 1 }).limit(500).lean();
    if (!kids.length) return;
    const me = await User.findOne({ id: String(refId) }, { referrals: 1 }).lean();
    const have = new Set(cleanReferrals(me && me.referrals).map(r => r.id));
    for (const k of kids) if (!have.has(k.id)) await creditReferral(k.id);
}

// ---------- MIDDLEWARE ----------
app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-init-data, x-device-id, x-device-fp, x-device-fp2, x-ts, x-nonce');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/admin')) {
        // Admin panel kisi site me frame nahi ho sakta, cache nahi hota
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        // HTML kabhi cache na ho, taaki Telegram hamesha naya index.html le
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    }
}));
app.get('/health', (req, res) => res.send(dbReady() ? 'OK' : 'OK (database connecting)'));
app.get('/api/ping', (req, res) => res.json({ ok: true, db: dbReady(), version: 'pepe-rewards-v1' }));

// ---------- USER API ----------
async function backgroundVerifyCheck(userId, hasReferrer) {
    try {
        const r = await checkVerifyChannels(userId);
        if (r.ok === false) {
            await User.updateOne({ id: userId }, { isVerified: false });
            guardAt.delete(userId);
        } else if (r.ok === true) {
            try {
                if (hasReferrer) await creditReferral(userId);
                await creditPendingForReferrer(userId);
            } catch (e) { console.log('Referral step error (ignored):', e.message); }
        }
    } catch (e) { console.log('Background channel check error (ignored):', e.message); }
}

app.post('/api/me', auth, wrap(async (req, res) => {
    const u = req.user;
    if (u.isVerified && Date.now() - (meCheckAt.get(u.id) || 0) > 5 * 60 * 1000) {
        meCheckAt.set(u.id, Date.now());
        backgroundVerifyCheck(u.id, !!u.referredBy);
    }
    let data;
    try { data = await userView(u); }
    catch (e) { console.log('userView error, using basic view:', e.message); data = publicUser(u, null); }
    res.json({ ok: true, data });
}));

app.post('/api/verify', auth, wrap(async (req, res) => {
    const u = req.user;
    const r = await checkVerifyChannels(u.id);
    if (r.error) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!r.ok) return res.json({ ok: false, missing: r.missing, error: 'Must join all channels and tap Check again.' });

    await User.updateOne({ id: u.id }, { isVerified: true });
    meCheckAt.set(u.id, Date.now());

    const jb = await User.findOneAndUpdate(
        { id: u.id, joinBonus: { $ne: true } },
        { $set: { joinBonus: true }, $inc: earn(JOIN_BONUS) }
    );
    const gotJoin = !!jb;

    try { await creditReferral(u.id); }
    catch (e) { console.log('creditReferral error (ignored):', e.message); }

    const fresh = await User.findOne({ id: u.id });
    let data;
    try { data = await userView(fresh); }
    catch (e) { console.log('userView error in verify:', e.message); data = publicUser(fresh, null); }
    res.json({ ok: true, joinBonus: gotJoin, data });
}));

// ---------- TAP (energy + daily cap) ----------
app.post('/api/tap', auth, wrap(async (req, res) => {
    const id = req.user.id;
    const taps = Math.floor(Number(req.body.taps));
    if (!Number.isFinite(taps) || taps < 1 || taps > 60) return res.json({ ok: false, error: 'Invalid request' });

    const r = await withLock(id, async () => {
        const u = await User.findOne({ id });
        if (!u || !u.isVerified) return { error: 'Please verify channels first.' };
        const g = await guardCached(u);
        if (g) return { error: g };

        const now = Date.now();
        const done = tapToday(u);
        const energy = curEnergy(u, now);

        if (done >= TAP_CAP) return { error: 'Daily tap limit reached', u };
        if (energy < 1) return { error: 'Out of energy', u };

        // insani raftaar: pichle batch ke baad itne seconds me itne hi taps possible
        const elapsed = Math.min(now - (u.lastTapAt || 0), 10000);
        const allowed = Math.floor(elapsed / 1000 * MAX_TPS) + 5;
        const n = Math.min(taps, allowed, Math.floor(energy), TAP_CAP - done);
        if (n <= 0) return { u };

        const credit = n * TAP_BASE;
        const upd = await User.findOneAndUpdate(
            { id },
            {
                $set: { tapDay: utcDay(now), tapToday: done + n, energy: energy - n, energyAt: now, lastTapAt: now },
                $inc: earn(credit)
            },
            { new: true }
        );
        return { u: upd };
    });

    if (r.error) {
        return res.json({ ok: false, error: r.error, ...(r.u ? { data: await userView(r.u) } : {}) });
    }
    res.json({ ok: true, data: await userView(r.u) });
}));

// ---------- DAILY CHECK-IN (7 din ka cycle) ----------
app.post('/api/checkin', auth, wrap(async (req, res) => {
    const u = req.user;
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const today = utcDay();
    const st = ciState(u);
    if (st.claimed) return res.json({ ok: false, error: 'Already claimed' });
    const amount = CHECKIN[st.streak % 7];

    const done = await User.findOneAndUpdate(
        { id: u.id, ciDay: { $ne: today } },
        { $set: { ciDay: today, ciStreak: st.streak + 1 }, $inc: earn(amount) },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Already claimed' });
    res.json({ ok: true, amount, data: await userView(done) });
}));

// ---------- LUCKY WHEEL (din me ek baar, result server decide karta hai) ----------
app.post('/api/spin', auth, wrap(async (req, res) => {
    const u = req.user;
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const today = utcDay();
    const amount = crypto.randomInt(100) < WHEEL_BIG_CHANCE ? WHEEL_BIG : WHEEL_SMALL;
    const done = await User.findOneAndUpdate(
        { id: u.id, spinDay: { $ne: today } },
        { $set: { spinDay: today }, $inc: earn(amount) },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Already spun' });
    res.json({ ok: true, amount, data: await userView(done) });
}));

// ---------- TELEGRAM TASK (membership server check karta hai) ----------
app.post('/api/task', auth, wrap(async (req, res) => {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (taskId !== 'tg2') return res.json({ ok: false, error: 'Invalid task' });
    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });

    const m = await isMember(TASK_CHANNEL.id, u.id);
    if (m === null) return res.json({ ok: false, error: 'Could not verify right now, please try again shortly' });
    if (!m) return res.json({ ok: false, error: 'Please join the channel first!' });

    const done = await User.findOneAndUpdate(
        { id: u.id, 'tasks.tg2': { $ne: true } },
        { $set: { 'tasks.tg2': true }, $inc: earn(rewardFor('tg2')) },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed' });
    res.json({ ok: true, data: await userView(done) });
}));

// ---------- YOUTUBE + WHATSAPP TASKS (Open -> Submit -> Claim) ----------
async function ytSubmit(req, res) {
    const u = req.user;
    const taskId = String(req.body.taskId || '');
    if (!YT_TASKS.includes(taskId)) return res.json({ ok: false, error: 'Invalid task' });

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    if (u.tasks && u.tasks[taskId]) return res.json({ ok: false, error: 'Task already claimed' });

    const existing = await PendingClaim.findOne({ userId: u.id });
    if (existing) {
        if (existing.task === taskId) return res.json({ ok: true, alreadySubmitted: true, data: await userView(u) });
        return res.json({ ok: false, error: 'Please claim your pending reward first.', data: await userView(u) });
    }

    try { await PendingClaim.create({ userId: u.id, task: taskId, createdAt: Date.now() }); }
    catch (e) { return res.json({ ok: false, error: 'Please claim your pending reward first.' }); }
    res.json({ ok: true, data: await userView(u) });
}

async function ytClaim(req, res) {
    const u = req.user;
    const taskId = String(req.body.taskId || '');

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const pending = await PendingClaim.findOne({ userId: u.id });
    if (!pending || (taskId && pending.task !== taskId)) return res.json({ ok: false, error: 'Submit the task first' });

    const wait = pending.createdAt + YT_CLAIM_DELAY - Date.now();
    if (wait > 0) return res.json({ ok: false, error: `Please wait ${Math.ceil(wait / 1000)}s and try again.` });

    const pr = await PendingClaim.findOneAndDelete({ userId: u.id, task: pending.task });
    if (!pr) return res.json({ ok: false, error: 'Submit the task first' });

    const key = `tasks.${pr.task}`;
    const done = await User.findOneAndUpdate(
        { id: u.id, [key]: { $ne: true } },
        { $set: { [key]: true }, $inc: earn(rewardFor(pr.task)) },
        { new: true }
    );
    if (!done) return res.json({ ok: false, error: 'Task already claimed' });
    res.json({ ok: true, data: await userView(done) });
}

app.post('/api/yt/submit', auth, wrap(ytSubmit));
app.post('/api/yt/claim', auth, wrap(ytClaim));

// ---------- WITHDRAW ($PEPE BEP-20) ----------
const adminButtons = reqId => ({ inline_keyboard: [[{ text: '✅ Approve', callback_data: `approve_${reqId}` }, { text: '❌ Reject', callback_data: `reject_${reqId}` }]] });

async function notifyAdminRequest(reqId, user, amt, address) {
    let st = '';
    try { st = '\n' + statsLine(await userStats(user.id)); } catch (e) { console.log('userStats error:', e.message); }
    await sendMsg(ADMIN_ID,
        `📤 <b>New Withdraw Request</b>\n\n` +
        `👤 User ID: <code>${esc(user.id)}</code>\n` +
        `💰 Amount: <b>${fmtD(amt)} ${COIN}</b> (BEP-20)\n` +
        `🏦 Address: <code>${esc(address)}</code>` + st,
        adminButtons(reqId)
    );
}

app.post('/api/withdraw', auth, wrap(async (req, res) => {
    const u = req.user;
    if (!rl('wd:' + u.id, 5, 60000)) return res.json({ ok: false, error: 'Too many attempts. Please wait a minute.' });

    const amt = Math.floor(Number(req.body.amount));
    const address = String(req.body.address || '').trim();

    if (!u.isVerified) return res.json({ ok: false, error: 'Please verify channels first.' });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.json({ ok: false, error: 'Invalid BEP-20 wallet address!' });
    if (!Number.isFinite(amt) || amt < MIN_WITHDRAW) return res.json({ ok: false, error: `Minimum withdrawal is ${fmtD(MIN_WITHDRAW)} ${COIN}!` });
    if (amt > 1e12) return res.json({ ok: false, error: 'Invalid amount' });

    const refCount = await User.countDocuments({ referredBy: u.id, isVerified: true });
    if (refCount < MIN_REFS) {
        return res.json({ ok: false, error: `You need at least ${MIN_REFS} verified referrals to withdraw. You have ${refCount}.` });
    }

    const guard = await telegramGuard(u);
    if (guard) return res.json({ ok: false, error: guard });

    const addr = address.toLowerCase();
    if (u.wallet && u.wallet !== addr) {
        return res.json({ ok: false, error: 'Withdrawals go only to your first used wallet. Contact support to change it.' });
    }
    if (!u.wallet) {
        try { await User.updateOne({ id: u.id, wallet: null }, { $set: { wallet: addr } }); }
        catch (e) {
            if (e && e.code === 11000) return res.json({ ok: false, error: 'This wallet is already linked to another account.' });
            throw e;
        }
        const fresh = await User.findOne({ id: u.id });
        if (!fresh || fresh.wallet !== addr) return res.json({ ok: false, error: 'Withdrawals go only to your first used wallet.' });
    }

    const reqId = 'wd_' + crypto.randomBytes(6).toString('hex');
    try { await PendingRequest.create({ reqId, userId: u.id, amount: amt, address }); }
    catch (e) { return res.json({ ok: false, error: 'You already have a pending withdrawal request.' }); }

    let upd;
    try {
        upd = await User.findOneAndUpdate(
            { id: u.id, balance: { $gte: amt } },
            {
                $inc: { balance: -amt },
                $push: { withdrawals: { $each: [{ id: reqId, amount: amt, address, status: 'PENDING', date: new Date().toISOString() }], $position: 0 } }
            },
            { new: true }
        );
    } catch (e) {
        await PendingRequest.deleteOne({ reqId });
        throw e;
    }
    if (!upd) {
        await PendingRequest.deleteOne({ reqId });
        return res.json({ ok: false, error: 'Insufficient balance!' });
    }

    const view = await userView(upd);
    res.json({ ok: true, data: view });
    notifyAdminRequest(reqId, u, amt, address).catch(e => console.log('notifyAdminRequest error:', e.message));
}));

// ---------- WITHDRAW RESOLVE ----------
async function markPaid(pr) {
    const paidUser = await User.findOneAndUpdate(
        { id: pr.userId },
        { $set: { 'withdrawals.$[w].status': 'PAID' }, $inc: { totalWithdrawn: pr.amount } },
        { arrayFilters: [{ 'w.id': pr.reqId }], new: true }
    );
    sendMsg(pr.userId, `✅ Your withdrawal of <b>${fmtD(pr.amount)} ${COIN}</b> has been paid!`);

    const uname = paidUser && paidUser.username ? paidUser.username : 'User';
    sendMsg(PAYMENT_CHANNEL,
        `✅ <b>New Payment Sent!</b>\n\n` +
        `👤 User: <b>${esc(uname)}</b>\n` +
        `🆔 ID: <code>${esc(pr.userId)}</code>\n` +
        `💰 Amount: <b>${fmtD(pr.amount)} ${COIN}</b> (BEP-20)\n` +
        `🏦 Address: <code>${esc(pr.address)}</code>\n\n` +
        `🚀 Earn free ${COIN} with @${BOT_USERNAME}`
    ).then(r => { if (!r.ok) console.log('Payment channel post failed:', r.description || ''); });
}

async function resolveWithdraw(reqId, approve) {
    const pr = await PendingRequest.findOneAndDelete({ reqId: String(reqId) });
    if (!pr) return { ok: false, message: 'Request already handled / not found' };

    if (approve) {
        // Manual: admin pehle khud payment bhejta hai, phir Approve dabata hai
        await markPaid({ reqId: String(reqId), userId: pr.userId, amount: pr.amount, address: pr.address });
    } else {
        await User.updateOne(
            { id: pr.userId },
            { $set: { 'withdrawals.$[w].status': 'DECLINED' }, $inc: { balance: pr.amount } },
            { arrayFilters: [{ 'w.id': String(reqId) }] }
        );
        sendMsg(pr.userId, `❌ Your withdrawal of <b>${fmtD(pr.amount)} ${COIN}</b> was declined and the amount was refunded.`);
    }
    return { ok: true, pr };
}

// ---------- TELEGRAM WEBHOOK ----------
app.post('/api/webhook', async (req, res) => {
    const got = String(req.headers['x-telegram-bot-api-secret-token'] || '');
    if (got.length !== WEBHOOK_SECRET.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(WEBHOOK_SECRET))) return res.sendStatus(403);
    res.sendStatus(200);

    try {
        const update = req.body;

        if (update.message && update.message.text !== undefined) {
            const msg = update.message;
            const chatId = String(msg.chat.id);
            const text = msg.text || '';
            if (msg.chat.type !== 'private') return;

            const known = await User.findOne({ id: chatId });
            if (known && known.isBanned) return sendMsg(chatId, '⚠️ <b>Access Denied:</b> Your account has been banned.');

            if (text.startsWith('/start')) {
                const m = text.match(/^\/start(?:@\w+)?\s+(?:ref_?)?(\d{1,20})\s*$/i);
                let referrer = m ? m[1] : null;
                if (referrer === chatId) referrer = null;
                if (referrer && !(await User.exists({ id: referrer }))) {
                    console.log('Referral: referrer not found in DB', referrer);
                    referrer = null;
                }

                const name = displayName(msg.from);
                let user;
                try {
                    user = await User.findOneAndUpdate({ id: chatId }, { $set: { username: name } }, { upsert: true, new: true, setDefaultsOnInsert: true });
                } catch (e) {
                    if (e && e.code === 11000) user = await User.findOneAndUpdate({ id: chatId }, { $set: { username: name } }, { new: true });
                    else throw e;
                }
                // Referrer sirf link hota hai; bonus verification success par milta hai
                if (referrer && user && !user.referredBy && !user.isVerified) {
                    await User.updateOne({ id: chatId, referredBy: null }, { $set: { referredBy: referrer } });
                    console.log(`Referral linked: ${chatId} <- ${referrer}`);
                }

                const kb = [
                    [{ text: '📢 Official Updates Channel', url: CHANNEL_UPDATES.url }],
                    [{ text: '💸 Official Payouts Channel', url: CHANNEL_PAYOUTS.url }]
                ];
                await sendWelcome(chatId, { inline_keyboard: kb });
            } else if (text === '/admin' && chatId === ADMIN_ID) {
                await sendMsg(chatId, '👑 <b>$PEPE Rewards Admin</b>',
                    PUBLIC_URL ? { inline_keyboard: [[{ text: '🔐 Admin Login Panel', url: `${PUBLIC_URL}/admin/login` }]] } : undefined);
            }

        } else if (update.callback_query) {
            const q = update.callback_query;
            const chatId = String(q.message.chat.id);
            const m = (q.data || '').match(/^(approve|reject)_(wd_[a-f0-9]+)$/);
            if (!m) return;

            if (chatId !== ADMIN_ID) return tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Unauthorized!' });

            const approve = m[1] === 'approve';
            const r = await resolveWithdraw(m[2], approve);
            if (!r.ok) return tg('answerCallbackQuery', { callback_query_id: q.id, text: String(r.message || 'Already handled!').slice(0, 190), show_alert: true });

            tg('editMessageText', {
                chat_id: chatId,
                message_id: q.message.message_id,
                parse_mode: 'HTML',
                text: `${approve ? '✅ <b>Approved</b>' : '❌ <b>Rejected</b>'}\nUser ID: ${esc(r.pr.userId)}\nAmount: ${fmtD(r.pr.amount)} ${COIN}`
            });
            tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Done!' });
        }
    } catch (e) {
        console.log('Webhook error:', e);
    }
});

// ---------- ADMIN PANEL ----------
const sessions = new Map();
const attempts = new Map();
const parseCookies = h => Object.fromEntries(
    (h || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(p => [p[0], decodeURIComponent(p.slice(1).join('='))])
);
const safeEq = (a, b) => {
    const x = crypto.createHash('sha256').update(String(a)).digest();
    const y = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(x, y);
};

// ---------- ADMIN 2FA (TOTP) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32decode(str) {
    let bits = '';
    for (const c of str) { const i = B32.indexOf(c); if (i < 0) return null; bits += i.toString(2).padStart(5, '0'); }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(bytes);
}
function b32encode(buf) {
    let bits = '', out = '';
    for (const b of buf) bits += b.toString(2).padStart(8, '0');
    for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return out;
}
function totpAt(key, step) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(step));
    const h = crypto.createHmac('sha1', key).update(buf).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 1000000).padStart(6, '0');
}
const ADMIN_TOTP_SECRET = (process.env.ADMIN_TOTP_SECRET || '').replace(/[\s=-]/g, '').toUpperCase();
if (ADMIN_TOTP_SECRET && !(b32decode(ADMIN_TOTP_SECRET) || []).length) {
    console.error('❌ ADMIN_TOTP_SECRET invalid (base32 A-Z, 2-7 hona chahiye).');
    process.exit(1);
}
const TOTP_ON = !!ADMIN_TOTP_SECRET;
const setupSecret = b32encode(crypto.randomBytes(20));
let lastTotpStep = 0;
function verifyTotp(secret, code) {
    const key = b32decode(secret);
    code = String(code || '').replace(/\s/g, '');
    if (!key || !key.length || !/^\d{6}$/.test(code)) return false;
    const cur = Math.floor(Date.now() / 30000);
    for (let d = -1; d <= 1; d++) {
        const st = cur + d;
        if (st > lastTotpStep && safeEq(totpAt(key, st), code)) { lastTotpStep = st; return true; }
    }
    return false;
}

function checkAdmin(req, res, next) {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t && sessions.has(t) && sessions.get(t) > Date.now()) return next();
    if (req.method === 'GET') return res.redirect('/admin/login');
    return res.status(401).json({ ok: false, message: 'Not logged in' });
}

// CSRF: admin POST sirf apni hi site se (Origin check)
function sameOrigin(req, res, next) {
    const o = req.headers.origin;
    if (o && PUBLIC_URL && o.replace(/\/$/, '') !== PUBLIC_URL) return res.status(403).json({ ok: false, message: 'Bad origin' });
    next();
}

app.get('/admin/login', (req, res) => {
    res.send(`<!DOCTYPE html><html><head><title>Admin Login</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#080c17;color:#fff;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.c{background:#111829;border:1px solid #222d4a;padding:30px;border-radius:16px;width:90%;max-width:360px;text-align:center}h2{color:#3df5be}input{width:100%;padding:12px;margin-bottom:12px;background:#080c17;border:1px solid #2a3a55;color:#fff;border-radius:8px}button{width:100%;padding:12px;background:#3df5be;color:#031410;font-weight:bold;border:none;border-radius:8px;cursor:pointer}</style></head>
<body><div class="c"><h2>🐸 $PEPE Rewards Admin</h2><form action="/admin/login" method="POST"><input name="username" placeholder="Username" required><input type="password" name="password" placeholder="Password" required>${TOTP_ON ? '<input name="code" placeholder="2FA Code (6 digits)" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required>' : ''}<button>Login</button></form></div></body></html>`);
});

app.post('/admin/login', (req, res) => {
    const ip = req.ip;
    const a = attempts.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - a.t > 15 * 60 * 1000) { a.n = 0; a.t = Date.now(); }
    if (a.n >= 5) return res.status(429).send('Too many attempts. Try again in 15 minutes.');

    const { username = '', password = '', code = '' } = req.body;
    const passOk = safeEq(username, ADMIN_USERNAME) & safeEq(password, ADMIN_PASSWORD);
    const codeOk = !TOTP_ON || verifyTotp(ADMIN_TOTP_SECRET, code);
    if (passOk && codeOk) {
        attempts.delete(ip);
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + 24 * 3600 * 1000);
        res.setHeader('Set-Cookie',
            `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${PUBLIC_URL.startsWith('https') ? '; Secure' : ''}`);
        return res.redirect('/admin/dashboard');
    }
    a.n++;
    attempts.set(ip, a);
    res.send(`<script>alert('Invalid Credentials!');location.href='/admin/login'</script>`);
});

app.get('/admin/2fa-setup', checkAdmin, (req, res) => {
    const label = encodeURIComponent('PEPE Rewards Admin');
    const uri = `otpauth://totp/${label}?secret=${setupSecret}&issuer=${label}&digits=6&period=30`;
    const body = TOTP_ON
        ? `<h2>✅ 2FA is ON</h2><p>Login par ab password ke saath authenticator ka 6-digit code lagta hai.</p>`
        : `<h2>🔐 2FA Setup</h2>
<p><b>Step 1:</b> Google Authenticator / Authy me "Enter setup key" chuno aur ye key daalo (Time based):</p>
<p><code style="font-size:16px;word-break:break-all">${setupSecret}</code></p>
<p>Ya phone par ye link tap karo: <a href="${uri}">Open in Authenticator</a></p>
<p><b>Step 2:</b> Render → Environment me variable banao:<br><code>ADMIN_TOTP_SECRET</code> = <code>${setupSecret}</code></p>
<p><b>Step 3:</b> Redeploy karo. Uske baad login par 2FA code maanga jayega.</p>
<p style="color:#f59e0b">Dhyan: Step 2 karne se pehle ye page band na karo (server restart par nayi key banti hai).</p>`;
    res.send(`<!DOCTYPE html><html><head><title>2FA Setup</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{background:#080c17;color:#f3f4f6;font-family:'Segoe UI',sans-serif;padding:20px;line-height:1.6}h2{color:#3df5be}code{background:#111829;padding:3px 6px;border-radius:6px;color:#3df5be}a{color:#3df5be}</style></head>
<body>${body}<p><a href="/admin/dashboard">← Back to dashboard</a></p></body></html>`);
});

app.get('/admin/logout', (req, res) => {
    const t = parseCookies(req.headers.cookie).admin_session;
    if (t) sessions.delete(t);
    res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
    res.redirect('/admin/login');
});

app.get('/admin/dashboard', checkAdmin, wrap(async (req, res) => {
    const [totalUsers, verified, pending, agg] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ isVerified: true }),
        PendingRequest.find({}).sort({ _id: -1 }),
        User.aggregate([{ $group: { _id: null, bal: { $sum: '$balance' }, paid: { $sum: '$totalWithdrawn' } } }])
    ]);
    const s = agg[0] || { bal: 0, paid: 0 };
    const whi = await tg('getWebhookInfo', {});
    const wh = whi.ok ? whi.result : {};
    const q = String(req.query.search || '').trim().slice(0, 64);
    const found = q ? await User.findOne({ $or: [{ id: q }, { username: q.startsWith('@') ? q : '@' + q }] }) : null;

    const pStats = await Promise.all(pending.map(r =>
        userStats(r.userId).catch(() => ({ refs: 0, totalWithdrawn: 0, paidCount: 0 }))
    ));

    const reqRows = pending.map((r, i) => `<tr><td>${esc(r.userId)}</td><td><b>${fmtD(r.amount)} ${COIN}</b></td><td>${pStats[i].refs}</td><td>${fmtD(pStats[i].totalWithdrawn)} (${pStats[i].paidCount})</td><td><code>${esc(r.address)}</code></td>
<td><button class="b g" data-act="req" data-do="approve" data-id="${esc(r.reqId)}">Approve</button> <button class="b r" data-act="req" data-do="reject" data-id="${esc(r.reqId)}">Reject</button></td></tr>`).join('');

    let userBox = '';
    if (found) {
        const fs = await userStats(found.id).catch(() => ({ refs: 0 }));
        userBox = `<div class="box">
<p>👤 <b>${esc(found.username)}</b> | ID: <code>${esc(found.id)}</code></p>
<p>💰 Balance: <b>${fmtD(found.balance)} ${COIN}</b> | 🏆 Total earned: <b>${fmtD(found.total)}</b> | 📤 Total Withdrawn: <b>${fmtD(found.totalWithdrawn)} ${COIN}</b></p>
<p>✅ Verified: ${found.isVerified ? 'Yes' : 'No'} | 🚫 Banned: ${found.isBanned ? 'Yes' : 'No'} | 👥 Referrals (verified): ${fs.refs} | Referred by: ${esc(found.referredBy || 'Direct')} | Ref credited: ${found.refCredited ? 'Yes' : 'No'} | Device allowed: ${found.deviceOk ? 'Yes' : 'No'}</p>
<p>👆 Today's tap reward: ${tapToday(found)} / ${TAP_CAP} | 🏦 Wallet: <code>${esc(found.wallet || 'not linked')}</code></p>
<div class="row"><input type="number" step="any" id="amt" placeholder="Amount (${COIN})">
<button class="b g" data-act="bal" data-do="add" data-uid="${esc(found.id)}">+ Add</button>
<button class="b r" data-act="bal" data-do="cut" data-uid="${esc(found.id)}">- Cut</button>
<button class="b r" data-act="ban" data-do="ban" data-uid="${esc(found.id)}">Ban</button>
<button class="b g" data-act="ban" data-do="unban" data-uid="${esc(found.id)}">Unban</button>
<button class="b" data-act="dev" data-uid="${esc(found.id)}">Reset Device</button>
<button class="b" data-act="wal" data-uid="${esc(found.id)}">Reset Wallet</button>
<button class="b g" data-act="allowdev" data-uid="${esc(found.id)}">Allow Device</button>
<button class="b g" data-act="cref" data-uid="${esc(found.id)}">Credit Referral</button></div>
<div class="row"><input id="smsg" placeholder="Message to this user"><button class="b" data-act="msg" data-uid="${esc(found.id)}">Send</button></div></div>`;
    } else if (q) {
        userBox = '<p style="color:#ef4444">User not found!</p>';
    }

    res.send(`<!DOCTYPE html><html><head><title>$PEPE Rewards Admin</title><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>*{box-sizing:border-box;font-family:'Segoe UI',sans-serif}body{background:#080c17;color:#f3f4f6;margin:0;padding:16px}h1{color:#3df5be;font-size:22px;margin:0}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.lo{background:#ef4444;color:#fff;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:bold}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.st{background:#111829;border:1px solid #222d4a;border-radius:12px;padding:14px}.st small{color:#8a96b5;font-size:11px;text-transform:uppercase}.st div{font-size:19px;font-weight:bold;color:#3df5be;margin-top:6px}
.card{background:#111829;border:1px solid #222d4a;border-radius:12px;padding:16px;margin-bottom:16px}.card h3{color:#3df5be;margin:0 0 10px;font-size:15px}
input,textarea{background:#080c17;border:1px solid #2a3a55;color:#fff;padding:10px;border-radius:8px;width:100%;font-size:14px}.row{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}.row input{flex:1;min-width:120px}
.b{background:#3df5be;color:#031410;border:none;font-weight:bold;padding:9px 14px;border-radius:8px;cursor:pointer}.b.g{background:#22c55e;color:#fff}.b.r{background:#ef4444;color:#fff}
table{width:100%;border-collapse:collapse}th,td{padding:8px;text-align:left;border-bottom:1px solid #222d4a;font-size:12px;word-break:break-all}th{color:#8a96b5}.box{background:#080c17;padding:12px;border-radius:8px;border:1px solid #222d4a;margin-top:10px;font-size:13px;line-height:1.8}</style></head><body>
<div class="top"><h1>🐸 $PEPE Rewards Admin</h1><a class="lo" href="/admin/logout">Logout</a></div>
<p style="font-size:12px;margin-bottom:6px">${TOTP_ON ? '🔒 2FA: <b>ON</b>' : '⚠️ 2FA: <b style="color:#f59e0b">OFF</b> - <a href="/admin/2fa-setup" style="color:#3df5be">Enable now</a>'}</p>
<p style="font-size:12px;color:#8a96b5;margin-bottom:6px">Withdrawals: <b>Manual</b> (pehle payment bhejo, phir Approve dabao)</p>
<p style="font-size:12px;color:#8a96b5;margin-bottom:12px;word-break:break-all">Webhook: <code>${esc(wh.url || 'NOT SET')}</code> | Pending: ${esc(wh.pending_update_count || 0)}${wh.last_error_message ? ' | <span style="color:#ef4444">Last error: ' + esc(wh.last_error_message) + '</span>' : ''} | Server: ${esc(PUBLIC_URL || 'PUBLIC_URL not set')}</p>
<div class="grid">
<div class="st"><small>Total Users</small><div>${totalUsers}</div></div>
<div class="st"><small>Verified Users</small><div>${verified}</div></div>
<div class="st"><small>Users' Balance</small><div>${fmtD(s.bal)} ${COIN}</div></div>
<div class="st"><small>Paid Out</small><div>${fmtD(s.paid)} ${COIN}</div></div>
<div class="st"><small>Pending Requests</small><div>${pending.length}</div></div></div>
<div class="card"><h3>⏳ Pending Withdrawal Requests</h3>${pending.length ? `<table><tr><th>User ID</th><th>Amount</th><th>Verified Refs</th><th>Total Withdrawn (paid #)</th><th>Wallet (BEP-20)</th><th>Action</th></tr>${reqRows}</table>` : '<p style="color:#8a96b5;font-size:12px">No pending requests.</p>'}</div>
<div class="card"><h3>🔍 Search & Manage User</h3><form method="GET" class="row"><input name="search" placeholder="Telegram ID or @username" value="${esc(q)}"><button class="b">Search</button></form>${userBox}</div>
<div class="card"><h3>🛠 Referral Repair</h3><p style="font-size:12px;color:#8a96b5;margin-bottom:10px">Missed referrals (user verified but referrer got no bonus) ko ek click me theek karo.</p><button class="b g" style="width:100%" data-act="rep">Repair All Referrals</button></div>
<div class="card"><h3>📢 Broadcast</h3><textarea id="bc" rows="3" placeholder="Message to all users..."></textarea><button class="b" style="margin-top:10px;width:100%" data-act="bc">Send Broadcast</button></div>
<script>
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});const d=await r.json();alert(d.message||'Done');return d}
document.addEventListener('click',async e=>{const b=e.target.closest('[data-act]');if(!b)return;const a=b.dataset.act;let d;
if(a==='req')d=await post('/admin/action',{reqId:b.dataset.id,action:b.dataset.do});
else if(a==='bal'){const amount=document.getElementById('amt').value;if(!amount)return alert('Enter amount');d=await post('/admin/balance',{userId:b.dataset.uid,amount,action:b.dataset.do})}
else if(a==='ban')d=await post('/admin/ban',{userId:b.dataset.uid,action:b.dataset.do});
else if(a==='dev'){if(!confirm('Reset device lock for this user?'))return;d=await post('/admin/resetdevice',{userId:b.dataset.uid})}
else if(a==='wal'){if(!confirm('Unlink wallet for this user?'))return;d=await post('/admin/resetwallet',{userId:b.dataset.uid})}
else if(a==='rep'){if(!confirm('Repair all missed referrals?'))return;d=await post('/admin/repairrefs',{})}
else if(a==='cref'){d=await post('/admin/creditref',{userId:b.dataset.uid})}
else if(a==='allowdev'){if(!confirm('Allow this user (skip fingerprint/IP matching)?'))return;d=await post('/admin/allowdevice',{userId:b.dataset.uid})}
else if(a==='msg'){const message=document.getElementById('smsg').value;if(!message)return;d=await post('/admin/msg',{userId:b.dataset.uid,message})}
else if(a==='bc'){const message=document.getElementById('bc').value;if(!message)return;if(!confirm('Send to all users?'))return;d=await post('/admin/broadcast',{message})}
if(a!=='msg'&&a!=='bc')location.reload()});
</script></body></html>`);
}));

app.post('/admin/action', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const { reqId, action } = req.body;
    if (!['approve', 'reject'].includes(action)) return res.json({ ok: false, message: 'Invalid action' });
    const r = await resolveWithdraw(reqId, action === 'approve');
    if (!r.ok) return res.json({ ok: false, message: r.message });
    res.json({ ok: true, message: `Request ${action}d!` });
}));

app.post('/admin/balance', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const { userId, action } = req.body;
    const amt = Math.floor(Number(req.body.amount));
    if (!Number.isFinite(amt) || amt <= 0 || amt > 1e9) return res.json({ ok: false, message: 'Invalid amount' });

    let u;
    if (action === 'add') {
        u = await User.findOneAndUpdate({ id: String(userId) }, { $inc: { balance: amt } }, { new: true });
    } else {
        u = await User.findOneAndUpdate({ id: String(userId), balance: { $gte: amt } }, { $inc: { balance: -amt } }, { new: true });
    }
    if (!u) return res.json({ ok: false, message: 'User not found or balance too low' });

    sendMsg(u.id, action === 'add'
        ? `🎁 Admin added +${fmtD(amt)} ${COIN} to your balance!`
        : `⚠️ Admin deducted ${fmtD(amt)} ${COIN} from your balance.`);
    res.json({ ok: true, message: `Done. New balance: ${fmtD(u.balance)} ${COIN}` });
}));

app.post('/admin/ban', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const ban = req.body.action === 'ban';
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { isBanned: ban }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    sendMsg(u.id, ban ? '🚫 <b>Account Banned</b> by admin.' : '✅ <b>Account Unbanned</b> by admin.');
    res.json({ ok: true, message: ban ? 'User banned' : 'User unbanned' });
}));

app.post('/admin/resetdevice', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const r = await Device.deleteMany({ userId: String(req.body.userId) });
    res.json({ ok: true, message: `Device lock reset (${r.deletedCount} device removed).` });
}));

app.post('/admin/resetwallet', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { $set: { wallet: null } }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    res.json({ ok: true, message: 'Wallet unlinked. User can link a new wallet on next withdraw.' });
}));

app.post('/admin/allowdevice', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const u = await User.findOneAndUpdate({ id: String(req.body.userId) }, { $set: { deviceOk: true } }, { new: true });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    res.json({ ok: true, message: 'Device allowed. User can open the app again.' });
}));

app.post('/admin/creditref', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const u = await User.findOne({ id: String(req.body.userId) });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    if (!u.referredBy) return res.json({ ok: false, message: 'This user has no referrer (Referred by = Direct). The /start link did not reach the bot.' });
    if (!u.isVerified) return res.json({ ok: false, message: 'User is not verified yet.' });
    const done = await creditReferral(u.id);
    res.json({ ok: done, message: done ? 'Referral credited and referrer notified.' : 'Nothing to credit: already in referrer list, or referrer not found in DB.' });
}));

app.post('/admin/repairrefs', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const users = await User.find({ isVerified: true, referredBy: { $ne: null } }, { id: 1 });
    let n = 0, failed = 0;
    for (const x of users) {
        try { if (await creditReferral(x.id)) n++; }
        catch (e) { failed++; console.log('Repair error for', x.id, e.message); }
    }
    res.json({ ok: true, message: `Repaired ${n} missed referral(s) out of ${users.length} referred users.` + (failed ? ` Failed: ${failed}` : '') });
}));

app.post('/admin/msg', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const u = await User.findOne({ id: String(req.body.userId) });
    if (!u) return res.json({ ok: false, message: 'User not found' });
    await sendMsg(u.id, `📩 Message from Admin:\n\n${String(req.body.message).slice(0, 3000)}`, undefined, false);
    res.json({ ok: true, message: 'Message sent!' });
}));

app.post('/admin/broadcast', checkAdmin, sameOrigin, wrap(async (req, res) => {
    const message = String(req.body.message || '').slice(0, 3500);
    if (!message.trim()) return res.json({ ok: false, message: 'Empty message' });
    const ids = (await User.find({ isBanned: false }, { id: 1 })).map(u => u.id);
    res.json({ ok: true, message: `Broadcast started for ${ids.length} users.` });
    for (const id of ids) {
        await sendMsg(id, message, undefined, false);
        await sleep(60);
    }
}));

app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'Not found' }));

// ---------- START ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    if (PUBLIC_URL.startsWith('https://')) {
        const r = await tg('setWebhook', {
            url: `${PUBLIC_URL}/api/webhook`,
            secret_token: WEBHOOK_SECRET,
            allowed_updates: ['message', 'callback_query']
        });
        console.log(r.ok ? '✅ Telegram webhook set' : '❌ Webhook failed', r.description || '');

        // KEEP-ALIVE: Render free server idle par so jata hai
        setInterval(() => {
            fetch(PUBLIC_URL + '/health', { signal: AbortSignal.timeout(10000) }).catch(() => {});
        }, 10 * 60 * 1000).unref();
    } else {
        console.log('⚠️ PUBLIC_URL (https) not set - webhook not configured.');
    }
});
