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
//
// NOVITÀ: il pannello admin ora si sblocca SOLO facendo login con
// Discord (stesso OAuth2 già usato per le prenotazioni) e verificando
// che il tuo ID Discord sia nella tabella "admin_whitelist". Niente
// più password condivisa. La whitelist si gestisce sia da qui (se
// vuoi aggiungere righe a mano nel database) sia da comandi del bot
// Discord (vedi bot.js), che scrivono nella stessa tabella.
// ============================================================

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(express.static('public'));

// ============================================================
// VARIABILI D'AMBIENTE (da impostare su Railway, MAI nel codice)
// ============================================================
// DATABASE_URL: creata automaticamente da Railway quando colleghi
// il plugin Postgres al servizio (vedi README per i passaggi).
const DATABASE_URL = process.env.DATABASE_URL;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const IMGBB_API_KEY = process.env.IMGBB_API_KEY;

// Variabili per il login "Accedi con Discord" (prenotazioni E admin)
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
// URL pubblico di QUESTO backend, usato per costruire il redirect OAuth2.
// Deve combaciare esattamente con un Redirect registrato su Discord Developer Portal.
const APP_BASE_URL = process.env.APP_BASE_URL || 'https://outlet-usato-garantito.up.railway.app';
const DISCORD_REDIRECT_URI = `${APP_BASE_URL}/auth/discord/callback`;
// Chiave per firmare il cookie di sessione post-login. Se non impostata,
// ne generiamo una casuale all'avvio: funziona lo stesso, ma le sessioni
// non sopravvivono a un riavvio del server.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

['DATABASE_URL', 'DISCORD_WEBHOOK_URL', 'IMGBB_API_KEY', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET'].forEach((k) => {
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
      data_richiesta TEXT NOT NULL,
      discord_id TEXT,
      discord_username TEXT
    );
  `);
  // Se la tabella esisteva già da prima del login Discord, aggiungiamo le
  // due colonne senza perdere le prenotazioni già presenti.
  await pool.query(`ALTER TABLE prenotazioni ADD COLUMN IF NOT EXISTS discord_id TEXT;`);
  await pool.query(`ALTER TABLE prenotazioni ADD COLUMN IF NOT EXISTS discord_username TEXT;`);
  // Un solo veicolo può avere una prenotazione "confermata" alla volta:
  // il database stesso impedisce le doppie conferme in caso di richieste
  // simultanee, cosa che con JSONBin non era garantita.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_una_conferma_per_auto
    ON prenotazioni (auto_id) WHERE stato = 'confermata';
  `);

  // Whitelist admin: chi è dentro questa tabella può entrare nel pannello
  // admin del sito dopo aver fatto login con Discord. Righe gestibili sia
  // a mano su Postgres sia con i comandi del bot (/admin-add, /admin-remove).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_whitelist (
      discord_id TEXT PRIMARY KEY,
      discord_username TEXT,
      aggiunto_da TEXT,
      aggiunto_il TEXT NOT NULL
    );
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
    dataRichiesta: riga.data_richiesta,
    discordId: riga.discord_id || null,
    discordUsername: riga.discord_username || null
  };
}

