const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  areJidsSameUser,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3100;

app.use(bodyParser.json());

let sock;
let starting = false;

const getText = (m) =>
  m.message?.conversation ??
  m.message?.extendedTextMessage?.text ??
  m.message?.imageMessage?.caption ??
  m.message?.videoMessage?.caption ??
  m.message?.buttonsResponseMessage?.selectedDisplayText ??
  m.message?.listResponseMessage?.singleSelectReply?.selectedRowId ??
  m.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ??
  '';

const collectMentionedJidsDeep = (obj, acc = []) => {
  if (!obj || typeof obj !== 'object') return acc;
  if (obj.contextInfo && Array.isArray(obj.contextInfo.mentionedJid)) {
    acc.push(...obj.contextInfo.mentionedJid);
  }
  if (obj.contextInfo && obj.contextInfo.quotedMessage) {
    collectMentionedJidsDeep(obj.contextInfo.quotedMessage, acc);
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v && typeof v === 'object') collectMentionedJidsDeep(v, acc);
  }
  return acc;
};

const toJid = (raw) => (raw && raw.includes('@') ? raw : `${String(raw || '').replace(/\D/g, '')}@s.whatsapp.net`);

// axios con timeout y mejores errores
const http = axios.create({ timeout: 10000 });

async function startBot() {
  if (starting) return;
  starting = true;

  const logger = P({ level: 'info' });
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  sock = makeWASocket({
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: true,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('🧾 Escanea el QR:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log('🔌 Conexión cerrada. Reintentar:', shouldReconnect, 'razón:', reason);
      starting = false;
      if (shouldReconnect) setTimeout(startBot, 1500);
    } else if (connection === 'open') {
      console.log('✅ Bot conectado');
      starting = false;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // (puedes comentar estos logs cuando termines de depurar)
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      const msgType = Object.keys(m.message || {})[0] || 'unknown';
      console.log('[UPSERT:RAW]', { type, jid, msgType, fromMe: !!m.key?.fromMe });
    }

    if (!['notify', 'append'].includes(type)) return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatJid = msg.key.remoteJid;
      const isGroup = chatJid.endsWith('@g.us');
      if (!isGroup) continue; // SOLO grupos

      // IDs del bot (device, user normalizado, LID si existe)
      const meDevice = sock?.user?.id || '';
      const meUser   = jidNormalizedUser(meDevice);
      const meLid    = sock?.user?.lid || state?.creds?.me?.lid || state?.creds?.me?.lidJid || null;

      const myJids = [meDevice, meUser, meLid]
        .filter(Boolean)
        .map((j) => jidNormalizedUser(j));

      // Menciones del mensaje
      const mentionedRaw  = collectMentionedJidsDeep(msg.message);
      const mentionedNorm = mentionedRaw.map((j) => jidNormalizedUser(j));

      const iAmMentioned = mentionedNorm.some((j) => myJids.some((mine) => areJidsSameUser(j, mine)));

      console.log('[MENTIONS]', { myJids, mentioned: mentionedNorm, iAmMentioned });
      if (!iAmMentioned) continue;

      const text = (getText(msg) || '').trim();
      console.log(`📩 Mención en ${chatJid} → ${text}`);

      try {
        // ❗ OJO: quoted va en el 3er parámetro
        await sock.sendMessage(
          chatJid,
          { text: '🤖 Procesando tu solicitud…' },
          { quoted: msg }
        );

        // webhook a n8n
        await http.post('https://ai.dixelmedia.com/webhook/wa-in', {
          group_id: chatJid,
          participant: msg.key.participant || chatJid,
          message: text,
        });

        console.log('✅ Enviado a n8n');
      } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        console.error('❌ Error en manejo de mención:', err?.message || err);
        if (status) console.error('HTTP status:', status, 'body:', data);
      }
    }
  });
}

app.post('/send', async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ success: false, error: 'Socket no listo' });

    const to = toJid(req.body.to);
    const message = req.body.message || '';
    if (!to || !message)
      return res.status(400).json({ success: false, error: 'Faltan campos (to, message)' });

    await sock.sendMessage(to, { text: message });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ /send error:', err?.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 API escuchando en http://0.0.0.0:${PORT}/send`);
});

startBot();
