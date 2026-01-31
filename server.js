const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/vendor', express.static(path.join(ROOT_DIR, 'node_modules')));

function isSafeBase(base) {
  return base && !base.includes('..') && !base.includes('/') && !base.includes('\\');
}

function resolveDir(dirPath) {
  return path.isAbsolute(dirPath) ? dirPath : path.join(ROOT_DIR, dirPath);
}

async function loadConfig() {
  const raw = await fsp.readFile(CONFIG_PATH, 'utf-8');
  const cfg = JSON.parse(raw);
  return {
    sbgn_dir: resolveDir(cfg.sbgn),
    old_png_dir: resolveDir(cfg.old_png),
    new_png_dir: resolveDir(cfg.new_png),
    output_dir: resolveDir(cfg.output),
    max_image_dimension: cfg.max_image_dimension || 1200
  };
}

async function listFilesWithExt(dirPath, ext) {
  const entries = await fsp.readdir(dirPath);
  return entries.filter((name) => name.toLowerCase().endsWith(ext));
}

function basenameWithoutExt(filename) {
  return filename.replace(/\.[^/.]+$/, '');
}

async function listTripletBases(cfg) {
  const [sbgnFiles, oldPngFiles, newPngFiles] = await Promise.all([
    listFilesWithExt(cfg.sbgn_dir, '.sbgn'),
    listFilesWithExt(cfg.old_png_dir, '.png'),
    listFilesWithExt(cfg.new_png_dir, '.png')
  ]);

  const sbgnBases = new Set(sbgnFiles.map(basenameWithoutExt));
  const oldBases = new Set(oldPngFiles.map(basenameWithoutExt));
  const newBases = new Set(newPngFiles.map(basenameWithoutExt));

  const bases = [];
  for (const base of sbgnBases) {
    if (oldBases.has(base) && newBases.has(base)) {
      bases.push(base);
    }
  }

  bases.sort((a, b) => a.localeCompare(b));
  return bases;
}

async function ensureOutputData(cfg, bases) {
  await fsp.mkdir(cfg.output_dir, { recursive: true });
  const outputPath = path.join(cfg.output_dir, 'output.json');

  let data = [];
  if (fs.existsSync(outputPath)) {
    const raw = await fsp.readFile(outputPath, 'utf-8');
    try {
      data = JSON.parse(raw);
    } catch (err) {
      data = [];
    }
  }

  const byName = new Map();
  for (const entry of data) {
    if (entry && entry.filename) {
      byName.set(entry.filename, entry.status ?? null);
    }
  }

  let changed = false;
  for (const base of bases) {
    if (!byName.has(base)) {
      byName.set(base, null);
      changed = true;
    }
  }

  const merged = Array.from(byName.entries())
    .map(([filename, status]) => ({ filename, status }))
    .sort((a, b) => a.filename.localeCompare(b.filename));

  if (!fs.existsSync(outputPath) || changed) {
    await fsp.writeFile(outputPath, JSON.stringify(merged, null, 2));
  }

  return merged;
}

async function updateStatus(cfg, base, status) {
  const outputPath = path.join(cfg.output_dir, 'output.json');
  const raw = await fsp.readFile(outputPath, 'utf-8');
  const data = JSON.parse(raw);
  const entry = data.find((item) => item.filename === base);
  if (entry) {
    entry.status = status;
  }
  await fsp.writeFile(outputPath, JSON.stringify(data, null, 2));
}

app.get('/api/config', async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json({
      sbgn: cfg.sbgn_dir,
      old_png: cfg.old_png_dir,
      new_png: cfg.new_png_dir,
      output: cfg.output_dir,
      max_image_dimension: cfg.max_image_dimension
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load config.' });
  }
});

app.get('/api/files', async (req, res) => {
  try {
    const cfg = await loadConfig();
    const bases = await listTripletBases(cfg);
    const outputData = await ensureOutputData(cfg, bases);
    const statusMap = new Map(outputData.map((item) => [item.filename, item.status ?? null]));

    const files = bases.map((base) => ({
      base,
      status: statusMap.has(base) ? statusMap.get(base) : null
    }));

    res.json({ files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list files.' });
  }
});

app.get('/api/file/:base', async (req, res) => {
  const base = req.params.base;
  if (!isSafeBase(base)) {
    res.status(400).json({ error: 'Invalid base name.' });
    return;
  }

  try {
    const cfg = await loadConfig();
    const commentPath = path.join(cfg.output_dir, `${base}_comment.sbgn`);
    const sbgnPath = path.join(cfg.sbgn_dir, `${base}.sbgn`);
    const xml = fs.existsSync(commentPath)
      ? await fsp.readFile(commentPath, 'utf-8')
      : await fsp.readFile(sbgnPath, 'utf-8');

    const outputPath = path.join(cfg.output_dir, 'output.json');
    let status = null;
    if (fs.existsSync(outputPath)) {
      const raw = await fsp.readFile(outputPath, 'utf-8');
      const data = JSON.parse(raw);
      const entry = data.find((item) => item.filename === base);
      status = entry ? entry.status ?? null : null;
    }

    res.json({ base, xml, status });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load file.' });
  }
});

app.get('/api/image/:type/:base', async (req, res) => {
  const { type, base } = req.params;
  if (!isSafeBase(base)) {
    res.status(400).json({ error: 'Invalid base name.' });
    return;
  }

  try {
    const cfg = await loadConfig();
    const dir = type === 'old' ? cfg.old_png_dir : cfg.new_png_dir;
    const filePath = path.join(dir, `${base}.png`);

    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    const metadata = await sharp(filePath).metadata();
    const maxDim = cfg.max_image_dimension;
    if (metadata.width > maxDim || metadata.height > maxDim) {
      const buffer = await sharp(filePath)
        .resize({
          width: maxDim,
          height: maxDim,
          fit: 'inside',
          withoutEnlargement: true
        })
        .png()
        .toBuffer();
      res.set('Content-Type', 'image/png');
      res.send(buffer);
      return;
    }

    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load image.' });
  }
});

app.post('/api/save', async (req, res) => {
  const { base, xml } = req.body || {};
  if (!isSafeBase(base) || typeof xml !== 'string') {
    res.status(400).json({ error: 'Invalid payload.' });
    return;
  }

  try {
    const cfg = await loadConfig();
    await fsp.mkdir(cfg.output_dir, { recursive: true });
    const outputPath = path.join(cfg.output_dir, `${base}_comment.sbgn`);
    await fsp.writeFile(outputPath, xml, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save file.' });
  }
});

app.post('/api/status', async (req, res) => {
  const { base, status } = req.body || {};
  if (!isSafeBase(base)) {
    res.status(400).json({ error: 'Invalid base name.' });
    return;
  }

  if (status !== null && status !== 'accept' && status !== 'reject') {
    res.status(400).json({ error: 'Invalid status.' });
    return;
  }

  try {
    const cfg = await loadConfig();
    await updateStatus(cfg, base, status);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

app.listen(PORT, () => {
  console.log(`SBGN reviewer running on http://localhost:${PORT}`);
});