function formattaDataRichiesta() {
  return new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

// Controlla se un ID Discord è nella whitelist admin.
async function isAdminWhitelisted(discordId) {
  if (!discordId) return false;
  const r = await pool.query('SELECT 1 FROM admin_whitelist WHERE discord_id = $1 LIMIT 1', [discordId]);
  return r.rowCount > 0;
}

// ============================================================
// SESSIONE DI LOGIN DISCORD (cookie firmato, niente tabella extra)
// ============================================================
// Dopo il login Discord riuscito, salviamo { discordId, username } in un
// cookie firmato con HMAC. Il browser lo rimanda ad ogni richiesta; noi
// verifichiamo la firma per essere sicuri che non sia stato manomesso.
//
// Usiamo DUE cookie di sessione distinti perché hanno scopi e durate
// diverse:
//  - outlet_discord_session: sessione "cliente", dura 15 minuti, basta
//    per completare una prenotazione.
//  - outlet_admin_session: sessione "admin", dura più a lungo (8 ore),
//    per non dover rifare il login Discord ad ogni azione nel pannello.
// Entrambe si ottengono con lo stesso login Discord: la differenza è
// solo la durata del cookie e se l'ID risulta in whitelist admin.
const SESSION_COOKIE = 'outlet_discord_session';
const SESSION_DURATA_MS = 15 * 60 * 1000;
const ADMIN_SESSION_COOKIE = 'outlet_admin_session';
const ADMIN_SESSION_DURATA_MS = 8 * 60 * 60 * 1000;

function firmaSessione(payload) {
  const dati = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const firma = crypto.createHmac('sha256', SESSION_SECRET).update(dati).digest('base64url');
  return `${dati}.${firma}`;
}

function leggiSessione(cookieValue) {
  if (!cookieValue) return null;
  const [dati, firma] = cookieValue.split('.');
  if (!dati || !firma) return null;
  const firmaAttesa = crypto.createHmac('sha256', SESSION_SECRET).update(dati).digest('base64url');
  if (firma !== firmaAttesa) return null;
  try {
    const payload = JSON.parse(Buffer.from(dati, 'base64url').toString('utf8'));
    if (!payload.scadenza || Date.now() > payload.scadenza) return null;
    return payload;
  } catch {
    return null;
  }
}

// Genera un token anti-CSRF casuale per lo "state" OAuth2
function generaState() {
  return crypto.randomBytes(16).toString('hex');
}

// Cache in memoria semplice: con Postgres su Railway non serve più per
// evitare rate limit (non ce ne sono), ma resta utile per assorbire il
// polling frequente di più utenti senza fare una query ad ogni richiesta.
let cache = { data: null, timestamp: 0 };
const CACHE_TTL_MS = 2000;

function invalidaCache() {
  cache = { data: null, timestamp: 0 };
}

// Middleware: blocca la richiesta se non arriva da un admin con sessione
// admin valida. Da usare su tutte le rotte che modificano dati sensibili.
async function richiedeAdmin(req, res, next) {
  const sessione = leggiSessione(req.cookies[ADMIN_SESSION_COOKIE]);
  if (!sessione || !sessione.isAdmin) {
    return res.status(401).json({ errore: 'Devi accedere con Discord come amministratore.', richiedeLoginAdmin: true });
  }
  // Ricontrolliamo la whitelist ad ogni richiesta (non solo al login):
  // se un admin viene rimosso dalla whitelist, perde subito i permessi
  // anche se il suo cookie di sessione è ancora valido.
  const ancoraAutorizzato = await isAdminWhitelisted(sessione.discordId);
  if (!ancoraAutorizzato) {
    return res.status(401).json({ errore: 'Non sei più autorizzato come amministratore.', richiedeLoginAdmin: true });
  }
  req.admin = sessione;
  next();
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
// Non richiede più una password nel body: la richiesta deve arrivare
// con un cookie di sessione admin valido (vedi middleware richiedeAdmin).
app.put('/api/dati', richiedeAdmin, async (req, res) => {
  const { auto, prenotazioni } = req.body;

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
          (id, auto_id, nome, cognome, email, telefono, data_appuntamento, messaggio, stato, data_richiesta, discord_id, discord_username)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          p.id, p.autoId, p.nome, p.cognome, p.email, p.telefono,
          p.data, p.messaggio || '', p.stato || 'in-attesa',
          p.dataRichiesta || formattaDataRichiesta(),
          p.discordId || null, p.discordUsername || null
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
// LOGIN CON DISCORD (OAuth2)
// ============================================================
// Lo stesso flusso serve per due scopi diversi, distinti dal parametro
// "scope" nella query string di /auth/discord:
//   - /auth/discord?next=/                     → login cliente (prenotazioni)
//   - /auth/discord?next=/&intent=admin         → login per il pannello admin
// In entrambi i casi Discord fa la stessa cosa; cambia solo quale
// cookie di sessione scriviamo al ritorno e se controlliamo la whitelist.
app.get('/auth/discord', (req, res) => {
  if (!DISCORD_CLIENT_ID) {
    return res.status(500).send('Login Discord non configurato sul server.');
  }
  const next = typeof req.query.next === 'string' ? req.query.next : '/';
  const intent = req.query.intent === 'admin' ? 'admin' : 'cliente';
  const state = generaState();

  // Salviamo state, next e intent in un cookie temporaneo (5 minuti) per
  // leggerli al ritorno da Discord ed evitare attacchi CSRF sul login.
  const statoCookie = `${state}.${Buffer.from(next).toString('base64url')}.${intent}`;
  res.cookie('outlet_oauth_state', statoCookie, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 5 * 60 * 1000
  });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: 'identify',
    state
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

// GET /auth/discord/callback — Discord rimanda qui con un "code".
// Lo scambiamo per un token, prendiamo l'utente, creiamo la sessione
// (cliente o admin a seconda dell'intent) e torniamo alla pagina di partenza.
app.get('/auth/discord/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const cookieState = req.cookies['outlet_oauth_state'];
    if (!code || !state || !cookieState) {
      return res.status(400).send('Richiesta di login non valida o scaduta. Torna al sito e riprova.');
    }
    const [statoAtteso, nextB64, intent] = cookieState.split('.');
    if (state !== statoAtteso) {
      return res.status(400).send('Login non valido (state mismatch). Torna al sito e riprova.');
    }
    const next = nextB64 ? Buffer.from(nextB64, 'base64url').toString('utf8') : '/';

    const tokenResp = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });
    if (!tokenResp.ok) {
      console.error('Errore token Discord:', await tokenResp.text());
      return res.status(502).send('Login con Discord fallito. Torna al sito e riprova.');
    }
    const tokenData = await tokenResp.json();

    const userResp = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    if (!userResp.ok) {
      console.error('Errore utente Discord:', await userResp.text());
      return res.status(502).send('Impossibile leggere il profilo Discord. Torna al sito e riprova.');
    }
    const utente = await userResp.json();

    res.clearCookie('outlet_oauth_state');

    if (intent === 'admin') {
      // Login per il pannello admin: verifichiamo la whitelist SUBITO,
      // prima di creare qualsiasi sessione admin.
      const autorizzato = await isAdminWhitelisted(utente.id);
      if (!autorizzato) {
        return res.status(403).send(
          `Accesso negato: l'account Discord @${utente.username} non è autorizzato come amministratore. ` +
          `Chiedi a chi gestisce il server di aggiungerti con il comando del bot.`
        );
      }
      const sessioneAdmin = firmaSessione({
        discordId: utente.id,
        username: utente.username,
        isAdmin: true,
        scadenza: Date.now() + ADMIN_SESSION_DURATA_MS
      });
      res.cookie(ADMIN_SESSION_COOKIE, sessioneAdmin, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        maxAge: ADMIN_SESSION_DURATA_MS
      });
      return res.redirect(next);
    }

    // Login cliente normale (per prenotare)
    const sessione = firmaSessione({
      discordId: utente.id,
      username: `${utente.username}`,
      scadenza: Date.now() + SESSION_DURATA_MS
    });
    res.cookie(SESSION_COOKIE, sessione, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: SESSION_DURATA_MS
    });
    res.redirect(next);
  } catch (err) {
    console.error('Errore /auth/discord/callback:', err);
    res.status(500).send('Errore durante il login con Discord.');
  }
});

