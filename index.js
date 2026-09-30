const TelegramBot = require("node-telegram-bot-api");
const { Client } = require("ssh2");
const fs = require("fs");
const axios = require("axios");

// ==========================================
// CONFIGURASI
// ==========================================
const BOT_TOKEN = "8782567534:AAG_JAFukopGmfWE7bIcg_yyX9u2gruCmDM";
const OWNER_ID = 8594358853; // Ganti dengan ID Telegram kamu
const USERNAME = "root";

// Satu-satunya grup yang boleh dipakai untuk /createvps.
// Private chat bot TIDAK PERNAH boleh dipakai untuk create VPS, tanpa pengecualian (termasuk owner).
const ALLOWED_GROUP_ID = "-1003876088223";

const RAILWAY_API_URL = "https://backboard.railway.com/graphql/v2";
const CATCHMAIL_API_URL = "https://api.catchmail.io/api/v1";
const CATCHMAIL_DOMAINS = ["catchmail.io", "mailistry.com", "zeppost.com"];

// Foto banner yang tampil di momen-momen penting (VPS jadi, welcome, dll).
// GANTI URL INI dengan foto/logo kamu sendiri (upload ke Telegraph/Imgur, lalu paste link-nya di sini).
const BANNER_URL = "https://files.catbox.moe/wur3la.jpeg";

/**
 * Kirim pesan bergambar (foto + caption). Kalau BANNER_URL gagal diakses / expired,
 * otomatis jatuh ke pesan teks biasa supaya bot tidak pernah macet gara-gara foto.
 */
async function sendCardPhoto(chatId, caption, extra = {}) {
    try {
        return await bot.sendPhoto(chatId, BANNER_URL, { caption, parse_mode: "HTML", ...extra });
    } catch (e) {
        return bot.sendMessage(chatId, caption, { parse_mode: "HTML", ...extra });
    }
}

/**
 * Edit pesan menu (bisa foto+caption atau teks).
 * editMessageText gagal di pesan foto → "there is no text in the message to edit".
 * Otomatis pilih editMessageCaption atau editMessageText.
 */
async function editCardMessage(query, text, extra = {}) {
    const msg = query.message;
    const opts = {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "HTML",
        ...extra
    };
    const isMedia = !!(msg.photo || msg.animation || msg.video || msg.document || msg.sticker);
    try {
        if (isMedia) {
            return await bot.editMessageCaption(text, opts);
        }
        return await bot.editMessageText(text, opts);
    } catch (e) {
        // Fallback: coba metode lain kalau deteksi media salah
        try {
            if (isMedia) return await bot.editMessageText(text, opts);
            return await bot.editMessageCaption(text, opts);
        } catch (e2) {
            throw e;
        }
    }
}

const CHECK_INTERVAL = 2000;
const MAX_TIME = 15 * 60 * 1000;

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================================
// MANAJEMEN TOKEN (FILE)
// ==========================================
const TOKENS_FILE = 'tokens.json';
let tokens = {};

function loadTokens() {
    try {
        if (fs.existsSync(TOKENS_FILE)) {
            const data = fs.readFileSync(TOKENS_FILE);
            const raw = JSON.parse(data);
            tokens = {};
            let migrated = false;
            for (const alias of Object.keys(raw)) {
                const val = raw[alias];
                if (typeof val === 'string') {
                    // Format lama: alias -> token string. Migrasi ke format terkunci (belum ada pemilik).
                    tokens[alias] = { token: val, ownerId: null };
                    migrated = true;
                } else {
                    tokens[alias] = { token: val.token, ownerId: val.ownerId ?? null };
                }
            }
            if (migrated) saveTokens();
        } else {
            tokens = {};
            saveTokens();
        }
    } catch (e) {
        tokens = {};
    }
}

function saveTokens() {
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

loadTokens();

// Token hanya boleh dipakai oleh 1 akun Telegram (ownerId yang terikat).
// Owner bot selalu boleh memakai semua token untuk keperluan admin.
function canUseToken(alias, userId) {
    if (!tokens[alias]) return false;
    if (Number(userId) === OWNER_ID) return true;
    const ownerId = tokens[alias].ownerId;
    if (ownerId === null || ownerId === undefined) return false;
    return String(ownerId) === String(userId);
}

function getUserTokenAliases(userId) {
    return Object.keys(tokens).filter(a => canUseToken(a, userId));
}

/** Alias default 1 user = 1 token (bisa diganti kapan saja via /mytoken) */
function userTokenAlias(userId) {
    return `user_${String(userId)}`;
}

function setUserOwnToken(userId, tokenValue) {
    const alias = userTokenAlias(userId);
    tokens[alias] = { token: String(tokenValue).trim(), ownerId: String(userId) };
    saveTokens();
    return alias;
}

function getUserOwnToken(userId) {
    const alias = userTokenAlias(userId);
    if (tokens[alias] && canUseToken(alias, userId)) return tokens[alias].token;
    // fallback: token lain yang dikunci ke user ini (set owner)
    const aliases = getUserTokenAliases(userId);
    if (aliases.length > 0) return tokens[aliases[0]].token;
    return null;
}

// ==========================================
// MANAJEMEN PREMIUM (FILE)
// ==========================================
const PREMIUM_FILE = 'premium.json';
let premiumUsers = new Set();

function loadPremium() {
    try {
        if (fs.existsSync(PREMIUM_FILE)) {
            const data = JSON.parse(fs.readFileSync(PREMIUM_FILE));
            premiumUsers = new Set(data);
        } else {
            premiumUsers = new Set();
            savePremium();
        }
    } catch (e) {
        premiumUsers = new Set();
    }
}

function savePremium() {
    fs.writeFileSync(PREMIUM_FILE, JSON.stringify([...premiumUsers], null, 2));
}

loadPremium();

function isPremium(userId) {
    if (Number(userId) === OWNER_ID) return true;
    return premiumUsers.has(String(userId));
}

// ==========================================
// MANAJEMEN RESELLER (FILE)
// ==========================================
const RESELLER_FILE = 'reseller.json';
let resellerList = [];

function loadReseller() {
    try {
        if (fs.existsSync(RESELLER_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESELLER_FILE));
            resellerList = Array.isArray(data) ? data : [];
        } else {
            resellerList = [];
            saveReseller();
        }
    } catch (e) {
        resellerList = [];
    }
}

function saveReseller() {
    fs.writeFileSync(RESELLER_FILE, JSON.stringify(resellerList, null, 2));
}

loadReseller();

// ==========================================
// FUNGSI SANITASI SUPER AMAN (ZERO RISK)
// ==========================================
function sanitizeText(text) {
    if (!text) return "";
    let clean = String(text).replace(/[\x00-\x1F\x7F]/g, '');
    clean = clean.replace(/[^\p{L}\p{N}\s.,!?\-]/gu, '');
    return clean.trim();
}

function escapeHtml(text) {
    if (!text) return "";
    let clean = sanitizeText(text);
    return clean
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function mention(user) {
    if (!user) return "User";
    let name = user.username ? `@${user.username}` : (user.first_name || "User");
    return sanitizeText(name);
}

// ==========================================
// MANAJEMEN GRUP & FILE SYSTEM
// ==========================================
let allowedGroups = new Set();
try {
    if (fs.existsSync('groups.json')) {
        const data = JSON.parse(fs.readFileSync('groups.json'));
        // Filter string kosong / invalid agar tidak memblokir semua grup secara tidak sengaja
        const cleaned = (Array.isArray(data) ? data : []).map(String).filter(id => id && id !== "null" && id !== "undefined");
        allowedGroups = new Set(cleaned);
        if (cleaned.length !== (Array.isArray(data) ? data.length : 0)) {
            fs.writeFileSync('groups.json', JSON.stringify([...allowedGroups]));
        }
    } else {
        fs.writeFileSync('groups.json', JSON.stringify([...allowedGroups]));
    }
} catch (e) {
    console.error("[FILE ERROR] Gagal memuat groups.json");
    allowedGroups = new Set();
}

function saveGroups() {
    fs.writeFileSync('groups.json', JSON.stringify([...allowedGroups]));
}

// ==========================================
// SESI MEMORI
// ==========================================
const inputSessions = new Map(); 
const readySessions = new Map(); 
const mailSessions = new Map();  
const knownGroups = new Map();   

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const reqOptions = {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
    timeout: 10000
};

// ==========================================
// KEYBOARDS & UTILS — TAMPILAN "Agaahost" (v3, font-styled)
// ==========================================
const DIVIDER = "───────────◆───────────";
const BRAND = "𝗔𝗴𝗮𝗮𝗵𝗼𝘀𝘁";           // brand pakai font bold-sans unicode, biar beda & langsung kelihatan
const TAGLINE = "𝘝𝘗𝘚 𝙎𝙮𝙨𝙩𝙚𝙢";     // tagline pakai font italic-sans unicode

/**
 * Ganti nama section jadi huruf kapital kecil (small caps) — aksen tipografi
 * yang jarang dipakai bot lain, dipakai secukupnya biar tetap gampang dibaca.
 */
function smallCaps(text) {
    const map = { a:"ᴀ", b:"ʙ", c:"ᴄ", d:"ᴅ", e:"ᴇ", f:"ꜰ", g:"ɢ", h:"ʜ", i:"ɪ", j:"ᴊ", k:"ᴋ", l:"ʟ", m:"ᴍ", n:"ɴ", o:"ᴏ", p:"ᴘ", q:"q", r:"ʀ", s:"ꜱ", t:"ᴛ", u:"ᴜ", v:"ᴠ", w:"ᴡ", x:"x", y:"ʏ", z:"ᴢ" };
    return text.toLowerCase().split("").map(ch => map[ch] || ch).join("");
}

/**
 * Kartu utama tampilan bot — header brand bergaya font unik, judul jelas,
 * body polos biar tetap enak dibaca, dipisah garis tipis + aksen ◆.
 * Command TIDAK dibungkus <code> supaya otomatis tampil biru & bisa ditap oleh Telegram.
 */
function card(title, body, footer) {
    let inner =
`${BRAND}  <i>${TAGLINE}</i>
${DIVIDER}
<b>${title}</b>

${body || ""}`;
    if (footer) inner += `\n\n${DIVIDER}\n➤ <i>${footer}</i>`;
    return `<blockquote>${inner}</blockquote>`;
}

function cardOk(title, body, footer) {
    return card(`🟢 ${title}`, body, footer);
}

function cardErr(title, body, footer) {
    return card(`🔴 ${title}`, body, footer);
}

function cardWarn(title, body, footer) {
    return card(`🟡 ${title}`, body, footer);
}

function cardInfo(title, body, footer) {
    return card(`🔵 ${title}`, body, footer);
}

const cancelKeyboard = {
    inline_keyboard: [[{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel", style: "danger" }]]
};

const homeKeyboard = {
    inline_keyboard: [
        [{ text: "𝐋𝐨𝐠𝐢𝐧 & 𝐃𝐫𝐨𝐩", callback_data: "login", style: "primary" }, { text: "𝐂𝐞𝐤 𝐕𝐏𝐒", callback_data: "fix", style: "success" }],
        [{ text: "𝐓𝐨𝐤𝐞𝐧", callback_data: "menu_token", style: "primary" }, { text: "𝐒𝐭𝐚𝐭𝐬", callback_data: "stats_btn", style: "primary" }],
        [{ text: "𝐃𝐄𝐕", url: "https://t.me/MAKLOKNTLL", style: "success" }, { text: "𝗖𝗛𝗔𝗡𝗡𝗘𝗟", url: "https://t.me/AboutAgaahostt", style: "primary" }],
        [{ text: "𝐓𝐮𝐭𝐮𝐩", callback_data: "close", style: "danger" }]
    ]
};

// Tombol link doang, aman ditampilkan ke user biasa (bukan aksi owner-only)
const linksKeyboard = {
    inline_keyboard: [
        [{ text: "𝐃𝐄𝐕", url: "https://t.me/MAKLOKNTLL", style: "primary"}, { text: "𝗖𝗛𝗔𝗡𝗡𝗘𝗟", url: "https://t.me/AboutAgaahostt", style: "success" }]
    ]
};

const tokenMenuKeyboard = {
    inline_keyboard: [
        [{ text: "𝐓𝐚𝐦𝐛𝐚𝐡 𝐓𝐨𝐤𝐞𝐧", callback_data: "settoken_start", style: "primary" }],
        [{ text: "𝐃𝐚𝐟𝐭𝐚𝐫 𝐓𝐨𝐤𝐞𝐧", callback_data: "listtokens_view", style: "success" }],
        [{ text: "𝐊𝐞𝐦𝐛𝐚𝐥𝐢", callback_data: "back_home", style: "danger" }]
    ]
};

const backHomeKeyboard = {
    inline_keyboard: [[{ text: "𝐊𝐞𝐦𝐛𝐚𝐥𝐢 𝐤𝐞 𝐌𝐞𝐧𝐮", callback_data: "back_home", style: "danger" }]]
};

function isOwner(msg) {
    return Number(msg.from?.id) === OWNER_ID;
}

function clearInputSession(chatId) {
    const key = String(chatId);
    const session = inputSessions.get(key);
    if (session?.timer) clearTimeout(session.timer);
    inputSessions.delete(key);
}

function createInputSession(chatId, data) {
    const key = String(chatId);
    clearInputSession(key);
    data.timer = setTimeout(() => {
        inputSessions.delete(key);
    }, 10 * 60 * 1000);
    inputSessions.set(key, data);
}

function getInputSession(chatId) {
    return inputSessions.get(String(chatId));
}

function generateRandomPassword() {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let pw = 'Vps';
    for (let i = 0; i < 8; i++) {
        pw += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return pw + '#!'; 
}

function createEmail() {
    const randomStr = Math.random().toString(36).slice(2, 12);
    const domain = CATCHMAIL_DOMAINS[Math.floor(Math.random() * CATCHMAIL_DOMAINS.length)];
    return `railway${randomStr}@${domain}`;
}

// ==========================================
// CATCHMAIL API LOGIC
// ==========================================
async function checkInbox(address) {
    try {
        const res = await axios.get(`${CATCHMAIL_API_URL}/mailbox?address=${encodeURIComponent(address)}`, reqOptions);
        return Array.isArray(res.data?.messages) ? res.data.messages : [];
    } catch (err) { return []; }
}

async function readMessage(address, id) {
    try {
        const res = await axios.get(`${CATCHMAIL_API_URL}/message/${encodeURIComponent(id)}?mailbox=${encodeURIComponent(address)}`, reqOptions);
        return res.data || null;
    } catch (err) { return null; }
}

function bodyText(detail) {
    if (!detail) return "";
    if (detail.body?.text && detail.body.text.trim()) return detail.body.text.trim();
    if (detail.body?.html) {
        return detail.body.html
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
            .replace(/\s+/g, " ").trim();
    }
    return "";
}

function isRailwayMessage(detail) {
    const from = String(detail?.from || "").toLowerCase();
    const subject = String(detail?.subject || "").toLowerCase();
    const body = bodyText(detail).toLowerCase();
    const full = `${from}\n${subject}\n${body}`;

    if (!full.includes("railway")) return false;
    const loginContext = /login\s+code|verification\s+code|verify|verification|authentication|sign[\s-]?in|one[\s-]?time|otp/i;
    return loginContext.test(full) || /\b\d{6}\b/.test(full);
}

function extractRailwayCode(detail) {
    const subject = String(detail?.subject || "");
    const body = bodyText(detail);
    let match = subject.match(/\b(\d{6})\b/);
    if (match) return match[1];

    match = body.match(/(?:login|verification|verify|authentication|sign[\s-]?in|one[\s-]?time|otp)[^0-9]{0,80}(\d{6})\b/i);
    if (match) return match[1];

    match = `${subject}\n${body}`.match(/\b(\d{6})\b/);
    return match ? match[1] : null;
}

function stopMailSession(userId) {
    const session = mailSessions.get(userId);
    if (!session) return;
    clearInterval(session.interval);
    clearTimeout(session.timeout);
    mailSessions.delete(userId);
}

function startMailMonitor(chatId, userId, address, userMention) {
    stopMailSession(userId);

    const session = { address, seen: new Set(), interval: null, timeout: null };

    session.timeout = setTimeout(() => {
        if (!mailSessions.has(userId)) return;
        stopMailSession(userId);
        bot.sendMessage(chatId, card("⏰  Pemantauan Selesai", "Tidak ditemukan kode OTP Railway.", "Temp-mail sudah ditutup dari pemantauan."), { parse_mode: "HTML" }).catch(() => {});
    }, MAX_TIME);

    session.interval = setInterval(async () => {
        if (!mailSessions.has(userId)) return;
        try {
            const inbox = await checkInbox(address);
            for (const item of inbox) {
                if (!item?.id) continue;
                const id = String(item.id);
                if (session.seen.has(id)) continue;
                session.seen.add(id);

                const detail = await readMessage(address, item.id);
                if (!detail || !isRailwayMessage(detail)) continue;

                const code = extractRailwayCode(detail);
                if (!code) continue;

                stopMailSession(userId);

                const result = card("🚂  Kode Login Railway", `👤 User: ${userMention}\n🔐 Kode: <code>${escapeHtml(code)}</code>`, "✅ Temp-mail ditutup. Lanjutkan ke tahap pembuatan API Token.");

                await bot.sendMessage(chatId, result, {
                    parse_mode: "HTML",
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "𝐂𝐎𝐏𝐘 𝐂𝐎𝐃𝐄 𝐋𝐎𝐆𝐈𝐍", copy_text: { text: String(code) }, style: "success" }]
                        ]
                    }
                }).catch(()=>{});
                return;
            }
        } catch (err) {}
    }, CHECK_INTERVAL);

    mailSessions.set(userId, session);
}

// ==========================================
// ADMIN GROUP MANAGEMENT COMMANDS
// ==========================================
bot.onText(/^\/add$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id.toString();
    
    if (msg.chat.type === 'private') {
        return bot.sendMessage(chatId, cardWarn("Khusus Grup", `Halo ${mention(msg.from)}, gunakan perintah ini di dalam grup!`), { parse_mode: "HTML" });
    }

    allowedGroups.add(chatId);
    saveGroups();
    bot.sendMessage(chatId, cardOk("Grup Diizinkan", `Halo ${mention(msg.from)}, grup ini ditambahkan ke daftar putih. Semua member sekarang bisa pakai fitur bot.`), { parse_mode: "HTML" });
});

