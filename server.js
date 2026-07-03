import express from 'express';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { Database } from './db.js';

const app = express();
const PORT = process.env.NODE_ENV === 'production' ? (process.env.PORT || 3000) : 3000;

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.json());

const IS_VERCEL = !!process.env.VERCEL;
// NOTE: /tmp on Vercel is ephemeral (wiped on cold starts / new instances / redeploys).
// It is only used here as a scratch area for uploaded images within a single instance's
// lifetime. The actual data (movies, episodes, ads, settings) now lives in a real
// persistent database (Turso/libSQL) configured via TURSO_DATABASE_URL, so it no longer
// disappears. See README for details and the image-upload caveat.
const PHOTOS_DIR = IS_VERCEL ? '/tmp/photos' : path.join(process.cwd(), 'photos');
const MOVIE_DIR = IS_VERCEL ? '/tmp/movie' : path.join(process.cwd(), 'movie');
const DB_PATH = path.join(process.cwd(), 'db.json'); // used only as local-dev sqlite filename base / seed source

// Ensure directories exist
try {
  for (const d of [PHOTOS_DIR, MOVIE_DIR]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
} catch (e) {
  console.error("Error creating directories:", e);
}

if (IS_VERCEL && !process.env.TURSO_DATABASE_URL) {
  console.error(
    '[XATO] TURSO_DATABASE_URL topilmadi! Vercel muhitida bazangiz doimiy saqlanishi uchun ' +
    'TURSO_DATABASE_URL va TURSO_AUTH_TOKEN environment variable-larini sozlang, aks holda ' +
    'ma\'lumotlar saqlanmaydi.'
  );
}

// Initialize persistent database (Turso/libSQL in prod, local SQLite file in dev)
const db = new Database(DB_PATH);

// 1. Initialize Tables
await db.exec(`
  CREATE TABLE IF NOT EXISTS movies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      genre TEXT,
      year TEXT,
      quality TEXT,
      dood_url TEXT,
      video_type TEXT,
      poster TEXT,
      poster_url TEXT,
      folder_name TEXT,
      views INTEGER DEFAULT 0
  )
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
      epId INTEGER PRIMARY KEY AUTOINCREMENT,
      movieId INTEGER,
      episode_num INTEGER,
      title TEXT,
      video_url TEXT,
      video_type TEXT,
      views INTEGER DEFAULT 0,
      FOREIGN KEY(movieId) REFERENCES movies(id) ON DELETE CASCADE
  )
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      url TEXT,
      placement TEXT,
      duration INTEGER DEFAULT 5,
      skip_enabled INTEGER DEFAULT 1,
      image TEXT,
      image_url TEXT,
      active INTEGER DEFAULT 1
  )
`);

await db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
  )
`);

// 2. Database Migrations (Views field for backward compatibility)
try {
  await db.exec("ALTER TABLE movies ADD COLUMN views INTEGER DEFAULT 0");
} catch (e) {}

try {
  await db.exec("ALTER TABLE episodes ADD COLUMN views INTEGER DEFAULT 0");
} catch (e) {}

// 3. Insert Default Settings
try {
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('telegram_url', 'https://t.me/afilmsuz')").run();
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('youtube_url', 'https://www.youtube.com/@afilmsuz')").run();
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('instagram_url', 'https://www.instagram.com/afilmsuz')").run();
} catch (e) {}

// 4. One-time seed: if the movies table is empty and a local db.json seed file exists,
// import its contents so existing sample/test data isn't lost when switching to the
// real database for the first time. This only ever runs once (table stays non-empty after).
try {
  const countRows = await db.prepare("SELECT COUNT(*) as c FROM movies").all();
  const isEmpty = !countRows.length || Number(countRows[0].c) === 0;
  if (isEmpty && fs.existsSync(DB_PATH)) {
    const seed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    for (const m of seed.movies || []) {
      await db.prepare(`
        INSERT INTO movies (id, title, description, genre, year, quality, dood_url, video_type, poster, poster_url, folder_name, views)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(m.id, m.title || '', m.description || '', m.genre || '', m.year || '', m.quality || 'Full HD',
             m.dood_url || '', m.video_type || 'mover', m.poster || null, m.poster_url || '', m.folder_name || '', m.views || 0);
    }
    for (const e of seed.episodes || []) {
      await db.prepare(`
        INSERT INTO episodes (epId, movieId, episode_num, title, video_url, video_type, views)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(e.epId, e.movieId, e.episode_num, e.title || '', e.video_url || '', e.video_type || 'mover', e.views || 0);
    }
    for (const a of seed.ads || []) {
      await db.prepare(`
        INSERT INTO ads (id, title, url, placement, duration, skip_enabled, image, image_url, active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.title || '', a.url || '', a.placement || 'sidebar', a.duration || 5, a.skip_enabled ? 1 : 0, a.image || null, a.image_url || '', a.active ? 1 : 0);
    }
    for (const s of seed.settings || []) {
      await db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(s.key, s.value);
    }
    console.log('Seeded database from db.json (first run).');
  }
} catch (e) {
  console.error('Seeding from db.json failed (non-fatal):', e);
}


