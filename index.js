// backend/index.js
process.noDeprecation = true;
import express from "express";
import cors from "cors";
import { config } from "dotenv";
import multer from "multer";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
import sqlite3 from "sqlite3";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";
import NodeMediaServer from "node-media-server";
import { EventEmitter } from "node:events";
import Context from "node-media-server/src/core/context.js";

const execAsync = promisify(exec);

// Promise‑based wrapper for sqlite3
function openDB(path) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(path, err => {
      if (err) reject(err);
      else resolve(db);
    });
  });
}
function dbRun(db, sql, ...params) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}
function dbAll(db, sql, ...params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function dbGet(db, sql, ...params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function dbExec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, err => {
      if (err) reject(err);
      else resolve();
    });
  });
}
const __dirname = path.resolve();

// Configure the dotenv lib
config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
	console.log("Missing JWT_SECRET!");
	process.exit(-1);
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
}

function authMiddleware(req, res, next) {
  let token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : req.cookies?.token;
  if (!token) return res.status(401).json({ error: "Token ausente" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Token inválido" });
  }
}

// ============================================================
// TAG NORMALIZATION SYSTEM
// ============================================================

const STEM_RULES = [
  { pattern: /ologia$/i, suffix: "logia" },
  { pattern: /ção$/i, suffix: "cao" },
  { pattern: /mente$/i, suffix: "" },
  { pattern: /vel$/i, suffix: "vel" },
  { pattern: /ável$/i, suffix: "avel" },
  { pattern: /ível$/i, suffix: "ivel" },
  { pattern: /ista[s]?$/i, suffix: "ista" },
  { pattern: /ismo[s]?$/i, suffix: "ismo" },
  { pattern: /dor$/i, suffix: "dor" },
  { pattern: /eira$/i, suffix: "eira" },
  { pattern: /eiro$/i, suffix: "eiro" },
  { pattern: /ressa$/i, suffix: "ressa" },
  { pattern: /ice$/i, suffix: "ice" },
  { pattern: /ura$/i, suffix: "ura" },
  { pattern: /al$/i, suffix: "al" },
  { pattern: /ar$/i, suffix: "ar" },
  { pattern: /er$/i, suffix: "er" },
  { pattern: /ir$/i, suffix: "ir" },
];

function stem(word) {
  const lower = word.toLowerCase();
  for (const rule of STEM_RULES) {
    if (rule.pattern.test(lower)) {
      return lower.replace(rule.pattern, rule.suffix);
    }
  }
  return lower;
}

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(0));
  for (let i = 0; i <= b.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      const cost = b.charAt(i - 1) === a.charAt(j - 1) ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[b.length][a.length];
}

