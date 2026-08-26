// ============================================================
// OUTLET USATO GARANTITO — BACKEND PROXY
// ============================================================
// Questo server tiene TUTTE le chiavi API segrete lato server.
// Il sito (public/index.html) non contiene più nessuna chiave:
// chiama solo questo backend, che a sua volta parla con
// JSONBin, Discord e ImgBB usando le variabili d'ambiente.
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ============================================================
// VARIABILI D'AMBIENTE (da impostare su Railway, MAI nel codice)
// ============================================================
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiami123';

// Piccolo controllo di avvio: avvisa se manca qualcosa (ma non blocca il boot)
['JSONBIN_BIN_ID', 'JSONBIN_API_KEY', 'DISCORD_WEBHOOK_URL', 'IMGBB_API_KEY'].forEach((k) => {
  if (!process.env[k]) console.warn(`⚠️  Variabile d'ambiente mancante: ${k}`);
});

// Cache in memoria semplice per ridurre le chiamate a JSONBin (evita rate limit)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 4000; // 4 secondi: sufficiente per assorbire il polling di più utenti

// ============================================================
// GET /api/dati — legge auto + prenotazioni da JSONBin (con cache)
// ============================================================
app.get('/api/dati', async (req, res) => {
  try {
    const ora = Date.now();
    if (cache.data && (ora - cache.timestamp) < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });

    if (!response.ok) {
      const testo = await response.text();
      console.error('Errore JSONBin (GET):', response.status, testo);
      return res.status(502).json({ errore: 'Impossibile leggere i dati dal database.' });
    }

    const body = await response.json();
    const record = body.record || { auto: [], prenotazioni: [] };
    cache = { data: record, timestamp: ora };
    res.json(record);
  } catch (err) {
    console.error('Errore /api/dati:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// ============================================================
// PUT /api/dati — salva auto + prenotazioni su JSONBin
// Richiede il campo "password" per confermare che è l'admin
// (per le operazioni di scrittura semplici lato pubblico,
// vedi le rotte dedicate più sotto per le prenotazioni clienti).
// ============================================================
app.put('/api/dati', async (req, res) => {
  try {
    const { auto, prenotazioni, password } = req.body;

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ errore: 'Password non valida.' });
    }
    if (!Array.isArray(auto) || !Array.isArray(prenotazioni)) {
      return res.status(400).json({ errore: 'Formato dati non valido.' });
    }

    const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Master-Key': JSONBIN_API_KEY
      },
      body: JSON.stringify({ auto, prenotazioni })
    });

    if (!response.ok) {
      const testo = await response.text();
      console.error('Errore JSONBin (PUT):', response.status, testo);
      return res.status(502).json({ errore: 'Salvataggio fallito sul database.' });
    }

    // Invalida la cache così la prossima GET prende i dati freschi
    cache = { data: { auto, prenotazioni }, timestamp: Date.now() };

    res.json({ ok: true });
  } catch (err) {
    console.error('Errore PUT /api/dati:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// ============================================================
// POST /api/prenotazioni — un cliente (NON admin) invia una
// prenotazione. Non richiede password: chiunque visiti il sito
// deve poter prenotare. Il server fa il fetch+merge+save in modo
// atomico lato backend, così due prenotazioni simultanee non si
// sovrascrivono a vicenda come poteva succedere prima lato client.
// ============================================================
app.post('/api/prenotazioni', async (req, res) => {
  try {
    const { autoId, nome, cognome, email, telefono, data, messaggio } = req.body;

    if (!autoId || !nome || !cognome || !email || !telefono || !data) {
      return res.status(400).json({ errore: 'Compila tutti i campi obbligatori.' });
    }

    // Rileggi i dati più freschi possibile (bypassando la cache per sicurezza)
    const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    if (!response.ok) return res.status(502).json({ errore: 'Impossibile leggere il database.' });
    const body = await response.json();
    const record = body.record || { auto: [], prenotazioni: [] };

    if (record.prenotazioni.some(p => p.autoId === autoId && p.stato === 'confermata')) {
      return res.status(409).json({ errore: 'Questo veicolo è già stato prenotato.' });
    }

    const nuovaPrenotazione = {
      id: Date.now(),
      autoId,
      nome,
      cognome,
      email,
      telefono,
      data,
      messaggio: messaggio || '',
      stato: 'in-attesa',
      dataRichiesta: new Date().toLocaleDateString('it-IT', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
      })
    };

    record.prenotazioni.push(nuovaPrenotazione);

    const saveResp = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(record)
    });
    if (!saveResp.ok) return res.status(502).json({ errore: 'Salvataggio fallito.' });

    cache = { data: record, timestamp: Date.now() };

    // Notifica Discord (chiave/URL rimane sul server, mai esposta)
    const veicolo = record.auto.find(a => a.id === autoId);
    inviaNotificaDiscord(nuovaPrenotazione, veicolo ? `${veicolo.marca} ${veicolo.modello}` : `Veicolo #${autoId}`);

    res.json({ ok: true, prenotazione: nuovaPrenotazione });
  } catch (err) {
    console.error('Errore POST /api/prenotazioni:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

async function inviaNotificaDiscord(prenotazione, autoNome) {
  if (!DISCORD_WEBHOOK_URL) return;
  const embed = {
    title: '📩 Nuova prenotazione!',
    color: 0xe2001a,
    fields: [
      { name: '👤 Cliente', value: `${prenotazione.nome} ${prenotazione.cognome}`, inline: true },
      { name: '📧 Email', value: prenotazione.email, inline: true },
      { name: '📞 Telefono', value: prenotazione.telefono, inline: true },
      { name: '🚗 Veicolo', value: autoNome, inline: true },
      { name: '📅 Data', value: prenotazione.data, inline: true }
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Outlet Usato Garantito' }
  };
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] })
    });
  } catch (err) {
    console.error('Errore notifica Discord:', err);
  }
}

// ============================================================
// POST /api/login — verifica la password admin lato server
// ============================================================
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, errore: 'Password errata.' });
  }
});

// ============================================================
// POST /api/upload-foto — carica un'immagine su ImgBB
// (la key ImgBB non tocca mai il browser)
// ============================================================
app.post('/api/upload-foto', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ errore: 'Nessun file ricevuto.' });

    const base64 = req.file.buffer.toString('base64');
    const formData = new URLSearchParams();
    formData.append('key', IMGBB_API_KEY);
    formData.append('image', base64);

    const response = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: formData
    });
    const result = await response.json();

    if (!response.ok || !result.success) {
      console.error('Errore ImgBB:', result);
      return res.status(502).json({ errore: result?.error?.message || 'Caricamento immagine fallito.' });
    }

    res.json({ ok: true, url: result.data.url });
  } catch (err) {
    console.error('Errore /api/upload-foto:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