// Helper functions
function safeFolderName(title, movieId) {
  let s = title.trim().toLowerCase();
  s = s.replace(/o'/g, 'o')
       .replace(/g'/g, 'g')
       .replace(/o‘/g, 'o')
       .replace(/g‘/g, 'g');
  s = s.replace(/sh/g, 'sh')
       .replace(/ch/g, 'ch');
  s = s.replace(/[^a-z0-9\s_-]/g, '');
  s = s.replace(/[\s_-]+/g, '-');
  s = s.trim('-');
  if (!s) {
    s = "kino";
  }
  return `${s}-${movieId}`;
}

function createAnimePlayerPage(movieId, folderName) {
  try {
    const subDir = path.join(MOVIE_DIR, folderName);
    if (!fs.existsSync(subDir)) {
      fs.mkdirSync(subDir, { recursive: true });
    }
    const masterPath = path.join(process.cwd(), 'player.html');
    if (fs.existsSync(masterPath)) {
      let html = fs.readFileSync(masterPath, 'utf8');
      html = html.replace(/MOVI_ID_PLACEHOLDER/g, String(movieId));
      const playerPath = path.join(subDir, 'player.html');
      fs.writeFileSync(playerPath, html, 'utf8');
    }
  } catch (err) {
    console.error("Error creating anime player page:", err);
  }
}

function deleteAnimePlayerPage(folderName) {
  try {
    if (!folderName) return;
    const subDir = path.join(MOVIE_DIR, folderName);
    if (fs.existsSync(subDir)) {
      fs.rmSync(subDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.error("Error deleting anime player page:", err);
  }
}

function safeFilename(filename) {
  const ext = path.extname(filename);
  let name = path.basename(filename, ext);
  name = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${name}${ext.toLowerCase()}`;
}

// Multer Setup for File Uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, PHOTOS_DIR);
  },
  filename: function (req, file, cb) {
    const orig = safeFilename(file.originalname);
    const ext = path.extname(orig);
    const base = path.basename(orig, ext);
    let destName = orig;
    let counter = 1;
    while (fs.existsSync(path.join(PHOTOS_DIR, destName))) {
      destName = `${base}_${counter}${ext}`;
      counter++;
    }
    cb(null, destName);
  }
});
const upload = multer({ storage: storage });

// Authentication middleware
function checkAuth(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.split('Bearer ')[1].trim();
  return token === 'afilms_master_token_2026';
}

function requireAuth(req, res, next) {
  if (!checkAuth(req)) {
    return res.status(401).json({ error: 'Avtorizatsiya xatosi' });
  }
  next();
}


// --- API ROUTES ---

// 1. GET PHOTOS GALLERY LIST
app.get('/api/photos/list', async (req, res) => {
  try {
    const photos = [];
    if (fs.existsSync(PHOTOS_DIR)) {
      const files = fs.readdirSync(PHOTOS_DIR);
      for (const f of files) {
        if (/\.(png|jpg|jpeg|webp|gif)$/i.test(f)) {
          photos.push({
            name: f,
            url: `/api/photos/${f}`
          });
        }
      }
    }
    res.json(photos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve photos statically
app.use('/api/photos', express.static(PHOTOS_DIR, { maxAge: 86400000 }));

// 2. GET SETTINGS
app.get('/api/settings', async (req, res) => {
  try {
    const rows = await db.prepare("SELECT key, value FROM settings").all();
    const settings = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. SAVE SETTINGS
app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const data = req.body;
    const stmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    for (const key of ['telegram_url', 'youtube_url', 'instagram_url']) {
      if (key in data) {
        await stmt.run(key, String(data[key]));
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. GET MOVIES LIST
app.get('/api/movies', async (req, res) => {
  try {
    const movies = await db.prepare("SELECT * FROM movies ORDER BY id DESC").all();
    for (const m of movies) {
      m.episodes = await db.prepare("SELECT * FROM episodes WHERE movieId = ? ORDER BY episode_num ASC").all(m.id);
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. GET SINGLE MOVIE
app.get('/api/movies/:id', async (req, res) => {
  try {
    const movieId = parseInt(req.params.id, 10);
    if (isNaN(movieId)) {
      return res.status(400).json({ error: 'ID xato' });
    }
    const movies = await db.prepare("SELECT * FROM movies WHERE id = ?").all(movieId);
    if (movies.length > 0) {
      const movie = { ...movies[0] };
      movie.episodes = await db.prepare("SELECT * FROM episodes WHERE movieId = ? ORDER BY episode_num ASC").all(movieId);
      res.json(movie);
    } else {
      res.status(404).json({ error: 'Kino topilmadi' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. GET ADS
app.get('/api/ads', async (req, res) => {
  try {
    const ads = await db.prepare("SELECT * FROM ads ORDER BY id DESC").all();
    for (const ad of ads) {
      ad.skip_enabled = !!ad.skip_enabled;
      ad.active = !!ad.active;
    }
    res.json(ads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. GET STATS (Admin only)
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const top_movies = await db.prepare("SELECT id, title, views, genre FROM movies ORDER BY views DESC LIMIT 50").all();
    const top_episodes = await db.prepare(`
      SELECT e.epId, e.episode_num, e.title as ep_title, e.views, m.title as movie_title
      FROM episodes e
      JOIN movies m ON e.movieId = m.id
      ORDER BY e.views DESC LIMIT 50
    `).all();
    res.json({ top_movies, top_episodes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. GET VIDEO STREAM DECIPHER
app.get('/api/stream/:token', async (req, res) => {
  try {
    const token = req.params.token;
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const parts = decoded.split(':');
    const movieId = parseInt(parts[0], 10);
    const epId = parts[1] ? parseInt(parts[1], 10) : null;

    if (epId) {
      const rows = await db.prepare("SELECT video_url, video_type FROM episodes WHERE epId = ?").all(epId);
      if (rows.length > 0) {
        res.json({ url: rows[0].video_url, video_type: rows[0].video_type });
      } else {
        res.status(404).json({ error: 'Qism topilmadi' });
      }
    } else {
      const rows = await db.prepare("SELECT dood_url, video_type FROM movies WHERE id = ?").all(movieId);
      if (rows.length > 0) {
        res.json({ url: rows[0].dood_url, video_type: rows[0].video_type });
      } else {
        res.status(404).json({ error: 'Video topilmadi' });
      }
    }
  } catch (err) {
    res.status(400).json({ error: 'Token xato yoki muddati tugagan' });
  }
});

// 9. LOGIN API
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (username === 'admin' && (password === 'admin' || password === 'admin123')) {
      res.json({
        success: true,
        token: 'afilms_master_token_2026'
      });
    } else {
      res.status(401).json({ success: false, error: 'Login yoki parol xato!' });
    }
  } catch (err) {
    res.status(400).json({ success: false, error: 'Xato format' });
  }
});

// 10. ADD MOVIE
app.post('/api/movies', requireAuth, upload.single('poster'), async (req, res) => {
  try {
    const { title, description, genre, year, quality = 'Full HD', dood_url, video_type = 'mover', poster_url, existing_poster } = req.body;
    
    let poster_name = null;
    if (poster_url) {
      poster_name = null;
    } else if (req.file) {
      poster_name = req.file.filename;
    } else if (existing_poster) {
      poster_name = existing_poster;
    }

    const stmt = db.prepare(`
      INSERT INTO movies (title, description, genre, year, quality, dood_url, video_type, poster, poster_url, folder_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = await stmt.run(
      title || '',
      description || '',
      genre || '',
      year || '',
      quality,
      dood_url || '',
      video_type,
      poster_name,
      poster_url || '',
      ''
    );
    const movieId = result.lastInsertRowid;

    const folderName = safeFolderName(title || '', movieId);
    await db.prepare("UPDATE movies SET folder_name = ? WHERE id = ?").run(folderName, movieId);

    createAnimePlayerPage(movieId, folderName);

    res.json({ success: true, id: movieId, folder_name: folderName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 11. ADD EPISODE
app.post('/api/movies/:movieId/episodes', requireAuth, async (req, res) => {
  try {
    const movieId = parseInt(req.params.movieId, 10);
    const { episode_num, title, video_url, video_type = 'mover' } = req.body;

    const stmt = db.prepare(`
      INSERT INTO episodes (movieId, episode_num, title, video_url, video_type)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = await stmt.run(movieId, episode_num, title || '', video_url || '', video_type);
    const epId = result.lastInsertRowid;

    const epRows = await db.prepare("SELECT * FROM episodes WHERE epId = ?").all(epId);
    res.json({ success: true, episode: epRows[0] });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 12. GENERATE TOKEN & INCREMENT VIEWS
app.post('/api/token/:id', async (req, res) => {
  try {
    const movieId = parseInt(req.params.id, 10);
    const epIdStr = req.query.epId;
    const epId = epIdStr ? parseInt(epIdStr, 10) : null;

    try {
      if (epId) {
        await db.prepare("UPDATE episodes SET views = views + 1 WHERE epId = ?").run(epId);
      } else {
        await db.prepare("UPDATE movies SET views = views + 1 WHERE id = ?").run(movieId);
      }
    } catch (db_err) {
      console.error("Error updating views:", db_err);
    }

    const payload = `${movieId}:${epId || ''}`;
    const token = Buffer.from(payload).toString('base64');
    res.json({ token });
  } catch (err) {
    res.status(400).json({ error: 'Token yaratilmadi' });
  }
});

// 13. ADD AD
app.post('/api/ads', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const { title, url, placement = 'sidebar', duration = 5, skip_enabled = 'true', image_url, existing_image } = req.body;

    const skipEnabledVal = skip_enabled === 'true' || skip_enabled === true ? 1 : 0;
    let imageName = null;
    if (image_url) {
      imageName = null;
    } else if (req.file) {
      imageName = req.file.filename;
    } else if (existing_image) {
      imageName = existing_image;
    }

    const stmt = db.prepare(`
      INSERT INTO ads (title, url, placement, duration, skip_enabled, image, image_url, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `);
    const result = await stmt.run(title || '', url || '', placement, parseInt(duration, 10), skipEnabledVal, imageName, image_url || '');
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 14. UPDATE EPISODE
app.put('/api/movies/:movieId/episodes/:epId', requireAuth, async (req, res) => {
  try {
    const movieId = parseInt(req.params.movieId, 10);
    const epId = parseInt(req.params.epId, 10);
    const { episode_num, title, video_url, video_type = 'mover' } = req.body;

    await db.prepare(`
      UPDATE episodes
      SET episode_num = ?, title = ?, video_url = ?, video_type = ?
      WHERE epId = ? AND movieId = ?
    `).run(episode_num, title || '', video_url || '', video_type, epId, movieId);

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 15. UPDATE MOVIE
app.put('/api/movies/:id', requireAuth, upload.single('poster'), async (req, res) => {
  try {
    const movieId = parseInt(req.params.id, 10);
    const { title, description, genre, year, quality = 'Full HD', dood_url, video_type = 'mover', poster_url, existing_poster } = req.body;

    const currRows = await db.prepare("SELECT poster, folder_name FROM movies WHERE id = ?").all(movieId);
    let poster_name = currRows.length > 0 ? currRows[0].poster : null;
    const old_folder_name = currRows.length > 0 ? currRows[0].folder_name : null;

    if (poster_url) {
      poster_name = null;
    } else if (req.file) {
      poster_name = req.file.filename;
    } else if (existing_poster) {
      poster_name = existing_poster;
    }

    const folderName = safeFolderName(title || '', movieId);
    if (old_folder_name && old_folder_name !== folderName) {
      deleteAnimePlayerPage(old_folder_name);
    }

    await db.prepare(`
      UPDATE movies
      SET title = ?, description = ?, genre = ?, year = ?, quality = ?, dood_url = ?, video_type = ?, poster = ?, poster_url = ?, folder_name = ?
      WHERE id = ?
    `).run(title || '', description || '', genre || '', year || '', quality, dood_url || '', video_type, poster_name, poster_url || '', folderName, movieId);

    createAnimePlayerPage(movieId, folderName);

    res.json({ success: true, folder_name: folderName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 16. UPDATE AD
app.put('/api/ads/:id', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const adId = parseInt(req.params.id, 10);
    const { title, url, placement = 'sidebar', duration = 5, skip_enabled = 'true', image_url, existing_image } = req.body;

    const skipEnabledVal = skip_enabled === 'true' || skip_enabled === true ? 1 : 0;

    const currRows = await db.prepare("SELECT image FROM ads WHERE id = ?").all(adId);
    let imageName = currRows.length > 0 ? currRows[0].image : null;

    if (image_url) {
      imageName = null;
    } else if (req.file) {
      imageName = req.file.filename;
    } else if (existing_image) {
      imageName = existing_image;
    }

    await db.prepare(`
      UPDATE ads
      SET title = ?, url = ?, placement = ?, duration = ?, skip_enabled = ?, image = ?, image_url = ?
      WHERE id = ?
    `).run(title || '', url || '', placement, parseInt(duration, 10), skipEnabledVal, imageName, image_url || '', adId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 17. DELETE EPISODE
app.delete('/api/movies/:movieId/episodes/:epId', requireAuth, async (req, res) => {
  try {
    const movieId = parseInt(req.params.movieId, 10);
    const epId = parseInt(req.params.epId, 10);

    await db.prepare("DELETE FROM episodes WHERE epId = ? AND movieId = ?").run(epId, movieId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 18. DELETE MOVIE
app.delete('/api/movies/:id', requireAuth, async (req, res) => {
  try {
    const movieId = parseInt(req.params.id, 10);

    const rows = await db.prepare("SELECT folder_name FROM movies WHERE id = ?").all(movieId);
    const folderName = rows.length > 0 ? rows[0].folder_name : null;

    await db.prepare("DELETE FROM movies WHERE id = ?").run(movieId);
    await db.prepare("DELETE FROM episodes WHERE movieId = ?").run(movieId);

    if (folderName) {
      deleteAnimePlayerPage(folderName);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 19. DELETE AD
app.delete('/api/ads/:id', requireAuth, async (req, res) => {
  try {
    const adId = parseInt(req.params.id, 10);
    await db.prepare("DELETE FROM ads WHERE id = ?").run(adId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// --- STATIC AND TEMPLATE ROUTES ---

// Intercept dynamics for player.html
app.get('/movie/*', (req, res, next) => {
  const reqPath = req.path; // e.g., /movie/slug-5/player.html
  const match = reqPath.match(/-(\d+)\/player\.html$/);
  if (match) {
    const movieId = match[1];
    const masterPath = path.resolve(process.cwd(), 'player.html');
    if (fs.existsSync(masterPath)) {
      let html = fs.readFileSync(masterPath, 'utf8');
      html = html.replace(/MOVI_ID_PLACEHOLDER/g, String(movieId));
      
      const folderMatch = reqPath.match(/\/movie\/([^/]+)\/player\.html/);
      if (folderMatch) {
        const folderName = folderMatch[1];
        const subDir = path.resolve(MOVIE_DIR, folderName);
        if (!fs.existsSync(subDir)) {
          try { fs.mkdirSync(subDir, { recursive: true }); } catch (_) {}
        }
        const playerFilePath = path.join(subDir, 'player.html');
        try { fs.writeFileSync(playerFilePath, html, 'utf8'); } catch (_) {}
      }

      return res.header('Content-Type', 'text/html; charset=utf-8').send(html);
    }
  }
  next();
});

// Serve assets statically
app.use('/assets', express.static(path.join(process.cwd(), 'assets')));
app.use('/movie', express.static(MOVIE_DIR));

app.get('/', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'index.html'));
});

app.get('/index.html', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'index.html'));
});

app.get('/player.html', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'player.html'));
});

app.get('/admin.html', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'admin.html'));
});

app.get('/admin', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'admin.html'));
});

app.get('/admin/index.html', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'admin.html'));
});

app.get('/admin/', async (req, res) => {
  res.sendFile(path.resolve(process.cwd(), 'admin.html'));
});

// 404 handler
app.use(async (req, res) => {
  res.status(404).send("Sahifa topilmadi");
});

if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Node Express server listening on port ${PORT}...`);
  });
}

export default app;