// GET /api/sessione — il frontend lo chiama per sapere se l'utente ha già
// fatto il login Discord (per mostrare direttamente il modulo prenotazione
// invece del bottone "Accedi con Discord").
app.get('/api/sessione', (req, res) => {
  const sessione = leggiSessione(req.cookies[SESSION_COOKIE]);
  if (!sessione) return res.json({ loggato: false });
  res.json({ loggato: true, username: sessione.username });
});

// GET /api/sessione-admin — il frontend lo chiama per sapere se l'utente
// ha già una sessione admin valida (per mostrare il pannello admin senza
// dover rifare il login Discord ad ogni ricarica della pagina).
app.get('/api/sessione-admin', async (req, res) => {
  const sessione = leggiSessione(req.cookies[ADMIN_SESSION_COOKIE]);
  if (!sessione || !sessione.isAdmin) return res.json({ loggato: false });

  // Ricontrolliamo la whitelist: se nel frattempo sei stato rimosso,
  // la sessione risulta invalida anche se il cookie non è scaduto.
  const ancoraAutorizzato = await isAdminWhitelisted(sessione.discordId);
  if (!ancoraAutorizzato) return res.json({ loggato: false });

  res.json({ loggato: true, username: sessione.username });
});

// POST /api/logout-admin — esce dal pannello admin sul browser corrente.
app.post('/api/logout-admin', (req, res) => {
  res.clearCookie(ADMIN_SESSION_COOKIE);
  res.json({ ok: true });
});