function jaroWinkler(a, b) {
  if (a === b) return 1;
  const lenA = a.length, lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;
  const matchWindow = Math.floor(Math.max(lenA, lenB) / 2) - 1;
  const matchesA = Array(lenA).fill(false);
  const matchesB = Array(lenB).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < lenA; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, lenB);
    for (let j = start; j < end; j++) {
      if (matchesB[j] || a.charAt(i) !== b.charAt(j)) continue;
      matchesA[i] = matchesB[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let trans = 0;
  for (let i = 0, j = 0; i < lenA; i++) {
    if (!matchesA[i]) continue;
    while (!matchesB[j]) j++;
    if (a.charAt(i) !== b.charAt(j)) trans++;
    j++;
  }
  return (matches / lenA + matches / lenB + (matches - trans / 2) / matches) / 3;
}

function fuzzyMatch(input, target, threshold = 0.8) {
  const i = input.toLowerCase();
  const t = target.toLowerCase();
  if (i === t) return 1;
  if (i.includes(t) || t.includes(i)) return 0.9;
  const jw = jaroWinkler(i, t);
  if (jw >= threshold) return jw;
  const stemI = stem(i), stemT = stem(t);
  if (stemI === stemT) return 0.85;
  const dist = levenshtein(i, t);
  const len = Math.max(i.length, t.length);
  const ratio = 1 - dist / len;
  return ratio >= threshold ? ratio : 0;
}

const CANONICAL_TAGS = {
  tech: "tech", tecnologia: "tech", tecnology: "tech", tecnologica: "tech",
  programming: "programming", programacao: "programming", coding: "programming", codigo: "programming", código: "coding",
  python: "python", py: "python",
  javascript: "javascript", js: "javascript", jscript: "javascript",
  web: "web", desenvolvimento: "web", dev: "web", desenvolvimento_web: "web",
  games: "games", gaming: "games", game: "games", gameplay: "games", jogando: "games",
  music: "music", musica: "music", musical: "music", música: "music",
  science: "science", ciencia: "science", cientia: "science", ciência: "science",
  sports: "sports", esporte: "sports", desporto: "sports",
  tutorial: "tutorial", tutoriais: "tutorial", howto: "tutorial",
  review: "review", análise: "review", analise: "review", analysis: "review",
  anime: "anime", animê: "anime",
  movie: "movies", film: "movies", cinema: "movies", filme: "movies",
  comedy: "comedy", humor: "comedy",
  vlog: "vlog", vlogging: "vlog",
  livestream: "livestream", live: "livestream",
  reaction: "reaction", reacting: "reaction",
};

async function findCanonicalTag(source) {
  const s = source.toLowerCase().trim();
  if (CANONICAL_TAGS[s]) return CANONICAL_TAGS[s];
  const allTags = await dbAll(db, "SELECT id, name FROM tags");
  let bestMatch = null, bestScore = 0;
  for (const tag of allTags) {
    const score = fuzzyMatch(s, tag.name, 0.75);
    if (score > bestScore) { bestScore = score; bestMatch = tag.name; }
  }
  return bestMatch;
}

async function normalizeTag(name) {
  const source = name.toLowerCase().trim().replace(/^#/, "");
  const existingSyn = await dbGet(db, "SELECT target_id FROM tag_synonyms WHERE source = ?", source);
  if (existingSyn) return existingSyn.target_id;
  const existingTag = await dbGet(db, "SELECT id FROM tags WHERE name = ?", source);
  if (existingTag) return existingTag.id;
  const canonical = await findCanonicalTag(source);
  if (canonical && canonical !== source) {
    let canonicalTag = await dbGet(db, "SELECT id FROM tags WHERE name = ?", canonical);
    if (!canonicalTag) {
      const id = uuidv4();
      await dbRun(db, "INSERT INTO tags (id, name) VALUES (?,?)", id, canonical);
      canonicalTag = { id };
    }
    await dbRun(db, "INSERT INTO tag_synonyms (id, source, target_id) VALUES (?,?,?)", uuidv4(), source, canonicalTag.id);
    return canonicalTag.id;
  }
  const id = uuidv4();
  await dbRun(db, "INSERT INTO tags (id, name) VALUES (?,?)", id, source);
  return id;
}

const PORT = 4000;
const UPLOAD_ROOT = path.join(__dirname, "uploads");

// Prepare upload directory
await fs.mkdir(UPLOAD_ROOT, { recursive: true });
await fs.mkdir(path.join(UPLOAD_ROOT, 'live'), { recursive: true });

const dbPath = path.join(__dirname, "db", "video_platform.sqlite");
await fs.mkdir(path.join(__dirname, "db"), { recursive: true });
// Mantém o banco existente para persistência dos dados
const db = await openDB(dbPath);

await dbExec(db,`
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  bio TEXT,
  pronouns TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  pronouns TEXT,
  banner_url TEXT,
  avatar_url TEXT,
  stream_key TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(owner_id, name)
);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  owner_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  views INTEGER DEFAULT 0,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_resolutions (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  label TEXT NOT NULL,
  playlist_path TEXT NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  PRIMARY KEY (video_id, tag_id),
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tag_synonyms (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  target_id TEXT NOT NULL,
  UNIQUE(source, target_id),
  FOREIGN KEY (target_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS view_history (
  user_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  viewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS video_likes (
  user_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('like', 'dislike')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, video_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS channel_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, channel_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT,
  reference_id TEXT,
  reference_type TEXT,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS render_queue (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL,
  label TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS live_streams (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'offline',
  stream_key TEXT,
  viewer_count INTEGER DEFAULT 0,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS live_chat_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
`);

// Live schema migration: add scheduled_at column
try {
  await dbRun(db, "ALTER TABLE live_streams ADD COLUMN scheduled_at DATETIME");
} catch (e) { /* column already exists */ }
try {
  await dbRun(db, "ALTER TABLE live_streams ADD COLUMN late_notified INTEGER DEFAULT 0");
} catch (e) { /* column already exists */ }
try {
  await dbRun(db, "ALTER TABLE live_streams ADD COLUMN flv_id TEXT");
} catch (e) { /* column already exists */ }

console.log('[DB] Banco de dados inicializado');

const LIVE_DIR = path.join(__dirname, "uploads", "live");
await fs.mkdir(LIVE_DIR, { recursive: true });
console.log("[NMS] Live directory:", LIVE_DIR);

const RTMP_PORT = 1935;
const HTTP_PORT = 8000;

const nmsConfig = {
  bind: '0.0.0.0',
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 4096,
    gop_cache: true,
    ping: 30,
    ping_timeout: 30
  },
  http: {
    port: HTTP_PORT,
    allow_origin: '*',
    mediaroot: LIVE_DIR,
    static: {
      mountdir: LIVE_DIR,
      allow_origin: '*'
    }
  },
  trans: {
    ffmpeg: 'C:\\Program Files\\FFmpeg\\bin\\ffmpeg.exe',
    tasks: [
      {
        app: 'live',
        hls: false,
        dash: false,
        flv: true
      }
    ]
  }
};

const nms = new NodeMediaServer(nmsConfig);

// Event handlers for RTMP events
nms.on('prePublish', (session) => {
  console.log('[RTMP] prePublish:', session.streamPath, session.streamName);
  const streamPath = session.streamPath;
  const streamKey = session.streamName;
  if (!streamPath || !streamKey || streamKey.length < 10) return;
  
  const sessionId = session.id;
  console.log(`[RTMP] Session: ${sessionId}, key: ${streamKey.substring(0,8)}...`);
  
  rtmpSessions.set(sessionId, { channelId: null, channelName: 'Unknown', streamKey, flvId: null, time: Date.now() });
  
  dbGet(db, "SELECT id, name FROM channels WHERE stream_key = ?", streamKey).then(channel => {
    if (!channel) {
      console.log('[RTMP] Canal não encontrado:', streamKey);
      return;
    }
    console.log('[RTMP] Canal válido:', channel.name);
    // Reuse existing flv_id if one was pre-generated (e.g. scheduled live)
    dbGet(db, "SELECT flv_id FROM live_streams WHERE channel_id = ? AND status IN ('waiting','scheduled','ready','delayed') AND flv_id IS NOT NULL LIMIT 1", channel.id).then(existing => {
      const flvId = existing ? existing.flv_id : uuidv4().replace(/-/g, "").substring(0, 16);
      rtmpSessions.set(sessionId, { channelId: channel.id, channelName: channel.name, streamKey, flvId, time: Date.now() });
      createLiveRecord(channel.id, channel.name, streamKey, flvId);
    });
  }).catch(err => console.error('[RTMP] Erro:', err));
});

nms.on('postPublish', (session) => {
  const streamPath = session.streamPath;
  const streamKey = session.streamName;
  if (!streamPath || !streamKey || streamKey.length < 10) return;
  
  const sessionId = session.id;
  console.log('[RTMP] postPublish:', sessionId, streamKey);
  
  const sess = rtmpSessions.get(sessionId);
  if (sess && sess.channelId) {
    createLiveRecord(sess.channelId, sess.channelName, sess.streamKey, sess.flvId);
  }
});

nms.on('donePublish', (session) => {
  const sessionId = session.id;
  const sess = rtmpSessions.get(sessionId);
  if (sess) {
    console.log('[RTMP] donePublish:', sess.channelName, sess.streamKey);
    if (!sess.channelId) {
      console.warn('[RTMP] donePublish sem channelId, removendo sessão');
      rtmpSessions.delete(sessionId);
      return;
    }
    // If streamer disconnected before scheduled time, go back to 'scheduled'
    dbRun(db, "UPDATE live_streams SET status = 'scheduled' WHERE channel_id = ? AND status = 'ready'", sess.channelId)
      .then(() => {
        return dbRun(db, "UPDATE live_streams SET status = 'ended', ended_at = datetime('now') WHERE channel_id = ? AND status IN ('live','waiting','delayed')", sess.channelId);
      })
      .then(() => rtmpSessions.delete(sessionId))
      .catch(err => console.error('[RTMP] Erro:', err));
  }
});

// Additional debug events
const eventsToListen = ['prePlay', 'postPlay', 'donePlay'];
for (const eventName of eventsToListen) {
  nms.on(eventName, (session) => {
    console.log(`[DEBUG] ${eventName}:`, session?.id, session?.streamPath);
  });
}

// Handle NMS errors
nms.on('error', (err) => {
  console.error('[NMS] Error:', err.message);
});

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use("/static", express.static(UPLOAD_ROOT));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

const rtmpSessions = new Map();

function createLiveRecord(channelId, channelName, streamKey, flvId) {
  console.log(`[RTMP] Criando live para: ${channelName}`);
  
  dbGet(db, "SELECT id, status, scheduled_at FROM live_streams WHERE channel_id = ? AND status IN ('waiting','scheduled','ready','delayed','live')", channelId).then(existing => {
    if (existing) {
      if (existing.status === 'live') {
        console.log(`[RTMP] Live já ativa, atualizando flv_id (${existing.id})`);
        return dbRun(db, "UPDATE live_streams SET flv_id = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?", flvId, existing.id);
      }
      console.log(`[RTMP] Atualizando live ${existing.id} para live`);
      return dbRun(db, "UPDATE live_streams SET status = 'live', flv_id = ?, started_at = CURRENT_TIMESTAMP WHERE id = ?", flvId, existing.id);
    }
    const liveId = uuidv4();
    console.log(`[RTMP] INSERT live: ${liveId}`);
    return dbRun(db, 
      "INSERT INTO live_streams (id, channel_id, title, description, status, stream_key, flv_id, started_at) VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)",
      liveId, channelId, "Live", `Transmissão de ${channelName}`, "live", streamKey, flvId
    );
  }).then(() => {
    console.log('[RTMP] Live registrada!');
  }).catch(err => console.error('[RTMP] Erro ao criar live:', err));
}

// API endpoint to get active RTMP sessions
app.get("/api/rtmp/sessions", (req, res) => {
  const sessions = [];
  for (const [id, session] of rtmpSessions) {
    sessions.push({ id, ...session });
  }
  res.json({ sessions, count: sessions.length });
});

// Start the RTMP server
nms.run();

app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Campos obrigatórios" });
  const exists = await dbGet(db, "SELECT id FROM users WHERE email = ?", email);
  if (exists) return res.status(409).json({ error: "E‑mail já registrado" });
  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  await dbRun(db, "INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)", id, name, email, hash);
  const token = signToken({ id, name, email });
  res.cookie("token", token, { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  res.json({ user: { id, name, email } });
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await dbGet(db, "SELECT * FROM users WHERE email = ?", email);
  if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "Credenciais inválidas" });
  const token = signToken(user);
  console.log("Login success, setting cookie for user:", user.email);
  res.cookie("token", token, { maxAge: 7 * 24 * 60 * 60 * 1000, sameSite: "lax" });
  res.json({ user: { id: user.id, name: user.name, email: user.email } });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

// Channel routes
app.get("/api/channels", authMiddleware, async (req, res) => {
  const channels = await dbAll(db, "SELECT id, name, description, pronouns, banner_url, avatar_url, created_at FROM channels WHERE owner_id = ? ORDER BY created_at DESC", req.user.id);
  res.json(channels);
});

app.post("/api/channels", authMiddleware, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: "Nome do canal obrigatório" });
  const existing = await dbGet(db, "SELECT id FROM channels WHERE owner_id = ? AND name = ?", req.user.id, name);
  if (existing) return res.status(409).json({ error: "Canal com este nome já existe" });
  const id = uuidv4();
  const streamKey = uuidv4().replace(/-/g, "").substring(0, 32);
  await dbRun(db, "INSERT INTO channels (id, owner_id, name, description, stream_key) VALUES (?,?,?,?,?)", id, req.user.id, name, description || "", streamKey);
  res.json({ id, name, description: description || "", streamKey });
});

