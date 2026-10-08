import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { parseOfficeAsync } from 'officeparser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });
const app = express();
app.use(helmet({ contentSecurityPolicy: false }), cors(), express.json({ limit: '2mb' }));
app.use(['/auth', '/chat', '/presentation', '/learn', '/interview', '/projects'], rateLimit({ windowMs: 60000, limit: 60 }));

const NO_INFO = "I don't have that information in my Digital Me knowledge base.";
const NO_PROJECT = "This information isn't available in my current project knowledge base.";

// ---------- auth ----------
const sign = u => jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try { req.uid = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), process.env.JWT_SECRET).id; next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};
app.post('/auth/register', async (req, res) => {
  const { email, name, password } = req.body;
  if (!email || !name || (password || '').length < 8) return res.status(400).json({ error: 'email, name, password (8+) required' });
  try {
    const { rows } = await db.query('INSERT INTO users(email,name,password_hash) VALUES($1,$2,$3) RETURNING id,name',
      [email.toLowerCase(), name, await bcrypt.hash(password, 10)]);
    res.json({ token: sign(rows[0]), name });
  } catch { res.status(409).json({ error: 'Email already registered' }); }
});
app.post('/auth/login', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM users WHERE email=$1', [(req.body.email || '').toLowerCase()]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(req.body.password || '', u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(u), name: u.name });
});

// ---------- RAG: extract -> chunk -> embed -> store ----------
async function gfetch(pathq, body, tries = 5) {            // Google Gemini API (free tier), with backoff on rate limits
  for (let t = 0; t < tries; t++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${pathq}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY }, body: JSON.stringify(body) });
    if (r.status === 429 && t < tries - 1) { await new Promise(s => setTimeout(s, 8000 * (t + 1))); continue; }
    if (!r.ok) throw new Error('Gemini API: ' + await r.text());
    return r.json();
  }
}
async function embed(texts, type = 'document') {
  if (process.env.VOYAGE_API_KEY) {
    const r = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      body: JSON.stringify({ input: texts, model: 'voyage-3.5', input_type: type }) });
    if (!r.ok) throw new Error('Embedding failed: ' + await r.text());
    return (await r.json()).data.map(d => `[${d.embedding.join(',')}]`);
  }
  const d = await gfetch('models/gemini-embedding-001:batchEmbedContents', { requests: texts.map(t => ({
    model: 'models/gemini-embedding-001', content: { parts: [{ text: t }] },
    taskType: type === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: 1024 })) });
  return d.embeddings.map(e => `[${e.values.join(',')}]`);
}
function chunk(text, size = 900, overlap = 150) {
  const clean = text.replace(/\s+\n/g, '\n').trim(), out = [];
  for (let i = 0; i < clean.length; i += size - overlap) out.push(clean.slice(i, i + size));
  return out;
}
async function extract(file) {
  const ext = file.originalname.split('.').pop().toLowerCase();
  if (['txt', 'md'].includes(ext)) return file.buffer.toString('utf8');
  if (['png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) {            // OCR for image documents
    const { default: T } = await import('tesseract.js');
    return (await T.recognize(file.buffer, 'eng')).data.text;
  }
  if (['pdf', 'docx', 'pptx'].includes(ext)) return await parseOfficeAsync(file.buffer);
  throw new Error('Unsupported type. Images need an OCR step (e.g. Tesseract) added here.');
}
async function ingest(uid, title, category, text) {
  const parts = chunk(text);
  if (!parts.length) throw new Error('No text found');
  const { rows: [d] } = await db.query('INSERT INTO docs(user_id,title,category) VALUES($1,$2,$3) RETURNING id', [uid, title, category]);
  for (let i = 0; i < parts.length; i += 64) {
    const batch = parts.slice(i, i + 64), vecs = await embed(batch);
    for (let j = 0; j < batch.length; j++)
      await db.query('INSERT INTO chunks(doc_id,user_id,content,embedding) VALUES($1,$2,$3,$4)', [d.id, uid, batch[j], vecs[j]]);
  }
  return { id: d.id, chunks: parts.length };
}
async function retrieve(uid, q, k = 5, pubOnly = false) {
  const [v] = await embed([q], 'query');
  const { rows } = await db.query(
    `SELECT c.content, d.title, 1-(c.embedding <=> $2) AS score FROM chunks c JOIN docs d ON d.id=c.doc_id
     WHERE c.user_id=$1 AND (NOT $4::boolean OR d.public) ORDER BY c.embedding <=> $2 LIMIT $3`, [uid, v, k, pubOnly]);
  return rows;
}
const conf = s => (s >= 0.6 ? 'High' : s >= 0.45 ? 'Medium' : 'Low');

app.post('/knowledge', auth, upload.single('file'), async (req, res) => {
  try {
    const { title, category, text } = req.body;
    const body = req.file ? await extract(req.file) : text;
    res.json(await ingest(req.uid, title || req.file?.originalname || 'Untitled', category, body || ''));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/knowledge', auth, async (req, res) =>
  res.json((await db.query('SELECT id,title,category,public,created_at FROM docs WHERE user_id=$1 ORDER BY id DESC', [req.uid])).rows));
app.delete('/knowledge/:id', auth, async (req, res) => {
  await db.query('DELETE FROM docs WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]); res.json({ ok: true });
});
app.delete('/me/data', auth, async (req, res) => {           // "allow the user to delete stored information"
  await db.query('DELETE FROM docs WHERE user_id=$1', [req.uid]); res.json({ ok: true });
});

// ---------- LLM ----------
async function claude(system, messages) {
  if (process.env.ANTHROPIC_API_KEY) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 1000, system, messages }) });
    if (!r.ok) throw new Error(await r.text());
    return (await r.json()).content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';     // free-tier default
  const d = await gfetch(`models/${model}:generateContent`, {
    systemInstruction: { parts: [{ text: system }] },
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: 2048, ...(model.includes('2.5-flash') ? { thinkingConfig: { thinkingBudget: 0 } } : {}) } });
  return (d.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
}
const ctx = rows => rows.map((r, i) => `[${i + 1}] (${r.title}) ${r.content}`).join('\n\n');

