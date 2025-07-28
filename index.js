const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const P = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');
const app = express();

let sock;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    logger: P({ level: 'info' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('🧾 Escanea el QR para conectar tu bot:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        new Boom(lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Conexión cerrada. Reintentando:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('✅ Bot conectado correctamente a WhatsApp');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const sender = msg.key.remoteJid;
    const participant = msg.key.participant || sender;
    const messageType = Object.keys(msg.message)[0];
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.[messageType]?.text ||
      '';

    const isGroup = sender.endsWith('@g.us');
    const mentionedJids = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    const botId = sock.user.id.split(':')[0]; // ID sin instancia
    const isMentioned = mentionedJids.some((jid) => jid.includes(botId));

    if (!isGroup || !isMentioned) return;

    console.log(`📩 Mención recibida en grupo ${sender} de ${participant}: ${text}`);

    try {
      // Responder en el grupo
      await sock.sendMessage(sender, {
        text: '🤖 El asistente está procesando tu solicitud. Te responderá en breve.',
        quoted: msg,
      });

      // Enviar a n8n
      await axios.post('https://ai.dixelmedia.com/webhook/wa-in', {
        group_id: sender,
        participant: participant,
        message: text,
      });

      console.log('✅ Mensaje enviado a n8n');
    } catch (error) {
      console.error('❌ Error al procesar mención:', error.message);
    }
  });
}

app.use(bodyParser.json());

app.post('/send', async (req, res) => {
  const { to, message } = req.body;

  if (!sock) {
    return res.status(503).send({ success: false, error: 'WhatsApp socket no está listo aún.' });
  }

  try {
    await sock.sendMessage(to, { text: message });
    res.status(200).send({ success: true });
  } catch (err) {
    console.error('❌ Error al enviar desde /send:', err);
    res.status(500).send({ success: false, error: err.message });
  }
});

app.listen(3100, () => {
  console.log('📡 API escuchando en http://localhost:3100/send');
});

startBot();
