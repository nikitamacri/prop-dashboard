import 'dotenv/config';
import express from 'express';
import session from 'express-session';

const app = express();
const PORT = process.env.PORT || 3000;

// parsers
app.use(express.urlencoded({ extended: true })); // form POST
app.use(express.json()); // JSON dall'EA

// sessioni
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-questa-frase',
  resave: false,
  saveUninitialized: false
}));

// utenti di test
const USERS = {
  'admin': 'admin123',
  'marco.sabelli': 'marco123',
  'alessio.gallina': 'alessio123'
};

// associazione utente -> login MT5 (dummy per ora; cambiali quando sai i login reali)
const ACCOUNT_BY_USER = {
  'marco.sabelli': { displayName: 'Marco Sabelli', loginMT: '5039103835' },
  'alessio.gallina': { displayName: 'Alessio Gallina', loginMT: '5012345678' }
};

// archivio in RAM dell’ultimo pacchetto arrivato dall’EA
const LATEST_BY_LOGIN = Object.create(null);

// middleware auth
function requireAuth(req, res, next) {
  if (!req.session?.user) return res.redirect('/login');
  next();
}

// healthcheck
app.get('/healthz', (_req, res) => res.status(200).send('OK'));

// home
app.get('/', (_req, res) => {
  res.send('<h1>Prop Backend</h1><p><a href="/login">Login</a></p>');
});

// login form
app.get('/login', (_req, res) => {
  res.send(`
    <h2>Login</h2>
    <form method="POST" action="/login" style="max-width:320px">
      <label>Username</label><br/>
      <input name="username" placeholder="es. marco.sabelli" required /><br/><br/>
      <label>Password</label><br/>
      <input name="password" type="password" placeholder="********" required /><br/><br/>
      <button type="submit">Entra</button>
    </form>
    <p style="margin-top:10px;"><small>Utenti di test: admin/admin123, marco.sabelli/marco123, alessio.gallina/alessio123</small></p>
  `);
});

// login submit
app.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!USERS[username] || USERS[username] !== password) {
    return res.send('Credenziali errate. <a href="/login">Riprova</a>');
  }
  req.session.user = { username };
  res.redirect('/dashboard');
});

// logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ===== DIAGNOSTICA =====
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

// ===== ENDPOINT RICEZIONE DATI DALL'EA =====
// accetta apiKey in header 'x-api-key' OPPURE in body.apiKey
app.post('/update', (req, res) => {
  try {
    const required = process.env.EA_SHARED_SECRET;
    if (!required) return res.status(500).json({ ok: false, error: 'EA_SHARED_SECRET mancante sul server' });

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

    return res.json({ ok: true });
  } catch (e) {
    console.error('update error:', e);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
});

// ===== DASHBOARD PRIVATA =====
app.get('/dashboard', requireAuth, (req, res) => {
  const { username } = req.session.user;
  const acc = ACCOUNT_BY_USER[username] || null;
  const login = acc?.loginMT ? String(acc.loginMT) : null;
  const data = login ? LATEST_BY_LOGIN[login] : null;

  const balance = data?.balance ?? '—';
  const equity  = data?.equity  ?? '—';
  const updated = data?.receivedAt ? new Date(data.receivedAt).toLocaleString() : '—';

  res.send(`
    <h2>Ciao ${username}</h2>
    <div style="display:grid; gap:14px; max-width:720px;">
      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Il tuo conto MT5</h3>
        <p><b>Login MT5:</b> ${acc?.loginMT ?? '—'}</p>
        <p><b>Balance:</b> ${balance}</p>
        <p><b>Equity:</b> ${equity}</p>
        <p><b>Ultimo aggiornamento:</b> ${updated}</p>
        ${data ? '' : '<p style="color:#a00;">In attesa di dati dall\'EA...</p>'}
      </section>

      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Pagamenti Stripe</h3>
        <p>(in questo step ancora vuoto, lo colleghiamo dopo con webhook)</p>
      </section>

      <section style="border:1px solid #ddd; padding:12px; border-radius:8px;">
        <h3 style="margin:0 0 8px;">Payout</h3>
        <p>(in questo step ancora vuoto)</p>
      </section>
    </div>
    <p style="margin-top:16px;"><a href="/logout">Esci</a></p>
  `);
});

app.listen(PORT, () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
});

// --- DEBUG: vedi cosa è arrivato dall'EA ---
app.get('/diag-received', (_req, res) => {
  res.json({ keys: Object.keys(LATEST_BY_LOGIN), data: LATEST_BY_LOGIN });
});

// --- DEBUG: vedi cosa è arrivato dall'EA ---
app.get('/diag-received', (_req, res) => {
  res.json({ keys: Object.keys(LATEST_BY_LOGIN), data: LATEST_BY_LOGIN });
});