// Presentation Q&A: strict grounding, no hallucinated project facts
app.post('/presentation/qa', auth, async (req, res) => {
  try {
    const rows = await retrieve(req.uid, req.body.question);
    if (!rows.length || rows[0].score < 0.35) return res.json({ answer: NO_PROJECT, confidence: 'None', sources: [] });
    const answer = await claude(
      `You are Digital Me presenting on behalf of the user. Answer ONLY from the context. If it is not covered, reply exactly: "${NO_PROJECT}". Never invent facts. Be concise and spoken-style.`,
      [{ role: 'user', content: `Context:\n${ctx(rows)}\n\nAudience question: ${req.body.question}` }]);
    res.json({ answer, confidence: conf(rows[0].score), sources: [...new Set(rows.map(r => r.title))] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Companion chat: personal facts must come from KB; general teaching is allowed but labeled
app.post('/chat', auth, async (req, res) => {
  try {
    const rows = await retrieve(req.uid, req.body.message);
    const tasks = (await db.query('SELECT title,priority,deadline FROM tasks WHERE user_id=$1 AND NOT done ORDER BY priority, deadline NULLS LAST', [req.uid])).rows;
    const good = rows.filter(r => r.score >= 0.35);
    const hist = (await db.query('SELECT role,content FROM chat_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 10', [req.uid])).rows.reverse();
    const answer = await claude(
      `You are Digital Me, the user's study and productivity companion. Facts about the user or their projects must come ONLY from the context; if missing, say: "${NO_INFO}". General explanations (teaching, coding help) are allowed, but mark them "General knowledge" so they are never confused with the user's stored facts. Ask for clarification when needed.`,
      [...hist,
       { role: 'user', content: `Context:\n${ctx(good) || '(none)'}\n\nOpen tasks: ${JSON.stringify(tasks)}\n\nUser: ${req.body.message}` }]);
    await db.query("INSERT INTO chat_messages(user_id,role,content) VALUES($1,'user',$2),($1,'assistant',$3)", [req.uid, req.body.message, answer]);
    res.json({ answer, sources: [...new Set(good.map(r => r.title))] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- tasks ----------
app.get('/tasks', auth, async (req, res) => res.json((await db.query('SELECT * FROM tasks WHERE user_id=$1 ORDER BY done, priority, deadline NULLS LAST', [req.uid])).rows));
app.post('/tasks', auth, async (req, res) => res.json((await db.query('INSERT INTO tasks(user_id,title,priority,deadline) VALUES($1,$2,$3,$4) RETURNING *',
  [req.uid, req.body.title, req.body.priority || 'M', req.body.deadline || null])).rows[0]));
app.patch('/tasks/:id', auth, async (req, res) => res.json((await db.query('UPDATE tasks SET done=$3 WHERE id=$1 AND user_id=$2 RETURNING *', [req.params.id, req.uid, !!req.body.done])).rows[0]));
app.delete('/tasks/:id', auth, async (req, res) => { await db.query('DELETE FROM tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]); res.json({ ok: true }); });

// ---------- v2: identity, presentation notes, learning, interview, projects, analytics ----------
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { res.status(500).json({ error: e.message }); } };
const J = async (system, user) => {
  const t = await claude(system + '\nReturn ONLY valid JSON, no markdown fences.', [{ role: 'user', content: user }]);
  const m = t.match(/[\[{][\s\S]*[\]}]/); return JSON.parse(m ? m[0] : t);
};
const kv = o => Object.entries(o).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n');
const strong = async (uid, q, k = 4, min = 0.4) => (await retrieve(uid, q, k)).filter(r => r.score >= min);

// Digital Identity (also stored as a searchable knowledge doc so both modes can use it)
app.get('/profile', auth, wrap(async (req, res) =>
  res.json((await db.query('SELECT data FROM profiles WHERE user_id=$1', [req.uid])).rows[0]?.data || {})));
app.put('/profile', auth, wrap(async (req, res) => {
  await db.query('INSERT INTO profiles(user_id,data) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET data=$2', [req.uid, req.body]);
  await db.query("DELETE FROM docs WHERE user_id=$1 AND title='Digital Identity'", [req.uid]);
  const t = kv(req.body); if (t) await ingest(req.uid, 'Digital Identity', 'Personal', t);
  res.json({ ok: true });
}));

// Presentation: grounded spoken explanation per slide at a chosen depth
app.post('/presentation/notes', auth, wrap(async (req, res) => {
  const { title, text, depth = 'normal', name = '' } = req.body;
  const rows = await strong(req.uid, `${title} ${text}`);
  const style = { simple: 'Explain in plain words for a non-technical audience in 2-3 sentences.',
    technical: 'Explain technically for engineers: components, data flow and design choices, only where the sources state them.',
    normal: 'Explain clearly in 3-4 spoken sentences.' }[depth] || '';
  const answer = await claude(`You are Digital Me presenting on behalf of ${name || 'the user'}. Use ONLY the slide text and context. Never add project facts that are not present. ${style} Spoken style, no markdown.`,
    [{ role: 'user', content: `Slide: ${title}\n${text}\n\nContext:\n${ctx(rows) || '(none)'}` }]);
  res.json({ answer });
}));
app.post('/presentation/end', auth, wrap(async (req, res) => {
  const b = req.body;
  await db.query('INSERT INTO pres_sessions(user_id,topic,seconds,slides,questions,helpful,unhelpful) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [req.uid, b.topic, b.seconds | 0, b.slides | 0, b.questions | 0, b.helpful | 0, b.unhelpful | 0]);
  res.json({ ok: true });
}));
app.get('/analytics', auth, wrap(async (req, res) => {
  const sessions = (await db.query('SELECT * FROM pres_sessions WHERE user_id=$1 ORDER BY id DESC LIMIT 10', [req.uid])).rows;
  const docs = (await db.query('SELECT count(*)::int n FROM docs WHERE user_id=$1', [req.uid])).rows[0].n;
  res.json({ sessions, docs });
}));

// Learning
app.post('/learn/plan', auth, wrap(async (req, res) => {
  const { topic, level = 'beginner', days = 7 } = req.body, rows = await strong(req.uid, topic, 3);
  res.json({ answer: await claude('You are Digital Me, a study coach. Build a structured day-by-day learning path with goals, subtopics and practice tasks. Mark anything drawn from the user\'s notes as "From your notes"; the rest is general knowledge.',
    [{ role: 'user', content: `Topic: ${topic}\nLevel: ${level}\nDays: ${days}\nUser notes:\n${ctx(rows) || '(none)'}` }]) });
}));
app.post('/learn/quiz', auth, wrap(async (req, res) => {
  const { topic, n = 5, difficulty = 'medium' } = req.body, rows = await strong(req.uid, topic, 3);
  res.json(await J('You write accurate exam-quality MCQs as a JSON array of {"q","options":[4 strings],"answer":index 0-3,"why"}. Prefer the user notes when relevant.',
    `Topic: ${topic}\nCount: ${n}\nDifficulty: ${difficulty}\nUser notes:\n${ctx(rows) || '(none)'}`));
}));
app.post('/learn/cards', auth, wrap(async (req, res) =>
  res.json(await J('Create concise revision flashcards as a JSON array of {"front","back"}.', `Topic: ${req.body.topic}\nCount: 8`))));
app.post('/learn/result', auth, wrap(async (req, res) => {
  await db.query('INSERT INTO learn_progress(user_id,topic,correct,total) VALUES($1,$2,$3,$4)', [req.uid, req.body.topic, req.body.correct | 0, req.body.total | 0]);
  res.json({ ok: true });
}));
app.get('/learn/progress', auth, wrap(async (req, res) =>
  res.json((await db.query('SELECT topic, SUM(correct)::int c, SUM(total)::int t FROM learn_progress WHERE user_id=$1 AND total>0 GROUP BY topic ORDER BY topic', [req.uid])).rows)));

// Interview
app.post('/interview/question', auth, wrap(async (req, res) => {
  const { role = '', company = '', tech = '', difficulty = 'medium', kind = 'Technical', asked = [] } = req.body;
  const rows = kind === 'Project' ? await strong(req.uid, 'project architecture features technologies', 5, 0.2) : [];
  res.json({ question: await claude(`You are a ${company || 'top tech'} interviewer. Ask exactly ONE ${difficulty} ${kind} interview question for a ${role || 'software'} role (${tech || 'general'}). For Project questions use only the candidate's project context. Do not repeat earlier questions. Output the question only.`,
    [{ role: 'user', content: `Earlier questions: ${JSON.stringify(asked)}\nCandidate project context:\n${ctx(rows) || '(none)'}` }]) });
}));
app.post('/interview/evaluate', auth, wrap(async (req, res) => {
  const { question, answer, role = '', tech = '' } = req.body;
  const r = await J('You are a strict but fair interviewer. Return {"score":0-10,"strengths":[...],"improvements":[...],"weak_area":"short topic","ideal_answer":"concise model answer"}.',
    `Role: ${role}\nQuestion: ${question}\nCandidate answer: ${answer}`);
  await db.query('INSERT INTO learn_progress(user_id,topic,correct,total) VALUES($1,$2,$3,10)', [req.uid, 'Interview: ' + (tech || role || 'General'), Math.max(0, Math.min(10, r.score | 0))]);
  res.json(r);
}));

// Projects (each project is also synced into the knowledge base)
const projText = (n, d) => `Project: ${n}\n` + kv(d);
const syncProj = async (uid, oldName, name, d) => {
  await db.query('DELETE FROM docs WHERE user_id=$1 AND title=$2', [uid, 'Project: ' + oldName]);
  await ingest(uid, 'Project: ' + name, 'Project', projText(name, d));
};
app.get('/projects', auth, wrap(async (req, res) => res.json((await db.query('SELECT * FROM projects WHERE user_id=$1 ORDER BY id DESC', [req.uid])).rows)));
app.post('/projects', auth, wrap(async (req, res) => {
  const { name, data = {} } = req.body;
  const p = (await db.query('INSERT INTO projects(user_id,name,data) VALUES($1,$2,$3) RETURNING *', [req.uid, name, data])).rows[0];
  await syncProj(req.uid, name, name, data); res.json(p);
}));
app.put('/projects/:id', auth, wrap(async (req, res) => {
  const old = (await db.query('SELECT name FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.uid])).rows[0];
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { name, data = {} } = req.body;
  await db.query('UPDATE projects SET name=$3,data=$4 WHERE id=$1 AND user_id=$2', [req.params.id, req.uid, name, data]);
  await syncProj(req.uid, old.name, name, data); res.json({ ok: true });
}));
app.delete('/projects/:id', auth, wrap(async (req, res) => {
  const p = (await db.query('DELETE FROM projects WHERE id=$1 AND user_id=$2 RETURNING name', [req.params.id, req.uid])).rows[0];
  if (p) await db.query('DELETE FROM docs WHERE user_id=$1 AND title=$2', [req.uid, 'Project: ' + p.name]);
  res.json({ ok: true });
}));
app.post('/projects/:id/ask', auth, wrap(async (req, res) => {
  const p = (await db.query('SELECT * FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.uid])).rows[0];
  if (!p) return res.status(404).json({ error: 'Not found' });
  const rows = await strong(req.uid, req.body.question);
  res.json({ answer: await claude('You are Digital Me, a project assistant. Use ONLY the project record and context for facts. In the tasks field, lines starting with "x " are done; all others remain. Label anything that is your own idea as "Suggestion:". If a fact is missing, say so.',
    [{ role: 'user', content: `Project record:\n${projText(p.name, p.data)}\n\nContext:\n${ctx(rows) || '(none)'}\n\nQuestion: ${req.body.question}` }]) });
}));

// ---------- v3: health, config, google sign-in, chat history, export ----------
app.get('/health', async (req, res) => {
  let dbOk = false; try { await db.query('SELECT 1'); dbOk = true; } catch {}
  res.json({ db: dbOk, anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY), voyage: !!(process.env.VOYAGE_API_KEY || process.env.GEMINI_API_KEY), google: !!process.env.GOOGLE_CLIENT_ID });
});
app.get('/config', (req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null }));
app.post('/auth/google', wrap(async (req, res) => {
  const cid = process.env.GOOGLE_CLIENT_ID;
  if (!cid) return res.status(400).json({ error: 'Google sign-in is not configured' });
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential || ''));
  const g = await r.json();
  if (!r.ok || g.aud !== cid || String(g.email_verified) !== 'true') return res.status(401).json({ error: 'Invalid Google token' });
  const email = g.email.toLowerCase();
  let u = (await db.query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
  if (!u) u = (await db.query('INSERT INTO users(email,name) VALUES($1,$2) RETURNING *', [email, g.name || email])).rows[0];
  res.json({ token: sign(u), name: u.name });
}));
app.get('/chat/history', auth, wrap(async (req, res) =>
  res.json((await db.query('SELECT role,content FROM chat_messages WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.uid])).rows.reverse())));
app.delete('/chat/history', auth, wrap(async (req, res) => { await db.query('DELETE FROM chat_messages WHERE user_id=$1', [req.uid]); res.json({ ok: true }); }));
app.get('/export', auth, wrap(async (req, res) => {
  const q = (t, extra = '') => db.query(`SELECT * FROM ${t} WHERE user_id=$1 ${extra}`, [req.uid]).then(r => r.rows);
  res.setHeader('Content-Disposition', 'attachment; filename=digital-me-export.json');
  res.json({ profile: (await q('profiles'))[0]?.data || {}, documents: await db.query('SELECT d.title,d.category,string_agg(c.content,E\'\\n\' ORDER BY c.id) AS text FROM docs d JOIN chunks c ON c.doc_id=d.id WHERE d.user_id=$1 GROUP BY d.id', [req.uid]).then(r => r.rows),
    projects: await q('projects'), tasks: await q('tasks'), learning: await q('learn_progress'), presentations: await q('pres_sessions') });
}));
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')));
await db.query(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql'), 'utf8')); // auto-migrate

// ---------- v4: public Digital Me link, document generator, daily plan, rehearsal gaps ----------
const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'me';
app.use('/public', rateLimit({ windowMs: 60000, limit: 15 }));
app.get('/share', auth, wrap(async (req, res) =>
  res.json({ slug: (await db.query('SELECT slug FROM users WHERE id=$1', [req.uid])).rows[0]?.slug || null })));
app.put('/share', auth, wrap(async (req, res) => {
  if (!req.body.enabled) { await db.query('UPDATE users SET slug=NULL WHERE id=$1', [req.uid]); return res.json({ slug: null }); }
  const u = (await db.query('SELECT name,slug FROM users WHERE id=$1', [req.uid])).rows[0];
  const slug = u.slug || slugify(u.name) + '-' + Math.random().toString(36).slice(2, 6);
  await db.query('UPDATE users SET slug=$2 WHERE id=$1', [req.uid, slug]); res.json({ slug });
}));
app.patch('/knowledge/:id/public', auth, wrap(async (req, res) => {
  await db.query('UPDATE docs SET public=$3 WHERE id=$1 AND user_id=$2', [req.params.id, req.uid, !!req.body.public]); res.json({ ok: true });
}));
app.get('/p/:slug', (req, res) => res.sendFile(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public', 'visitor.html')));
app.get('/public/:slug', wrap(async (req, res) => {
  const u = (await db.query('SELECT id,name FROM users WHERE slug=$1', [req.params.slug])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  res.json({ name: u.name, topics: (await db.query('SELECT title FROM docs WHERE user_id=$1 AND public', [u.id])).rows.map(r => r.title) });
}));
app.post('/public/:slug/ask', wrap(async (req, res) => {
  const u = (await db.query('SELECT id,name FROM users WHERE slug=$1', [req.params.slug])).rows[0];
  const q = String(req.body.question || '').slice(0, 500);
  if (!u || !q) return res.status(400).json({ error: 'Bad request' });
  const rows = (await retrieve(u.id, q, 5, true)).filter(r => r.score >= 0.4);
  if (!rows.length) return res.json({ answer: `That isn't covered in the information ${u.name} has chosen to share.` });
  res.json({ answer: await claude(`You are Digital Me, the AI representative of ${u.name}, speaking to a visitor. Use ONLY the context, never invent facts, and never reveal anything beyond it. If it is not covered, say it is not in the shared information. Speak in the third person about ${u.name} unless asked to introduce yourself.`,
    [{ role: 'user', content: `Context:\n${ctx(rows)}\n\nVisitor question: ${q}` }]), sources: [...new Set(rows.map(r => r.title))] });
}));

app.post('/generate', auth, wrap(async (req, res) => {
  const { kind = 'resume', target = '' } = req.body;
  const rows = (await retrieve(req.uid, `${kind} ${target} skills projects experience education achievements`, 10)).filter(r => r.score >= 0.2);
  if (!rows.length) return res.json({ answer: "I don't have that information in my Digital Me knowledge base. Fill in your Identity page or upload your resume first." });
  const what = { resume: 'a one-page resume in clean plain text with sections', pitch: 'a 30-second spoken elevator pitch', bio: 'a 3-sentence professional bio for LinkedIn', cover: 'a concise cover letter' }[kind] || kind;
  res.json({ answer: await claude(`Write ${what} using ONLY the context. Never invent employers, dates, degrees, metrics or skills. Where something normally included is missing, put a placeholder like [add: graduation year].`,
    [{ role: 'user', content: `Target role/company: ${target || 'general'}\n\nContext:\n${ctx(rows)}` }]) });
}));

app.get('/plan/today', auth, wrap(async (req, res) => {
  const tasks = (await db.query('SELECT title,priority,deadline FROM tasks WHERE user_id=$1 AND NOT done ORDER BY priority, deadline NULLS LAST', [req.uid])).rows;
  const weak = (await db.query('SELECT topic, SUM(correct)::int c, SUM(total)::int t FROM learn_progress WHERE user_id=$1 AND total>0 GROUP BY topic HAVING SUM(correct)*1.0/SUM(total) < 0.6', [req.uid])).rows;
  res.json({ answer: await claude('You are Digital Me. Build a realistic plan for today from the open tasks (priority H>M>L, nearest deadline first) and weak topics to revise. Use only the data given; label extra ideas "Suggestion:". Keep it short, with time blocks.',
    [{ role: 'user', content: `Today: ${new Date().toISOString().slice(0, 10)}\nOpen tasks: ${JSON.stringify(tasks)}\nWeak topics: ${JSON.stringify(weak)}` }]) });
}));

app.post('/presentation/prep', auth, wrap(async (req, res) => {
  const deck = (req.body.slides || []).map(s => `${s.t}: ${s.x}`).join('\n').slice(0, 6000);
  const qs = await J('Return a JSON array of 8 tough but realistic audience questions about this presentation.', deck);
  res.json(await Promise.all(qs.slice(0, 8).map(async q => {
    const r = (await retrieve(req.uid, q, 1))[0];
    return { q, score: r ? +r.score.toFixed(2) : 0, covered: !!r && r.score >= 0.35, source: r?.title || null };
  })));
}));

app.listen(process.env.PORT || 4000, () => console.log('Digital Me API running'));