app.get("/api/channels/:id", async (req, res) => {
  const channel = await dbGet(db, "SELECT c.*, (SELECT COUNT(*) FROM videos WHERE channel_id = c.id) as video_count FROM channels c WHERE c.id = ?", req.params.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  res.json(channel);
});

app.get("/api/channels/:id/videos", async (req, res) => {
  const videos = await dbAll(db, `
    SELECT v.id, v.title, v.views, v.created_at,
           (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
    FROM videos v WHERE v.channel_id = ?
    ORDER BY v.created_at DESC`, req.params.id);
  res.json(videos.map(v => ({
    id: v.id,
    title: v.title,
    views: v.views,
    created_at: v.created_at,
    previewUrl: `/static/${path.basename(v.playlist1080)}`,
  })));
});

app.delete("/api/channels/:id", authMiddleware, async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  await dbRun(db, "DELETE FROM channels WHERE id = ?", req.params.id);
  res.json({ ok: true });
});

app.patch("/api/channels/:id", authMiddleware, async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  const { name, description, pronouns, banner_url, avatar_url } = req.body;
  if (name) await dbRun(db, "UPDATE channels SET name = ? WHERE id = ?", name, req.params.id);
  if (description !== undefined) await dbRun(db, "UPDATE channels SET description = ? WHERE id = ?", description, req.params.id);
  if (pronouns !== undefined) await dbRun(db, "UPDATE channels SET pronouns = ? WHERE id = ?", pronouns, req.params.id);
  if (banner_url) await dbRun(db, "UPDATE channels SET banner_url = ? WHERE id = ?", banner_url, req.params.id);
  if (avatar_url) await dbRun(db, "UPDATE channels SET avatar_url = ? WHERE id = ?", avatar_url, req.params.id);
  const updated = await dbGet(db, "SELECT * FROM channels WHERE id = ?", req.params.id);
  res.json(updated);
});

app.post("/api/channels/:id/stream-key", authMiddleware, async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  const newStreamKey = uuidv4().replace(/-/g, "").substring(0, 32);
  await dbRun(db, "UPDATE channels SET stream_key = ? WHERE id = ?", newStreamKey, req.params.id);
  res.json({ streamKey: newStreamKey });
});