// ============================================================
// GET /api/prenotazioni/mie — un cliente vede le PROPRIE prenotazioni,
// identificato dalla sessione Discord (stesso login usato per prenotare).
// Niente sessione, niente dati: così come per POST /api/prenotazioni.
// ============================================================
app.get('/api/prenotazioni/mie', async (req, res) => {
  try {
    const sessione = leggiSessione(req.cookies[SESSION_COOKIE]);
    if (!sessione) {
      return res.status(401).json({ errore: 'Devi accedere con Discord per vedere le tue prenotazioni.', richiedeLogin: true });
    }

    const prenResult = await pool.query(
      `SELECT * FROM prenotazioni WHERE discord_id = $1 ORDER BY id DESC`,
      [sessione.discordId]
    );
    const autoResult = await pool.query('SELECT dati FROM store_auto WHERE id = 1');
    const auto = autoResult.rows[0]?.dati || [];

    const risultati = prenResult.rows.map(rigaToPrenotazione).map(p => {
      const veicolo = auto.find(a => a.id === p.autoId);
      return {
        id: p.id,
        autoNome: veicolo ? `${veicolo.marca} ${veicolo.modello}` : `Veicolo #${p.autoId}`,
        data: p.data,
        stato: p.stato,
        dataRichiesta: p.dataRichiesta
      };
    });

    res.json({ ok: true, prenotazioni: risultati });
  } catch (err) {
    console.error('Errore /api/prenotazioni/mie:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// ============================================================
// POST /api/prenotazioni — un cliente (NON admin) invia una
// prenotazione. Richiede login Discord completato (cookie di sessione
// valido): niente sessione, niente prenotazione. Con una vera riga di
// database ogni richiesta è già atomica di suo: due prenotazioni
// simultanee non possono più sovrascriversi a vicenda come poteva
// succedere prima con JSONBin.
// ============================================================
app.post('/api/prenotazioni', async (req, res) => {
  try {
    const sessione = leggiSessione(req.cookies[SESSION_COOKIE]);
    if (!sessione) {
      return res.status(401).json({ errore: 'Devi accedere con Discord prima di prenotare.', richiedeLogin: true });
    }

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
      dataRichiesta: formattaDataRichiesta(),
      discordId: sessione.discordId,
      discordUsername: sessione.username
    };

    await pool.query(
      `INSERT INTO prenotazioni
        (id, auto_id, nome, cognome, email, telefono, data_appuntamento, messaggio, stato, data_richiesta, discord_id, discord_username)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        nuovaPrenotazione.id, autoId, nome, cognome, email, telefono,
        data, nuovaPrenotazione.messaggio, 'in-attesa', nuovaPrenotazione.dataRichiesta,
        sessione.discordId, sessione.username
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
      { name: '👤 Cliente', value: `${prenotazione.nome} ${prenotazione.cognome}${prenotazione.discordUsername ? ` (Discord: @${prenotazione.discordUsername})` : ''}`, inline: true },
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
// WHITELIST ADMIN — endpoint interno usato dal BOT DISCORD
// ============================================================
// Il bot non fa login OAuth2 (è un bot, non un browser): per aggiungere
// o rimuovere admin chiama questi endpoint con una chiave segreta
// condivisa, diversa dalla vecchia password del sito. Va impostata come
// variabile d'ambiente sia qui che nel processo del bot.
const BOT_INTERNAL_KEY = process.env.BOT_INTERNAL_KEY;

function richiedeChiaveBot(req, res, next) {
  const chiave = req.headers['x-bot-key'];
  if (!BOT_INTERNAL_KEY || chiave !== BOT_INTERNAL_KEY) {
    return res.status(401).json({ errore: 'Chiave del bot non valida.' });
  }
  next();
}

// POST /api/admin-whitelist/aggiungi  { discordId, discordUsername, aggiuntoDa }
app.post('/api/admin-whitelist/aggiungi', richiedeChiaveBot, async (req, res) => {
  try {
    const { discordId, discordUsername, aggiuntoDa } = req.body;
    if (!discordId) return res.status(400).json({ errore: 'discordId mancante.' });

    await pool.query(
      `INSERT INTO admin_whitelist (discord_id, discord_username, aggiunto_da, aggiunto_il)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id) DO UPDATE SET discord_username = $2`,
      [discordId, discordUsername || null, aggiuntoDa || null, formattaDataRichiesta()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Errore /api/admin-whitelist/aggiungi:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// POST /api/admin-whitelist/rimuovi  { discordId }
app.post('/api/admin-whitelist/rimuovi', richiedeChiaveBot, async (req, res) => {
  try {
    const { discordId } = req.body;
    if (!discordId) return res.status(400).json({ errore: 'discordId mancante.' });

    const r = await pool.query('DELETE FROM admin_whitelist WHERE discord_id = $1', [discordId]);
    res.json({ ok: true, rimosso: r.rowCount > 0 });
  } catch (err) {
    console.error('Errore /api/admin-whitelist/rimuovi:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
  }
});

// GET /api/admin-whitelist/lista  (header X-Bot-Key richiesto)
app.get('/api/admin-whitelist/lista', richiedeChiaveBot, async (req, res) => {
  try {
    const r = await pool.query('SELECT discord_id, discord_username, aggiunto_da, aggiunto_il FROM admin_whitelist ORDER BY aggiunto_il ASC');
    res.json({ ok: true, whitelist: r.rows });
  } catch (err) {
    console.error('Errore /api/admin-whitelist/lista:', err);
    res.status(500).json({ errore: 'Errore interno del server.' });
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
