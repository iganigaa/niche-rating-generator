const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { runPipeline, stopPipeline } = require('./pipeline');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============ FILE I/O HELPERS ============

const DATA_DIR = path.join(__dirname, 'data');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

function readProjects() {
  try { return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')); }
  catch { return []; }
}

function writeProjects(projects) {
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

function readProjectMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, `${id}.meta.json`), 'utf8')); }
  catch { return {}; }
}

function writeProjectMeta(id, meta) {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${id}.meta.json`), JSON.stringify(meta));
}

function readProjectHtml(id) {
  try { return fs.readFileSync(path.join(PROJECTS_DIR, `${id}.html`), 'utf8'); }
  catch { return ''; }
}

function writeProjectHtml(id, html) {
  fs.writeFileSync(path.join(PROJECTS_DIR, `${id}.html`), html, 'utf8');
}

// ============ SSE INFRASTRUCTURE ============

// Map: projectId → Set of response objects
const sseClients = new Map();

// Map: projectId → { abort, promise }
const runningPipelines = new Map();

function addSSEClient(projectId, res) {
  if (!sseClients.has(projectId)) sseClients.set(projectId, new Set());
  sseClients.get(projectId).add(res);
  res.on('close', () => {
    const clients = sseClients.get(projectId);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) sseClients.delete(projectId);
    }
  });
}

function emitSSE(projectId, event, data) {
  const clients = sseClients.get(projectId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

// Heartbeat every 30s to keep connections alive
setInterval(() => {
  for (const [, clients] of sseClients) {
    for (const res of clients) {
      try { res.write(': heartbeat\n\n'); } catch {}
    }
  }
}, 30000);

// ============ CRUD ENDPOINTS ============

// GET /api/projects — list all projects
app.get('/api/projects', (req, res) => {
  res.json(readProjects());
});

// POST /api/projects — create project
app.post('/api/projects', (req, res) => {
  const projects = readProjects();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const project = {
    id,
    niche: req.body.niche || '',
    geo: req.body.geo || '',
    geo_request: req.body.geo_request || '',
    query_lang: req.body.query_lang || 'Русский',
    site_lang: req.body.site_lang || 'Русский',
    injection_name: req.body.injection_name || '',
    injection_info: req.body.injection_info || '',
    status: 'new',
    currentStep: null,
    pipelineStatus: 'idle',
    created_at: now,
    updated_at: now,
  };

  projects.push(project);
  writeProjects(projects);
  res.status(201).json(project);
});

// GET /api/projects/:id — project + meta (without html)
app.get('/api/projects/:id', (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const meta = readProjectMeta(req.params.id);
  res.json({ ...project, meta });
});

// GET /api/projects/:id/html — html content
app.get('/api/projects/:id/html', (req, res) => {
  const html = readProjectHtml(req.params.id);
  if (!html) return res.status(404).json({ error: 'No HTML' });
  res.type('html').send(html);
});

// PUT /api/projects/:id — update project fields
app.put('/api/projects/:id', (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  const allowed = ['niche', 'geo', 'geo_request', 'query_lang', 'site_lang',
    'injection_name', 'injection_info', 'status', 'currentStep', 'pipelineStatus',
    'seo_block'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) project[key] = req.body[key];
  }
  project.updated_at = new Date().toISOString();
  writeProjects(projects);
  res.json(project);
});

// PUT /api/projects/:id/html — update html (from editor)
app.put('/api/projects/:id/html', (req, res) => {
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Not found' });

  writeProjectHtml(req.params.id, req.body.html || '');
  project.updated_at = new Date().toISOString();
  writeProjects(projects);
  res.json({ ok: true });
});

// DELETE /api/projects/:id — delete project + files
app.delete('/api/projects/:id', (req, res) => {
  let projects = readProjects();
  const idx = projects.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  // Stop pipeline if running
  if (runningPipelines.has(req.params.id)) {
    stopPipeline();
    runningPipelines.delete(req.params.id);
  }

  projects.splice(idx, 1);
  writeProjects(projects);

  // Clean up files
  const metaFile = path.join(PROJECTS_DIR, `${req.params.id}.meta.json`);
  const htmlFile = path.join(PROJECTS_DIR, `${req.params.id}.html`);
  try { fs.unlinkSync(metaFile); } catch {}
  try { fs.unlinkSync(htmlFile); } catch {}

  res.json({ ok: true });
});

// POST /api/projects/:id/duplicate — duplicate project
app.post('/api/projects/:id/duplicate', (req, res) => {
  const projects = readProjects();
  const source = projects.find(p => p.id === req.params.id);
  if (!source) return res.status(404).json({ error: 'Not found' });

  const newId = crypto.randomUUID();
  const now = new Date().toISOString();

  const duplicate = {
    ...source,
    id: newId,
    status: source.status,
    pipelineStatus: 'idle',
    created_at: now,
    updated_at: now,
  };

  projects.push(duplicate);
  writeProjects(projects);

  // Copy meta and html
  const sourceMeta = readProjectMeta(req.params.id);
  if (Object.keys(sourceMeta).length > 0) writeProjectMeta(newId, sourceMeta);
  const sourceHtml = readProjectHtml(req.params.id);
  if (sourceHtml) writeProjectHtml(newId, sourceHtml);

  res.status(201).json(duplicate);
});

// ============ PIPELINE CONTROL ============

// POST /api/projects/:id/pipeline/start — start pipeline
app.post('/api/projects/:id/pipeline/start', (req, res) => {
  const projectId = req.params.id;
  const { apiKey, startFrom } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'API key required' });

  const projects = readProjects();
  const project = projects.find(p => p.id === projectId);
  if (!project) return res.status(404).json({ error: 'Not found' });

  // Check if already running
  if (runningPipelines.has(projectId)) {
    return res.status(409).json({ error: 'Pipeline already running' });
  }

  // Update status
  project.pipelineStatus = 'running';
  project.updated_at = new Date().toISOString();
  writeProjects(projects);

  // Emit function for SSE
  const emit = (event, data) => {
    emitSSE(projectId, event, { ...data, projectId });
  };

  // Start pipeline async
  const pipelinePromise = runPipeline(projectId, apiKey, startFrom || null, emit)
    .then(() => {
      const projs = readProjects();
      const p = projs.find(pr => pr.id === projectId);
      if (p) {
        p.pipelineStatus = 'done';
        p.updated_at = new Date().toISOString();
        writeProjects(projs);
      }
      emitSSE(projectId, 'pipeline_done', { projectId });
      runningPipelines.delete(projectId);
    })
    .catch((err) => {
      console.error(`[pipeline] Error for ${projectId}:`, err.message);
      const projs = readProjects();
      const p = projs.find(pr => pr.id === projectId);
      if (p) {
        p.pipelineStatus = 'error';
        p.updated_at = new Date().toISOString();
        writeProjects(projs);
      }
      emitSSE(projectId, 'pipeline_error', { projectId, error: err.message });
      runningPipelines.delete(projectId);
    });

  runningPipelines.set(projectId, { promise: pipelinePromise });

  res.json({ ok: true, message: 'Pipeline started' });
});

// POST /api/projects/:id/pipeline/stop — stop pipeline
app.post('/api/projects/:id/pipeline/stop', (req, res) => {
  const projectId = req.params.id;

  if (!runningPipelines.has(projectId)) {
    return res.status(400).json({ error: 'Pipeline not running' });
  }

  stopPipeline();
  runningPipelines.delete(projectId);

  const projects = readProjects();
  const project = projects.find(p => p.id === projectId);
  if (project) {
    project.pipelineStatus = 'idle';
    project.updated_at = new Date().toISOString();
    writeProjects(projects);
  }

  emitSSE(projectId, 'pipeline_stopped', { projectId });
  res.json({ ok: true, message: 'Pipeline stop requested' });
});

// GET /api/projects/:id/pipeline/events — SSE stream
app.get('/api/projects/:id/pipeline/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send initial status
  const projects = readProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (project) {
    res.write(`event: status\ndata: ${JSON.stringify({
      projectId: req.params.id,
      pipelineStatus: project.pipelineStatus,
      currentStep: project.currentStep,
    })}\n\n`);
  }

  addSSEClient(req.params.id, res);
});

// ============ SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
