require('dotenv').config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v4: uuidv4 } = require("uuid");
const YTDlpWrap = require("yt-dlp-wrap").default;
const Groq = require("groq-sdk");
const { createClient } = require("@supabase/supabase-js");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { MercadoPagoConfig, Payment, PreApproval, Customer, CustomerCard } = require("mercadopago");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

let SERVER_GROQ_KEY = "";
try {
  const kf = path.join(__dirname, "groq-key.txt");
  if (fs.existsSync(kf)) SERVER_GROQ_KEY = fs.readFileSync(kf, "utf8").trim();
} catch {}
if (!SERVER_GROQ_KEY && process.env.GROQ_KEY) SERVER_GROQ_KEY = process.env.GROQ_KEY.trim();

const jobs = {};
function setJob(id, patch) { jobs[id] = { ...jobs[id], ...patch }; }

let ytDlp = null;
async function getDlp() {
  if (ytDlp) return ytDlp;
  const isWin = process.platform === "win32";
  const bin = path.join(__dirname, isWin ? "yt-dlp.exe" : "yt-dlp");
  if (!fs.existsSync(bin)) {
    console.log("[yt-dlp] Baixando binario...");
    await YTDlpWrap.downloadFromGithub(bin);
    if (!isWin) fs.chmodSync(bin, 0o755);
  }
  ytDlp = new YTDlpWrap(bin);
  return ytDlp;
}

async function updateDlpBackground() {
  try {
    const dlp = await getDlp();
    console.log("[yt-dlp] Atualizando em background...");
    await dlp.execPromise(["--update-to", "stable"]);
    console.log("[yt-dlp] Atualizado.");
  } catch (e) {
    console.log("[yt-dlp] Aviso ao atualizar:", e.message?.slice(0,80));
  }
}

function isYouTube(url) { return /youtube\.com|youtu\.be/i.test(url); }

function getPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return "youtube";
  if (/tiktok\.com/i.test(url)) return "tiktok";
  if (/instagram\.com/i.test(url)) return "instagram";
  if (/twitter\.com|x\.com/i.test(url)) return "twitter";
  if (/facebook\.com|fb\.watch/i.test(url)) return "facebook";
  if (/twitch\.tv/i.test(url)) return "twitch";
  return "other";
}

function parseVTT(vttText) {
  const segments = [];
  const blocks = vttText.replace(/\r/g, "").split("\n\n");
  const timeRe = /(\d+:\d{2}:\d{2}\.\d{3}|\d+:\d{2}\.\d{3}) --> (\d+:\d{2}:\d{2}\.\d{3}|\d+:\d{2}\.\d{3})/;
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const timeLine = lines.find(l => timeRe.test(l));
    if (!timeLine) continue;
    const m = timeLine.match(timeRe);
    if (!m) continue;
    const parseTime = t => { const p = t.split(":"); return p.length === 3 ? +p[0]*3600 + +p[1]*60 + parseFloat(p[2]) : +p[0]*60 + parseFloat(p[1]); };
    const textLines = lines.filter(l => !timeRe.test(l) && !l.match(/^\d+$/) && l.trim() && l !== "WEBVTT");
    const text = textLines.join(" ").replace(/<[^>]+>/g, "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").trim();
    if (text) segments.push({ start: parseTime(m[1]), end: parseTime(m[2]), text });
  }
  return segments;
}

function mergeSegments(segs) {
  const out = [];
  for (const seg of segs) {
    if (out.length && out[out.length-1].text === seg.text) {
      out[out.length-1].end = seg.end;
    } else {
      out.push({ ...seg });
    }
  }
  return out;
}

function isUselessMusicSubtitle(transcript) {
  if (!transcript || transcript.length < 5) return true;
  const cleaned = transcript
    .replace(/\[Music\]/gi, '')
    .replace(/\[Applause\]/gi, '')
    .replace(/\[Laughter\]/gi, '')
    .replace(/\[Inaudible\]/gi, '')
    .replace(/\[♪[^\]]*\]/gi, '')
    .replace(/♪+/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const ratio = cleaned.length / transcript.replace(/\s+/g,' ').trim().length;
  return cleaned.length < 20 || ratio < 0.30;
}

const GROQ_OK_EXTS = new Set(["flac","mp3","mp4","mpeg","mpga","m4a","ogg","opus","wav","webm"]);

