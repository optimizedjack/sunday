require('dotenv').config()
const express    = require('express')
const fetch      = require('node-fetch')
const cors       = require('cors')
const path       = require('path')
const rateLimit  = require('express-rate-limit')
const app        = express()

// ── Config ────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434'
const OBSIDIAN_URL = process.env.OBSIDIAN_URL || 'https://localhost:27124'
const OBSIDIAN_KEY = process.env.OBSIDIAN_KEY
const MODEL        = process.env.OLLAMA_MODEL || 'llama3.2'
const VAULT_FOLDER = process.env.VAULT_FOLDER || ''
const PORT         = process.env.PORT         || 3000

if (!OBSIDIAN_KEY) {
  console.error('ERROR: OBSIDIAN_KEY is not set in .env')
  process.exit(1)
}
// ─────────────────────────────────────────────────────────

// ── Security middleware ──

// Rate limiting — 60 requests per minute per IP
app.use('/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, slow down.' }
}))

app.use('/save', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, slow down.' }
}))

app.use(cors({ origin: false }))
app.use(express.json({ limit: '50kb' }))
app.use(express.static(path.join(__dirname)))

// ── Input validation helper ──
function validateString(val, maxLen = 8000) {
  if (typeof val !== 'string') return false
  if (val.trim().length === 0) return false
  if (val.length > maxLen) return false
  return true
}

// ── System prompts ──
const BASE_PROMPT = `You are Sunday — a creative collaborator with a point of view. You have taste, opinions, and convictions. You don't hedge. You write in prose, never bullet lists or numbered lists. You think like a director, not a search engine. When something is weak, you say so directly. When something is interesting, you push it further without being asked. You are concise but never shallow. You speak to the user like a sharp creative peer — honest, fast, and specific.`

const MODE_PROMPTS = {
  free:     '',
  riff:     "The user wants you to take their idea and run with it. Build on it, mutate it, find the unexpected angle. Be generative and committed — one strong direction executed with conviction, not five safe options. Follow the idea wherever it leads.",
  stuck:    "The user is creatively blocked. Do not give them solutions or options. Ask them one sharp, specific question that reframes the problem from an angle they haven't considered. Make it uncomfortable if needed. One question only. No preamble.",
  critique: "The user wants honest critique. Be direct and specific — say exactly what isn't working and why. Then say what is strong. Do not soften it. Do not end with a compliment. Treat the work seriously."
}

// ── POST /chat — streaming ──
app.post('/chat', async (req, res) => {
  const { prompt, history = [], mode = 'free' } = req.body
  if (!validateString(prompt)) return res.status(400).json({ error: 'Invalid prompt' })
  if (!Array.isArray(history) || history.length > 200) return res.status(400).json({ error: 'Invalid history' })
  const safeMode = ['free', 'riff', 'stuck', 'critique'].includes(mode) ? mode : 'free'
  const system = MODE_PROMPTS[safeMode] ? `${BASE_PROMPT}\n\n${MODE_PROMPTS[safeMode]}` : BASE_PROMPT

  const messages = [...history, { role: 'user', content: prompt }]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        system,
        messages,
        stream: true
      })
    })

    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const json = JSON.parse(line)
          if (json.message?.content) {
            res.write(`data: ${JSON.stringify({ token: json.message.content })}\n\n`)
          }
          if (json.done) {
            res.write(`data: [DONE]\n\n`)
            res.end()
          }
        } catch {}
      }
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: 'Ollama unreachable' })}\n\n`)
    res.end()
  }
})

// ── POST /save ──
app.post('/save', async (req, res) => {
  const { prompt, response, tags } = req.body
  if (!validateString(prompt)) return res.status(400).json({ error: 'Invalid prompt' })
  if (!validateString(response, 100000)) return res.status(400).json({ error: 'Invalid response' })

  const now     = new Date()
  const date    = now.toISOString().slice(0, 10)
  const time    = now.toTimeString().slice(0, 5)
  const tagList = tags && typeof tags === 'string'
    ? tags.split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
    : ['brain']

  const isFilename = prompt.endsWith('.md')
  const safeTitle  = prompt.slice(0, 40).replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
  const filename   = isFilename ? prompt : (VAULT_FOLDER ? `${VAULT_FOLDER}/${date} ${safeTitle}.md` : `${date} ${safeTitle}.md`)

  const content = isFilename
    ? `---\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n${response}`
    : `---\ntitle: "${safeTitle}"\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n# ${safeTitle}\n\n## Prompt\n${prompt}\n\n## Response\n${response}\n`

  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/${filename}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
      body: content,
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    })
    if (!r.ok) throw new Error(`Obsidian returned ${r.status}`)
    res.json({ saved: filename })
  } catch (err) {
    res.status(500).json({ error: 'Could not save to Obsidian', detail: err.message })
  }
})

// ── GET /note ──
app.get('/note', async (req, res) => {
  const { path: filePath } = req.query
  if (!validateString(filePath, 500)) return res.status(400).json({ error: 'Invalid path' })
  if (filePath.includes('..')) return res.status(400).json({ error: 'Invalid path' })
  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/${filePath}`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    })
    const text = await r.text()
    res.json({ content: text })
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch note', detail: err.message })
  }
})

// ── DELETE /note ──
app.delete('/note', async (req, res) => {
  const { path: filePath } = req.query
  if (!validateString(filePath, 500)) return res.status(400).json({ error: 'Invalid path' })
  if (filePath.includes('..')) return res.status(400).json({ error: 'Invalid path' })
  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/${filePath}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    })
    if (!r.ok) throw new Error(`Obsidian returned ${r.status}`)
    res.json({ deleted: filePath })
  } catch (err) {
    res.status(500).json({ error: 'Could not delete note', detail: err.message })
  }
})

// ── GET /notes ──
app.get('/notes', async (req, res) => {
  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      agent: new (require('https').Agent)({ rejectUnauthorized: false })
    })
    const data = await r.json()
    const files = (data.files || [])
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .slice(0, 20)
    res.json({ notes: files })
  } catch (err) {
    res.status(500).json({ error: 'Could not reach Obsidian', detail: err.message })
  }
})

// ── POST /rename ──
app.post('/rename', async (req, res) => {
  const { from, to } = req.body
  if (!validateString(from, 500) || !validateString(to, 500)) return res.status(400).json({ error: 'Invalid paths' })
  if (from.includes('..') || to.includes('..')) return res.status(400).json({ error: 'Invalid path' })
  const agent = new (require('https').Agent)({ rejectUnauthorized: false })
  try {
    // Read original
    const getRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(from)}`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` }, agent
    })
    if (!getRes.ok) throw new Error(`Could not read source file`)
    const content = await getRes.text()

    // Write to new path
    const putRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(to)}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
      body: content, agent
    })
    if (!putRes.ok) throw new Error(`Could not write to new path`)

    // Delete original
    const delRes = await fetch(`${OBSIDIAN_URL}/vault/${encodeURIComponent(from)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` }, agent
    })
    if (!delRes.ok) throw new Error(`Could not delete original`)

    res.json({ renamed: to })
  } catch (err) {
    res.status(500).json({ error: 'Rename failed', detail: err.message })
  }
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Sunday running on port ${PORT}`)
})