app.get("/api/channels/:id/stream-key", authMiddleware, async (req, res) => {
  const channel = await dbGet(db, "SELECT stream_key FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  res.json({ streamKey: channel.stream_key });
});

// Creator panel: my videos with stats
app.get("/api/creator/videos", authMiddleware, async (req, res) => {
  const videos = await dbAll(db, `
    SELECT v.id, v.title, v.description, v.views, v.created_at, c.name as channel_name,
           (SELECT COUNT(*) FROM comments WHERE video_id = v.id) as comment_count
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
    WHERE v.owner_id = ?
    ORDER BY v.created_at DESC`, req.user.id);
  
  // Enrich with render status
  const enriched = await Promise.all(videos.map(async (v) => {
    const completed = await dbAll(db, "SELECT label FROM video_resolutions WHERE video_id = ?", v.id);
    const queue = await dbAll(db, "SELECT label, status FROM render_queue WHERE video_id = ?", v.id);
    let status = 'complete';
    let processingLabel = null;
    if (queue.length > 0) {
      const processing = queue.find(q => q.status === 'processing');
      if (processing) {
        status = 'processing';
        processingLabel = processing.label;
      } else {
        const pending = queue.find(q => q.status === 'pending');
        if (pending) {
          status = 'pending';
        }
      }
    }
    return { ...v, renderStatus: status, processingLabel };
  }));
  res.json(enriched);
});

app.get("/api/creator/stats", authMiddleware, async (req, res) => {
  const stats = await dbGet(db, `
    SELECT 
      COUNT(DISTINCT v.id) as total_videos,
      COALESCE(SUM(v.views), 0) as total_views,
      COUNT(DISTINCT c.id) as total_comments
    FROM videos v
    LEFT JOIN comments c ON c.video_id = v.id
    WHERE v.owner_id = ?`, req.user.id);
  res.json(stats);
});

// Multer setup
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const dir = path.join(UPLOAD_ROOT, "raw");
    await fs.mkdir(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({ storage });

app.post("/api/videos", authMiddleware, upload.single("video"), async (req, res) => {
  const { channelId, title, description } = req.body;
  if (!channelId || !req.file) return res.status(400).json({ error: "Canal e arquivo obrigatórios" });
  const channel = await dbGet(db, "SELECT id, owner_id FROM channels WHERE id = ?", channelId);
  if (!channel || channel.owner_id !== req.user.id) return res.status(403).json({ error: "Canal não encontrado ou sem permissão" });
  const videoId = uuidv4();
  const rawPath = req.file.path;
  const outputBase = path.join(UPLOAD_ROOT, videoId);
  await fs.mkdir(outputBase, { recursive: true });

  const videoTitle = title && title.trim() ? title.trim() : req.file.originalname;
  const videoDesc = description && description.trim() ? description.trim() : "";

  // === SINGLE HLS: remux source into HLS with stream copy (zero CPU) ===
  const outDir = path.join(outputBase, 'source');
  await fs.mkdir(outDir, { recursive: true });

  const cmd = `ffmpeg -y -i "${rawPath}" -map_metadata -1 -c:v copy -c:a aac -b:a 128k -hls_time 6 -hls_playlist_type vod -hls_segment_filename "${outDir}/segment_%03d.ts" "${outDir}/playlist.m3u8"`;

  console.log(`[Upload] Remuxing ${req.file.originalname} -> HLS (stream copy)`);

  try {
    await execAsync(cmd);
  } catch (e) {
    console.error(`Erro ao gerar HLS:`, e.stderr);
    return res.status(500).json({ error: 'Falha ao processar vídeo' });
  }

  await dbRun(db,
    "INSERT INTO videos (id, channel_id, title, description, owner_id) VALUES (?,?,?,?,?)",
    videoId,
    channelId,
    videoTitle,
    videoDesc,
    req.user.id
  );

  const rawTags = req.body.tags || "";
  const tagList = rawTags.split(",").map(t => t.trim()).filter(Boolean);
  for (const tag of tagList) {
    const tagId = await normalizeTag(tag);
    await dbRun(db, "INSERT OR IGNORE INTO video_tags (video_id, tag_id) VALUES (?,?)", videoId, tagId);
  }

  await dbRun(db,
    "INSERT INTO video_resolutions (id, video_id, label, playlist_path) VALUES (?,?,?,?)",
    uuidv4(),
    videoId,
    'source',
    path.join(outDir, "playlist.m3u8")
  );

  const ext = path.extname(rawPath);
  const savedRawPath = path.join(path.dirname(rawPath), `${videoId}${ext}`);
  await fs.rename(rawPath, savedRawPath).catch(() => {});

  const thumbFile = path.join(outputBase, "thumbnail.jpg");
  try {
    await execAsync(`ffmpeg -y -i "${savedRawPath}" -ss 00:00:01 -vframes 1 -vf "scale=320:180:force_original_aspect_ratio=decrease" -q:v 2 "${thumbFile}"`);
  } catch (e) {
    console.error("Thumbnail generation failed:", e.message);
  }

  await notifySubscribers(db, channelId, videoId, videoTitle);

  res.json({ videoId, status: 'ready' });
});

async function notifySubscribers(db, channelId, videoId, videoTitle) {
  const channel = await dbGet(db, "SELECT name FROM channels WHERE id = ?", channelId);
  const subs = await dbAll(db, "SELECT user_id FROM channel_subscriptions WHERE channel_id = ?", channelId);
  for (const sub of subs) {
    await dbRun(db,
      "INSERT INTO notifications (id, user_id, type, title, message, reference_id, reference_type) VALUES (?,?,?,?,?,?,?)",
      uuidv4(),
      sub.user_id,
      "new_video",
      "Novo vídeo publicado",
      `${channel.name} publicou um novo vídeo: ${videoTitle}`,
      videoId,
      "video"
    );
  }
}

app.get("/api/videos", async (req, res) => {
  const q = req.query.q?.trim();
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = await dbAll(db,
      `SELECT v.id, c.name as channel, v.title, v.description, v.owner_id, v.views,
              (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       LEFT JOIN video_tags vt ON vt.video_id = v.id
       LEFT JOIN tags t ON t.id = vt.tag_id
       WHERE v.title LIKE ? OR v.description LIKE ? OR t.name LIKE ?
       GROUP BY v.id
       ORDER BY v.created_at DESC`, like, like, like);
  } else {
    rows = await dbAll(db,
      `SELECT v.id, c.name as channel, v.title, v.description, v.owner_id, v.views,
              (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       ORDER BY v.created_at DESC`
    );
  }
  const videos = rows.map(v => ({
    id: v.id,
    channel: v.channel,
    title: v.title,
    description: v.description,
    ownerId: v.owner_id,
    views: v.views,
    previewUrl: `/static/${path.basename(v.playlist1080)}`,
  }));
  res.json(videos);
});

app.get("/api/videos/:id", async (req, res) => {
  // Increment view count
  await dbRun(db, "UPDATE videos SET views = views + 1 WHERE id = ?", req.params.id);
  // Record view history if user is authenticated (optional)
  const authHeader = req.headers.authorization;
  let userId = null;
  if (authHeader?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
      userId = payload.id;
      await dbRun(db, "INSERT OR IGNORE INTO view_history (user_id, video_id) VALUES (?,?)", payload.id, req.params.id);
    } catch (_) {}
  }
  const video = await dbGet(db, `
    SELECT v.*, c.name as channel_name, c.avatar_url as channel_avatar_url
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
    WHERE v.id = ?`, req.params.id);
  if (!video) return res.status(404).json({ error: "Vídeo não encontrado" });
  const resolutions = await dbAll(db,
    "SELECT label, playlist_path FROM video_resolutions WHERE video_id = ?",
    video.id
  );
  const tags = await dbAll(db,
    `SELECT t.name FROM tags t
     JOIN video_tags vt ON vt.tag_id = t.id
     WHERE vt.video_id = ?`,
    video.id
  );
  const likeStats = await dbGet(db,
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'like' THEN 1 ELSE 0 END), 0) as likes,
       COALESCE(SUM(CASE WHEN type = 'dislike' THEN 1 ELSE 0 END), 0) as dislikes
     FROM video_likes WHERE video_id = ?`,
    video.id
  );
  let userLike = null;
  if (userId) {
    const like = await dbGet(db, "SELECT type FROM video_likes WHERE user_id = ? AND video_id = ?", userId, video.id);
    userLike = like?.type || null;
  }
  const commentCount = await dbGet(db, "SELECT COUNT(*) as cnt FROM comments WHERE video_id = ?", video.id);
  const baseUrl = "/static";
  const resUrls = resolutions.map(r => ({
    label: r.label,
    url: `${baseUrl}/${path.relative(UPLOAD_ROOT, r.playlist_path).replace(/\\/g, "/")}`,
  }));
  res.json({
    id: video.id,
    channel: video.channel_name,
    channelId: video.channel_id,
    title: video.title,
    description: video.description,
    ownerId: video.owner_id,
    views: video.views,
    createdAt: video.created_at,
    tags: tags.map(t => t.name),
    likes: likeStats.likes,
    dislikes: likeStats.dislikes,
    userLike,
    commentCount: commentCount.cnt,
    thumbnailUrl: `/static/${video.id}/thumbnail.jpg`,
    resolutions: resUrls,
  });
});

app.patch("/api/videos/:id", authMiddleware, async (req, res) => {
  const video = await dbGet(db, "SELECT * FROM videos WHERE id = ?", req.params.id);
  if (!video) return res.status(404).json({ error: "Vídeo não encontrado" });
  if (video.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });
  const { title, description } = req.body;
  await dbRun(db, 
    "UPDATE videos SET title = COALESCE(?, title), description = COALESCE(?, description) WHERE id = ?",
    title,
    description,
    video.id
  );
  res.json({ ok: true });
});

app.delete("/api/videos/:id", authMiddleware, async (req, res) => {
  const video = await dbGet(db, "SELECT id FROM videos WHERE id = ?", req.params.id);
  if (!video) return res.status(404).json({ error: "Vídeo não encontrado" });
  const owner = await dbGet(db, "SELECT owner_id FROM videos WHERE id = ?", req.params.id);
  if (owner.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });
  await dbRun(db, "DELETE FROM videos WHERE id = ?", req.params.id);
  res.json({ ok: true });
});

app.get("/api/videos/:id/comments", async (req, res) => {
  const rows = await dbAll(db,
    `SELECT c.id, c.text, c.author_id, c.created_at, u.name AS author_name, u.avatar_url AS author_avatar
     FROM comments c
     JOIN users u ON c.author_id = u.id
     WHERE c.video_id = ?
     ORDER BY c.created_at ASC`,
    req.params.id
  );
  res.json(rows);
});

app.post("/api/videos/:id/comments", authMiddleware, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto obrigatório" });
  const commentId = uuidv4();
  await dbRun(db, 
    "INSERT INTO comments (id, video_id, author_id, text) VALUES (?,?,?,?)",
    commentId,
    req.params.id,
    req.user.id,
    text
  );
  res.json({ commentId });
});

app.patch("/api/comments/:id", authMiddleware, async (req, res) => {
  const comment = await dbGet(db, "SELECT * FROM comments WHERE id = ?", req.params.id);
  if (!comment) return res.status(404).json({ error: "Comentário não encontrado" });
  if (comment.author_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Texto obrigatório" });
  await dbRun(db, "UPDATE comments SET text = ? WHERE id = ?", text, comment.id);
  res.json({ ok: true });
});

app.delete("/api/comments/:id", authMiddleware, async (req, res) => {
  const comment = await dbGet(db, "SELECT * FROM comments WHERE id = ?", req.params.id);
  if (!comment) return res.status(404).json({ error: "Comentário não encontrado" });
  if (comment.author_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });
  await dbRun(db, "DELETE FROM comments WHERE id = ?", comment.id);
  res.json({ ok: true });
});

// Get render status (simplified — single HLS, always ready)
app.get("/api/videos/:id/render-status", async (req, res) => {
  const video = await dbGet(db, "SELECT id FROM videos WHERE id = ?", req.params.id);
  if (!video) return res.status(404).json({ error: "Vídeo não encontrado" });
  res.json({ completed: ['source'], pending: [], processing: [], progress: 100, isComplete: true });
});

// Subscriptions
app.post("/api/channels/:id/subscribe", authMiddleware, async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ?", req.params.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  await dbRun(db,
    "INSERT OR IGNORE INTO channel_subscriptions (id, user_id, channel_id) VALUES (?,?,?)",
    uuidv4(),
    req.user.id,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete("/api/channels/:id/subscribe", authMiddleware, async (req, res) => {
  await dbRun(db, "DELETE FROM channel_subscriptions WHERE user_id = ? AND channel_id = ?", req.user.id, req.params.id);
  res.json({ ok: true });
});

app.get("/api/channels/:id/subscribers/count", async (req, res) => {
  const result = await dbGet(db, "SELECT COUNT(*) as cnt FROM channel_subscriptions WHERE channel_id = ?", req.params.id);
  res.json({ count: result.cnt });
});

app.get("/api/channels/:id/subscribed", authMiddleware, async (req, res) => {
  const sub = await dbGet(db, "SELECT id FROM channel_subscriptions WHERE user_id = ? AND channel_id = ?", req.user.id, req.params.id);
  res.json({ subscribed: !!sub });
});

// Notifications
app.get("/api/notifications", authMiddleware, async (req, res) => {
  const notifications = await dbAll(db,
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
    req.user.id
  );
  res.json(notifications);
});

app.post("/api/notifications/:id/read", authMiddleware, async (req, res) => {
  await dbRun(db, "UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?", req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post("/api/notifications/read-all", authMiddleware, async (req, res) => {
  await dbRun(db, "UPDATE notifications SET is_read = 1 WHERE user_id = ?", req.user.id);
  res.json({ ok: true });
});

app.get("/api/notifications/unread-count", authMiddleware, async (req, res) => {
  const result = await dbGet(db, "SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND is_read = 0", req.user.id);
  res.json({ count: result.cnt });
});

// Live Streams
// Chat endpoint for live streams
app.post('/api/live/:channelId/chat', authMiddleware, async (req, res) => {
  const { channelId } = req.params;
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto obrigatório' });
  const user = await dbGet(db, 'SELECT name FROM users WHERE id = ?', req.user.id);
  const author = user?.name || 'Anonymous';
  const id = uuidv4();
  await dbRun(db,
    'INSERT INTO live_chat_messages (id, channel_id, author, text) VALUES (?,?,?,?)',
    id, channelId, author, text
  );
  // Also push to in-memory cache so chat-history includes this message
  if (!liveChats[channelId]) liveChats[channelId] = [];
  liveChats[channelId].push({
    id,
    username: author,
    author,
    message: text,
    text,
    timestamp: new Date().toISOString()
  });
  if (liveChats[channelId].length > 200) liveChats[channelId].shift();
  // Emit to all sockets listening to this channel
  io.to(`live-${channelId}`).emit('new-message', { author, text });
  res.json({ ok: true });
});

app.post("/api/live", authMiddleware, async (req, res) => {
  const { channelId, title, description, mode, scheduledAt } = req.body;
  if (!channelId || !title) return res.status(400).json({ error: "Canal e título obrigatórios" });
  const channel = await dbGet(db, "SELECT id, owner_id, stream_key FROM channels WHERE id = ?", channelId);
  if (!channel || channel.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });

  // Cancel any existing non-ended live for this channel
  await dbRun(db, "UPDATE live_streams SET status = 'cancelled' WHERE channel_id = ? AND status NOT IN ('ended', 'cancelled')", channelId);

  const streamKey = channel.stream_key || uuidv4().replace(/-/g, "");
  const flvId = uuidv4().replace(/-/g, "").substring(0, 16);
  const liveId = uuidv4();
  let status = 'waiting';
  let scheduledAtVal = null;

  if (mode === 'schedule' && scheduledAt) {
    status = 'scheduled';
    scheduledAtVal = new Date(scheduledAt).toISOString().replace('T', ' ').substring(0, 19);
  }

  await dbRun(db,
    "INSERT INTO live_streams (id, channel_id, title, description, status, stream_key, flv_id, scheduled_at) VALUES (?,?,?,?,?,?,?,?)",
    liveId, channelId, title, description || "", status, streamKey, flvId, scheduledAtVal
  );
  res.json({ liveId, streamKey, flvId, status, scheduledAt: scheduledAtVal });
});

// Schedule a live (alias for POST /api/live with mode='schedule')
app.post("/api/channels/:id/schedule-live", authMiddleware, async (req, res) => {
  req.body.channelId = req.params.id;
  req.body.mode = 'schedule';
  // forward to POST /api/live
  const channel = await dbGet(db, "SELECT id, owner_id FROM channels WHERE id = ?", req.params.id);
  if (!channel || channel.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });
  const { title, description, scheduledAt } = req.body;
  if (!title || !scheduledAt) return res.status(400).json({ error: "Título e horário obrigatórios" });
  
  const streamKey = channel.stream_key || uuidv4().replace(/-/g, "");
  const flvId = uuidv4().replace(/-/g, "").substring(0, 16);
  const liveId = uuidv4();
  
  await dbRun(db,
    "INSERT INTO live_streams (id, channel_id, title, description, status, stream_key, flv_id, scheduled_at) VALUES (?,?,?,?,?,?,?,?)",
    liveId, req.params.id, title, description || "", "scheduled", streamKey, flvId, new Date(scheduledAt).toISOString().replace('T', ' ').substring(0, 19)
  );
  res.json({ liveId, streamKey, flvId, status: 'scheduled', scheduledAt });
});

// Cancel a live
app.post("/api/live/:id/cancel", authMiddleware, async (req, res) => {
  const live = await dbGet(db, "SELECT * FROM live_streams WHERE id = ?", req.params.id);
  if (!live) return res.status(404).json({ error: "Live não encontrada" });
  const channel = await dbGet(db, "SELECT owner_id FROM channels WHERE id = ?", live.channel_id);
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });

  await dbRun(db, "UPDATE live_streams SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?", req.params.id);
  res.json({ ok: true, status: 'cancelled' });
});

// Get live status with timing info
app.get("/api/live/:channelId/status", async (req, res) => {
  const live = await dbGet(db,
    `SELECT l.*, c.name as channel_name, c.avatar_url as channel_avatar
     FROM live_streams l
     JOIN channels c ON c.id = l.channel_id
     WHERE l.channel_id = ? AND l.status IN ('scheduled','ready','waiting','live','delayed')`,
    req.params.channelId);
  if (!live) return res.json({ status: 'offline' });
  
  // Calculate delay info
  const now = new Date();
  let delayMinutes = 0;
  let isLate = false;
  
  if (live.scheduled_at) {
    const scheduledTime = new Date(live.scheduled_at.replace(' ', 'T') + 'Z');
    const diffMs = now - scheduledTime;
    delayMinutes = Math.max(0, Math.floor(diffMs / 60000));
    isLate = delayMinutes > 0 && (live.status === 'scheduled' || live.status === 'ready' || live.status === 'waiting' || live.status === 'delayed');
  }
  
  res.json({
    id: live.id,
    channel_id: live.channel_id,
    channel_name: live.channel_name,
    channel_avatar: live.channel_avatar,
    title: live.title,
    description: live.description,
    status: live.status,
    stream_key: live.stream_key,
    flv_id: live.flv_id,
    scheduled_at: live.scheduled_at,
    delay_minutes: delayMinutes,
    is_late: isLate
  });
});

app.get("/api/live/:id", async (req, res) => {
  const live = await dbGet(db, "SELECT * FROM live_streams WHERE id = ?", req.params.id);
  if (!live) return res.status(404).json({ error: "Live não encontrada" });
  res.json(live);
});

app.get("/api/channels/:id/live", async (req, res) => {
  const live = await dbGet(db, "SELECT * FROM live_streams WHERE channel_id = ? AND status IN ('scheduled','ready','waiting','live','delayed') ORDER BY rowid DESC", req.params.id);
  res.json(live || null);
});

app.delete("/api/live/:id", authMiddleware, async (req, res) => {
  const live = await dbGet(db, "SELECT * FROM live_streams WHERE id = ?", req.params.id);
  if (!live) return res.status(404).json({ error: "Live não encontrada" });
  const channel = await dbGet(db, "SELECT owner_id FROM channels WHERE id = ?", live.channel_id);
  if (channel.owner_id !== req.user.id) return res.status(403).json({ error: "Acesso negado" });

  await dbRun(db, "UPDATE live_streams SET status = 'ended', ended_at = datetime('now') WHERE id = ?", req.params.id);
  res.json({ ok: true });
});

app.get("/api/live/:id/viewers", async (req, res) => {
  const live = await dbGet(db, "SELECT * FROM live_streams WHERE id = ? OR channel_id = ?", req.params.id, req.params.id);
  if (!live) return res.json({ count: 0 });
  res.json({ count: live.viewer_count || 1 });
});

app.get("/api/live", async (req, res) => {
  const lives = await dbAll(db,
    `SELECT l.*, c.name as channel_name, c.avatar_url as channel_avatar
     FROM live_streams l
     JOIN channels c ON c.id = l.channel_id
     WHERE l.status IN ('live','waiting','delayed','scheduled','ready')
     ORDER BY CASE l.status WHEN 'live' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END, l.scheduled_at ASC`
  );
  res.json(lives);
});

// Webhook para servidores RTMP externos (nginx/node-media-server)
// O servidor RTMP deve fazer POST para esses endpoints quando uma transmissão começa/acaba
app.post("/api/webhook/live-start", async (req, res) => {
  const { channelId, streamKey, title } = req.body;
  if (!channelId || !streamKey) return res.status(400).json({ error: "channelId e streamKey obrigatórios" });
  
  const channel = await dbGet(db, "SELECT id, name FROM channels WHERE id = ? AND stream_key = ?", channelId, streamKey);
  if (!channel) return res.status(403).json({ error: "Stream key inválida" });
  
  const existing = await dbGet(db, "SELECT id, status FROM live_streams WHERE channel_id = ? AND status IN ('waiting','scheduled','delayed','live')", channelId);
  if (existing) {
    if (existing.status === 'live') return res.json({ ok: true, message: "Live já está ativa" });
    // Update existing record to live
    await dbRun(db, "UPDATE live_streams SET status = 'live', started_at = datetime('now') WHERE id = ?", existing.id);
    return res.json({ ok: true, liveId: existing.id });
  }
  
  const liveId = uuidv4();
  await dbRun(db,
    "INSERT INTO live_streams (id, channel_id, title, description, status, started_at) VALUES (?,?,?,?,?,datetime('now'))",
    liveId,
    channelId,
    title || "Live",
    "Transmissão ao vivo"
  );
  
  console.log(`[Webhook] Live iniciada para canal ${channel.name} (${channelId})`);
  res.json({ ok: true, liveId });
});

app.post("/api/webhook/live-end", async (req, res) => {
  const { channelId, streamKey } = req.body;
  if (!channelId || !streamKey) return res.status(400).json({ error: "channelId e streamKey obrigatórios" });
  
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND stream_key = ?", channelId, streamKey);
  if (!channel) return res.status(403).json({ error: "Stream key inválida" });
  
  await dbRun(db, 
    "UPDATE live_streams SET status = 'ended', ended_at = datetime('now') WHERE channel_id = ? AND status IN ('live','waiting','delayed')",
    channelId
  );
  
  console.log(`[Webhook] Live encerrada para canal ${channelId}`);
  res.json({ ok: true });
});

// Proxy FLV: maps flv_id -> stream_key (NMS nunca é consultado com nome errado)
app.get("/api/flv/:flvId.flv", async (req, res) => {
  try {
    const live = await dbGet(db,
      "SELECT stream_key FROM live_streams WHERE flv_id = ? AND status = 'live'",
      req.params.flvId
    );
    if (!live) return res.status(404).end();
    const url = `http://localhost:${HTTP_PORT}/live/${live.stream_key}.flv`;
    http.get(url, (proxyRes) => {
      if (!proxyRes.statusCode || proxyRes.statusCode >= 400)
        return res.status(proxyRes.statusCode || 502).end();
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }).on("error", () => { if (!res.headersSent) res.status(502).end(); });
  } catch { res.status(500).end(); }
});