bot.onText(/^\/del$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id.toString();

    if (msg.chat.type === 'private') {
        return bot.sendMessage(chatId, cardWarn("Khusus Grup", `Halo ${mention(msg.from)}, gunakan perintah ini di dalam grup!`), { parse_mode: "HTML" });
    }

    allowedGroups.delete(chatId);
    saveGroups();
    bot.sendMessage(chatId, cardErr("Grup Dihapus", `Halo ${mention(msg.from)}, izin penggunaan bot untuk grup ini dicabut.`), { parse_mode: "HTML" });
});

bot.onText(/^\/listadd$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id.toString();

    if (allowedGroups.size === 0) {
        return bot.sendMessage(chatId, card("📋  Daftar Grup", `Halo ${mention(msg.from)}, belum ada grup yang diizinkan.`), { parse_mode: "HTML" });
    }

    let list = Array.from(allowedGroups).map((id, index) => `${index + 1}. <code>${escapeHtml(id)}</code>`).join("\n");
    bot.sendMessage(chatId, card("📋  Grup Diizinkan", list), { parse_mode: "HTML" });
});

// ==========================================
// TOKEN MANAGEMENT COMMANDS
// ==========================================
// Owner: set token untuk user lain (alias + token + id telegram)
bot.onText(/^\/settoken(?:\s+(\S+)\s+(\S+)\s+(\S+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;

    if (match[1] && match[2] && match[3]) {
        const alias = match[1];
        const token = match[2];
        const ownerIdInput = match[3];
        if (!/^\d+$/.test(ownerIdInput)) {
            return bot.sendMessage(chatId, cardErr("ID Tidak Valid", `Gunakan format:\n/settoken alias token id_telegram`, "Tips: reply pesan seseorang lalu ketik /whoami untuk lihat ID mereka."), { parse_mode: "HTML" });
        }
        tokens[alias] = { token, ownerId: ownerIdInput };
        saveTokens();
        return bot.sendMessage(chatId, cardOk("Token Tersimpan", `Alias: <b>${escapeHtml(alias)}</b>\nDikunci untuk akun Telegram: <code>${escapeHtml(ownerIdInput)}</code>`, "Token ini tidak bisa dipakai akun Telegram lain."), { parse_mode: "HTML" });
    }

    createInputSession(chatId, { step: "settoken_alias", action: "settoken" });
    await bot.sendMessage(chatId, card("🏷️  Tambah Token  ·  1/3", "Masukkan <b>alias</b> untuk token ini.\nContoh: <code>utama</code> atau <code>vps2</code>"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
});

// SEMUA USER: set / ganti token Railway milik sendiri
bot.onText(/^\/mytoken(?:@[a-zA-Z0-9_]+)?(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = msg.chat.id.toString();
    const userId = msg.from.id;
    const userMention = mention(msg.from);
    const isPrivate = msg.chat.type === "private";

    // Di grup: hanya grup yang diizinkan
    if (!isPrivate && !allowedGroups.has(chatId)) {
        return bot.sendMessage(chatId, cardErr("Grup Belum Didaftarkan", `Halo ${userMention}, grup ini belum diizinkan.`, "Owner ketik /add di grup ini dulu."), { parse_mode: "HTML" }).catch(() => {});
    }

    const tokenArg = match[1] ? match[1].trim() : null;

    if (tokenArg) {
        // Langsung simpan token (disarankan di DM agar token tidak bocor di grup)
        if (!isPrivate) {
            try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
            return bot.sendMessage(chatId, cardWarn("Keamanan", `Halo ${userMention}, jangan kirim token di grup.`, "Buka DM bot, lalu ketik:\n/mytoken TOKEN_RAILWAY_KAMU"), { parse_mode: "HTML" });
        }
        if (tokenArg.length < 20) {
            return bot.sendMessage(chatId, cardErr("Token Tidak Valid", "Token Railway terlalu pendek. Paste token lengkap dari dashboard."), { parse_mode: "HTML" });
        }
        const alias = setUserOwnToken(userId, tokenArg);
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
        return withBootFlair(chatId, [
            "$ agaahost-cli token --save",
            "encrypting & binding to user_id...",
            "→ saved"
        ], () => bot.sendMessage(chatId, cardOk("Token Tersimpan", `Halo ${userMention}, token Railway kamu berhasil disimpan/diganti.`, `Alias: <code>${escapeHtml(alias)}</code>\nSekarang kembali ke grup dan ketik /createvps.`), { parse_mode: "HTML" }));
    }

    // Tanpa argumen: tampilkan status + panduan
    const existing = getUserOwnToken(userId);
    const status = existing
        ? `Status: <b>sudah ada token</b>\nPreview: <code>${escapeHtml(existing.substring(0, 8))}…</code>\n\nUntuk <b>ganti</b> token, kirim token baru di DM:\n/mytoken TOKEN_BARU`
        : `Status: <b>belum ada token</b>\n\nKirim di DM bot:\n/mytoken TOKEN_RAILWAY_KAMU`;

    const bootLines = ["$ agaahost-cli token --status", "checking bound token...", "→ done"];

    if (isPrivate) {
        createInputSession(chatId, { step: "mytoken_wait", action: "mytoken", initiator: userId });
        return withBootFlair(chatId, bootLines, () => bot.sendMessage(chatId, card("🔑  Token Railway", `${status}\n\nAtau langsung <b>kirim token</b> di chat ini (tanpa perintah).`, "Token hanya untuk akun Telegram kamu."), {
            parse_mode: "HTML",
            reply_markup: cancelKeyboard
        }));
    }

    return withBootFlair(chatId, bootLines, () => bot.sendMessage(chatId, card("🔑  Token Railway", `Halo ${userMention}\n${status}`, "Lebih aman set token lewat DM bot."), { parse_mode: "HTML" }));
});

bot.onText(/^\/whoami(?:@[a-zA-Z0-9_]+)?$/i, async msg => {
    const target = msg.reply_to_message ? msg.reply_to_message.from : msg.from;
    const label = msg.reply_to_message ? "ID Telegram user yang di-reply" : "ID Telegram kamu";
    await withBootFlair(msg.chat.id, [
        "$ whoami --telegram",
        `resolving user_id...`,
        "→ done"
    ], () => bot.sendMessage(msg.chat.id, card("🆔  ID Telegram", `${label}: <code>${target.id}</code>`), { parse_mode: "HTML" }));
});

bot.onText(/^\/ping(?:@[a-zA-Z0-9_]+)?$/i, async msg => {
    const t0 = Date.now();
    const sent = await bot.sendMessage(msg.chat.id, `<pre>$ ping agaahost-core\nwaiting for reply...</pre>`, { parse_mode: "HTML" });
    const ms = Date.now() - t0;
    try {
        await bot.editMessageText(card("🏓  Pong!", `Latency respons bot : <code>${ms}ms</code>`), { chat_id: msg.chat.id, message_id: sent.message_id, parse_mode: "HTML" });
    } catch (e) {}
});

bot.onText(/^\/stats$/, async msg => {
    if (!isOwner(msg)) return;
    const uptimeSec = process.uptime();
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const body =
`🔑 Token tersimpan  : <code>${Object.keys(tokens).length}</code>
🌐 Grup resmi       : <code>${allowedGroups.size}</code>
⭐ User premium      : <code>${premiumUsers.size}</code>
🤝 Akses reseller    : <code>${resellerList.length}</code>
🟢 Sesi VPS aktif    : <code>${readySessions.size}</code>
⏱️ Bot berjalan      : <code>${d}h ${h}j ${m}m</code>`;
    await withBootFlair(msg.chat.id, [
        "$ agaahost-cli stats --collect",
        "reading in-memory state...",
        "→ done"
    ], () => bot.sendMessage(msg.chat.id, card("📊  Statistik Bot", body), { parse_mode: "HTML" }));
});

bot.onText(/^\/listtokens$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    const aliases = Object.keys(tokens);
    if (aliases.length === 0) {
        return bot.sendMessage(chatId, card("📭  Daftar Token", "Belum ada token tersimpan."), { parse_mode: "HTML" });
    }
    let list = aliases.map((a, i) => {
        const t = tokens[a];
        const bound = t.ownerId ? `<code>${escapeHtml(String(t.ownerId))}</code>` : "⚠️ <i>belum dikunci</i>";
        return `<b>${i+1}. ${escapeHtml(a)}</b>\n    🔐 <code>${escapeHtml(t.token.substring(0,8))}...</code>\n    👤 Pemilik: ${bound}`;
    }).join("\n\n");
    bot.sendMessage(chatId, card("📋  Token Tersimpan", list), { parse_mode: "HTML" });
});

bot.onText(/^\/deltoken(?:\s+(\S+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (!match[1]) {
        return bot.sendMessage(chatId, cardWarn("Cara Pakai", "/deltoken &lt;alias&gt;"), { parse_mode: "HTML" });
    }
    const alias = match[1];
    if (!tokens[alias]) {
        return bot.sendMessage(chatId, cardErr("Alias Tidak Ditemukan", `Alias <b>${escapeHtml(alias)}</b> tidak ada.`), { parse_mode: "HTML" });
    }
    delete tokens[alias];
    saveTokens();
    bot.sendMessage(chatId, cardOk("Token Dihapus", `Token <b>${escapeHtml(alias)}</b> berhasil dihapus.`), { parse_mode: "HTML" });
});

// ==========================================
// PREMIUM MANAGEMENT COMMANDS
// ==========================================
bot.onText(/^\/addprem(?:\s+(\d+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (!match[1]) {
        return bot.sendMessage(chatId, cardWarn("Cara Pakai", "/addprem &lt;user_id&gt;"), { parse_mode: "HTML" });
    }
    const userId = match[1];
    if (premiumUsers.has(userId)) {
        return bot.sendMessage(chatId, cardInfo("Sudah Premium", `User <code>${escapeHtml(userId)}</code> sudah premium.`), { parse_mode: "HTML" });
    }
    premiumUsers.add(userId);
    savePremium();
    bot.sendMessage(chatId, cardOk("Premium Ditambahkan", `User <code>${escapeHtml(userId)}</code> berhasil ditambahkan ke daftar premium.`), { parse_mode: "HTML" });
});

bot.onText(/^\/delprem(?:\s+(\d+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (!match[1]) {
        return bot.sendMessage(chatId, cardWarn("Cara Pakai", "/delprem &lt;user_id&gt;"), { parse_mode: "HTML" });
    }
    const userId = match[1];
    if (!premiumUsers.has(userId)) {
        return bot.sendMessage(chatId, cardErr("Tidak Ditemukan", `User <code>${escapeHtml(userId)}</code> tidak ada di daftar premium.`), { parse_mode: "HTML" });
    }
    premiumUsers.delete(userId);
    savePremium();
    bot.sendMessage(chatId, cardOk("Premium Dihapus", `User <code>${escapeHtml(userId)}</code> berhasil dihapus dari daftar premium.`), { parse_mode: "HTML" });
});

bot.onText(/^\/listprem$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (premiumUsers.size === 0) {
        return bot.sendMessage(chatId, card("📭  Daftar Premium", "Belum ada user premium."), { parse_mode: "HTML" });
    }
    let list = [...premiumUsers].map((id, i) => `${i+1}. <code>${escapeHtml(id)}</code>`).join("\n");
    bot.sendMessage(chatId, card("📋  Daftar Premium", list), { parse_mode: "HTML" });
});

// ==========================================
// RESELLER MANAGEMENT COMMANDS
// ==========================================
bot.onText(/^\/address(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (!match[1]) {
        return bot.sendMessage(chatId, cardWarn("Cara Pakai", "/address &lt;id_telegram&gt;", "Contoh: /address 123456789"), { parse_mode: "HTML" });
    }
    const reseller = match[1].trim();
    if (resellerList.includes(reseller)) {
        return bot.sendMessage(chatId, cardInfo("Sudah Ada", `Reseller dengan ID <code>${escapeHtml(reseller)}</code> sudah ada.`), { parse_mode: "HTML" });
    }
    resellerList.push(reseller);
    saveReseller();
    bot.sendMessage(chatId, cardOk("Reseller Ditambahkan", `ID <code>${escapeHtml(reseller)}</code> berhasil ditambahkan.`), { parse_mode: "HTML" });
});

bot.onText(/^\/delress(?:\s+(.+))?$/, async (msg, match) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (!match[1]) {
        return bot.sendMessage(chatId, cardWarn("Cara Pakai", "/delress &lt;id_telegram&gt;", "Contoh: /delress 123456789"), { parse_mode: "HTML" });
    }
    const reseller = match[1].trim();
    const index = resellerList.indexOf(reseller);
    if (index === -1) {
        return bot.sendMessage(chatId, cardErr("Tidak Ditemukan", `Reseller dengan ID <code>${escapeHtml(reseller)}</code> tidak ditemukan.`), { parse_mode: "HTML" });
    }
    resellerList.splice(index, 1);
    saveReseller();
    bot.sendMessage(chatId, cardOk("Reseller Dihapus", `ID <code>${escapeHtml(reseller)}</code> berhasil dihapus.`), { parse_mode: "HTML" });
});

bot.onText(/^\/listress$/, async (msg) => {
    if (!isOwner(msg)) return;
    const chatId = msg.chat.id;
    if (resellerList.length === 0) {
        return bot.sendMessage(chatId, card("📭  Daftar Reseller", "Belum ada reseller tersimpan."), { parse_mode: "HTML" });
    }
    let list = resellerList.map((r, i) => `${i+1}. <code>${escapeHtml(r)}</code>`).join("\n");
    bot.sendMessage(chatId, card("📋  Daftar Reseller", list), { parse_mode: "HTML" });
});

// ==========================================
// COMMAND: /tempmail
// ==========================================
bot.onText(/^\/tempmail(?:@[a-zA-Z0-9_]+)?$/i, async (msg) => {
    const chatId = String(msg.chat.id);
    const userId = msg.from.id;
    const userMention = mention(msg.from);

    if (!allowedGroups.has(chatId)) return; 

    if (mailSessions.has(userId)) {
        return bot.sendMessage(chatId, cardWarn("Sesi Masih Aktif", `Halo ${userMention}\n\nTunggu OTP Railway sebelumnya masuk dulu.`), { parse_mode: "HTML" });
    }

    const address = createEmail();
    const message = card(
        "📧  Temp Mail Railway",
        `User   : ${userMention}\nEmail  : <code>${escapeHtml(address)}</code>`,
        "Menunggu OTP (maks. 15 menit)…"
    );

    const sent = await withBootFlair(chatId, [
        "$ tempmail --provision",
        "requesting inbox from catchmail...",
        "→ inbox ready"
    ], () => bot.sendMessage(chatId, message, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "𝐒𝐚𝐥𝐢𝐧 𝐄𝐦𝐚𝐢𝐥", copy_text: { text: address } }]] }
    }).catch(() => null));

    if (!sent) return;
    startMailMonitor(msg.chat.id, userId, address, userMention);
});

