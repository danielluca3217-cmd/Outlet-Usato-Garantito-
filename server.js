// ============================================================
// OUTLET USATO GARANTITO — BACKEND PROXY
// ============================================================
// Il "database" ora è un Postgres dentro Railway stesso (non più
// JSONBin). Railway crea da solo la variabile DATABASE_URL quando
// colleghi il plugin Postgres al servizio: non serve procurarsi
// nessuna nuova chiave, e non ci sono più i limiti di richieste
// del piano gratuito di un servizio esterno.
//
// Le altre chiavi (Discord, ImgBB) restano lato server come prima,
// il sito (public/index.html) non contiene nessuna chiave e continua
// a chiamare solo questo backend, senza nessuna modifica.
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

// ============================================================
// VARIABILI D'AMBIENTE (da impostare su Railway, MAI nel codice)
// ============================================================
// DATABASE_URL: creata automaticamente da Railway quando colleghi
// il plugin Postgres al servizio (vedi README per i passaggi).
const DATABASE_URL = process.env.DATABASE_URL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'cambiami123';

['DATABASE_URL', 'DISCORD_WEBHOOK_URL', 'IMGBB_API_KEY'].forEach((k) => {
  if (!process.env[k]) console.warn(`⚠️  Variabile d'ambiente mancante: ${k}`);
});

// ============================================================
// CONNESSIONE A POSTGRES
// ============================================================
// Su Railway la connessione interna tra servizi dello stesso progetto
// non richiede SSL, ma se in futuro ti connetti dall'esterno (o Railway
// cambia rete) serve accettare certificati self-signed: la riga sotto
// gestisce entrambi i casi senza bisogno di configurazione manuale.
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && !DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

// Crea le tabelle al primo avvio, se non esistono già.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store_auto (
      id INTEGER PRIMARY KEY,
      dati JSONB NOT NULL DEFAULT '[]'::jsonb
    );
  `);
  await pool.query(`
    INSERT INTO store_auto (id, dati) VALUES (1, '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING;
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS prenotazioni (
      id BIGINT PRIMARY KEY,
      auto_id INTEGER NOT NULL,
      nome TEXT NOT NULL,
      cognome TEXT NOT NULL,
      email TEXT NOT NULL,
      telefono TEXT NOT NULL,
      data_appuntamento TEXT NOT NULL,
      messaggio TEXT DEFAULT '',
      stato TEXT NOT NULL DEFAULT 'in-attesa',
      data_richiesta TEXT NOT NULL
    );
  `);
  // Un solo veicolo può avere una prenotazione "confermata" alla volta:
  // il database stesso impedisce le doppie conferme in caso di richieste
  // simultanee, cosa che con JSONBin non era garantita.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_una_conferma_per_auto
    ON prenotazioni (auto_id) WHERE stato = 'confermata';
  `);
  console.log('✅ Tabelle Postgres pronte.');
}

// Converte una riga della tabella prenotazioni nel formato usato dal sito
function rigaToPrenotazione(riga) {
  return {
    id: Number(riga.id),
    autoId: riga.auto_id,
    nome: riga.nome,
    cognome: riga.cognome,
    email: riga.email,
    telefono: riga.telefono,
    data: riga.data_appuntamento,
    messaggio: riga.messaggio || '',
    stato: riga.stato,
    dataRichiesta: riga.data_richiesta
  };
}