// Recommendation: videos based on tags (public endpoint)
app.get("/api/recommendations", async (req, res) => {
const exId = req.query.exclude;
const tagCounts = await dbAll(db,
  `SELECT t.id, t.name, COUNT(*) as cnt
   FROM view_history vh
   JOIN videos v ON v.id = vh.video_id
   JOIN video_tags vt ON vt.video_id = v.id
   JOIN tags t ON t.id = vt.tag_id
   GROUP BY t.id
   ORDER BY cnt DESC
   LIMIT 5`
);

let videos;
if (tagCounts.length > 0) {
  const tagIds = tagCounts.map(t => t.id);
  const excludePart = exId ? `AND v.id != ?` : "";
  videos = await dbAll(db,
    `SELECT v.id, c.name as channel, c.avatar_url as channel_avatar, v.title, v.description, v.owner_id, v.views, v.created_at,
            (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
     FROM videos v
     JOIN channels c ON c.id = v.channel_id
     JOIN video_tags vt ON vt.video_id = v.id
     WHERE vt.tag_id IN (${tagIds.map(() => '?').join(',')}) ${excludePart}
     GROUP BY v.id
     ORDER BY v.views DESC
     LIMIT 20`,
    ...tagIds, ...(exId ? [exId] : [])
  );
} else {
  const excludePart = exId ? `WHERE v.id != ?` : "";
  videos = await dbAll(db,
    `SELECT v.id, c.name as channel, c.avatar_url as channel_avatar, v.title, v.description, v.owner_id, v.views, v.created_at,
            (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
     FROM videos v
     JOIN channels c ON c.id = v.channel_id
     ${excludePart}
     ORDER BY v.views DESC
     LIMIT 20`,
    ...(exId ? [exId] : [])
  );
}
const result = videos.map(v => ({
  id: v.id,
  channel: v.channel,
  channelAvatar: v.channel_avatar,
  title: v.title,
  description: v.description,
  ownerId: v.owner_id,
  views: v.views,
  created_at: v.created_at,
  previewUrl: v.playlist1080 ? `/static/${path.basename(v.playlist1080)}` : null,
}));
res.json(result);
});

