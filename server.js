import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import fs from 'fs';

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------- Parsers ---------------------
app.use(express.urlencoded({ extended: true })); // form POST
app.use(express.json());                          // JSON dall'EA

// ------------------- Sessioni ----------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-questa-frase',
  resave: false,
  saveUninitialized: false
}));

// ---------------- Persistenza (state.json) ---------
const STATE_FILE = './state.json';
function loadState(USERS, ACCOUNT_BY_USER) {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.USERS) Object.assign(USERS, parsed.USERS);
      if (parsed.ACCOUNT_BY_USER) Object.assign(ACCOUNT_BY_USER, parsed.ACCOUNT_BY_USER);
      console.log('Stato caricato da state.json');
    }
  } catch (e) {
    console.error('Errore caricando state.json:', e.message);
  }
}
function saveState(USERS, ACCOUNT_BY_USER) {
  try {
    const data = { USERS, ACCOUNT_BY_USER };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    console.log('Stato salvato in state.json');
  } catch (e) {
    console.error('Errore salvando state.json:', e.message);
  }
}

// --------------- Dati in memoria (base) ------------
const USERS = {
  'admin': 'admin123',
  'marco.sabelli': 'marco123',
  'alessio.gallina': 'alessio123'
};
const ACCOUNT_BY_USER = {
  'marco.sabelli':  { displayName: 'Marco Sabelli',  loginMT: '95474178' }, // aggiorna a piacere
  'alessio.gallina':{ displayName: 'Alessio Gallina',loginMT: '5012345678' }
};

// carica stato persistente, se esiste
loadState(USERS, ACCOUNT_BY_USER);

// ultimi pacchetti ricevuti dall’EA per login MT
const LATEST_BY_LOGIN = Object.create(null);

// ----------------- Auth middleware -----------------
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

// -------------------- Routes base ------------------
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

app.get('/', (_req, res) => {
  res.send('<h1>Prop Backend — TEST DIAG</h1><p><a href="/login">Login</a> | <a href="/diag">/diag</a> | <a href="/diag-received">/diag-received</a></p>');
});

// ---------------------- Login ----------------------
app.get('/login', (_req, res) => {
  res.send(`
    <h2>Login</h2>
    <form method="POST" action="/login" style="max-width:320px">
      <label>Username</label><br/>
      <input name="username" placeholder="es. nome.cognome" required /><br/><br/>
      <label>Password</label><br/>
      <input name="password" type="password" placeholder="********" required /><br/><br/>
      <button type="submit">Entra</button>
    </form>
    <p><small>Utenti di test: admin/admin123, marco.sabelli/marco123, alessio.gallina/alessio123</small></p>
  `);
});

app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERS[username] || USERS[username] !== password) {
    return res.send('Credenziali errate. <a href="/login">Riprova</a>');
  }
  req.session.user = { username };
  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ------------------- Diagnostica -------------------
app.get('/diag', (_req, res) => {
  const slugs = Object.keys(ACCOUNT_BY_USER);
  const out = slugs.map(u => {
    const login = ACCOUNT_BY_USER[u]?.loginMT || null;
    return {
      user: u,
      loginMT: login,
      lastPacketExists: login ? !!LATEST_BY_LOGIN[String(login)] : false
    };
  });
  res.json({ ok: true, slugs: out });
});

app.get('/diag/:user', (req, res) => {
  const { user } = req.params;
  const login = ACCOUNT_BY_USER[user]?.loginMT || null;
  res.json({
    ok: true,
    user,
    loginMT: login,
    lastPacket: login ? (LATEST_BY_LOGIN[String(login)] || null) : null
  });
});

// cosa è arrivato finora dall’EA (per trovare login reali)
app.get('/diag-received', (_req, res) => {
  res.json({ keys: Object.keys(LATEST_BY_LOGIN), data: LATEST_BY_LOGIN });
});