async function transcribeWithGroq(audioFile, groqKey) {
  const groq = new Groq({ apiKey: groqKey });
  const response = await groq.audio.transcriptions.create({
    file: fs.createReadStream(audioFile),
    model: "whisper-large-v3-turbo",
    response_format: "verbose_json",
    timestamp_granularities: ["segment"],
  });
  return {
    transcript: (response.text || "").trim(),
    segments: (response.segments || []).map(s => ({ start: s.start, end: s.end, text: s.text.trim() })),
    language: response.language || "",
  };
}

async function runJob(jobId, url, groqKey) {
  try {
    const dlp = await getDlp();
    const tmpDir = os.tmpdir();
    const effectiveKey = groqKey || SERVER_GROQ_KEY;

    if (isYouTube(url)) {
      setJob(jobId, { status: "subtitles", message: "Buscando legendas..." });
      const subBase = path.join(tmpDir, jobId);
      try {
        const subTimeout = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("subtitle-timeout")), 18000)
        );
        await Promise.race([
          dlp.execPromise([
            url,
            "--write-auto-sub", "--write-sub",
            "--sub-format", "vtt",
            "--sub-langs", "en,pt,en-orig",
            "--skip-download",
            "--no-playlist",
            "-o", subBase,
            "--no-warnings", "--quiet",
            "--socket-timeout", "15",
            "--retries", "1",
            "--extractor-args", "youtube:player_client=android_vr",
          ]),
          subTimeout,
        ]);
      } catch {}
      const subFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith(jobId) && f.endsWith(".vtt"));
      if (subFiles.length) {
        try {
          const preferredFile = subFiles.find(f => f.includes(".en-orig.")) || subFiles.find(f => f.includes(".en.")) || subFiles[0];
          const vttText = fs.readFileSync(path.join(tmpDir, preferredFile), "utf8");
          subFiles.forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
          const raw = parseVTT(vttText);
          const segments = mergeSegments(raw);
          const transcript = segments.map(s => s.text).join(" ").replace(/\s+/g, " ").trim();
          if (transcript.length > 10 && !isUselessMusicSubtitle(transcript)) {
            setJob(jobId, { status: "done", message: "Transcricao concluida!", transcript, segments, wordCount: transcript.split(/\s+/).length, language: "", method: "subtitles" });
            return;
          }
        } catch {}
      }
    }

    if (!effectiveKey) {
      throw new Error("Servico temporariamente indisponivel. Tente novamente mais tarde.");
    }

    setJob(jobId, { status: "downloading", message: "Baixando audio..." });

    const outTemplate = path.join(tmpDir, jobId + ".%(ext)s");

    const isYT = isYouTube(url);
    const ytArgs = isYT ? ["--extractor-args", "youtube:player_client=android_vr"] : [];

    const tryDownload = async (formatStr) => {
      try {
        await dlp.execPromise([
          url,
          "-f", formatStr,
          "-o", outTemplate,
          "--no-playlist", "--no-warnings", "--quiet",
          "--socket-timeout", "20",
          "--retries", "1",
          ...ytArgs,
        ]);
      } catch (e) {
        const landed = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(jobId) && !f.endsWith(".vtt") && !f.endsWith(".json"));
        if (!landed.length) throw e;
      }
    };

    try {
      await tryDownload("bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=mp4]/bestaudio");
    } catch (e1) {
      try {
        await tryDownload("best[ext=mp4]/best");
      } catch (e2) {
        throw new Error("Nao foi possivel baixar o audio. Verifique se o link e valido, publico e nao restrito por idade ou regiao.");
      }
    }

    const files = fs.readdirSync(tmpDir).filter(f => f.startsWith(jobId) && !f.endsWith(".vtt") && !f.endsWith(".json"));
    if (!files.length) throw new Error("Nao foi possivel baixar o audio. Verifique se o link e valido e o conteudo e publico.");

    const audioFile = path.join(tmpDir, files[0]);
    const ext = path.extname(audioFile).replace(".", "").toLowerCase();
    const sizeMB = fs.statSync(audioFile).size / (1024 * 1024);

    if (sizeMB > 25) {
      fs.unlinkSync(audioFile);
      throw new Error("Audio muito grande (" + sizeMB.toFixed(0) + "MB). Limite: 25MB. Tente um video mais curto (menos de ~30 min).");
    }

    if (!GROQ_OK_EXTS.has(ext)) {
      fs.unlinkSync(audioFile);
      throw new Error("Formato de audio nao suportado: " + ext + ". Por favor, use videos em formatos comuns.");
    }

    setJob(jobId, { status: "transcribing", message: "Transcrevendo com IA..." });

    const result = await transcribeWithGroq(audioFile, effectiveKey);
    try { fs.unlinkSync(audioFile); } catch {}

    setJob(jobId, {
      status: "done", message: "Transcricao concluida!",
      transcript: result.transcript,
      segments: result.segments,
      wordCount: result.transcript ? result.transcript.split(/\s+/).length : 0,
      language: result.language,
      method: "whisper",
    });

  } catch (err) {
    setJob(jobId, { status: "error", message: err.message || "Erro desconhecido." });
  }
}

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.post("/transcribe", (req, res) => {
  const { url, groqKey } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: "URL nao fornecida." });
  const jobId = uuidv4();
  jobs[jobId] = { status: "queued", message: "Na fila...", transcript: null, segments: [], wordCount: 0, language: "" };
  runJob(jobId, url.trim(), groqKey?.trim() || null);
  res.json({ job_id: jobId });
});