app.use("/static", express.static(UPLOAD_ROOT));

// IMPORTANT: /api/users/me must come BEFORE /api/users/:id
app.get("/api/users/me", authMiddleware, async (req, res) => {
  const user = await dbGet(db, "SELECT id, name, email, bio, pronouns, avatar_url FROM users WHERE id = ?", req.user.id);
  res.json(user);
});

app.get("/api/users/:id", async (req, res) => {
  const user = await dbGet(db, "SELECT id, name, email FROM users WHERE id = ?", req.params.id);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado" });
  res.json(user);
});

app.post("/api/videos/:id/like", authMiddleware, async (req, res) => {
  const { type } = req.body;
  if (!type || !["like", "dislike"].includes(type)) {
    return res.status(400).json({ error: "Tipo inválido" });
  }
  await dbRun(db,
    "INSERT OR REPLACE INTO video_likes (user_id, video_id, type) VALUES (?,?,?)",
    req.user.id, req.params.id, type
  );
  const stats = await dbGet(db,
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'like' THEN 1 ELSE 0 END), 0) as likes,
       COALESCE(SUM(CASE WHEN type = 'dislike' THEN 1 ELSE 0 END), 0) as dislikes
     FROM video_likes WHERE video_id = ?`,
    req.params.id
  );
  res.json({ likes: stats.likes, dislikes: stats.dislikes, userLike: type });
});

app.delete("/api/videos/:id/like", authMiddleware, async (req, res) => {
  await dbRun(db, "DELETE FROM video_likes WHERE user_id = ? AND video_id = ?", req.user.id, req.params.id);
  const stats = await dbGet(db,
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'like' THEN 1 ELSE 0 END), 0) as likes,
       COALESCE(SUM(CASE WHEN type = 'dislike' THEN 1 ELSE 0 END), 0) as dislikes
     FROM video_likes WHERE video_id = ?`,
    req.params.id
  );
  res.json({ likes: stats.likes, dislikes: stats.dislikes, userLike: null });
});

app.patch("/api/users/me", authMiddleware, async (req, res) => {
  const { name, password, bio, pronouns, avatar_url } = req.body;
  if (name) {
    await dbRun(db, "UPDATE users SET name = ? WHERE id = ?", name, req.user.id);
  }
  if (password) {
    const hash = await bcrypt.hash(password, 12);
    await dbRun(db, "UPDATE users SET password_hash = ? WHERE id = ?", hash, req.user.id);
  }
  if (bio !== undefined) {
    await dbRun(db, "UPDATE users SET bio = ? WHERE id = ?", bio, req.user.id);
  }
  if (pronouns !== undefined) {
    await dbRun(db, "UPDATE users SET pronouns = ? WHERE id = ?", pronouns, req.user.id);
  }
  if (avatar_url) {
    await dbRun(db, "UPDATE users SET avatar_url = ? WHERE id = ?", avatar_url, req.user.id);
  }
  const user = await dbGet(db, "SELECT id, name, email, bio, pronouns, avatar_url FROM users WHERE id = ?", req.user.id);
  res.json(user);
});

