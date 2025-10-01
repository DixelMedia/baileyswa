const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  areJidsSameUser
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

/**
 * Extrae todos los mentionedJid posibles
 */
const getMentionedJids = (msg) => {
  const m = msg.message || {};
  const tryCtx = (x) => x?.contextInfo?.mentionedJid || [];
  return [
    ...(tryCtx(m.extendedTextMessage)),
    ...(tryCtx(m.imageMessage)),
    ...(tryCtx(m.videoMessage)),
    ...(tryCtx(m.buttonsMessage)),
    ...(tryCtx(m.buttonsResponseMessage)),
    ...(tryCtx(m.listMessage)),
    ...(tryCtx(m.listResponseMessage)),
    ...(tryCtx(m.interactiveResponseMessage)),
  ].filter(Boolean);
};

const toJid = (raw) => {
  if (!raw) return raw;
  return raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
};

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
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chatJid = msg.key.remoteJid;
      const isGroup = chatJid.endsWith('@g.us');
      if (!isGroup) continue; // solo grupos

      const text = (getText(msg) || '').trim();
      const mentioned = getMentionedJids(msg);
      const me = sock?.user?.id;

      const iAmMentioned =
        Array.isArray(mentioned) && mentioned.some((j) => areJidsSameUser(j, me));

      // Si no me mencionaron, no hago nada
      if (!iAmMentioned) continue;

      console.log(`📩 Mención en ${chatJid} → ${text}`);

      try {
        // Respuesta inmediata al grupo
        await sock.assertSessions([chatJid], false);
        await sock.sendMessage(chatJid, {
          text: '🤖 Procesando tu solicitud…',
          quoted: msg,
        });

        // Notificar a n8n
        await axios.post('https://ai.dixelmedia.com/webhook/wa-in', {
          group_id: chatJid,
          participant: msg.key.participant || chatJid,
          message: text,
        });

        console.log('✅ Enviado a n8n');
      } catch (err) {
        console.error('❌ Error en manejo de mención:', err?.message || err);
      }
    }
  });
}

// endpoint para enviar mensajes manualmente
app.post('/send', async (req, res) => {
  try {
    if (!sock) return res.status(503).json({ success: false, error: 'Socket no listo' });

    const to = toJid(req.body.to);
    const message = req.body.message || '';
    if (!to || !message)
      return res.status(400).json({ success: false, error: 'Faltan campos (to, message)' });

    await sock.assertSessions([to], false);
    await sock.sendMessage(to, { text: message });

    res.json({ success: true });
  } catch (err) {
    console.error('❌ /send error:', err?.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// servidor API
app.listen(PORT, '0.0.0.0', () => {
  console.log(`📡 API escuchando en http://0.0.0.0:${PORT}/send`);
});

startBot();