app.get("/status/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Job nao encontrado." });
  res.json(job);
});

const SUPABASE_URL        = process.env.SUPABASE_URL        || '';
const SUPABASE_ANON_KEY   = process.env.SUPABASE_ANON_KEY   || '';
const SUPABASE_SECRET     = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const JWT_SECRET          = process.env.JWT_SECRET          || '';
const MP_ACCESS_TOKEN     = process.env.MP_ACCESS_TOKEN     || '';

// In-memory reset token store: token → { userId, email, expires }
const resetTokens = new Map();
// In-memory pending signup store: email → { name, hash, code, expires, attempts }
const pendingSignups = new Map();
function cleanExpiredTokens() { for (const [t,d] of resetTokens) if (d.expires < Date.now()) resetTokens.delete(t); }
function cleanExpiredSignups() { for (const [e,d] of pendingSignups) if (d.expires < Date.now()) pendingSignups.delete(e); }
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });

if (!SUPABASE_URL || !SUPABASE_SECRET) {
  console.error('[ERRO] Variaveis SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nao definidas no arquivo .env');
  console.error('[ERRO] Copie o arquivo .env.example para .env e preencha com suas credenciais do Supabase.');
}
if (!JWT_SECRET) {
  console.error('[ERRO] JWT_SECRET nao definido no arquivo .env');
}
if (!MP_ACCESS_TOKEN) {
  console.warn('[AVISO] MP_ACCESS_TOKEN nao definido no .env — pagamentos nao funcionarao.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET);

function makeToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, is_premium: user.is_premium },
    JWT_SECRET, { expiresIn: '30d' }
  );
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Nao autenticado.' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token invalido.' });
  }
}

app.get('/api/config', (req, res) => {
  res.json({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_ANON_KEY });
});