// --------------- Endpoint per l’EA (/update) -------
app.post('/update', (req, res) => {
  try {
    const required = process.env.EA_SHARED_SECRET;
    if (!required) return res.status(500).json({ ok: false, error: 'EA_SHARED_SECRET mancante' });

    const apiKey = req.headers['x-api-key'] || req.body?.apiKey;
    if (apiKey !== required) return res.status(401).json({ ok: false, error: 'API key invalid' });

    const {
      platform, login, server, name,
      balance, equity, margin_free, positions, timestamp
    } = req.body || {};

    if (!login) return res.status(400).json({ ok: false, error: 'login mancante' });

    LATEST_BY_LOGIN[String(login)] = {
      platform: platform || 'MT5',
      login: String(login),
      server: server || null,
      name: name || null,
      balance: balance ?? null,
      equity: equity ?? null,
      margin_free: margin_free ?? null,
      positions: Array.isArray(positions) ? positions : [],
      receivedAt: new Date().toISOString(),
      reportedAt: timestamp || null
    };

    // salva (facoltativo, ma comodo conservarlo insieme alle associazioni)
    saveState(USERS, ACCOUNT_BY_USER);

    return res.json({ ok: true });
  } catch (e) {
    console.error('update error:', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// ------------------- Dashboard utente --------------
app.get('/dashboard', requireAuth, (req, res) => {
  const { username } = req.session.user;
  const acc = ACCOUNT_BY_USER[username] || null;
  const login = acc?.loginMT ? String(acc.loginMT) : null;
  const data = login ? LATEST_BY_LOGIN[login] : null;

  const balance = data?.balance ?? '—';
  const equity  = data?.equity  ?? '—';
  const updated = data?.receivedAt ? new Date(data.receivedAt).toLocaleString() : '—';

  const waitingNote = data ? '' : '<p style="color:#a00;">In attesa di dati dall&#39;EA...</p>';

  res.send(`
    <h2>Ciao ${acc?.displayName || username}</h2>
    <div style="display:grid; gap:14px; max-width:720px;">
      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Il tuo conto MT5</h3>
        <p><b>Login MT5:</b> ${acc?.loginMT ?? '—'}</p>
        <p><b>Balance:</b> ${balance}</p>
        <p><b>Equity:</b> ${equity}</p>
        <p><b>Ultimo aggiornamento:</b> ${updated}</p>
        ${waitingNote}
      </section>

      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Pagamenti Stripe</h3>
        <p>(placeholder)</p>
      </section>

      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Payout</h3>
        <p>(placeholder)</p>
      </section>
    </div>
    <p style="margin-top:16px;"><a href="/logout">Esci</a></p>
    ${req.session.user.username === 'admin' ? '<p><a href="/admin/users/new">Admin: crea utente</a> | <a href="/admin/bind">Admin: bind login</a></p>' : ''}
  `);
});

// ---------------------- Admin utils ----------------
function allAssignedLogins() {
  const set = new Set();
  Object.values(ACCOUNT_BY_USER).forEach(v => {
    if (v?.loginMT) set.add(String(v.loginMT));
  });
  return set;
}
function unassignedLogins() {
  const assigned = allAssignedLogins();
  return Object.keys(LATEST_BY_LOGIN).filter(login => !assigned.has(login));
}

// ------------------- Admin: bind/login -------------
app.get('/admin/bind', (req, res) => {
  if (!req.session?.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Solo admin. <a href="/login">Login</a>');
  }

  const users = Object.keys(USERS).filter(u => u !== 'admin');
  const freeLogins = unassignedLogins();
  const current = Object.entries(ACCOUNT_BY_USER).map(([u, v]) => ({
    user: u,
    login: v?.loginMT || '—'
  }));

  res.send(`
    <h2>Admin: Associa login MT5 a utente</h2>
    <form method="POST" action="/admin/bind/do" style="display:grid; gap:12px; max-width:420px;">
      <label>Login MT5 (non assegnati)</label>
      <select name="login" required>
        ${freeLogins.length ? freeLogins.map(l => `<option value="${l}">${l}</option>`).join('') : '<option value="">(nessuno disponibile)</option>'}
      </select>

      <label>Utente</label>
      <select name="user" required>
        ${users.map(u => `<option value="${u}">${u}</option>`).join('')}
      </select>

      <button type="submit"${freeLogins.length ? '' : ' disabled'}>Associa</button>
    </form>

    <hr/>
    <h3>Situazione attuale</h3>
    <ul>
      ${current.map(row => `<li>${row.user} → ${row.login}</li>`).join('')}
    </ul>

    <p style="margin-top:10px;"><a href="/dashboard">Torna alla dashboard</a></p>
  `);
});

app.post('/admin/bind/do', (req, res) => {
  if (!req.session?.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Solo admin.');
  }
  const { user, login } = req.body || {};
  if (!user || !login) return res.status(400).send('Parametri mancanti');

  if (!ACCOUNT_BY_USER[user]) {
    ACCOUNT_BY_USER[user] = { displayName: user, loginMT: String(login) };
  } else {
    ACCOUNT_BY_USER[user].loginMT = String(login);
  }

  saveState(USERS, ACCOUNT_BY_USER);
  res.redirect(`/diag/${encodeURIComponent(user)}`);
});

// ------------------- Admin: crea utente ------------
app.get('/admin/users/new', (req, res) => {
  if (!req.session?.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Solo admin.');
  }

  res.send(`
    <h2>Admin: Aggiungi utente</h2>
    <form method="POST" action="/admin/users/new" style="display:grid; gap:12px; max-width:420px;">
      <label>Username (es. mario.rossi)</label>
      <input name="username" required />
      <label>Password</label>
      <input name="password" type="password" required />
      <label>Nome da mostrare (opzionale)</label>
      <input name="displayName" />
      <button type="submit">Crea</button>
    </form>
    <p><a href="/admin/bind">Vai a bind</a></p>
  `);
});

app.post('/admin/users/new', (req, res) => {
  if (!req.session?.user || req.session.user.username !== 'admin') {
    return res.status(403).send('Solo admin.');
  }
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).send('username/password obbligatori');

  USERS[username] = password;
  if (!ACCOUNT_BY_USER[username]) {
    ACCOUNT_BY_USER[username] = { displayName: displayName || username, loginMT: null };
  }

  saveState(USERS, ACCOUNT_BY_USER);
  res.redirect('/admin/bind');
});

// -------------------- Avvio server -----------------
app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT} (TEST DIAG)`);
});