// ==========================================
// SSH: FETCH VPS DATA & UPLOAD & MONITOR
// ==========================================
function connectSSH(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let finished = false;

    function finish(error, result) {
      if (finished) return;
      finished = true;
      try { conn.end(); } catch {}
      error ? reject(error) : resolve(result);
    }

    conn.once("ready", () => {
      const command = `
mv /etc/profile.d/ara-welcome.sh /etc/profile.d/ara-welcome.sh.disabled 2>/dev/null
echo "__IP__"; IP=$(dig +short ${config.host} 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1); [ -z "$IP" ] && IP=$(dig +short tokaido.proxy.rlwy.net 2>/dev/null | grep -E '^[0-9.]+$' | head -n 1); [ -z "$IP" ] && IP=$(curl -sS ifconfig.me 2>/dev/null); [ -z "$IP" ] && IP=$(hostname -I 2>/dev/null | awk '{print $1}'); echo "$IP"
echo "__OS__"; . /etc/os-release 2>/dev/null; echo "\${PRETTY_NAME:-Unknown}"
echo "__CPU__"; lscpu 2>/dev/null | awk -F: '/Model name/{gsub(/^ +| +$/,"",$2); print $2; exit}'
echo "__CORES__"; nproc
echo "__RAM__"; free -h | awk '/^Mem:/{print $2}'
echo "__RAMUSED__"; free -h | awk '/^Mem:/{print $3"/"$2}'
echo "__DISK__"; df -hP / | awk 'NR==2{print $2}'
echo "__DISKUSED__"; df -hP / | awk 'NR==2{print $3"/"$2" ("$5")"}'
echo "__UPTIME__"; uptime -p | sed 's/up //'
echo "__KERNEL__"; uname -r
echo "__ARCH__"; uname -m
echo "__VIRT__"; (systemd-detect-virt 2>/dev/null || echo "unknown")
echo "__HOSTNAME__"; hostname
`;
      conn.exec(command, (err, stream) => {
        if (err) return finish(err);
        let stdout = "", stderr = "";
        stream.on("data", data => { stdout += data.toString(); });
        stream.stderr.on("data", data => { stderr += data.toString(); });
        stream.on("close", code => {
          if (!stdout.trim() && code !== 0) return finish(new Error(stderr.trim() || `Command exited with code ${code}`));
          finish(null, stdout);
        });
      });
    });

    conn.once("error", finish);
    conn.connect({ host: config.host, port: config.port, username: USERNAME, password: config.password, readyTimeout: 15000, keepaliveInterval: 5000, keepaliveCountMax: 3 });
  });
}

function uploadAndExtractSSH(config, localFilePath, fileName) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) { conn.end(); return reject(err); }
        const remotePath = `/root/${fileName}`;
        sftp.fastPut(localFilePath, remotePath, (err) => {
          if (err) { conn.end(); return reject(err); }
          const extractCmd = `
            cd /root; apt-get update >/dev/null 2>&1; apt-get install -y unzip file >/dev/null 2>&1
            MIME=$(file -b --mime-type "${fileName}")
            if [[ "$MIME" == *"gzip"* || "$MIME" == *"x-gzip"* ]]; then tar -xzf "${fileName}";
            elif [[ "$MIME" == *"zip"* ]]; then unzip -o "${fileName}";
            elif [[ "$MIME" == *"tar"* ]]; then tar -xf "${fileName}";
            else unzip -o "${fileName}" || tar -xzf "${fileName}" || tar -xf "${fileName}"; fi
          `;
          conn.exec(extractCmd, (err, stream) => {
            if (err) { conn.end(); return reject(err); }
            stream.on('close', () => { conn.end(); resolve(); }).on('data', () => {}).stderr.on('data', () => {});
          });
        });
      });
    }).on('error', (err) => reject(err)).connect({ host: config.host, port: config.port, username: USERNAME, password: config.password, readyTimeout: 15000, keepaliveInterval: 5000, keepaliveCountMax: 3 });
  });
}

function testSSHAuth(config) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => { conn.end(); resolve(true); })
        .on('error', (err) => reject(err))
        .connect({ host: config.host, port: config.port, username: USERNAME, password: config.password, readyTimeout: 10000 });
  });
}

function startVPSMonitor(readyId, config, targetNotifyId, userMention) {
  let attempts = 0;
  const timer = setInterval(async () => {
    attempts++;
    if (attempts > 360) {
      clearInterval(timer);
      readySessions.delete(readyId);
      return;
    }
    try {
      await testSSHAuth(config);
    } catch (err) {
      clearInterval(timer);
      const sessionData = readySessions.get(readyId);
      if (sessionData) {
        readySessions.delete(readyId); 
        if (targetNotifyId) {
           try { 
             await bot.sendMessage(targetNotifyId, cardWarn("Peringatan Sistem", `Halo ${userMention}, terdeteksi data VPS sudah diambil! Harap segera setor ke admin @MAKLOKNTLL`), { parse_mode: "HTML" }); 
           } catch (e) {}
        }
      }
    }
  }, 10000); 

  return timer;
}