// Upload user avatar
app.post("/api/users/me/avatar", authMiddleware, upload.single("avatar"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo obrigatório" });
  const ext = path.extname(req.file.originalname);
  const filename = `avatar_${req.user.id}${ext}`;
  const dest = path.join(__dirname, "uploads", "avatars", filename);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(req.file.path, dest);
  const avatarUrl = `/static/avatars/${filename}`;
  await dbRun(db, "UPDATE users SET avatar_url = ? WHERE id = ?", avatarUrl, req.user.id);
  res.json({ avatar_url: avatarUrl });
});

// Upload channel avatar/banner
app.post("/api/channels/:id/avatar", authMiddleware, upload.single("avatar"), async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  if (!req.file) return res.status(400).json({ error: "Arquivo obrigatório" });
  const ext = path.extname(req.file.originalname);
  const filename = `channel_${req.params.id}_avatar${ext}`;
  const dest = path.join(__dirname, "uploads", "channels", filename);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(req.file.path, dest);
  const avatarUrl = `/static/channels/${filename}`;
  await dbRun(db, "UPDATE channels SET avatar_url = ? WHERE id = ?", avatarUrl, req.params.id);
  res.json({ avatar_url: avatarUrl });
});

app.post("/api/channels/:id/banner", authMiddleware, upload.single("banner"), async (req, res) => {
  const channel = await dbGet(db, "SELECT id FROM channels WHERE id = ? AND owner_id = ?", req.params.id, req.user.id);
  if (!channel) return res.status(404).json({ error: "Canal não encontrado" });
  if (!req.file) return res.status(400).json({ error: "Arquivo obrigatório" });
  const ext = path.extname(req.file.originalname);
  const filename = `channel_${req.params.id}_banner${ext}`;
  const dest = path.join(__dirname, "uploads", "channels", filename);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(req.file.path, dest);
  const bannerUrl = `/static/channels/${filename}`;
  await dbRun(db, "UPDATE channels SET banner_url = ? WHERE id = ?", bannerUrl, req.params.id);
  res.json({ banner_url: bannerUrl });
});

// Page routes - always render without user, let client handle auth
function getUserFromReq(req) {
  // For API calls, check header, query, or cookie
  let token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) token = req.query._token;
  if (!token) token = req.cookies?.token;
  console.log("getUserFromReq - token:", token?.substring(0, 20) + "...");
  if (!token) return null;
  try {
    const user = jwt.verify(token, JWT_SECRET);
    console.log("getUserFromReq - verified user:", user?.name);
    return user;
  } catch (err) {
    console.log("getUserFromReq - error:", err.message);
    return null;
  }
}

// Home page
app.get("/", async (req, res) => {
  const user = getUserFromReq(req);
  const q = req.query.q?.trim();
  let videos;
  
  if (q) {
    const like = `%${q}%`;
    const rows = await dbAll(db,
      `SELECT v.id, c.name as channel, v.title, v.description, v.owner_id, v.views,
              (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       LEFT JOIN video_tags vt ON vt.video_id = v.id
       LEFT JOIN tags t ON t.id = vt.tag_id
       WHERE v.title LIKE ? OR v.description LIKE ? OR t.name LIKE ?
       GROUP BY v.id
       ORDER BY v.created_at DESC`, like, like, like);
    videos = rows.map(v => ({
      id: v.id,
      channel: v.channel,
      title: v.title,
      description: v.description,
      ownerId: v.owner_id,
      views: v.views,
      thumbnailUrl: `/static/${v.id}/thumbnail.jpg`,
      type: 'video'
    }));
  } else {
    const rows = await dbAll(db,
      `SELECT v.id, c.name as channel, v.title, v.description, v.owner_id, v.views,
              (SELECT playlist_path FROM video_resolutions WHERE video_id = v.id AND label = '1080p' LIMIT 1) AS playlist1080
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       ORDER BY v.created_at DESC`);
    videos = rows.map(v => ({
      id: v.id,
      channel: v.channel,
      title: v.title,
      description: v.description,
      ownerId: v.owner_id,
      views: v.views,
      thumbnailUrl: `/static/${v.id}/thumbnail.jpg`,
      type: 'video'
    }));
  }

  const lives = await dbAll(db,
    `SELECT l.id, l.title, l.stream_key, l.flv_id, l.status, l.scheduled_at, c.id as channel_id, c.name as channel, c.avatar_url as channel_avatar
     FROM live_streams l
     JOIN channels c ON c.id = l.channel_id
     WHERE l.status IN ('live','waiting','delayed','scheduled','ready')
     ORDER BY CASE l.status WHEN 'live' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END, l.scheduled_at ASC`);
  const livesFormatted = lives.map(l => ({
    id: l.id,
    channelId: l.channel_id,
    title: l.title,
    channel: l.channel,
    channelAvatar: l.channel_avatar,
    streamKey: l.stream_key,
    status: l.status,
    scheduledAt: l.scheduled_at,
    type: 'live'
  }));

  const allContent = [...livesFormatted, ...videos];
  
  res.render("home", { videos: allContent, user, searchQuery: q });
});

// Auth page
app.get("/auth", (req, res) => {
  res.render("auth", { user: null });
});

// Video detail page
app.get("/video/:id", async (req, res) => {
  const user = getUserFromReq(req);
  
  await dbRun(db, "UPDATE videos SET views = views + 1 WHERE id = ?", req.params.id);
  
  let userId = null;
  if (user) {
    userId = user.id;
    try {
      await dbRun(db, "INSERT OR IGNORE INTO view_history (user_id, video_id) VALUES (?,?)", user.id, req.params.id);
    } catch (_) {}
  }
  
  const video = await dbGet(db, `
    SELECT v.*, c.name as channel_name, c.avatar_url as channel_avatar_url
    FROM videos v
    JOIN channels c ON c.id = v.channel_id
    WHERE v.id = ?`, req.params.id);
  
  if (!video) return res.status(404).send("Vídeo não encontrado");
  
  const resolutions = await dbAll(db,
    "SELECT label, playlist_path FROM video_resolutions WHERE video_id = ?",
    video.id
  );
  
  const tags = await dbAll(db,
    `SELECT t.name FROM tags t
     JOIN video_tags vt ON vt.tag_id = t.id
     WHERE vt.video_id = ?`,
    video.id
  );
  
  const likeStats = await dbGet(db,
    `SELECT
       COALESCE(SUM(CASE WHEN type = 'like' THEN 1 ELSE 0 END), 0) as likes,
       COALESCE(SUM(CASE WHEN type = 'dislike' THEN 1 ELSE 0 END), 0) as dislikes
     FROM video_likes WHERE video_id = ?`,
    video.id
  );
  
  let userLike = null;
  if (userId) {
    const like = await dbGet(db, "SELECT type FROM video_likes WHERE user_id = ? AND video_id = ?", userId, video.id);
    userLike = like?.type || null;
  }
  
  const commentCount = await dbGet(db, "SELECT COUNT(*) as cnt FROM comments WHERE video_id = ?", video.id);
  
  const resUrls = resolutions.map(r => ({
    label: r.label,
    url: `/static/${path.relative(UPLOAD_ROOT, r.playlist_path).replace(/\\/g, "/")}`,
  }));
  
  res.render("video", {
    video: {
      id: video.id,
      channel: video.channel_name,
      channelId: video.channel_id,
      channelAvatarUrl: video.channel_avatar_url,
      ownerId: video.owner_id,
      title: video.title,
      description: video.description,
      views: video.views,
      createdAt: video.created_at,
      tags: tags.map(t => t.name),
      likes: likeStats.likes,
      dislikes: likeStats.dislikes,
      userLike,
      commentCount: commentCount.cnt,
      resolutions: resUrls,
    },
    user
  });
});

