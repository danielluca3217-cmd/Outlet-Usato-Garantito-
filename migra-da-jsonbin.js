// ============================================================
// MIGRAZIONE UNA TANTUM: JSONBin → Postgres
// ============================================================
// Usalo UNA SOLA VOLTA per copiare le auto e le prenotazioni che hai
// già salvato su JSONBin dentro il nuovo database Postgres di Railway.
// Dopo la migrazione puoi anche rimuovere JSONBIN_BIN_ID e
// JSONBIN_API_KEY dalle variabili d'ambiente: non servono più.
//
// Come si usa (da locale, con le variabili d'ambiente giuste):
//   JSONBIN_BIN_ID=xxx JSONBIN_API_KEY=yyy DATABASE_URL=zzz node migra-da-jsonbin.js
//
// Oppure da Railway: apri una shell sul servizio ("railway run") con
// queste tre variabili impostate temporaneamente e lancia lo script.
// ============================================================

const fetch = require('node-fetch');
const { Pool } = require('pg');

const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

if (!JSONBIN_BIN_ID || !JSONBIN_API_KEY || !DATABASE_URL) {
  console.error('❌ Servono JSONBIN_BIN_ID, JSONBIN_API_KEY e DATABASE_URL come variabili d\'ambiente.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: !DATABASE_URL.includes('localhost') ? { rejectUnauthorized: false } : false
});

function formattaDataRichiesta() {
  return new Date().toLocaleDateString('it-IT', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
}

async function migra() {
  console.log('📥 Leggo i dati da JSONBin...');
  const response = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_API_KEY }
  });
  if (!response.ok) {
    throw new Error(`JSONBin ha risposto ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  const { auto = [], prenotazioni = [] } = body.record || {};
  console.log(`   Trovate ${auto.length} auto e ${prenotazioni.length} prenotazioni.`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS store_auto (
        id INTEGER PRIMARY KEY,
        dati JSONB NOT NULL DEFAULT '[]'::jsonb
      );
    `);
    await client.query(`
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
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_una_conferma_per_auto
      ON prenotazioni (auto_id) WHERE stato = 'confermata';
    `);

    await client.query(
      `INSERT INTO store_auto (id, dati) VALUES (1, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET dati = $1::jsonb`,
      [JSON.stringify(auto)]
    );

    await client.query('DELETE FROM prenotazioni');
    for (const p of prenotazioni) {
      await client.query(
        `INSERT INTO prenotazioni
          (id, auto_id, nome, cognome, email, telefono, data_appuntamento, messaggio, stato, data_richiesta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.id, p.autoId, p.nome, p.cognome, p.email, p.telefono,
          p.data, p.messaggio || '', p.stato || 'in-attesa',
          p.dataRichiesta || formattaDataRichiesta()
        ]
      );
    }

    await client.query('COMMIT');
    console.log('✅ Migrazione completata. I dati sono ora su Postgres.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migra().catch((err) => {
  console.error('❌ Migrazione fallita:', err);
  process.exit(1);
});