function progressBar(step, total) {
    const filled = "●".repeat(step);
    const empty = "○".repeat(Math.max(0, total - step));
    const pct = Math.round((step / total) * 100);
    return `${filled}${empty}  <b>${pct}%</b>`;
}

// Cuplikan log teknis palsu yang tampil di tiap tahap deploy — kesannya kompleks
// dan meyakinkan, tapi murni kosmetik (bukan output request asli).
const DEPLOY_LOGS = {
    1: ["POST /graphql/v2 HTTP/1.1", 'query { me { workspaces { edges { node { id } } } } }', "→ 200 OK  auth=bearer  scope=full", "connection: keep-alive  latency=42ms"],
    2: ["GET workspace.members?role=admin", "→ access_level: ADMIN  quota: unlimited", "cache-control: no-store"],
    3: ["mutation projectCreate(input:{ name })", "→ project_id: prj_" + randomHex(8), "region: asia-southeast1  plan: pro"],
    4: ["mutation serviceCreate(source:{ image: 'ubuntu:22.04' })", "→ deployment: queued → building → active", "builder: railpack@2.4.1"],
    5: ["openssl rand -base64 18 | tee /root/.pw", 'chpasswd <<< "root:••••••••••"', "→ passwd: password updated successfully", "sha512crypt rounds=5000"],
    6: ["iptables -A INPUT -p tcp --dport $PORT -j ACCEPT", "systemctl restart sshd", "→ sshd: Server listening on 0.0.0.0 port 22", "tcp_proxy: bound external port"]
};

function randomHex(len) {
    const chars = "abcdef0123456789";
    let out = "";
    for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return out;
}

function deployCard(step, total, text, note) {
    const base = card(`⚙️ Menyiapkan VPS <i>(tahap ${step}/${total})</i>`, `${progressBar(step, total)}\n\n${text}`, note || "Mohon tunggu, jangan spam perintah.");
    const logs = DEPLOY_LOGS[step];
    // Log dipasang DI LUAR blockquote card, dibungkus <pre> (Telegram tidak izinkan <pre> bersarang di blockquote)
    return logs ? `${base}\n<pre>${escapeHtml(logs.join("\n"))}</pre>` : base;
}

// Kumpulan log build/deploy palsu yang berputar tiap kali status Railway di-poll,
// biar layar "Menyiapkan Server" (yang bisa nunggu lama) kelihatan benar-benar jalan.
const BUILD_LOG_POOL = {
    BUILDING: [
        "Step 1/9 : FROM ubuntu:22.04",
        "Step 2/9 : RUN apt-get update && apt-get install -y openssh-server curl",
        "Step 3/9 : RUN useradd -m -s /bin/bash deploy",
        "Step 4/9 : COPY entrypoint.sh /entrypoint.sh",
        "Step 5/9 : RUN chmod +x /entrypoint.sh",
        "Step 6/9 : EXPOSE 22",
        "Step 7/9 : ENTRYPOINT [\"/entrypoint.sh\"]",
        "Step 8/9 : pushing layer sha256:" + randomHex(12),
        "Step 9/9 : Successfully built " + randomHex(12),
        "Compressing image layers (9/9)...",
        "Tagging image as agaahost/vps:" + randomHex(6),
        "Pushing to internal registry... 100%"
    ],
    DEPLOYING: [
        "Starting container " + randomHex(10),
        "sshd: Server listening on 0.0.0.0 port 22",
        "GET /healthz → 200 OK",
        "readiness probe: passed (3/3)",
        "Container status: running",
        "Attaching overlay network eth0",
        "Mounting volume /var/lib/agaahost...",
        "Applying cgroup limits (cpu, mem)...",
        "Registering service with proxy mesh...",
        "Healthcheck interval set to 10s"
    ],
    default: [
        "Allocating build worker...",
        "Pulling base image layers...",
        "sha256:" + randomHex(12) + " [====>     ] 42%",
        "sha256:" + randomHex(12) + " [========> ] 78%",
        "Waiting for available compute slot...",
        "Provisioning ephemeral volume (20Gi)...",
        "Resolving DNS for internal.railway.app...",
        "Negotiating build cache with worker-" + randomHex(4),
        "Scheduling deployment on region us-west1",
        "Queue position: " + (Math.floor(Math.random() * 5) + 1)
    ]
};

function buildLogSnippet(status, attempt) {
    const pool = BUILD_LOG_POOL[status] || BUILD_LOG_POOL.default;
    const start = attempt % pool.length;
    const lines = [];
    for (let i = 0; i < Math.min(5, pool.length); i++) lines.push(pool[(start + i) % pool.length]);
    return lines;
}

/**
 * Animasi "log koneksi SSH" — baris log muncul satu-satu lewat edit pesan,
 * biar kelihatan sedang benar-benar mengecek server (bukan cuma spinner polos).
 */