function formattaDataRichiesta() {
  return new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Cache in memoria semplice: con Postgres su Railway non serve più per
// evitare rate limit (non ce ne sono), ma resta utile per assorbire il
// polling frequente di più utenti senza fare una query ad ogni richiesta.
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 2000;

function invalidaCache() {
  cache = { data: null, timestamp: 0 };
}

// ============================================================
// GET /api/dati — legge auto + prenotazioni da Postgres (con cache)
// ============================================================
app.get('/api/dati', async (req, res) => {
  try {
    const ora = Date.now();
    if (cache.data && (ora - cache.timestamp) < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    const autoResult = await pool.query('SELECT dati FROM store_auto WHERE id = 1');
    const auto = autoResult.rows[0]?.dati || [];

    const prenResult = await pool.query('SELECT * FROM prenotazioni ORDER BY id ASC');
    const prenotazioni = prenResult.rows.map(rigaToPrenotazione);

    const record = { auto, prenotazioni };
    cache = { data: record, timestamp: ora };
    res.json(record);
  } catch (err) {
    console.error('Errore /api/dati:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// ============================================================
// PUT /api/dati — salva auto + prenotazioni su Postgres (solo admin)
// ============================================================
app.put('/api/dati', async (req, res) => {
  const { auto, prenotazioni, password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ errore: 'Password non valida.' });
  }
  if (!Array.isArray(auto) || !Array.isArray(prenotazioni)) {
    return res.status(400).json({ errore: 'Formato dati non valido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO store_auto (id, dati) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET dati = $1::jsonb`,
      [JSON.stringify(auto)]
    );

    // Il pannello admin salva sempre l'elenco intero delle prenotazioni:
    // svuotiamo e reinseriamo dentro la stessa transazione, così un errore
    // a metà strada annulla tutto invece di lasciare dati a metà.
    await client.query('DELETE FROM prenotazioni');
    for (const p of prenotazioni) {
      await client.query(
        `INSERT INTO prenotazioni
          (id, auto_id, nome, cognome, email, telefono, data_appuntamento, messaggio, stato, data_richiesta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          p.id, p.autoId, p.nome, p.cognome, p.email, p.telefono,
          p.data, p.messaggio || '', p.stato || 'in-attesa',
          p.dataRichiesta || formattaDataRichiesta()
        ]
      );
    }

    await client.query('COMMIT');
    cache = { data: { auto, prenotazioni }, timestamp: Date.now() };
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Errore PUT /api/dati:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  } finally {
    client.release();
  }
});

// ============================================================
// POST /api/prenotazioni — un cliente (NON admin) invia una
// prenotazione. Non richiede password: chiunque visiti il sito
// deve poter prenotare. Con una vera riga di database ogni richiesta
// è già atomica di suo: due prenotazioni simultanee non possono più
// sovrascriversi a vicenda come poteva succedere prima con JSONBin.
// ============================================================
app.post('/api/prenotazioni', async (req, res) => {
  try {
    const { autoId, nome, cognome, email, telefono, data, messaggio } = req.body;

    if (!autoId || !nome || !cognome || !email || !telefono || !data) {
      return res.status(400).json({ errore: 'Compila tutti i campi obbligatori.' });
    }

    const giaConfermata = await pool.query(
      `SELECT 1 FROM prenotazioni WHERE auto_id = $1 AND stato = 'confermata' LIMIT 1`,
      [autoId]
    );
    if (giaConfermata.rowCount > 0) {
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
      dataRichiesta: formattaDataRichiesta()
    };

    await pool.query(
      `INSERT INTO prenotazioni
        (id, auto_id, nome, cognome, email, telefono, data_appuntamento, messaggio, stato, data_richiesta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        nuovaPrenotazione.id, autoId, nome, cognome, email, telefono,
        data, nuovaPrenotazione.messaggio, 'in-attesa', nuovaPrenotazione.dataRichiesta
      ]
    );

    invalidaCache();

    const autoResult = await pool.query('SELECT dati FROM store_auto WHERE id = 1');
    const autoArr = autoResult.rows[0]?.dati || [];
    const veicolo = autoArr.find(a => a.id === autoId);
    inviaNotificaDiscord(nuovaPrenotazione, veicolo ? `${veicolo.marca} ${veicolo.modello}` : `Veicolo #${autoId}`);

    res.json({ ok: true, prenotazione: nuovaPrenotazione });
  } catch (err) {
    // Se qualcuno prenota la stessa auto nello stesso istante, l'indice
    // unico del database può rifiutare l'inserimento: lo trattiamo come
    // "già prenotato" invece di un errore generico.
    if (err.code === '23505') {
      return res.status(409).json({ errore: 'Questo veicolo è già stato prenotato.' });
    }
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

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ Server avviato sulla porta ${PORT}`));
  })
  .catch((err) => {
    console.error('❌ Impossibile inizializzare il database:', err);
    process.exit(1);
  });