app.post('/api/signup', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Preencha todos os campos.' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha com minimo 6 caracteres.' });

  const normalEmail = email.trim().toLowerCase();
  const { data: existing } = await supabase.from('users').select('id,password_hash').eq('email', normalEmail).maybeSingle();
  if (existing) {
    if (existing.password_hash?.startsWith('google:'))
      return res.status(409).json({ error: 'Este e-mail ja esta associado a uma conta Google. Clique em "Continuar com Google" para entrar.' });
    return res.status(409).json({ error: 'E-mail ja cadastrado.', action: 'forgot_password', action_label: 'Esqueceu sua senha? Clique aqui para recuperar.' });
  }

  cleanExpiredSignups();
  const code = String(Math.floor(100000 + Math.random() * 900000)); // 6-digit code
  const hash = await bcrypt.hash(password, 10);
  pendingSignups.set(normalEmail, { name, hash, code, expires: Date.now() + 15 * 60 * 1000, attempts: 0 });

  console.log(`\n[VERIFICACAO] Codigo para ${normalEmail}: ${code}\n`);

  // Send email if SMTP configured
  if (process.env.SMTP_HOST) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: normalEmail,
        subject: 'Código de verificação – Transcrição Universal',
        html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;text-align:center"><h2>Verificação de e-mail</h2><p>Olá, ${name}! Use o código abaixo para confirmar seu cadastro:</p><div style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;margin:20px 0">${code}</div><p style="color:#64748b;font-size:14px">Código válido por 15 minutos.</p></div>`,
      });
    } catch (e) { console.error('[SMTP] Erro ao enviar codigo:', e.message); }
  }

  const devCode = !process.env.SMTP_HOST ? code : undefined;
  res.json({ pending: true, email: normalEmail, dev_code: devCode });
});

app.post('/api/verify-email', async (req, res) => {
  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).json({ error: 'E-mail e codigo sao necessarios.' });

  const normalEmail = email.trim().toLowerCase();
  cleanExpiredSignups();
  const pending = pendingSignups.get(normalEmail);
  if (!pending) return res.status(400).json({ error: 'Codigo expirado ou nao solicitado. Tente criar a conta novamente.' });

  pending.attempts++;
  if (pending.attempts > 5) {
    pendingSignups.delete(normalEmail);
    return res.status(429).json({ error: 'Muitas tentativas. Crie a conta novamente.' });
  }

  if (String(code).trim() !== pending.code) {
    return res.status(400).json({ error: 'Codigo incorreto. Verifique e tente novamente.' });
  }

  // Code correct — create the user
  const { data: user, error } = await supabase
    .from('users')
    .insert({ name: pending.name, email: normalEmail, password_hash: pending.hash })
    .select('id,email,name,is_premium')
    .single();

  pendingSignups.delete(normalEmail);
  if (error) { console.error('[signup]', error); return res.status(500).json({ error: 'Erro ao criar conta.' }); }
  res.json({ token: makeToken(user), user: { id: user.id, email: user.email, name: user.name, is_premium: user.is_premium } });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Informe e-mail e senha.' });

  const { data: user } = await supabase
    .from('users')
    .select('id,email,name,password_hash,is_premium')
    .eq('email', email)
    .maybeSingle();

  if (!user) return res.status(401).json({ error: 'E-mail nao cadastrado.' });
  if (user.password_hash?.startsWith('google:')) return res.status(401).json({ error: 'Esta conta usa login com Google. Clique em "Continuar com Google".' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Senha incorreta.' });

  res.json({ token: makeToken(user), user: { id: user.id, email: user.email, name: user.name, is_premium: user.is_premium } });
});

app.get('/api/me', authMiddleware, async (req, res) => {
  const { data: user } = await supabase
    .from('users')
    .select('id,email,name,is_premium,next_billing_date,subscription_cancelled,mp_subscription_id')
    .eq('id', req.user.id)
    .maybeSingle();
  if (!user) return res.status(404).json({ error: 'Usuario nao encontrado.' });

  // Premium is lifetime — no expiration check needed
  const payment_method = 'pix'; // all payments are PIX now
  const { mp_subscription_id: _, ...userOut } = user; // don't expose internal id
  res.json({ user: { ...userOut, payment_method } });
});

app.get('/api/usage', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('usage')
    .select('count')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .maybeSingle();
  res.json({ count: data?.count || 0, date: today });
});

app.post('/api/usage/inc', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('usage')
    .select('id,count')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .maybeSingle();

  let newCount;
  if (existing) {
    newCount = existing.count + 1;
    await supabase.from('usage').update({ count: newCount }).eq('id', existing.id);
  } else {
    newCount = 1;
    await supabase.from('usage').insert({ user_id: req.user.id, date: today, count: 1 });
  }
  res.json({ count: newCount, date: today });
});

app.post('/api/usage/dec', authMiddleware, async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const { data: existing } = await supabase
    .from('usage')
    .select('id,count')
    .eq('user_id', req.user.id)
    .eq('date', today)
    .maybeSingle();

  if (existing && existing.count > 0) {
    await supabase.from('usage').update({ count: existing.count - 1 }).eq('id', existing.id);
  }
  res.json({ ok: true });
});

app.post('/api/google-auth', async (req, res) => {
  const { access_token } = req.body || {};
  if (!access_token) return res.status(400).json({ error: 'Token obrigatorio.' });

  const { data: { user: sbUser }, error } = await supabase.auth.getUser(access_token);
  if (error || !sbUser) return res.status(401).json({ error: 'Token Google invalido. Configure o Google OAuth no painel do Supabase.' });

  let { data: user } = await supabase.from('users').select('id,email,name,is_premium').eq('email', sbUser.email).maybeSingle();
  if (!user) {
    const name = sbUser.user_metadata?.full_name || sbUser.user_metadata?.name || sbUser.email.split('@')[0];
    const { data: newUser, error: ce } = await supabase
      .from('users')
      .insert({ name, email: sbUser.email, password_hash: 'google:' + sbUser.id })
      .select('id,email,name,is_premium')
      .single();
    if (ce) { console.error('[google-auth]', ce); return res.status(500).json({ error: 'Erro ao criar conta Google.' }); }
    user = newUser;
  }

  res.json({ token: makeToken(user), user: { id: user.id, email: user.email, name: user.name, is_premium: user.is_premium } });
});

app.post('/api/subscribe', authMiddleware, async (req, res) => {
  const { token, identificationType, identificationNumber, cardholderEmail, cardholderName, paymentType, paymentMethodId, issuerId } = req.body || {};
  if (!token) return res.status(400).json({ error: 'Token do cartao nao fornecido.' });

  const email = cardholderEmail || req.user.email;
  const isDebit = paymentType === 'debit_card';
  const nextBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const cleanDoc = (identificationNumber || '').replace(/\D/g, '');

  try {
    let subId = null;

    if (isDebit) {
      const paymentClient = new Payment(mpClient);
      // MP CardForm always returns credit payment_method_id (visa/master/elo).
      // For debit we must map to the debit variant or MP charges as credit auth only.
      const DEBIT_MAP = {
        'visa': 'debvisa',
        'master': 'debmaster',
        'mastercard': 'debmaster',
        'elo': 'elo_debit',
        'cabal': 'debcabal',
        'naranja': 'debnaranja',
        'hipercard': 'hipercard',
      };
      const debitMethodId = DEBIT_MAP[paymentMethodId?.toLowerCase()] || paymentMethodId;
      console.log('[MP Debit] paymentMethodId recebido:', paymentMethodId, '→ usando:', debitMethodId);
      const charge = await paymentClient.create({
        body: {
          transaction_amount: 0.05,
          token,
          description: 'Premium – Transcricao Universal (TESTE)',
          installments: 1,
          payment_method_id: debitMethodId,
          issuer_id: issuerId,
          three_d_secure_mode: 'optional',
          capture: true,
          payer: {
            email,
            identification: { type: identificationType, number: cleanDoc },
          },
          external_reference: String(req.user.id),
        }
      });
      console.log('[MP Debit] status:', charge.status, '| detail:', charge.status_detail, '| id:', charge.id);
      // 3DS challenge required — return URL to frontend
      if (charge.status === 'pending' && charge.three_d_secure_info?.external_resource_url) {
        return res.json({ status: 'pending_3ds', redirect_url: charge.three_d_secure_info.external_resource_url, payment_id: String(charge.id) });
      }
      if (charge.status !== 'approved') {
        const reason = charge.status_detail || charge.status || 'rejected';
        return res.json({ status: 'rejected', message: 'Cartao recusado (' + reason + '). Verifique os dados.' });
      }
      subId = charge.id ? String(charge.id) : null;
    } else {
      // --- CRÉDITO: cobrança direta via Payment com token ---
      const paymentClient2 = new Payment(mpClient);
      const charge2 = await paymentClient2.create({
        body: {
          transaction_amount: 0.05,
          token,
          payment_method_id: paymentMethodId,
          installments: 1,
          description: 'Premium – Transcricao Universal (TESTE)',
          capture: true,
          payer: {
            email,
            identification: { type: identificationType, number: cleanDoc },
          },
          external_reference: String(req.user.id),
        }
      });
      console.log('[MP Credit] Payment status:', charge2.status, '| detail:', charge2.status_detail, '| id:', charge2.id);
      if (charge2.status !== 'approved') {
        const reason = charge2.status_detail || charge2.status || 'rejected';
        return res.json({ status: 'rejected', message: 'Cartao recusado (' + reason + '). Verifique os dados.' });
      }
      subId = String(charge2.id);
    }

    const { error: cardUpdErr } = await supabase.from('users').update({
      is_premium: true,
      mp_subscription_id: subId,
      next_billing_date: nextBillingDate.toISOString(),
      subscription_cancelled: false,
    }).eq('id', req.user.id);
    if (cardUpdErr) {
      console.error('[MP Subscribe] ERRO ao salvar is_premium no DB:', cardUpdErr);
      return res.status(500).json({ error: 'Pagamento aprovado mas houve um erro ao ativar o Premium. Contate o suporte com seu comprovante.' });
    }
    // Reset today's usage to 0 so premium user starts with full 100 credits
    const todayStr = new Date().toISOString().slice(0, 10);
    await supabase.from('usage').upsert({ user_id: req.user.id, date: todayStr, count: 0 }, { onConflict: 'user_id,date' });
    const { data: user } = await supabase.from('users').select('id,email,name,is_premium').eq('id', req.user.id).maybeSingle();
    if (!user?.is_premium) {
      console.error('[MP Subscribe] ALERTA: update retornou sem erro mas is_premium ainda false para user', req.user.id);
      return res.status(500).json({ error: 'Pagamento aprovado mas ativacao do Premium falhou. Contate o suporte.' });
    }
    return res.json({ status: 'approved', token: makeToken(user), user, payment_method: isDebit ? 'card' : 'card' });
  } catch (err) {
    const detail = err?.cause ? JSON.stringify(err.cause) : (err?.message || String(err));
    console.error('[MP Subscribe] Erro:', detail);
    return res.status(500).json({ error: 'Erro ao processar pagamento. Verifique os dados e tente novamente.' });
  }
});

app.get('/api/check-payment/:paymentId', authMiddleware, async (req, res) => {
  try {
    const paymentClient = new Payment(mpClient);
    const charge = await paymentClient.get({ id: req.params.paymentId });
    if (!charge || String(charge.external_reference) !== String(req.user.id)) {
      return res.status(403).json({ error: 'Pagamento nao pertence a este usuario.' });
    }
    if (charge.status === 'approved') {
      const cSubId = `pix:${charge.id}`;
      const { error: pixUpdErr } = await supabase.from('users').update({
        is_premium: true,
        mp_subscription_id: cSubId,
        next_billing_date: null,
        subscription_cancelled: false,
      }).eq('id', req.user.id);
      if (pixUpdErr) {
        console.error('[MP CheckPayment] ERRO ao salvar is_premium no DB:', pixUpdErr);
        return res.status(500).json({ error: 'PIX aprovado mas houve um erro ao ativar o Premium. Contate o suporte com seu comprovante.' });
      }
      // Reset today's usage to 0 so premium user starts with full 100 credits
      const todayStr2 = new Date().toISOString().slice(0, 10);
      await supabase.from('usage').upsert({ user_id: req.user.id, date: todayStr2, count: 0 }, { onConflict: 'user_id,date' });
      const { data: user } = await supabase.from('users').select('id,email,name,is_premium').eq('id', req.user.id).maybeSingle();
      if (!user?.is_premium) {
        console.error('[MP CheckPayment] ALERTA: update retornou sem erro mas is_premium ainda false para user', req.user.id);
        return res.status(500).json({ error: 'PIX aprovado mas ativacao do Premium falhou. Contate o suporte.' });
      }
      return res.json({ status: 'approved', token: makeToken(user), user, payment_method: 'pix' });
    } else if (charge.status === 'pending') {
      return res.json({ status: 'pending', message: 'Verificacao ainda em andamento. Aguarde um momento.' });
    } else {
      const reason = charge.status_detail || charge.status || 'rejected';
      return res.json({ status: 'rejected', message: 'Cartao recusado (' + reason + '). Verifique os dados.' });
    }
  } catch (err) {
    const detail = err?.cause ? JSON.stringify(err.cause) : (err?.message || String(err));
    console.error('[MP CheckPayment] Erro:', detail);
    return res.status(500).json({ error: 'Erro ao verificar pagamento: ' + detail });
  }
});

app.post('/api/cancel', authMiddleware, async (req, res) => {
  try {
    const { data: dbUser } = await supabase
      .from('users')
      .select('id,email,name,is_premium,mp_subscription_id,next_billing_date')
      .eq('id', req.user.id)
      .maybeSingle();
    if (!dbUser) return res.status(404).json({ error: 'Usuario nao encontrado.' });

    if (dbUser.mp_subscription_id) {
      console.log('[CANCEL] Payment ID (referencia):', dbUser.mp_subscription_id);
    }

    await supabase.from('users').update({
      subscription_cancelled: true,
      mp_subscription_id: null,
    }).eq('id', req.user.id);

    const { data: updatedUser } = await supabase
      .from('users')
      .select('id,email,name,is_premium,next_billing_date')
      .eq('id', req.user.id)
      .maybeSingle();

    return res.json({
      token: makeToken(updatedUser),
      user: updatedUser,
      next_billing_date: updatedUser.next_billing_date,
    });
  } catch (err) {
    console.error('[CANCEL] Erro:', err?.message || err);
    return res.status(500).json({ error: 'Erro ao cancelar assinatura.' });
  }
});

// ── PIX PAYMENT ─────────────────────────────────────────────────────────────
app.post('/api/pix', authMiddleware, async (req, res) => {
  const paymentClient = new Payment(mpClient);
  const parts = (req.user.name || 'Usuario').trim().split(' ');
  const firstName = parts[0] || 'Usuario';
  const lastName  = parts.slice(1).join(' ') || firstName;
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min window
  try {
    const charge = await paymentClient.create({
      body: {
        transaction_amount: 0.05,
        description: 'Premium – Transcricao Universal (TESTE)',
        payment_method_id: 'pix',
        date_of_expiration: expires,
        external_reference: String(req.user.id),
        payer: { email: req.user.email, first_name: firstName, last_name: lastName },
      }
    });
    console.log('[PIX] Created payment id:', charge.id, 'status:', charge.status);
    if (!charge.id) return res.status(500).json({ error: 'Erro ao criar PIX.' });
    res.json({
      payment_id: String(charge.id),
      qr_code: charge.point_of_interaction?.transaction_data?.qr_code,
      qr_code_base64: charge.point_of_interaction?.transaction_data?.qr_code_base64,
    });
  } catch (err) {
    const detail = err?.cause ? JSON.stringify(err.cause) : (err?.message || String(err));
    console.error('[PIX] Erro:', detail);
    res.status(500).json({ error: 'Erro ao gerar PIX: ' + detail });
  }
});

// ── FORGOT / RESET PASSWORD ───────────────────────────────────────────────────
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Informe seu e-mail.' });

  cleanExpiredTokens();
  const { data: user } = await supabase.from('users').select('id,email,name,password_hash').eq('email', email.trim().toLowerCase()).maybeSingle();

  if (!user) return res.json({ ok: true }); // don't reveal if email exists

  if (user.password_hash?.startsWith('google:')) {
    return res.json({ ok: true, google_account: true });
  }

  const token = uuidv4();
  resetTokens.set(token, { userId: user.id, email: user.email, expires: Date.now() + 60 * 60 * 1000 });

  const origin = process.env.APP_URL || `http://localhost:${PORT}`;
  const resetUrl = `${origin}/login.html?reset=${token}`;

  console.log(`\n[RESET PASSWORD] Link para ${email}:\n  ${resetUrl}\n`);

  // Send email if SMTP configured
  if (process.env.SMTP_HOST) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      });
      await transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: email,
        subject: 'Recuperar senha – Transcrição Universal',
        html: `<p>Olá, ${user.name}!</p><p>Clique no link abaixo para redefinir sua senha (válido por 1 hora):</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>Se você não solicitou, ignore este e-mail.</p>`,
      });
    } catch (e) { console.error('[SMTP] Erro ao enviar e-mail:', e.message); }
  }

  // Dev mode: return URL so developer can test without SMTP
  const devUrl = !process.env.SMTP_HOST ? resetUrl : undefined;
  res.json({ ok: true, dev_url: devUrl });
});

app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token e senha sao necessarios.' });
  if (password.length < 6) return res.status(400).json({ error: 'Senha com minimo 6 caracteres.' });

  cleanExpiredTokens();
  const data = resetTokens.get(token);
  if (!data || data.expires < Date.now()) return res.status(400).json({ error: 'Link expirado ou invalido. Solicite um novo.' });

  const hash = await bcrypt.hash(password, 10);
  const { error } = await supabase.from('users').update({ password_hash: hash }).eq('id', data.userId);
  if (error) { console.error('[reset-password]', error); return res.status(500).json({ error: 'Erro ao atualizar senha.' }); }

  resetTokens.delete(token);
  const { data: user } = await supabase.from('users').select('id,email,name,is_premium').eq('id', data.userId).maybeSingle();
  res.json({ token: makeToken(user), user: { id: user.id, email: user.email, name: user.name, is_premium: user.is_premium } });
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Transcricao Universal rodando em http://localhost:" + PORT);
  updateDlpBackground();
});