async function sshCheckAnimation(chatId, title, host, port) {
    const lines = [
        `$ ssh -p ${port} root@${host}`,
        "Authenticating (publickey,password)...",
        "root@target's password: ••••••••••",
        `Last login: ${new Date().toUTCString()}`,
        "Fetching: uname -a && lscpu",
        "Fetching: free -h && df -hP /",
        "Fetching: uptime -p && systemd-detect-virt",
        "→ session established, parsing output..."
    ];
    const body = card(title, "", "Mohon tunggu sebentar...");
    let shown = [lines[0]];
    let msg;
    try {
        msg = await bot.sendMessage(chatId, `${body}\n<pre>${escapeHtml(shown.join("\n"))}</pre>`, { parse_mode: "HTML", reply_markup: cancelKeyboard });
    } catch (e) {
        return null;
    }
    for (let i = 1; i < lines.length; i++) {
        await sleep(300 + Math.random() * 250);
        shown.push(lines[i]);
        try {
            await bot.editMessageText(`${body}\n<pre>${escapeHtml(shown.join("\n"))}</pre>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "HTML" });
        } catch (e) {}
    }
    return msg;
}

/**
 * Flair singkat ala "loading code" — dipasang di depan menu/perintah apa pun
 * biar setiap kali command dijalankan, kelihatan ada proses teknis yang jalan
 * sebelum hasil akhirnya muncul. Otomatis dihapus setelah selesai.
 */
async function quickBoot(chatId, lines) {
    let shown = [lines[0]];
    let msg;
    try {
        msg = await bot.sendMessage(chatId, `<pre>${escapeHtml(shown.join("\n"))}</pre>`, { parse_mode: "HTML" });
    } catch (e) {
        return null;
    }
    for (let i = 1; i < lines.length; i++) {
        await sleep(160 + Math.random() * 140);
        shown.push(lines[i]);
        try {
            await bot.editMessageText(`<pre>${escapeHtml(shown.join("\n"))}</pre>`, { chat_id: chatId, message_id: msg.message_id, parse_mode: "HTML" });
        } catch (e) {}
    }
    await sleep(220);
    return msg;
}

async function withBootFlair(chatId, lines, task) {
    const boot = await quickBoot(chatId, lines);
    try {
        return await task();
    } finally {
        if (boot) { try { await bot.deleteMessage(chatId, boot.message_id); } catch (e) {} }
    }
}

// ==========================================
// PARSER & FORMATTERS (WITH PERFECT RAM FIX)
// ==========================================
function getField(raw, name) {
  const match = raw.match(new RegExp(`__${name}__\\s*\\n([\\s\\S]*?)(?=\\n__|$)`));
  return match ? match[1].trim() : "-";
}

function parseVPS(raw) {
  let ramRaw = getField(raw, "RAM");
  let ramDisplay = ramRaw;
  
  if (ramRaw !== "-") {
      const num = ramRaw.replace(/[^\d\.]/g, '');
      if (ramRaw.toUpperCase().includes('G')) {
          ramDisplay = num + ' GB';
      } else if (ramRaw.toUpperCase().includes('M')) {
          ramDisplay = num + ' MB';
      }
  }

  return {
    ip: getField(raw, "IP"), os: getField(raw, "OS"), cpu: getField(raw, "CPU"),
    cores: getField(raw, "CORES"), ram: ramDisplay, disk: getField(raw, "DISK"),
    uptime: getField(raw, "UPTIME"),
    ramUsed: getField(raw, "RAMUSED"), diskUsed: getField(raw, "DISKUSED"),
    kernel: getField(raw, "KERNEL"), arch: getField(raw, "ARCH"),
    virt: getField(raw, "VIRT"), hostname: getField(raw, "HOSTNAME")
  };
}

function formatCombinedVPS(vps, port, password) {
  return card(
    "🖥️ VPS Berhasil Dibuat",
`<b>${smallCaps("Spesifikasi")}</b>
🏷️ Hostname : <code>${escapeHtml(vps.hostname)}</code>
🧩 OS       : <code>${escapeHtml(vps.os)}</code>
🧬 Kernel   : <code>${escapeHtml(vps.kernel)}</code>
🏗️ Arch     : <code>${escapeHtml(vps.arch)}</code>
🧊 Virt     : <code>${escapeHtml(vps.virt)}</code>
🧠 CPU      : <code>${escapeHtml(vps.cpu)}</code>
🧵 Core     : <code>${escapeHtml(vps.cores)}</code>
💾 RAM      : <code>${escapeHtml(vps.ramUsed)}</code> <i>(total ${escapeHtml(vps.ram)})</i>
📀 Disk     : <code>${escapeHtml(vps.diskUsed)}</code> <i>(total ${escapeHtml(vps.disk)})</i>
⏱️ Uptime   : <code>${escapeHtml(vps.uptime)}</code>

🟢 Status   : <b>ACTIVE</b>`,
    "IP, username, port, dan password ada di tombol salin di bawah ini. Simpan baik-baik, jangan share ke orang lain."
  );
}

// ==========================================
// COMMAND: /createvps (TUTORIAL TANPA LINK)
// ==========================================
bot.onText(/^\/createvps(?:@[a-zA-Z0-9_]+)?$/i, async msg => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const userMention = mention(msg.from);
  const isPrivate = msg.chat.type === "private";

  // Create VPS TIDAK PERNAH boleh dari private chat bot, tanpa pengecualian.
  if (isPrivate) {
    return bot.sendMessage(chatId, cardErr(
      "Tidak Bisa di Sini",
      `Halo ${userMention}, pembuatan VPS tidak bisa dilakukan lewat chat pribadi bot.`,
      "Masuk ke grup resmi, lalu ketik /createvps di sana."
    ), { parse_mode: "HTML" }).catch(() => {});
  }

  // Hanya boleh dipakai di satu grup resmi yang sudah ditentukan.
  if (chatId !== ALLOWED_GROUP_ID) {
    return bot.sendMessage(chatId, cardErr(
      "Grup Tidak Diizinkan",
      `Halo ${userMention}, /createvps hanya bisa dipakai di grup resmi.`,
      "Hubungi owner jika kamu merasa ini salah."
    ), { parse_mode: "HTML" }).catch(() => {});
  }

  try { await bot.deleteMessage(chatId, msg.message_id); } catch(e) {}

  // Wajib bisa DM (data login VPS dikirim privat)
  try {
      await bot.sendMessage(userId, cardOk(
          "DM Terhubung",
          `Halo ${userMention}\n\nData login VPS akan dikirim ke sini setelah selesai.`,
          "Lanjutkan isi token &amp; nama di chat sebelumnya."
      ), { parse_mode: 'HTML' });
  } catch (error) {
      const botInfo = await bot.getMe();
      await bot.sendMessage(chatId, cardWarn(
          "DM Masih Tertutup",
          `Halo ${userMention}\n\nBot harus bisa kirim data VPS ke DM kamu.\nKlik tombol di bawah, lalu ketik ulang /createvps.`,
          null
      ), {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: "𝐒𝐭𝐚𝐫𝐭 𝐁𝐨𝐭", url: `https://t.me/${botInfo.username}?start=createvps`, style: "success" }]] }
      });
      return;
  }

  // Alur: (1) token → (2) nama → buat VPS
  createInputSession(chatId, {
      step: "createvps_token",
      action: "createvps",
      initiator: userId
  });

  await withBootFlair(chatId, [
      "$ agaahost-cli init --session " + userId,
      "allocating session slot...",
      "→ ready for token input"
  ], () => bot.sendMessage(chatId, card(
      "🖥️ Create VPS · Langkah 1 dari 2",
      `Halo ${userMention}, kirim <b>token Railway</b> kamu di chat ini.\n\n<b>Cara ambil token:</b>\nBuka halaman Token Railway, lalu pilih <b>New Token</b> → <b>My Projects</b>. Klik <b>Create</b>, salin token yang muncul, lalu tempel di sini.`,
      "Pesan token kamu akan langsung dihapus otomatis setelah diterima."
  ), {
      parse_mode: "HTML",
      reply_markup: {
          inline_keyboard: [
              [{ text: "𝐒𝐚𝐥𝐢𝐧 𝐋𝐢𝐧𝐤 𝐓𝐨𝐤𝐞𝐧 𝐑𝐚𝐢𝐥𝐰𝐚𝐲", copy_text: { text: "https://railway.app/account/tokens", style: "primary" } }],
              [{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel", style: "danger" }]
          ]
      }
  }));
});

// ==========================================
// COMMAND: /start, /login, /fix, /upload
// ==========================================
bot.onText(/^\/start/, async msg => {
  if (msg.text.includes('createvps')) {
      return bot.sendMessage(msg.chat.id, cardOk(
          "DM Aktif",
          `Halo ${mention(msg.from)}, koneksi DM berhasil.\nSekarang kembali ke grup resmi dan ketik /createvps untuk mulai.`,
          "Create VPS hanya bisa dari grup resmi, bukan dari DM ini."
      ), { parse_mode: "HTML" });
  }

  if (msg.text.includes('fix')) {
      return bot.sendMessage(msg.chat.id, cardOk(
          "DM Aktif",
          `Halo ${mention(msg.from)}, koneksi DM berhasil.\nSekarang kembali ke grup dan ketik /fix untuk mulai.`,
          "Hasil cek VPS akan dikirim ke sini, bukan ke grup."
      ), { parse_mode: "HTML" });
  }

  if (msg.text.includes('mytoken')) {
      const userId = msg.from.id;
      const existing = getUserOwnToken(userId);
      const status = existing
          ? `🔐 Token tersimpan · <code>${escapeHtml(existing.substring(0, 8))}…</code>\n\nKirim token baru untuk mengganti.`
          : `Belum ada token.\n\nKirim token Railway sekarang.`;
      createInputSession(msg.chat.id, { step: "mytoken_wait", action: "mytoken", initiator: userId });
      return bot.sendMessage(msg.chat.id, card(
          "🔑 Token Railway",
          `Halo ${mention(msg.from)}\n\n${status}`,
          "Token hanya untuk akun Telegram kamu."
      ), { parse_mode: "HTML", reply_markup: cancelKeyboard });
  }

  // User biasa
  if (!isOwner(msg)) {
      const userList =
`<b>Perintah tersedia</b>
▸ /createvps — buat VPS <i>(khusus di grup resmi)</i>
▸ /fix — cek spek &amp; akses VPS <i>(hasil dikirim ke DM)</i>
▸ /mytoken — pasang atau ganti token
▸ /tempmail — email sementara
▸ /whoami — cek ID Telegram kamu
▸ /ping — cek bot masih hidup`;
      return withBootFlair(msg.chat.id, [
          "$ agaahost menu --user " + msg.from.id,
          "loading permissions...",
          "→ ready"
      ], () => sendCardPhoto(msg.chat.id, card(
          "🖥️ VPS Manager",
          `Halo ${mention(msg.from)}\n\n${userList}`,
          "Create VPS tidak bisa dari DM ini, hanya di grup resmi."
      ), { reply_markup: linksKeyboard }));
  }

  clearInputSession(msg.chat.id);

  const panelSections = [
      { h: "🖥 VPS &amp; Akses", items: [
          "/createvps — buat VPS baru",
          "/login — ambil alih VPS",
          "/fix — cek spek + akses VPS",
          "/upload — kirim file ke VPS"
      ]},
      { h: "🔑 Token Railway", items: [
          "/settoken — tambah/atur token",
          "/listtokens — daftar token",
          "/deltoken — hapus token"
      ]},
      { h: "🗂 Data VPS", items: [
          "/listvps — semua VPS aktif",
          "/delvps — hapus dari daftar",
          "/fixvps — cek ulang VPS lama"
      ]},
      { h: "🌐 Grup", items: [
          "/add — daftarkan grup",
          "/del — hapus grup",
          "/listadd — daftar grup"
      ]},
      { h: "⭐ Premium &amp; Reseller", items: [
          "/addprem — tambah premium",
          "/delprem — hapus premium",
          "/listprem — daftar premium",
          "/address — tambah reseller",
          "/delress — hapus reseller",
          "/listress — daftar reseller"
      ]},
      { h: "⚙️ Lainnya", items: [
          "/stats — statistik bot",
          "/ping — cek bot hidup",
          "/whoami — cek ID Telegram"
      ]}
  ];
  const panelBody = panelSections.map(s => `<b>${s.h}</b>\n` + s.items.map(i => "▸ " + i).join("\n")).join("\n\n");

  await withBootFlair(msg.chat.id, [
      "$ agaahost-cli auth --owner " + msg.from.id,
      "verifying credentials...",
      "privilege: ROOT (full access)",
      "→ access granted"
  ], () => sendCardPhoto(msg.chat.id, card(
      "🖥️ VPS Manager · Dashboard Owner",
      `Halo ${mention(msg.from)}\n\n${panelBody}`,
      "Create VPS cuma bisa dari grup resmi, bukan DM."
  ), { reply_markup: homeKeyboard }));
});

bot.onText(/^\/login$/, async msg => {
  if (!isOwner(msg)) return;
  createInputSession(msg.chat.id, { step: "domain", action: "login" });
  await withBootFlair(msg.chat.id, [
      "$ agaahost-cli init --session login",
      "allocating session slot...",
      "→ ready"
  ], () => bot.sendMessage(msg.chat.id, card("🌐  Login VPS  ·  1/2", `Halo ${mention(msg.from)}, kirim domain / hostname SSH VPS tujuan.`, "Bisa format langsung: host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard }));
});

bot.onText(/^\/fix$/, async msg => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const userMention = mention(msg.from);
  const isPrivate = msg.chat.type === "private";
  const allowed = isOwner(msg) || (!isPrivate && allowedGroups.has(chatId));
  if (!allowed) return;

  // Kalau dipakai di grup, hasil cek VPS nanti dikirim ke DM — pastikan DM-nya kebuka dulu.
  if (!isPrivate) {
    try {
      await bot.sendMessage(userId, cardOk(
        "DM Terhubung",
        `Halo ${userMention}\n\nHasil cek VPS nanti dikirim ke sini, bukan ke grup.`,
        "Lanjutkan isi domain, port, dan password di grup."
      ), { parse_mode: "HTML" });
    } catch (error) {
      const botInfo = await bot.getMe();
      return bot.sendMessage(chatId, cardWarn(
        "DM Masih Tertutup",
        `Halo ${userMention}\n\nBot harus bisa kirim hasil cek VPS ke DM kamu.\nKlik tombol di bawah, lalu ketik ulang /fix.`,
        null
      ), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "𝐒𝐭𝐚𝐫𝐭 𝐁𝐨𝐭", url: `https://t.me/${botInfo.username}?start=fix`, style: "success" }]] }
      });
    }
  }

  createInputSession(msg.chat.id, { step: "domain", action: "fix", initiator: userId, originIsPrivate: isPrivate });
  await withBootFlair(msg.chat.id, [
      "$ agaahost-cli init --session fix",
      "allocating session slot...",
      "→ ready"
  ], () => bot.sendMessage(msg.chat.id, card("🔧  Cek VPS  ·  1/2", `Halo ${userMention}, kirim domain / hostname SSH VPS.`, "Bisa format langsung: host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard }));
});

bot.onText(/^\/upload$/, async msg => {
  if (!isOwner(msg)) return;
  if (!msg.reply_to_message || !msg.reply_to_message.document) {
    return bot.sendMessage(msg.chat.id, cardWarn("Cara Pakai /upload", `Halo ${mention(msg.from)}, reply (balas) sebuah file yang sudah dikirim ke bot dengan perintah /upload.`), { parse_mode: "HTML" });
  }
  const doc = msg.reply_to_message.document;
  createInputSession(msg.chat.id, { step: "domain", action: "upload", fileId: doc.file_id, fileName: doc.file_name || "uploaded_file" });
  await bot.sendMessage(msg.chat.id, card("📂  Upload File  ·  1/2", `File terdeteksi: <code>${escapeHtml(doc.file_name)}</code>\n\nHalo ${mention(msg.from)}, kirim domain / hostname SSH VPS tujuan.`, "Bisa format langsung: host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
});

// ==========================================
// ===== FITUR BARU: LISTVPS, DELVPS, FIXVPS =====
// ==========================================

// --- FUNGSI API RAILWAY (tambahan) ---

async function fetchProjects(token) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const wsQuery = `query { me { workspaces { edges { node { id } } } } }`;
    const wsRes = await axios.post(RAILWAY_API_URL, { query: wsQuery }, { headers });
    const workspaceId = wsRes.data?.data?.me?.workspaces?.edges?.[0]?.node?.id;
    if (!workspaceId) throw new Error("Tidak ditemukan workspace untuk token ini.");

    const projQuery = `query { workspace(id: "${workspaceId}") { projects { edges { node { id name } } } } }`;
    const projRes = await axios.post(RAILWAY_API_URL, { query: projQuery }, { headers });
    const projects = projRes.data?.data?.workspace?.projects?.edges?.map(e => e.node) || [];
    return projects;
}

async function fetchServices(token, projectId) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const query = `query { project(id: "${projectId}") { services { edges { node { id name } } } } }`;
    const res = await axios.post(RAILWAY_API_URL, { query }, { headers });
    const services = res.data?.data?.project?.services?.edges?.map(e => e.node) || [];
    return services;
}

async function deleteService(token, serviceId) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const mutation = `mutation { serviceDelete(input: { id: "${serviceId}" }) { id } }`;
    const res = await axios.post(RAILWAY_API_URL, { query: mutation }, { headers });
    return res.data?.data?.serviceDelete?.id || null;
}

async function redeployService(token, serviceId) {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const mutation = `mutation { deploymentCreate(input: { serviceId: "${serviceId}" }) { id } }`;
    const res = await axios.post(RAILWAY_API_URL, { query: mutation }, { headers });
    return res.data?.data?.deploymentCreate?.id || null;
}