// Channel page
app.get("/channel/:id", async (req, res) => {
  const user = getUserFromReq(req);
  
  const channel = await dbGet(db, 
    "SELECT c.*, (SELECT COUNT(*) FROM videos WHERE channel_id = c.id) as video_count FROM channels c WHERE c.id = ?", 
    req.params.id);
  
  if (!channel) return res.status(404).send("Canal não encontrado");
  
  const videos = await dbAll(db,
    `SELECT v.id, v.title, v.views, v.created_at FROM videos v WHERE v.channel_id = ? ORDER BY v.created_at DESC`,
    req.params.id);
  
  const live = await dbGet(db,
    `SELECT l.*, c.stream_key FROM live_streams l 
     JOIN channels c ON c.id = l.channel_id 
     WHERE l.channel_id = ? AND l.status IN ('live','waiting','scheduled','ready','delayed')
     ORDER BY CASE l.status WHEN 'live' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 WHEN 'ready' THEN 3 ELSE 4 END, l.scheduled_at ASC`,
    req.params.id);
  
  const isOwner = user && user.id === channel.owner_id;
  
  res.render("channel", { channel, videos, user, isOwner, live });
});

// User profile page
app.get("/user/:id", async (req, res) => {
  const user = getUserFromReq(req);
  const profileUser = await dbGet(db, "SELECT id, name, bio, pronouns, avatar_url FROM users WHERE id = ?", req.params.id);
  
  if (!profileUser) return res.status(404).send("Usuário não encontrado");
  
  const channels = await dbAll(db,
    "SELECT c.*, (SELECT COUNT(*) FROM videos WHERE channel_id = c.id) as video_count FROM channels c WHERE c.owner_id = ?",
    req.params.id);
  
  // Check if current user owns this profile
  const isOwner = user && user.id === profileUser.id;
  res.render("user", { profileUser, channels, user: isOwner ? user : null, isOwner });
});

// Live page
app.get("/live", async (req, res) => {
  res.render("live", { user: getUserFromReq(req), live: null });
});

app.get("/live/:channelId", async (req, res) => {
  const user = getUserFromReq(req);
  const { channelId } = req.params;
  
  let live = await dbGet(db, 
    `SELECT l.*, c.name as channel_name, c.avatar_url as channel_avatar, c.stream_key, c.pronouns as channel_pronouns
     FROM live_streams l 
     JOIN channels c ON l.channel_id = c.id 
     WHERE l.channel_id = ? AND l.status IN ('live','waiting','scheduled','ready','delayed')
     ORDER BY CASE l.status WHEN 'live' THEN 0 WHEN 'waiting' THEN 1 WHEN 'scheduled' THEN 2 ELSE 3 END, l.scheduled_at ASC`,
    channelId);
  
  if (!live) {
    live = await dbGet(db, 
      `SELECT l.*, c.name as channel_name, c.avatar_url as channel_avatar, c.stream_key, c.pronouns as channel_pronouns
       FROM live_streams l 
       JOIN channels c ON l.channel_id = c.id 
       WHERE l.channel_id = ? AND l.status = 'ended'
       ORDER BY l.ended_at DESC`,
      channelId);
  }
  
  if (!live) {
    return res.redirect("/live");
  }
  
  res.render("live", { user, live });
});

// Creator studio page
app.get("/creator", async (req, res) => {
  const user = getUserFromReq(req);
  
  // If no user, render page without data (client will handle auth)
  if (!user) {
    return res.render("creator", { channels: [], videos: [], stats: { total_videos: 0, total_views: 0, total_comments: 0 }, user: null, API: "http://localhost:4000/api" });
  }
  
  const channels = await dbAll(db, 
    "SELECT id, name, description, pronouns, banner_url, avatar_url FROM channels WHERE owner_id = ? ORDER BY created_at DESC", 
    user.id);
  
  let videos = [];
  let stats = { total_videos: 0, total_views: 0, total_comments: 0 };
  
  if (channels.length > 0) {
    videos = await dbAll(db,
      `SELECT v.id, v.title, v.views, v.created_at, c.name as channel_name,
              (SELECT COUNT(*) FROM comments WHERE video_id = v.id) as comment_count
       FROM videos v
       JOIN channels c ON c.id = v.channel_id
       WHERE v.owner_id = ?
       ORDER BY v.created_at DESC`,
      user.id);
    
    stats = await dbGet(db,
      `SELECT 
        COUNT(DISTINCT v.id) as total_videos,
        COALESCE(SUM(v.views), 0) as total_views,
        COUNT(DISTINCT com.id) as total_comments
      FROM videos v
      LEFT JOIN comments com ON com.video_id = v.id
      WHERE v.owner_id = ?`,
      user.id);
  }
  
  res.render("creator", { channels, videos, stats, user, API: "http://localhost:4000/api" });
});

// Socket.IO setup
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const liveChats = {};

io.on("connection", (socket) => {
  console.log("[SOCKET] Cliente conectado:", socket.id);
  
  socket.on("join-live", async (channelId) => {
    socket.join(`live-${channelId}`);
    // Load from DB if in-memory cache is empty (server restart)
    if (!liveChats[channelId] || liveChats[channelId].length === 0) {
      const rows = await dbAll(db,
        "SELECT id, author, text, created_at FROM live_chat_messages WHERE channel_id = ? ORDER BY created_at ASC",
        channelId
      );
      liveChats[channelId] = rows.map(r => ({
        id: r.id,
        username: r.author,
        author: r.author,
        message: r.text,
        text: r.text,
        timestamp: r.created_at
      }));
    }
    socket.emit("chat-history", liveChats[channelId].slice(-100));
    console.log(`[SOCKET] Cliente ${socket.id} entrou no chat da live ${channelId}`);
  });
  
  socket.on("send-message", async (data) => {
    const { channelId, username, message, avatar } = data;
    const msgData = {
      id: uuidv4(),
      username,
      message,
      avatar,
      timestamp: new Date().toISOString()
    };
    // Persist message
    await dbRun(db,
      "INSERT INTO live_chat_messages (id, channel_id, author, text) VALUES (?,?,?,?)",
      msgData.id, channelId, username, message
    );
    // Keep in‑memory cache (optional)
    if (!liveChats[channelId]) liveChats[channelId] = [];
    liveChats[channelId].push(msgData);
    if (liveChats[channelId].length > 200) liveChats[channelId].shift();
    io.to(`live-${channelId}`).emit("new-message", msgData);
  });
  
  socket.on("disconnect", () => {
    console.log("[SOCKET] Cliente desconectado:", socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[SERVER] Servidor rodando em http://localhost:${PORT}`);
  console.log(`[SERVER] FLV disponível em http://localhost:8000/live/{flvId}.flv`);
});

// Live state checker: runs every 15s
// - 'ready' → 'live' when scheduled time arrives
// - 'scheduled' → 'delayed' when time passes without streamer
// - 'delayed'/'ready' → 'cancelled' if >10min overdue
setInterval(async () => {
  try {
    const lives = await dbAll(db,
      "SELECT * FROM live_streams WHERE status IN ('scheduled','ready','waiting','delayed') AND scheduled_at IS NOT NULL"
    );
    const now = new Date();
    for (const live of lives) {
      const scheduled = new Date(live.scheduled_at.replace(' ', 'T') + 'Z');
      const diffMin = (now - scheduled) / 60000;
      if (live.status === 'ready' && diffMin >= 0) {
        // Streamer is ready, time has come — go live!
        console.log(`[AUTO] Live ${live.id} agendada → LIVE`);
        await dbRun(db, "UPDATE live_streams SET status = 'live', started_at = CURRENT_TIMESTAMP WHERE id = ?", live.id);
      } else if (live.status === 'scheduled' && diffMin > 0) {
        // Time passed but streamer hasn't connected
        console.log(`[AUTO] Live ${live.id} atrasada (scheduled → delayed)`);
        await dbRun(db, "UPDATE live_streams SET status = 'delayed' WHERE id = ?", live.id);
      } else if ((live.status === 'delayed' || live.status === 'ready') && diffMin > 10) {
        // Too late — cancel
        console.log(`[AUTO] Cancelando live: ${live.id} (${Math.floor(diffMin)} min atraso)`);
        await dbRun(db, "UPDATE live_streams SET status = 'cancelled', ended_at = datetime('now') WHERE id = ?", live.id);
      }
    }
  } catch (e) { /* silent */ }
}, 15000);