// --- COMMAND: /listvps ---
bot.onText(/^\/listvps$/, async msg => {
    if (!isOwner(msg)) return;
    createInputSession(msg.chat.id, { step: "listvps_token", action: "listvps" });
    await bot.sendMessage(msg.chat.id, card("🔑  List VPS", `Halo ${mention(msg.from)}, masukkan Railway API Token untuk melihat daftar VPS.`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
});

// --- COMMAND: /delvps ---
bot.onText(/^\/delvps$/, async msg => {
    if (!isOwner(msg)) return;
    createInputSession(msg.chat.id, { step: "delvps_token", action: "delvps" });
    await bot.sendMessage(msg.chat.id, card("🔑  Hapus VPS", `Halo ${mention(msg.from)}, masukkan Railway API Token untuk menghapus VPS.`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
});

// --- COMMAND: /fixvps ---
bot.onText(/^\/fixvps$/, async msg => {
    if (!isOwner(msg)) return;
    createInputSession(msg.chat.id, { step: "fixvps_token", action: "fixvps" });
    await bot.sendMessage(msg.chat.id, card("🔑  Perbaiki VPS", `Halo ${mention(msg.from)}, masukkan Railway API Token untuk memperbaiki VPS (redeploy).`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
});

// ==========================================
// CALLBACK BUTTON
// ==========================================
bot.on("callback_query", async query => {
  const chatId = String(query.message.chat.id);
  const userId = query.from.id.toString();
  const userMention = mention(query.from);

  if (query.data === "cancel") {
    clearInputSession(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Proses dibatalkan." });
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}
    return;
  }

  // --- Tombol "Create VPS" via DM DINONAKTIFKAN. Create VPS hanya boleh via /createvps di grup resmi. ---
  if (query.data === "createvps") {
      await bot.answerCallbackQuery(query.id, { text: "Create VPS tidak bisa dari DM.", show_alert: true });
      return bot.editMessageText(cardErr(
          "Tidak Bisa di Sini",
          `Halo ${userMention}, pembuatan VPS tidak bisa dilakukan lewat chat pribadi bot.`,
          "Masuk ke grup resmi, lalu ketik /createvps di sana."
      ), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML"
      }).catch(() => {});
  }

  // --- Lanjutkan Create VPS dengan token tersimpan (dari /createvps di grup) ---
  if (query.data.startsWith("lanjut_create_vps_")) {
      const targetUserId = query.data.split("_")[3];
      if (userId !== targetUserId) return bot.answerCallbackQuery(query.id, { text: "Ini bukan sesi kamu!", show_alert: true });

      await bot.answerCallbackQuery(query.id);

      // Hanya token yang terkunci untuk akun Telegram ini yang ditampilkan (1 token = 1 akun Telegram)
      const aliases = getUserTokenAliases(targetUserId);
      if (aliases.length === 0) {
          return bot.editMessageText(cardErr("Belum Punya Token", "Kamu belum set token Railway.", "Buka DM bot → ketik /mytoken TOKEN_KAMU (bisa diganti kapan saja)."), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML"
          });
      }

      if (aliases.length === 1) {
          const alias = aliases[0];
          const token = tokens[alias].token;
          createInputSession(chatId, { step: "vps_name", action: "createvps", initiator: targetUserId, selectedToken: token, selectedAlias: alias });
          return bot.editMessageText(card("🏷️  Nama VPS", `Halo ${userMention}, masukkan nama VPS.`, `Token: <b>${escapeHtml(alias)}</b> · Contoh: bot-vps-1 (tanpa spasi)`), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML",
              reply_markup: cancelKeyboard
          });
      }

      const buttons = aliases.map(a => [{ text: escapeHtml(a), callback_data: `select_token_${a}` }]);
      buttons.push([{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel", style: "danger" }]);
      await bot.editMessageText(card("🔑  Pilih Token", "Pilih token yang akan digunakan:"), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: buttons }
      });
      return;
  }

  // --- Pilihan token untuk createvps ---
  if (query.data.startsWith("select_token_")) {
      const alias = query.data.replace("select_token_", "");
      if (!tokens[alias]) {
          return bot.answerCallbackQuery(query.id, { text: "Token tidak ditemukan.", show_alert: true });
      }
      // Kunci 1 token = 1 akun Telegram: tolak jika token bukan milik akun ini (owner bot dikecualikan)
      if (!canUseToken(alias, userId)) {
          return bot.answerCallbackQuery(query.id, { text: "Token ini bukan milik akun Telegram kamu!", show_alert: true });
      }
      const token = tokens[alias].token;
      let session = getInputSession(chatId);
      if (!session || session.action !== 'createvps') {
          createInputSession(chatId, { step: "vps_name", action: "createvps", initiator: userId, selectedToken: token, selectedAlias: alias });
      } else {
          session.selectedToken = token;
          session.selectedAlias = alias;
          session.step = "vps_name";
      }
      await bot.answerCallbackQuery(query.id);
      await bot.editMessageText(card("🏷️  Nama VPS", `Halo ${userMention}, masukkan nama VPS.`, `Token: <b>${escapeHtml(alias)}</b> · Contoh: bot-vps-1 (tanpa spasi)`), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: cancelKeyboard
      });
      return;
  }

  // --- FITUR LISTVPS/DELVPS/FIXVPS (callback) ---
  if (query.data.startsWith("listvps_project_") || query.data.startsWith("delvps_project_") || query.data.startsWith("fixvps_project_")) {
      const parts = query.data.split("_");
      const action = parts[0];
      const projectId = parts[2];
      const session = getInputSession(chatId);
      if (!session || session.action !== action) {
          return bot.answerCallbackQuery(query.id, { text: "Sesi tidak valid atau sudah kadaluarsa.", show_alert: true });
      }
      const token = session.token;
      try {
          const services = await fetchServices(token, projectId);
          if (services.length === 0) {
              await bot.answerCallbackQuery(query.id, { text: "Project ini tidak memiliki service (VPS).", show_alert: true });
              return;
          }
          session.projectId = projectId;
          session.services = services;
          session.step = `${action}_select_service`;
          const buttons = services.map(s => [{ text: escapeHtml(s.name || s.id), callback_data: `${action}_service_${s.id}` }]);
          buttons.push([{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel", style: "danger" }]);
          await bot.editMessageText(card("📦  Pilih Service", "Pilih service (VPS) dari project:"), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML",
              reply_markup: { inline_keyboard: buttons }
          });
          await bot.answerCallbackQuery(query.id);
      } catch (err) {
          await bot.answerCallbackQuery(query.id, { text: `Error: ${escapeHtml(err.message)}`, show_alert: true });
      }
      return;
  }

  if (query.data.startsWith("listvps_service_")) {
      const parts = query.data.split("_");
      const serviceId = parts[2];
      const session = getInputSession(chatId);
      if (!session || session.action !== "listvps") {
          return bot.answerCallbackQuery(query.id, { text: "Sesi tidak valid.", show_alert: true });
      }
      const service = session.services.find(s => s.id === serviceId);
      if (!service) {
          return bot.answerCallbackQuery(query.id, { text: "Service tidak ditemukan.", show_alert: true });
      }
      await bot.editMessageText(card("📄  Detail Service", `Nama: ${escapeHtml(service.name)}\nID: <code>${escapeHtml(service.id)}</code>`), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "𝐊𝐞𝐦𝐛𝐚𝐥𝐢 𝐤𝐞 𝐝𝐚𝐟𝐭𝐚𝐫 𝐬𝐞𝐫𝐯𝐢𝐜𝐞", callback_data: `${session.action}_project_${session.projectId}`, style: "danger" }], [{ text: "𝐓𝐮𝐭𝐮𝐩", callback_data: "close", style: "danger" }]] }
      });
      await bot.answerCallbackQuery(query.id);
      return;
  }

  if (query.data.startsWith("delvps_service_")) {
      const parts = query.data.split("_");
      const serviceId = parts[2];
      const session = getInputSession(chatId);
      if (!session || session.action !== "delvps") {
          return bot.answerCallbackQuery(query.id, { text: "Sesi tidak valid.", show_alert: true });
      }
      const service = session.services.find(s => s.id === serviceId);
      if (!service) {
          return bot.answerCallbackQuery(query.id, { text: "Service tidak ditemukan.", show_alert: true });
      }
      await bot.editMessageText(cardWarn("Konfirmasi Hapus", `Yakin ingin menghapus service <b>${escapeHtml(service.name)}</b>? (ID: ${escapeHtml(serviceId)})`, "Aksi ini tidak dapat dibatalkan."), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          reply_markup: {
              inline_keyboard: [
                  [{ text: "𝐘𝐚, 𝐇𝐚𝐩𝐮𝐬", callback_data: `delvps_confirm_${serviceId}`, style: "danger" }],
                  [{ text: "𝐁𝐚𝐭𝐚𝐥", callback_data: "cancel", style: "danger"  }]
              ]
          }
      });
      await bot.answerCallbackQuery(query.id);
      return;
  }

  if (query.data.startsWith("delvps_confirm_")) {
      const parts = query.data.split("_");
      const serviceId = parts[2];
      const session = getInputSession(chatId);
      if (!session || session.action !== "delvps") {
          return bot.answerCallbackQuery(query.id, { text: "Sesi tidak valid.", show_alert: true });
      }
      const token = session.token;
      try {
          await deleteService(token, serviceId);
          await bot.editMessageText(cardOk("Service Dihapus", "Service berhasil dihapus."), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML"
          });
          clearInputSession(chatId);
          await bot.answerCallbackQuery(query.id, { text: "Berhasil dihapus!" });
      } catch (err) {
          await bot.editMessageText(cardErr("Gagal Menghapus", escapeHtml(err.message)), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML"
          });
          await bot.answerCallbackQuery(query.id, { text: "Error", show_alert: true });
      }
      return;
  }

  if (query.data.startsWith("fixvps_service_")) {
      const parts = query.data.split("_");
      const serviceId = parts[2];
      const session = getInputSession(chatId);
      if (!session || session.action !== "fixvps") {
          return bot.answerCallbackQuery(query.id, { text: "Sesi tidak valid.", show_alert: true });
      }
      const token = session.token;
      try {
          const deploymentId = await redeployService(token, serviceId);
          await bot.editMessageText(cardOk("Redeploy Dimulai", `Deployment ID: <code>${escapeHtml(deploymentId)}</code>`), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML"
          });
          clearInputSession(chatId);
          await bot.answerCallbackQuery(query.id, { text: "Redeploy berhasil!" });
      } catch (err) {
          await bot.editMessageText(cardErr("Gagal Redeploy", escapeHtml(err.message)), {
              chat_id: chatId,
              message_id: query.message.message_id,
              parse_mode: "HTML"
          });
          await bot.answerCallbackQuery(query.id, { text: "Error", show_alert: true });
      }
      return;
  }

  // KHUSUS OWNER: Cek izin untuk tombol menu utama
  if (Number(userId) !== OWNER_ID) {
      return bot.answerCallbackQuery(query.id, { text: "⛔ Akses ditolak." });
  }

  if (query.data === "close") {
    clearInputSession(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Ditutup." });
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}
    return;
  }

  if (query.data === "back_home") {
    clearInputSession(chatId);
    await bot.answerCallbackQuery(query.id);
    const commandList =
`<b>🖥 VPS &amp; Akses</b>
▸ /createvps
▸ /login
▸ /fix
▸ /upload

<b>🔑 Token</b>
▸ /settoken
▸ /listtokens
▸ /deltoken

<b>🗂 Data VPS</b>
▸ /listvps
▸ /delvps
▸ /fixvps

<b>🌐 Grup &amp; Akses</b>
▸ /add  /del  /listadd
▸ /addprem  /delprem  /listprem
▸ /address  /delress  /listress

<b>⚙️ Lainnya</b>
▸ /stats
▸ /ping
▸ /whoami`;
    return editCardMessage(query, card(
        "🖥️ VPS Manager · Dashboard Owner",
        `Halo ${userMention}\n\n${commandList}`,
        "Create VPS tidak bisa dari DM, hanya di grup resmi."
    ), { reply_markup: homeKeyboard });
  }

  if (query.data === "menu_token") {
    await bot.answerCallbackQuery(query.id);
    return editCardMessage(query, card(
        "🔑  Kelola Token Railway",
        "Setiap token dikunci ke 1 akun Telegram.\nPilih aksi di bawah 👇",
        "Owner only"
    ), { reply_markup: tokenMenuKeyboard });
  }

  if (query.data === "stats_btn") {
    if (Number(userId) !== OWNER_ID) {
        return bot.answerCallbackQuery(query.id, { text: "Khusus owner.", show_alert: true });
    }
    await bot.answerCallbackQuery(query.id);
    const uptimeSec = process.uptime();
    const d = Math.floor(uptimeSec / 86400);
    const h = Math.floor((uptimeSec % 86400) / 3600);
    const m = Math.floor((uptimeSec % 3600) / 60);
    const body =
`🔑 Token tersimpan  : <code>${Object.keys(tokens).length}</code>
🌐 Grup resmi       : <code>${allowedGroups.size}</code>
⭐ User premium      : <code>${premiumUsers.size}</code>
🤝 Akses reseller    : <code>${resellerList.length}</code>
🟢 Sesi VPS aktif    : <code>${readySessions.size}</code>
⏱️ Bot berjalan      : <code>${d}h ${h}j ${m}m</code>`;
    return editCardMessage(query, card("📊  Statistik Bot", body, "Kembali ke menu untuk aksi lain."), {
        reply_markup: backHomeKeyboard
    });
  }

  if (query.data === "listtokens_view") {
    await bot.answerCallbackQuery(query.id);
    const aliases = Object.keys(tokens);
    if (aliases.length === 0) {
        return editCardMessage(query, card("📭  Daftar Token", "Belum ada token tersimpan."), { reply_markup: tokenMenuKeyboard });
    }
    let list = aliases.map((a, i) => {
        const t = tokens[a];
        const bound = t.ownerId ? `<code>${escapeHtml(String(t.ownerId))}</code>` : "⚠️ <i>belum dikunci</i>";
        return `<b>${i+1}. ${escapeHtml(a)}</b>\n    🔐 <code>${escapeHtml(t.token.substring(0,8))}...</code>\n    👤 Pemilik: ${bound}`;
    }).join("\n\n");
    return editCardMessage(query, card("📋  Token Tersimpan", list), { reply_markup: tokenMenuKeyboard });
  }

  if (query.data === "settoken_start") {
    await bot.answerCallbackQuery(query.id);
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}
    createInputSession(chatId, { step: "settoken_alias", action: "settoken" });
    return bot.sendMessage(chatId, card("🏷️  Tambah Token  ·  1/3", "Masukkan <b>alias</b> untuk token ini.\nContoh: <code>utama</code> atau <code>vps2</code>"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
  }

  if (query.data === "login") {
    await bot.answerCallbackQuery(query.id);
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}
    createInputSession(chatId, { step: "domain", action: "login" });
    return bot.sendMessage(chatId, card("🌐  Login VPS  ·  1/2", `Halo ${userMention}, kirim domain / hostname SSH VPS tujuan.`, "Bisa format langsung: host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
  }

  if (query.data === "fix") {
    await bot.answerCallbackQuery(query.id);
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {}
    createInputSession(chatId, { step: "domain", action: "fix", initiator: userId, originIsPrivate: query.message.chat.type === "private" });
    return bot.sendMessage(chatId, card("🔧  Cek VPS  ·  1/2", `Halo ${userMention}, kirim domain / hostname SSH VPS.`, "Bisa format langsung: host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
  }

  if (query.data.startsWith("drop_vps_")) {
    const readyId = query.data.substring(9);
    const sessionData = readySessions.get(readyId);
    
    if (!sessionData) return bot.answerCallbackQuery(query.id, { text: "Sesi VPS ini tidak ditemukan atau sudah hangus dipantau.", show_alert: true });
    if (knownGroups.size === 0) return bot.answerCallbackQuery(query.id, { text: "⚠️ Bot belum mendeteksi grup.", show_alert: true });

    const groupButtons = [];
    for (const [gId, gTitle] of knownGroups.entries()) {
      groupButtons.push([{ text: `📢 ${escapeHtml(gTitle)}`, callback_data: `sendto_${gId}_${readyId}`, style: "primary" }]);
    }
    groupButtons.push([{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel", style: "danger" }]);

    await bot.answerCallbackQuery(query.id);
    return bot.editMessageText(card("🎯  Pilih Grup Tujuan", `Halo ${userMention}, ke grup manakah data VPS ini mau dijatuhkan?`), {
      chat_id: chatId, message_id: query.message.message_id, parse_mode: "HTML", reply_markup: { inline_keyboard: groupButtons }
    });
  }

  if (query.data.startsWith("sendto_")) {
    const match = query.data.match(/sendto_(-?\d+)_([a-zA-Z0-9]+)/);
    if (!match) return;
    
    const targetGroupId = match[1];
    const readyId = match[2];

    const sessionData = readySessions.get(readyId);
    if (!sessionData) return bot.answerCallbackQuery(query.id, { text: "Sesi kadaluarsa atau password sudah diganti.", show_alert: true });
    if (sessionData.dropped) return bot.answerCallbackQuery(query.id, { text: "VPS ini sudah dijatuhkan!", show_alert: true });
    
    sessionData.dropped = true; 
    sessionData.targetNotifyId = targetGroupId; 

    await bot.answerCallbackQuery(query.id, { text: "VPS sedang dikirim ke target grup!" });
    try { await bot.deleteMessage(chatId, query.message.message_id); } catch {} 

    const { vps, config } = sessionData;
    const countdownMsg = await bot.sendMessage(targetGroupId, card("🎯  VPS Sedang Dijatuhkan", "Semuanya siap! VPS akan dikirim dalam hitungan mundur..."), { parse_mode: "HTML" });
    await delay(3000);

    for (let i = 10; i >= 1; i--) {
      try { await bot.editMessageText(card("⏳  Hitungan Mundur", `VPS akan muncul dalam <b>${i}</b> detik...`), { chat_id: targetGroupId, message_id: countdownMsg.message_id, parse_mode: "HTML" }); } catch (e) {}
      await delay(1000);
    }
    try { await bot.deleteMessage(targetGroupId, countdownMsg.message_id); } catch (e) {}

    const combinedMsg = formatCombinedVPS(vps, config.port, config.password);
    const copyKeyboard = {
      inline_keyboard: [
        [{ text: "𝐂𝐎𝐏𝐘 𝐈𝐏𝐕𝐏𝐒", copy_text: { text: vps.ip }, style: "success" }],
        [{ text: "𝐂𝐎𝐏𝐘 𝐔𝐒𝐄𝐑𝐍𝐀𝐌𝐄", copy_text: { text: USERNAME }, style: "primary" }],
        [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐎𝐑𝐓", copy_text: { text: String(config.port) }, style: "success" }],
        [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐀𝐒𝐒𝐖𝐎𝐑𝐃", copy_text: { text: config.password }, style: "primary" }]
      ]
    };

    const finalMsg = await sendCardPhoto(targetGroupId, combinedMsg, { reply_markup: copyKeyboard });
    try { await bot.pinChatMessage(targetGroupId, finalMsg.message_id); } catch (err) {}
  }
});

// ==========================================
// MESSAGE HANDLER (FLOW PERCAKAPAN)
// ==========================================
bot.on("message", async msg => {
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    knownGroups.set(msg.chat.id.toString(), msg.chat.title);
  }

  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = String(msg.chat.id);
  const session = getInputSession(chatId);
  if (!session) return;

  const value = msg.text.trim();
  const userMention = mention(msg.from);

  // --- LOGIKA SET TOKEN OWNER (step by step) ---
  if (session.action === 'settoken') {
      if (session.step === 'settoken_alias') {
          const alias = value;
          if (alias.includes(' ')) return bot.sendMessage(chatId, cardErr("Alias Tidak Valid", "Alias tidak boleh mengandung spasi. Coba lagi."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
          session.alias = alias;
          session.step = 'settoken_token';
          return bot.sendMessage(chatId, card("🔑  Tambah Token  ·  2/3", `Alias: <b>${escapeHtml(alias)}</b>\n\nSekarang kirim <b>token Railway</b>-nya.`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }
      if (session.step === 'settoken_token') {
          session.token = value;
          session.step = 'settoken_owner';
          return bot.sendMessage(chatId, card("👤  Tambah Token  ·  3/3", `Token diterima ✅\n\nSekarang kirim <b>ID Telegram</b> akun yang boleh memakai token ini.`, "Tips: minta orangnya kirim pesan, reply pesan itu, lalu ketik /whoami."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }
      if (session.step === 'settoken_owner') {
          if (!/^\d+$/.test(value)) return bot.sendMessage(chatId, cardErr("ID Tidak Valid", "ID Telegram harus berupa angka. Coba lagi."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
          const alias = session.alias;
          const token = session.token;
          const ownerId = value;
          tokens[alias] = { token, ownerId };
          saveTokens();
          clearInputSession(chatId);
          return bot.sendMessage(chatId, cardOk("Token Tersimpan", `Alias: <b>${escapeHtml(alias)}</b>\nDikunci untuk akun Telegram: <code>${escapeHtml(ownerId)}</code>`, "Token ini tidak bisa dipakai akun Telegram lain."), { parse_mode: "HTML" });
      }
  }

  // --- LOGIKA MYTOKEN (user set/ganti token sendiri) ---
  if (session.action === 'mytoken' && session.step === 'mytoken_wait') {
      const uid = session.initiator || msg.from.id;
      if (String(msg.from.id) !== String(uid)) return;
      if (value.length < 20) {
          return bot.sendMessage(chatId, cardErr("Token Tidak Valid", "Token terlalu pendek. Paste token Railway lengkap."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }
      const alias = setUserOwnToken(uid, value);
      clearInputSession(chatId);
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
      return bot.sendMessage(chatId, cardOk("Token Tersimpan", `Halo ${userMention}, token berhasil disimpan/diganti.`, `Alias: <code>${escapeHtml(alias)}</code>\nKembali ke grup → /createvps`), { parse_mode: "HTML" });
  }

  // --- LOGIKA CREATEVPS: langkah 1 token → langkah 2 nama → deploy ---
  if (session.action === 'createvps') {
      // Hanya user yang memulai sesi yang boleh menjawab
      if (session.initiator && String(msg.from.id) !== String(session.initiator)) return;

      if (session.step === 'createvps_token') {
          if (value.length < 20) {
              return bot.sendMessage(chatId, cardErr("Token Tidak Valid", "Token terlalu pendek. Paste token Railway yang lengkap."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
          }
          session.selectedToken = value;
          session.step = 'vps_name';
          try { setUserOwnToken(msg.from.id, value); } catch (e) {}
          try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
          return bot.sendMessage(chatId, card(
              "🖥️ Create VPS · Langkah 2 dari 2",
              `Halo ${userMention}, token berhasil diterima.\n\nSekarang kirim <b>nama VPS</b> yang kamu mau.\nContoh: <code>bot-vps-1</code> — boleh huruf, angka, dan tanda hubung, tanpa spasi.`,
              "Begitu nama dikirim, proses pembuatan VPS langsung berjalan."
          ), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }

      if (session.step === 'vps_name') {
      const apiToken = session.selectedToken;
      if (!apiToken) {
          clearInputSession(chatId);
          return bot.sendMessage(chatId, cardErr("Token Tidak Ditemukan", "Silakan mulai ulang dengan /createvps."), { parse_mode: "HTML" });
      }
      let vpsName = value.replace(/\s+/g, '-');
      if (!/^[a-zA-Z0-9\-]+$/.test(vpsName)) {
          return bot.sendMessage(chatId, cardErr("Nama VPS Tidak Valid", "Nama VPS hanya boleh huruf, angka, dan tanda hubung (tanpa spasi)."), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }
      const targetUserId = session.initiator || msg.from.id;
      
      clearInputSession(chatId);
      let loadMsg;
      
      try {
          const randomPassword = generateRandomPassword();

          loadMsg = await bot.sendMessage(chatId, deployCard(1, 6, `Halo ${userMention}, memeriksa akses Token API...`), { parse_mode: 'HTML' });
          await delay(1000);

          const headers = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
          const fetchAPI = async (query) => {
              try {
                  const res = await axios.post(RAILWAY_API_URL, { query }, { headers });
                  if (res.data.errors) throw new Error(res.data.errors[0].message);
                  return res.data.data;
              } catch (e) {
                  if (e.response && e.response.data) throw new Error(typeof e.response.data === 'object' ? JSON.stringify(e.response.data) : e.response.data);
                  throw new Error(e.message);
              }
          };

          await bot.editMessageText(deployCard(2, 6, `Halo ${userMention}, menyesuaikan akses workspace...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          let workspaceId = null;
          try {
              const wsData = await fetchAPI(`query { me { workspaces { edges { node { id } } } } }`);
              if (wsData && wsData.me && wsData.me.workspaces.edges.length > 0) workspaceId = wsData.me.workspaces.edges[0].node.id;
          } catch(e) {}

          await bot.editMessageText(deployCard(3, 6, `Halo ${userMention}, membuat project &amp; lingkungan baru...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          let projQuery = workspaceId 
              ? `mutation { projectCreate(input: { name: "${vpsName}", workspaceId: "${workspaceId}" }) { id environments(first: 1) { edges { node { id } } } } }`
              : `mutation { projectCreate(input: { name: "${vpsName}" }) { id environments(first: 1) { edges { node { id } } } } }`;
          const data1 = await fetchAPI(projQuery);
          const projectId = data1.projectCreate.id;
          const envId = data1.projectCreate.environments.edges[0].node.id;
          await delay(1000);

          await bot.editMessageText(deployCard(4, 6, `Halo ${userMention}, menarik template server Ubuntu + Claude...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          const svcQuery = `mutation { serviceCreate(input: { projectId: "${projectId}", name: "${vpsName}", source: { repo: "parham7991/railway-ubuntu-ssh-claude" } }) { id } }`;
          const data2 = await fetchAPI(svcQuery);
          const serviceId = data2.serviceCreate.id;
          await delay(1000);

          await bot.editMessageText(deployCard(5, 6, `Halo ${userMention}, menyuntikkan password random (root)...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          const varQuery = `mutation { variableCollectionUpsert(input: { projectId: "${projectId}", environmentId: "${envId}", serviceId: "${serviceId}", variables: { ROOT_PASSWORD: "${randomPassword}" } }) }`;
          await fetchAPI(varQuery);
          await delay(1000);

          await bot.editMessageText(deployCard(6, 6, `Halo ${userMention}, membuka akses port jaringan SSH...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          const tcpQuery = `mutation { tcpProxyCreate(input: { environmentId: "${envId}", serviceId: "${serviceId}", applicationPort: 22 }) { domain proxyPort } }`;
          const data4 = await fetchAPI(tcpQuery);
          const proxyDomain = data4.tcpProxyCreate.domain;
          const proxyPort = data4.tcpProxyCreate.proxyPort;
          await delay(1000);

          let isReady = false;
          let attempt = 0;
          let lastStatus = "INITIALIZING";

          while (!isReady && attempt < 240) { 
              attempt++;
              let statusText = lastStatus === "BUILDING" ? "🛠 Sedang merakit OS (Building)..." :
                               lastStatus === "DEPLOYING" ? "🚀 Menyiapkan server (Deploying)..." :
                               `⏳ Mengantre di server Railway (${lastStatus})...`;

              const logLines = buildLogSnippet(lastStatus, attempt);
              try {
                  await bot.editMessageText(
                      `${card("🖥  Menyiapkan Server", `${statusText}\n\nHalo ${userMention}`, "Proses 1–15 menit. Mohon tunggu.")}\n<pre>${escapeHtml(logLines.join("\n"))}</pre>`,
                      { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' }
                  );
              } catch(e) {}
              await delay(5000); 

              const checkQuery = `query { deployments(input: { projectId: "${projectId}", environmentId: "${envId}", serviceId: "${serviceId}" }) { edges { node { status } } } }`;
              try {
                  const checkData = await fetchAPI(checkQuery);
                  if (checkData && checkData.deployments && checkData.deployments.edges.length > 0) {
                      lastStatus = checkData.deployments.edges[0].node.status;
                      if (lastStatus === "SUCCESS") isReady = true;
                      else if (lastStatus === "FAILED" || lastStatus === "CRASHED") throw new Error(`Deployment gagal/crash di server Railway!`);
                  }
              } catch (errCheck) {
                  if (errCheck.message.includes("gagal/crash")) throw errCheck; 
              }
          }
          if (!isReady) throw new Error("Timeout! Proses build melebihi 20 menit, silakan cek dashboard Railway secara manual.");

          await bot.editMessageText(card("🔐  Mengambil Data VPS", `Halo ${userMention}, menghubungkan ke SSH untuk mengambil IP dan data VPS...`), { chat_id: chatId, message_id: loadMsg.message_id, parse_mode: 'HTML' });
          
          const sshConfig = { host: proxyDomain, port: proxyPort, password: randomPassword };
          let rawSSH = null;
          
          let retries = 60; 
          
          while(retries > 0 && !rawSSH) {
              try {
                  await delay(10000); 
                  rawSSH = await connectSSH(sshConfig);
              } catch (e) {
                  retries--;
              }
          }

          if (!rawSSH) throw new Error("VPS Berhasil dibuat, tapi SSH belum bisa diakses (Timeout). Coba login manual via menu /fix.");

          const vps = parseVPS(rawSSH);
          
          try { await bot.deleteMessage(chatId, loadMsg.message_id); } catch(e){}

          await bot.sendMessage(chatId, cardOk(
              "VPS Siap!",
              `Halo ${userMention}\n\nVPS <code>${escapeHtml(vpsName)}</code> berhasil dibuat.\nData login sudah dikirim ke <b>DM</b> kamu.`,
              "Cek chat pribadi dengan bot sekarang."
          ), { parse_mode: 'HTML' });

          const readyId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
          const monitorTimer = startVPSMonitor(readyId, sshConfig, targetUserId, userMention);
          readySessions.set(readyId, { vps, config: sshConfig, timer: monitorTimer, dropped: true, targetNotifyId: targetUserId });

          const combinedMsg = formatCombinedVPS(vps, sshConfig.port, sshConfig.password);
          const copyKeyboard = {
            inline_keyboard: [
              [{ text: "𝐂𝐎𝐏𝐘 𝐈𝐏𝐕𝐏𝐒", copy_text: { text: vps.ip }, style: "success" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐔𝐒𝐄𝐑𝐍𝐀𝐌𝐄", copy_text: { text: USERNAME }, style: "primary" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐎𝐑𝐓", copy_text: { text: String(sshConfig.port) }, style: "success" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐀𝐒𝐒𝐖𝐎𝐑𝐃", copy_text: { text: sshConfig.password }, style: "primary" }]
            ]
          };
          
          const finalMsg = await sendCardPhoto(targetUserId, combinedMsg, { reply_markup: copyKeyboard });
          try { await bot.pinChatMessage(targetUserId, finalMsg.message_id); } catch (err) {}

      } catch (error) {
          let detailError = error.message;
          bot.editMessageText(cardErr(
              "Deploy Gagal",
              `Halo ${userMention}\n\nProses gagal. Cek token Railway &amp; kuota akun.\n\n<code>${escapeHtml(detailError)}</code>`,
              "Coba lagi dengan /createvps"
          ), { chat_id: chatId, message_id: loadMsg?.message_id, parse_mode: 'HTML' });
      }
      return;
      } // end step vps_name
  } // end action createvps

  // --- LOGIKA UNTUK FITUR LISTVPS, DELVPS, FIXVPS (menerima token) ---
  if (session.action === "listvps" || session.action === "delvps" || session.action === "fixvps") {
      if (session.step === "listvps_token" || session.step === "delvps_token" || session.step === "fixvps_token") {
          const token = value;
          session.token = token;
          try {
              const projects = await fetchProjects(token);
              if (projects.length === 0) {
                  clearInputSession(chatId);
                  return bot.sendMessage(chatId, cardErr("Tidak Ada Project", "Tidak ada project di akun ini."), { parse_mode: "HTML" });
              }
              const buttons = projects.map(p => [{ text: escapeHtml(p.name || p.id), callback_data: `${session.action}_project_${p.id}` }]);
              buttons.push([{ text: "𝐁𝐚𝐭𝐚𝐥𝐤𝐚𝐧", callback_data: "cancel" }]);
              session.projects = projects;
              session.step = `${session.action}_select_project`;
              await bot.sendMessage(chatId, card("📋  Pilih Project", "Pilih project VPS:"), {
                  parse_mode: "HTML",
                  reply_markup: { inline_keyboard: buttons }
              });
          } catch (err) {
              clearInputSession(chatId);
              await bot.sendMessage(chatId, cardErr("Gagal Ambil Project", escapeHtml(err.message)), { parse_mode: "HTML" });
          }
          return;
      }
  }

  // --- LOGIKA ADMIN: Proses fitur Domain, Port, Password ---
  // /fix boleh dijalankan siapa saja di grup yang di-/add; fitur lain (login/upload) tetap khusus owner.
  if (["domain", "port", "password"].includes(session.step)) {
    if (!isOwner(msg) && session.action !== "fix") return;
    // Hanya user yang memulai sesi ini yang boleh melanjutkan (penting di grup rame)
    if (session.initiator && String(msg.from.id) !== String(session.initiator)) return;

    if (session.step === "domain") {
      const match = value.match(/^([^:\s]+)(?::(\d+))?$/);
      if (!match || match[1].length > 253) return bot.sendMessage(chatId, cardErr("Hostname Tidak Valid", `Halo ${userMention}, coba kirim ulang domain/hostname yang benar.`, "Format: host atau host:port"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      session.host = match[1];

      if (match[2]) {
        const port = Number(match[2]);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return bot.sendMessage(chatId, cardErr("Port Tidak Valid", `Halo ${userMention}, port harus angka 1-65535.`, "Contoh: 22 atau 57031"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
        session.port = port; session.step = "password"; 
        return bot.sendMessage(chatId, card("🔑  Password  ·  Terakhir", `Halo ${userMention}, masukkan password SSH root VPS.`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      }
      session.step = "port";
      return bot.sendMessage(chatId, card("🔌  Port SSH  ·  2/2", `Halo ${userMention}, masukkan port SSH VPS.`, "Contoh: 22 atau 57031"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
    }

    if (session.step === "port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return bot.sendMessage(chatId, cardErr("Port Tidak Valid", `Halo ${userMention}, port harus angka 1-65535.`, "Contoh: 22 atau 57031"), { parse_mode: "HTML", reply_markup: cancelKeyboard });
      session.port = port; session.step = "password";
      return bot.sendMessage(chatId, card("🔑  Password  ·  Terakhir", `Halo ${userMention}, masukkan password SSH root VPS.`), { parse_mode: "HTML", reply_markup: cancelKeyboard });
    }

    if (session.step === "password") {
      const config = { host: session.host, port: session.port, password: value };
      const action = session.action; 
      
      if (action === "upload") {
        const fileId = session.fileId, fileName = session.fileName;
        clearInputSession(chatId);
        let progressMsg, localFilePath;
        try {
          progressMsg = await bot.sendMessage(chatId, card("⏳  Upload File", `Halo ${userMention}, mendownload file...`), { parse_mode: "HTML" });
          localFilePath = await bot.downloadFile(fileId, "./");
          try { await bot.editMessageText(card("⏳  Upload File", `Halo ${userMention}, mengupload ke VPS via SFTP &amp; ekstrak otomatis...`), { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: "HTML" }); } catch(e) {}
          await uploadAndExtractSSH(config, localFilePath, fileName);
          try { await bot.editMessageText(cardOk("Upload Sukses", `Halo ${userMention}, file <code>${escapeHtml(fileName)}</code> berhasil diekstrak di <code>/root/</code>.`), { chat_id: chatId, message_id: progressMsg.message_id, parse_mode: "HTML" }); } catch(e) {}
        } catch (error) {
          await bot.sendMessage(chatId, cardErr("Upload Gagal", `Halo ${userMention}, ${escapeHtml(error.message)}`), { parse_mode: "HTML" });
        } finally {
          if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
        }
        return;
      }

      if (action === "login") {
        clearInputSession(chatId);
        let progress;
        try {
          const animPromise = sshCheckAnimation(chatId, "🌐 Login VPS", session.host, session.port);
          const raw = await connectSSH(config);
          const vps = parseVPS(raw);
          progress = await animPromise;
          try { if (progress) await bot.deleteMessage(chatId, progress.message_id); } catch {}

          const readyId = Date.now().toString(36) + Math.random().toString(36).substring(2, 5);
          const monitorTimer = startVPSMonitor(readyId, config, null, userMention);

          readySessions.set(readyId, { vps, config, timer: monitorTimer, dropped: false, targetNotifyId: null });

          await bot.sendMessage(chatId, cardOk("VPS Siap Dijatuhkan", `Halo ${userMention}, klik tombol di bawah kalau sudah siap menjatuhkan VPS-nya.`, "Tombol ini aman ditinggal — kamu bisa cek VPS lain dulu tanpa takut error."), { 
            parse_mode: "HTML", 
            reply_markup: { inline_keyboard: [[{ text: "𝐑𝐄𝐀𝐃𝐘", callback_data: `drop_vps_${readyId}`, style: "primary" }]] } 
          });

        } catch (error) {
          try { if (progress) await bot.deleteMessage(chatId, progress.message_id); } catch {}
          await bot.sendMessage(chatId, cardErr("Gagal Login VPS", `Halo ${userMention}, tidak bisa terhubung ke VPS. Cek kembali domain, port, dan password.`), { parse_mode: "HTML" });
        }
        return;
      }

      if (action === "fix") {
        clearInputSession(chatId);
        let progress;
        const targetId = session.originIsPrivate ? chatId : String(session.initiator);
        try {
          const animPromise = sshCheckAnimation(chatId, "🔧 Cek VPS", session.host, session.port);
          const raw = await connectSSH(config);
          const vps = parseVPS(raw);
          progress = await animPromise;
          try { if (progress) await bot.deleteMessage(chatId, progress.message_id); } catch {}

          const combinedMsg = formatCombinedVPS(vps, config.port, config.password);
          const copyKeyboard = {
            inline_keyboard: [
              [{ text: "𝐂𝐎𝐏𝐘 𝐈𝐏𝐕𝐏𝐒", copy_text: { text: vps.ip }, style: "success" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐔𝐒𝐄𝐑𝐍𝐀𝐌𝐄", copy_text: { text: USERNAME }, style: "primary" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐎𝐑𝐓", copy_text: { text: String(config.port) }, style: "success" }],
              [{ text: "𝐂𝐎𝐏𝐘 𝐏𝐀𝐒𝐒𝐖𝐎𝐑𝐃", copy_text: { text: config.password }, style: "primary" }]
            ]
          };
          await sendCardPhoto(targetId, combinedMsg, { reply_markup: copyKeyboard });

          // Kalau dijalankan dari grup, kasih konfirmasi singkat di grup (tanpa data sensitif).
          if (!session.originIsPrivate) {
            await bot.sendMessage(chatId, cardOk("Cek VPS Selesai", `Halo ${userMention}, VPS berhasil dicek.`, "Detail lengkap sudah dikirim ke DM kamu."), { parse_mode: "HTML" });
          }
        } catch (error) {
          try { if (progress) await bot.deleteMessage(chatId, progress.message_id); } catch {}
          await bot.sendMessage(chatId, cardErr("Gagal Login", `Halo ${userMention}, ${escapeHtml(error.message)}`), { parse_mode: "HTML" });
        }
        return;
      }
    }
  }
});

// ==========================================
// POLLING ERROR & DAEMON
// ==========================================
bot.on("polling_error", error => console.error("[Telegram]", error.message));
process.on("unhandledRejection", err => console.error("[UNHANDLED REJECTION]", err));
process.on("uncaughtException", err => console.error("[UNCAUGHT EXCEPTION]", err));

console.log("");
console.log("╭──────────────────────────────╮");
console.log("│ VPS MANAGER BOT • ONLINE     │");
console.log(`│ OWNER ID : ${OWNER_ID}           │`);
console.log("╰──────────────────────────────╯");
console.log("");