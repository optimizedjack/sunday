require('dotenv').config()
const express = require('express')
const fetch   = require('node-fetch')
const cors    = require('cors')
const path    = require('path')
const https   = require('https')
const fs      = require('fs')
const app     = express()

// ── Config ────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434'
const OBSIDIAN_URL = process.env.OBSIDIAN_URL || 'https://localhost:27124'
const OBSIDIAN_KEY = process.env.OBSIDIAN_KEY
const MODEL         = process.env.OLLAMA_MODEL  || 'llama3.2'
const EMBED_MODEL   = process.env.EMBED_MODEL   || 'nomic-embed-text'
const VAULT_FOLDER  = process.env.VAULT_FOLDER  || ''
const SKILLS_FOLDER = process.env.SKILLS_FOLDER || 'Sunday/Skills'
const PORT         = parseInt(process.env.PORT, 10) || 3000
const HOST         = process.env.HOST || '0.0.0.0'

// ── Agent API key (optional — set AGENT_KEY in .env to require it) ──
// If set, all requests to /agent must include header: x-agent-key: <value>
const AGENT_KEY = process.env.AGENT_KEY || ''

if (!OBSIDIAN_KEY) {
  console.error('ERROR: OBSIDIAN_KEY is not set in .env')
  process.exit(1)
}

if (VAULT_FOLDER) {
  const norm = path.posix.normalize(VAULT_FOLDER)
  if (norm.startsWith('..') || norm.startsWith('/')) {
    console.error('ERROR: VAULT_FOLDER must be a relative path with no ".."')
    process.exit(1)
  }
}
// ─────────────────────────────────────────────────────────

// ── Shared HTTPS agent (reused; avoids re-creating TLS context per request) ──
const obsidianAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true })

// ── Vector index ──────────────────────────────────────────
// In-memory store: { [filename]: { vector, title, snippet, indexed_at } }
// Persisted to sunday_vectors.json alongside server.js
const INDEX_PATH = path.join(__dirname, 'sunday_vectors.json')
let vectorIndex  = {}
let embedAvailable = null  // null = unknown, true/false after first probe

function loadVectorIndex() {
  try {
    const raw  = fs.readFileSync(INDEX_PATH, 'utf8')
    const data = JSON.parse(raw)
    vectorIndex = data.notes || {}
    const count = Object.keys(vectorIndex).length
    if (count) console.log(`Vector index loaded — ${count} notes`)
  } catch {
    vectorIndex = {}
  }
}

// Serialise all writes through a promise chain so concurrent indexNote()
// calls can never interleave and silently lose an entry.
let _indexWriteQueue = Promise.resolve()

function saveVectorIndex() {
  _indexWriteQueue = _indexWriteQueue.then(() => new Promise(resolve => {
    const data = JSON.stringify({ version: 1, notes: vectorIndex }, null, 0)
    fs.writeFile(INDEX_PATH, data, 'utf8', err => {
      if (err) console.error('Could not save vector index:', err.message)
      resolve()
    })
  }))
}

async function getEmbedding(text) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: EMBED_MODEL, prompt: text.slice(0, 2000) }),
      signal:  AbortSignal.timeout(15_000)
    })
    // 404 = model not pulled — definitively unavailable until restart/pull
    if (res.status === 404) { embedAvailable = false; return null }
    // Other non-ok = transient (Ollama busy, timeout, etc.) — don't poison the flag
    if (!res.ok) return null
    const data = await res.json()
    if (!Array.isArray(data.embedding)) return null
    embedAvailable = true
    return data.embedding
  } catch {
    // Network/timeout error — transient, don't permanently mark unavailable
    return null
  }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB)
  return mag === 0 ? 0 : dot / mag
}

// Returns top-N entries sorted by similarity, filtered by threshold
function semanticSearch(queryVector, topN = 6, threshold = 0.3) {
  return Object.entries(vectorIndex)
    .map(([filename, entry]) => ({
      filename,
      title:   entry.title,
      snippet: entry.snippet,
      score:   cosineSimilarity(queryVector, entry.vector)
    }))
    .filter(r => r.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
}

// Embed and store a note — safe to fire-and-forget
async function indexNote(filename, rawContent) {
  const body  = rawContent.replace(/^---[\s\S]*?---\n?/, '').trim()
  const name  = filename.split('/').pop().replace('.md', '')
  const dm    = name.match(/^(\d{4}-\d{2}-\d{2})\s+\d{2}-\d{2}\s+(.+)$/)
  const title = dm ? dm[2] : name
  // Combine title + body for richer embedding signal
  const vector = await getEmbedding(`${title}\n\n${body.slice(0, 1600)}`)
  if (!vector) return false
  vectorIndex[filename] = {
    vector,
    title,
    snippet:    body.slice(0, 300),
    indexed_at: new Date().toISOString()
  }
  saveVectorIndex()
  return true
}

loadVectorIndex()

// ── Pinned notes ──────────────────────────────────────────
// Pinned notes are always injected into the system prompt regardless
// of semantic similarity — useful for ongoing projects, standing context,
// or reference docs the model should always keep in mind.
const PINS_PATH = path.join(__dirname, 'sunday_pins.json')
let pins = []

function loadPins() {
  try {
    const raw = JSON.parse(fs.readFileSync(PINS_PATH, 'utf8'))
    pins = Array.isArray(raw) ? raw : []
  } catch { pins = [] }
}
function savePins() {
  fs.writeFile(PINS_PATH, JSON.stringify(pins), 'utf8', err => {
    if (err) console.error('Could not save pins:', err.message)
  })
}
loadPins()

app.use(cors())
// 500kb: /save carries full conversation text which can exceed 50kb
app.use(express.json({ limit: '500kb' }))
app.use(express.static(path.join(__dirname)))

// ── Input validation helpers ──
function validateString(val, maxLen = 8000) {
  if (typeof val !== 'string') return false
  if (val.trim().length === 0) return false
  if (val.length > maxLen) return false
  return true
}

// Validates a vault-relative file path against traversal and absolute paths.
function validateVaultPath(filePath) {
  if (!validateString(filePath, 500)) return false
  if (filePath.includes('\0')) return false
  const norm = path.posix.normalize(filePath)
  if (norm === '..' || norm.startsWith('../') || norm.includes('/../')) return false
  if (norm.startsWith('/')) return false
  return true
}

// Builds an Obsidian vault URL with each path segment individually encoded.
// encodeURIComponent on a full path turns "folder/note.md" into "folder%2Fnote.md"
// which the Obsidian API treats as a literal filename, not a subfolder path.
function vaultUrl(filePath) {
  const encoded = filePath.split('/').map(encodeURIComponent).join('/')
  return `${OBSIDIAN_URL}/vault/${encoded}`
}

// Parses YAML frontmatter from a markdown string.
// Handles quoted and unquoted scalar values; not a full YAML parser.
function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split('\n')) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (key) result[key] = val
  }
  return result
}

// ── System prompts ──
const BASE_PROMPT = `You are Sunday — a creative collaborator with a point of view. You have taste, opinions, and convictions. You don't hedge. You write in prose, never bullet lists or numbered lists. You think like a director, not a search engine. When something is weak, you say so directly. When something is interesting, you push it further without being asked. You are concise but never shallow. You speak to the user like a sharp creative peer — honest, fast, and specific.`

const MODE_PROMPTS = {
  free:     '',
  riff:     "The user wants you to take their idea and run with it. Build on it, mutate it, find the unexpected angle. Be generative and committed — one strong direction executed with conviction, not five safe options. Follow the idea wherever it leads.",
  stuck:    "The user is creatively blocked. Do not give them solutions or options. Ask them one sharp, specific question that reframes the problem from an angle they haven't considered. Make it uncomfortable if needed. One question only. No preamble.",
  critique: "The user wants honest critique. Be direct and specific — say exactly what isn't working and why. Then say what is strong. Do not soften it. Do not end with a compliment. Treat the work seriously."
}

const VALID_ROLES = new Set(['user', 'assistant'])

// ── POST /chat — streaming ──
app.post('/chat', async (req, res) => {
  const { prompt, history = [], mode = 'free', context = '', model: modelOverride = '', customPrompt = '' } = req.body

  if (!validateString(prompt)) return res.status(400).json({ error: 'Invalid prompt' })

  if (!Array.isArray(history) || history.length > 200) {
    return res.status(400).json({ error: 'Invalid history' })
  }
  for (const msg of history) {
    if (!VALID_ROLES.has(msg.role) || typeof msg.content !== 'string' || msg.content.length > 50000) {
      return res.status(400).json({ error: 'Invalid history entry' })
    }
  }

  // Open the SSE stream immediately so the client sees the connection —
  // embedding + Obsidian fetches happen after this, but the user isn't blocked waiting
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const activeModel   = (typeof modelOverride === 'string' && modelOverride.trim()) ? modelOverride.trim() : MODEL
  const safeContext   = typeof context === 'string' ? context.slice(0, 20000) : ''
  const safeCustom    = typeof customPrompt === 'string' ? customPrompt.slice(0, 5000) : ''
  const safeMode      = ['free', 'riff', 'stuck', 'critique'].includes(mode) ? mode : 'free'
  const modeAddendum  = safeCustom ? `\n\n${safeCustom}` : (MODE_PROMPTS[safeMode] ? `\n\n${MODE_PROMPTS[safeMode]}` : '')

  // ── Pinned notes (always included) ──
  let pinnedBlock = ''
  if (pins.length) {
    const pinnedFetched = await Promise.allSettled(
      pins.slice(0, 5).map(async filename => {
        const r = await fetch(vaultUrl(filename), {
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
          signal:  AbortSignal.timeout(5_000),
          agent:   obsidianAgent
        })
        const text = await r.text()
        const body = text.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 600)
        const name = filename.split('/').pop().replace('.md', '')
          .replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}-\d{2}\s+/, '')
        return `[📌 ${name}]\n${body}`
      })
    )
    const ctx = pinnedFetched
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .join('\n\n---\n\n')
    if (ctx) pinnedBlock = `\n\nThe following notes are pinned by the user as permanently relevant context. Always keep them in mind:\n\n${ctx}`
  }

  // ── Semantic context retrieval ──
  // Try to embed the prompt and find the most relevant vault notes.
  // Falls back to the client-provided recent-notes context if embeddings
  // aren't available (nomic-embed-text not pulled) or the index is empty.
  let contextBlock = ''
  const queryVec = await getEmbedding(prompt.slice(0, 1000))
  if (queryVec) {
    const matches = semanticSearch(queryVec, 6)
    if (matches.length) {
      const fetched = await Promise.allSettled(
        matches.map(async ({ filename, title, score }) => {
          const r = await fetch(vaultUrl(filename), {
            headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
            signal:  AbortSignal.timeout(5_000),
            agent:   obsidianAgent
          })
          const text = await r.text()
          const body = text.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 800)
          return `[${title}]\n${body}`
        })
      )
      const ctx = fetched
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value)
        .join('\n\n---\n\n')
      if (ctx) {
        contextBlock = `\n\nThe following notes from your vault are semantically relevant to this conversation. Draw on them naturally — reference them when useful, build on existing threads, notice patterns.\n\n${ctx}`
      }
    }
  }

  // Fallback: use the recent-notes context the client sent
  if (!contextBlock && safeContext) {
    contextBlock = `\n\nThe following are excerpts from the user's past conversations and saved notes. Use them to inform your responses — reference them when relevant, notice patterns, build on threads the user has already been pulling on. Do not recite them back verbatim.\n\n${safeContext}`
  }

  const system   = `${BASE_PROMPT}${modeAddendum}${pinnedBlock}${contextBlock}`
  const messages = [...history, { role: 'user', content: prompt }]

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: activeModel, system, messages, stream: true }),
      signal: AbortSignal.timeout(120_000)
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
            res.write('data: [DONE]\n\n')
            res.end()
          }
        } catch {}
      }
    }
  } catch {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'Ollama unreachable' })}\n\n`)
      res.end()
    }
  }
})

// ── POST /agent ────────────────────────────────────────────
// Structured reasoning endpoint for external agents.
// Sunday acts as the brain: it receives a task + the result of the last
// action, and returns the next action as a JSON object.
//
// Request body:
//   task         {string}   — the overall goal (required)
//   step         {number}   — which step we're on (0 = first call)
//   result       {any}      — output of the last action (null on step 0)
//   history      {array}    — prior {role, content} turns for multi-step memory
//   capabilities {string[]} — action names the agent can actually execute
//   model        {string}   — optional model override
//
// Response:
//   { ok: true, thought, action, params, done }
//   { ok: false, raw, error }  — if model returned non-JSON
//
// Auth: if AGENT_KEY is set in .env, caller must send header x-agent-key: <value>
// ──────────────────────────────────────────────────────────
app.post('/agent', async (req, res) => {
  // Optional key-based auth for agent access
  if (AGENT_KEY) {
    const provided = req.headers['x-agent-key'] || ''
    if (provided !== AGENT_KEY) {
      return res.status(401).json({ error: 'Unauthorized — invalid x-agent-key' })
    }
  }

  const {
    task,
    step         = 0,
    result       = null,
    history      = [],
    capabilities = [],
    model: modelOverride = ''
  } = req.body

  if (!validateString(task, 4000)) {
    return res.status(400).json({ error: 'Invalid task' })
  }

  // Guard against huge result payloads being forwarded to Ollama
  if (result !== null && result !== undefined) {
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result)
    if (resultStr.length > 50_000) {
      return res.status(400).json({ error: 'Result payload too large (max 50 KB)' })
    }
  }

  if (!Array.isArray(history) || history.length > 100) {
    return res.status(400).json({ error: 'Invalid history' })
  }
  for (const msg of history) {
    if (!VALID_ROLES.has(msg.role) || typeof msg.content !== 'string' || msg.content.length > 20000) {
      return res.status(400).json({ error: 'Invalid history entry' })
    }
  }

  const activeModel = (typeof modelOverride === 'string' && modelOverride.trim())
    ? modelOverride.trim()
    : MODEL

  // Tell the model exactly which actions are available so it doesn't plan
  // steps the agent can't actually execute.
  const capsList = Array.isArray(capabilities) && capabilities.length
    ? `The agent has these available actions:\n${capabilities.map(c => `  - ${c}`).join('\n')}`
    : 'The agent can perform general file and system operations.'

  const systemPrompt = `You are Sunday — the reasoning brain for an AI agent operating on a user's computer. Your only job is to think clearly about a task and decide the single next action the agent should take.

${capsList}

Rules:
- Respond ONLY with a single valid JSON object. No markdown, no prose outside the object.
- Never plan multiple steps at once. One action per response.
- Only use actions from the list above (or "done" when finished).
- Be specific in params — the agent executes exactly what you say.
- If a previous step's result reveals a problem, adapt.

JSON schema (every field required):
{
  "thought": "brief internal reasoning about why this is the right next step",
  "action": "action_name_here",
  "params": { "key": "value" },
  "done": false
}

When the task is fully complete, set "action": "done" and "done": true.`

  // Build the message: step 0 is just the task; subsequent steps include
  // what the last action returned so Sunday can reason from real results.
  const userContent = step === 0
    ? `Task: ${task}`
    : `Task: ${task}\n\nCompleted step ${step}. Result:\n${JSON.stringify(result, null, 2)}\n\nWhat is the next action?`

  const messages = [
    ...history,
    { role: 'user', content: userContent }
  ]

  try {
    const response = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
        system: systemPrompt,
        messages,
        stream: false,
        // Lower temperature for more deterministic JSON output
        options: { temperature: 0.2 }
      }),
      signal: AbortSignal.timeout(60_000)
    })

    const data = await response.json()
    const raw  = data.message?.content || ''

    // Strip any accidental markdown fences the model may have added
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()

    try {
      const parsed = JSON.parse(cleaned)

      // Validate the shape so the agent never gets a silently malformed response
      if (typeof parsed.thought !== 'string' || typeof parsed.action !== 'string') {
        return res.json({ ok: false, raw, error: 'Model returned incomplete JSON schema' })
      }

      res.json({
        ok:     true,
        thought: parsed.thought,
        action:  parsed.action,
        params:  parsed.params  || {},
        done:    parsed.done    === true
      })
    } catch {
      res.json({ ok: false, raw, error: 'Model did not return valid JSON — try a stronger model' })
    }
  } catch {
    res.status(500).json({ error: 'Ollama unreachable' })
  }
})

// ── POST /save ──
app.post('/save', async (req, res) => {
  // Two calling conventions:
  //   Session save (from saveConversation): { filename, content, tags }
  //   Manual save  (from save button):      { prompt, response, tags }
  const { prompt, response, tags, filename: explicitFilename, content: explicitContent } = req.body

  const now     = new Date()
  const date    = now.toISOString().slice(0, 10)
  const time    = now.toTimeString().slice(0, 5)
  const tagList = tags && typeof tags === 'string'
    ? tags.split(',').map(t => t.trim().replace(/[^\w-]/g, '').slice(0, 50)).filter(Boolean).slice(0, 10)
    : ['brain']

  let filename, content

  if (explicitFilename) {
    // Session save — client owns the filename
    if (!validateVaultPath(explicitFilename)) return res.status(400).json({ error: 'Invalid filename' })
    if (!validateString(explicitContent, 500000)) return res.status(400).json({ error: 'Invalid content' })
    filename = explicitFilename
    content  = `---\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n${explicitContent}`
  } else {
    // Manual save — derive filename from prompt
    if (!validateString(prompt)) return res.status(400).json({ error: 'Invalid prompt' })
    if (!validateString(response, 100000)) return res.status(400).json({ error: 'Invalid response' })
    const safeTitle = prompt.slice(0, 40).replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
    filename = VAULT_FOLDER ? `${VAULT_FOLDER}/${date} ${safeTitle}.md` : `${date} ${safeTitle}.md`
    content  = `---\ntitle: "${safeTitle}"\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n# ${safeTitle}\n\n## Prompt\n${prompt}\n\n## Response\n${response}\n`
  }

  try {
    const r = await fetch(vaultUrl(filename), {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
      body: content,
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!r.ok) throw new Error(`Obsidian returned ${r.status}`)
    // Background-index the note for semantic search — don't block the response
    indexNote(filename, content).catch(() => {})
    res.json({ saved: filename })
  } catch {
    res.status(500).json({ error: 'Could not save to Obsidian' })
  }
})

// ── GET /note ──
app.get('/note', async (req, res) => {
  const { path: filePath } = req.query
  if (!validateVaultPath(filePath)) return res.status(400).json({ error: 'Invalid path' })
  try {
    const r = await fetch(vaultUrl(filePath), {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const text = await r.text()
    res.json({ content: text })
  } catch {
    res.status(500).json({ error: 'Could not fetch note' })
  }
})

// ── DELETE /note ──
app.delete('/note', async (req, res) => {
  const { path: filePath } = req.query
  if (!validateVaultPath(filePath)) return res.status(400).json({ error: 'Invalid path' })
  try {
    const r = await fetch(vaultUrl(filePath), {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!r.ok) throw new Error(`Obsidian returned ${r.status}`)
    // Remove from vector index
    if (vectorIndex[filePath]) {
      delete vectorIndex[filePath]
      saveVectorIndex()
    }
    // Remove from pins if pinned
    if (pins.includes(filePath)) {
      pins = pins.filter(f => f !== filePath)
      savePins()
    }
    res.json({ deleted: filePath })
  } catch {
    res.status(500).json({ error: 'Could not delete note' })
  }
})

// ── GET /context — recent notes as memory for the model ──
app.get('/context', async (req, res) => {
  const n = Math.min(Math.max(1, parseInt(req.query.n, 10) || 8), 20)
  try {
    const listRes = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const data  = await listRes.json()
    const files = (data.files || [])
      .filter(f => typeof f === 'string' && f.endsWith('.md'))
      .sort().reverse().slice(0, n)

    if (!files.length) return res.json({ context: '' })

    const notes = await Promise.allSettled(files.map(async filename => {
      const r = await fetch(vaultUrl(filename), {
        headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
        signal: AbortSignal.timeout(10_000),
        agent: obsidianAgent
      })
      const text = await r.text()
      const body = text.replace(/^---[\s\S]*?---\n?/, '').trim().slice(0, 600)
      const label = filename.split('/').pop().replace('.md', '')
      return `[${label}]\n${body}`
    }))

    const context = notes
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .join('\n\n---\n\n')

    res.json({ context })
  } catch {
    res.status(500).json({ error: 'Could not load context' })
  }
})

// ── GET /notes — paginated ──
// Query params: limit (1–100, default 20), offset (default 0)
app.get('/notes', async (req, res) => {
  const limit  = Math.min(Math.max(1, parseInt(req.query.limit,  10) || 20), 100)
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0)
  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const data     = await r.json()
    const allFiles = (data.files || [])
      .filter(f => typeof f === 'string' && f.endsWith('.md'))
      .sort().reverse()
    const total = allFiles.length
    const notes = allFiles.slice(offset, offset + limit)
    res.json({ notes, total, offset, limit })
  } catch {
    res.status(500).json({ error: 'Could not reach Obsidian' })
  }
})

// ── POST /rename ──
app.post('/rename', async (req, res) => {
  const { from, to } = req.body
  if (!validateVaultPath(from) || !validateVaultPath(to)) {
    return res.status(400).json({ error: 'Invalid paths' })
  }
  try {
    const getRes = await fetch(vaultUrl(from), {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!getRes.ok) throw new Error('Could not read source file')
    const content = await getRes.text()

    const putRes = await fetch(vaultUrl(to), {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
      body: content,
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!putRes.ok) throw new Error('Could not write to new path')

    const delRes = await fetch(vaultUrl(from), {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!delRes.ok) throw new Error('Could not delete original')

    // Update vector index key
    if (vectorIndex[from]) {
      vectorIndex[to] = vectorIndex[from]
      delete vectorIndex[from]
      saveVectorIndex()
    }
    // Update pins key
    const pinIdx = pins.indexOf(from)
    if (pinIdx !== -1) {
      pins[pinIdx] = to
      savePins()
    }
    res.json({ renamed: to })
  } catch {
    res.status(500).json({ error: 'Rename failed' })
  }
})

// ── GET /models — list pulled Ollama models ──
app.get('/models', async (req, res) => {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(5_000)
    })
    const data   = await r.json()
    const models = (data.models || []).map(m => m.name)
    res.json({ models })
  } catch {
    res.status(500).json({ error: 'Could not reach Ollama' })
  }
})

// ── GET /library — curated list of popular Ollama models ──
const MODEL_LIBRARY = [
  { name: 'llama3.2',        description: 'Meta · 3B · fast everyday model',           size: '2.0 GB' },
  { name: 'llama3.2:1b',     description: 'Meta · 1B · ultra-fast, minimal RAM',        size: '1.3 GB' },
  { name: 'llama3.1',        description: 'Meta · 8B · strong general purpose',         size: '4.7 GB' },
  { name: 'llama3.1:70b',    description: 'Meta · 70B · best quality, needs ~48GB RAM', size: '40 GB'  },
  { name: 'mistral',         description: 'Mistral · 7B · fast and capable',            size: '4.1 GB' },
  { name: 'mistral-nemo',    description: 'Mistral · 12B · multilingual',               size: '7.1 GB' },
  { name: 'qwen2.5',         description: 'Alibaba · 7B · strong reasoning',            size: '4.7 GB' },
  { name: 'qwen2.5:14b',     description: 'Alibaba · 14B · coding and reasoning',       size: '9.0 GB' },
  { name: 'qwen2.5:32b',     description: 'Alibaba · 32B · near-frontier quality',      size: '20 GB'  },
  { name: 'gemma2',          description: 'Google · 9B · efficient and capable',        size: '5.5 GB' },
  { name: 'gemma2:2b',       description: 'Google · 2B · tiny, runs anywhere',          size: '1.6 GB' },
  { name: 'phi4',            description: 'Microsoft · 14B · strong reasoning',         size: '9.1 GB' },
  { name: 'phi3.5',          description: 'Microsoft · 3.8B · small but smart',         size: '2.2 GB' },
  { name: 'deepseek-r1',     description: 'DeepSeek · 7B · reasoning model',            size: '4.7 GB' },
  { name: 'deepseek-r1:14b', description: 'DeepSeek · 14B · stronger reasoning',        size: '9.0 GB' },
  { name: 'deepseek-r1:32b', description: 'DeepSeek · 32B · frontier-class reasoning',  size: '19 GB'  },
  { name: 'llava',           description: 'LLaVA · 7B · vision + language',             size: '4.7 GB' },
  { name: 'codellama',       description: 'Meta · 7B · code generation',                size: '3.8 GB' },
  { name: 'nomic-embed-text',description: 'Nomic · text embeddings',                    size: '274 MB' },
]

app.get('/library', (req, res) => {
  res.json({ models: MODEL_LIBRARY })
})

// ── POST /pull — pull a model from Ollama registry (streams progress) ──
app.post('/pull', async (req, res) => {
  const { name } = req.body
  if (!validateString(name, 200)) return res.status(400).json({ error: 'Invalid model name' })
  // Allow alphanumeric, dots, colons, hyphens, underscores, slashes (for user/model:tag)
  if (!/^[a-zA-Z0-9._:\-\/]+$/.test(name)) return res.status(400).json({ error: 'Invalid model name' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  try {
    const response = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
      signal: AbortSignal.timeout(3_600_000) // 1 hour — large models take time
    })

    for await (const chunk of response.body) {
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const json = JSON.parse(line)
          res.write(`data: ${JSON.stringify(json)}\n\n`)
          if (json.status === 'success') {
            res.write('data: [DONE]\n\n')
            res.end()
          }
        } catch {}
      }
    }
  } catch {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: 'Pull failed — is Ollama running?' })}\n\n`)
      res.end()
    }
  }
})

// ── GET /skills — load skill definitions from vault ──
// Skills are .md files in SKILLS_FOLDER with frontmatter: name, prompt, description (optional)
app.get('/skills', async (req, res) => {
  try {
    const listRes = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const data   = await listRes.json()
    const prefix = SKILLS_FOLDER.endsWith('/') ? SKILLS_FOLDER : SKILLS_FOLDER + '/'
    const files  = (data.files || [])
      .filter(f => typeof f === 'string' && f.startsWith(prefix) && f.endsWith('.md'))

    if (!files.length) return res.json({ skills: [] })

    const results = await Promise.allSettled(files.map(async filename => {
      const r = await fetch(vaultUrl(filename), {
        headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
        signal: AbortSignal.timeout(10_000),
        agent: obsidianAgent
      })
      const text = await r.text()
      const fm   = parseFrontmatter(text)
      if (!fm.name || !fm.prompt) return null
      return { name: fm.name, prompt: fm.prompt, description: fm.description || '' }
    }))

    res.json({
      skills: results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
    })
  } catch {
    res.json({ skills: [] })
  }
})

// ── GET /search — full-text search across vault notes ──
app.get('/search', async (req, res) => {
  const { q } = req.query
  if (!validateString(q, 200)) return res.status(400).json({ error: 'Invalid query' })

  try {
    const listRes = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const data  = await listRes.json()
    const files = (data.files || [])
      .filter(f => typeof f === 'string' && f.endsWith('.md'))
      .sort().reverse()
      .slice(0, 100) // cap to keep response times reasonable on large vaults

    const lower   = q.toLowerCase()
    const results = await Promise.allSettled(files.map(async filename => {
      const r = await fetch(vaultUrl(filename), {
        headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
        signal: AbortSignal.timeout(5_000),
        agent: obsidianAgent
      })
      const text = await r.text()
      const body = text.replace(/^---[\s\S]*?---\n?/, '').trim()
      const idx  = body.toLowerCase().indexOf(lower)
      if (idx === -1) return null

      const start   = Math.max(0, idx - 80)
      const end     = Math.min(body.length, idx + q.length + 80)
      const snippet = (start > 0 ? '…' : '') + body.slice(start, end).replace(/\n+/g, ' ') + (end < body.length ? '…' : '')

      const name      = filename.split('/').pop().replace('.md', '')
      const dateMatch = name.match(/^(\d{4}-\d{2}-\d{2})\s+\d{2}-\d{2}\s+(.+)$/)
      const title     = dateMatch ? dateMatch[2] : name
      const date      = dateMatch ? dateMatch[1] : ''
      return { filename, title, date, snippet }
    }))

    res.json({
      results: results
        .filter(r => r.status === 'fulfilled' && r.value)
        .map(r => r.value)
    })
  } catch {
    res.status(500).json({ error: 'Search failed' })
  }
})

// ── GET /config — return current env values (masks secrets) ──
app.get('/config', (req, res) => {
  const mask = val => val ? '••••••••' : ''
  res.json({
    OLLAMA_URL:    process.env.OLLAMA_URL    || 'http://localhost:11434',
    OLLAMA_MODEL:  process.env.OLLAMA_MODEL  || 'llama3.2',
    EMBED_MODEL:   process.env.EMBED_MODEL   || 'nomic-embed-text',
    OBSIDIAN_URL:  process.env.OBSIDIAN_URL  || 'https://localhost:27124',
    OBSIDIAN_KEY:  mask(process.env.OBSIDIAN_KEY),
    VAULT_FOLDER:  process.env.VAULT_FOLDER  || '',
    SKILLS_FOLDER: process.env.SKILLS_FOLDER || 'Sunday/Skills',
    AGENT_KEY:     mask(process.env.AGENT_KEY),
  })
})

// ── POST /config — write updated values to .env ──
// Masked placeholder values (••••••••) are skipped — keeps existing secret intact.
// Most changes take effect immediately via process.env; OBSIDIAN_KEY and PORT
// require a server restart since they're used at startup / cached in closures.
app.post('/config', (req, res) => {
  const ALLOWED = ['OLLAMA_URL', 'OLLAMA_MODEL', 'EMBED_MODEL', 'OBSIDIAN_URL', 'OBSIDIAN_KEY', 'VAULT_FOLDER', 'SKILLS_FOLDER', 'AGENT_KEY']
  const MASKED  = '••••••••'

  // Validate incoming values
  const updates = {}
  for (const key of ALLOWED) {
    const val = req.body[key]
    if (val === undefined) continue
    if (typeof val !== 'string') return res.status(400).json({ error: `Invalid value for ${key}` })
    if (val === MASKED) continue // user didn't change this secret — skip
    if (val.includes('\n') || val.includes('\r')) return res.status(400).json({ error: `Newlines not allowed in ${key}` })
    updates[key] = val
  }

  const envPath = path.join(__dirname, '.env')

  // Parse existing .env so we don't clobber unrelated keys (e.g. PORT, HOST)
  const existing = {}
  try {
    const raw = fs.readFileSync(envPath, 'utf8')
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      const k = trimmed.slice(0, eq).trim()
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      existing[k] = v
    }
  } catch {
    // .env doesn't exist yet — we'll create it
  }

  const merged = { ...existing, ...updates }

  // Reconstruct .env preserving original comment lines
  let originalLines = []
  try { originalLines = fs.readFileSync(envPath, 'utf8').split('\n') } catch {}

  // Rebuild: keep comment/blank lines, update known keys, append new ones
  const written = new Set()
  const outputLines = originalLines.map(line => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eq = trimmed.indexOf('=')
    if (eq === -1) return line
    const k = trimmed.slice(0, eq).trim()
    if (merged[k] !== undefined) {
      written.add(k)
      return `${k}=${merged[k]}`
    }
    return line
  })

  // Append any keys that weren't already in the file
  for (const [k, v] of Object.entries(merged)) {
    if (!written.has(k)) outputLines.push(`${k}=${v}`)
  }

  try {
    fs.writeFileSync(envPath, outputLines.join('\n'), 'utf8')
  } catch {
    return res.status(500).json({ error: 'Could not write .env — check file permissions' })
  }

  // Apply non-secret changes to the live process immediately
  const liveApply = ['OLLAMA_URL', 'OLLAMA_MODEL', 'EMBED_MODEL', 'VAULT_FOLDER', 'SKILLS_FOLDER']
  for (const key of liveApply) {
    if (updates[key] !== undefined) process.env[key] = updates[key]
  }

  // These need a restart to take full effect
  const needsRestart = ['OBSIDIAN_URL', 'OBSIDIAN_KEY', 'AGENT_KEY'].some(k => updates[k] !== undefined)

  res.json({ saved: true, needsRestart })
})

// ── GET /index-status — how many notes are indexed ──
app.get('/index-status', (req, res) => {
  const indexed = Object.keys(vectorIndex).length
  res.json({
    indexed,
    embedModel:    EMBED_MODEL,
    embedAvailable // null = untested, true/false after first embed attempt
  })
})

// ── POST /reindex — rebuild the entire vector index from the vault ──
// Streams progress via SSE: { status, total, indexed, failed, done? }
let reindexRunning = false
app.post('/reindex', async (req, res) => {
  if (reindexRunning) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.write(`data: ${JSON.stringify({ error: 'Reindex already running' })}\n\n`)
    res.write('data: [DONE]\n\n')
    return res.end()
  }
  reindexRunning = true
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`)

  // Probe embed model first — bail early if it's not available
  const probe = await getEmbedding('test')
  if (!probe) {
    send({ error: `${EMBED_MODEL} is not available — pull it via the model picker first` })
    res.write('data: [DONE]\n\n')
    return res.end()
  }

  try {
    const listRes = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal:  AbortSignal.timeout(10_000),
      agent:   obsidianAgent
    })
    const data  = await listRes.json()
    const files = (data.files || []).filter(f => typeof f === 'string' && f.endsWith('.md'))

    send({ status: `Found ${files.length} notes`, total: files.length, indexed: 0, failed: 0 })

    let indexed = 0, failed = 0

    for (const filename of files) {
      if (res.writableEnded) break
      try {
        const r = await fetch(vaultUrl(filename), {
          headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
          signal:  AbortSignal.timeout(10_000),
          agent:   obsidianAgent
        })
        const content = await r.text()
        const ok = await indexNote(filename, content)
        if (ok) indexed++; else failed++
      } catch { failed++ }

      send({ status: `Indexed ${indexed} / ${files.length}`, total: files.length, indexed, failed })
    }

    send({ status: `Done — ${indexed} notes indexed`, total: files.length, indexed, failed, done: true })
    res.write('data: [DONE]\n\n')
    res.end()
  } catch (err) {
    send({ error: err.message || 'Reindex failed' })
    res.write('data: [DONE]\n\n')
    res.end()
  } finally {
    reindexRunning = false
  }
})

// ── POST /generate-title — generate a short title for a conversation ──
app.post('/generate-title', async (req, res) => {
  const { prompt, response, model: modelOverride = '' } = req.body
  if (!validateString(prompt) || !validateString(response, 10000)) {
    return res.status(400).json({ error: 'Invalid input' })
  }
  const activeModel = (typeof modelOverride === 'string' && modelOverride.trim()) ? modelOverride.trim() : MODEL
  const system = 'Generate a short, specific title (4–6 words) for this conversation. Return only the title — no quotes, no punctuation at the end, no explanation.'
  const content = `User: ${prompt.slice(0, 400)}

Assistant: ${response.slice(0, 400)}`
  try {
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   activeModel,
        system,
        messages: [{ role: 'user', content }],
        stream:  false,
        options: { temperature: 0.3 }
      }),
      signal: AbortSignal.timeout(30_000)
    })
    const data  = await r.json()
    const raw   = data.message?.content?.trim() || ''
    const title = raw
      .replace(/^["'""'']|["'""'']$/g, '')
      .replace(/[\/:*?"<>|#^[\]]/g, '')
      .trim()
      .slice(0, 60)
    if (!title) throw new Error('empty')
    res.json({ title })
  } catch {
    res.status(500).json({ error: 'Could not generate title' })
  }
})

// ── GET /pins ──
app.get('/pins', (req, res) => {
  res.json({ pins })
})

// ── POST /pins — add a note to pinned set ──
app.post('/pins', (req, res) => {
  const { filename } = req.body
  if (!validateVaultPath(filename)) return res.status(400).json({ error: 'Invalid filename' })
  if (!pins.includes(filename)) {
    pins.push(filename)
    savePins()
  }
  res.json({ pins })
})

// ── DELETE /pins — remove a note from pinned set ──
app.delete('/pins', (req, res) => {
  const { filename } = req.body
  if (!validateVaultPath(filename)) return res.status(400).json({ error: 'Invalid filename' })
  pins = pins.filter(f => f !== filename)
  savePins()
  res.json({ pins })
})

app.listen(PORT, HOST, () => {
  console.log(`Sunday running on http://${HOST}:${PORT}`)
  if (AGENT_KEY) {
    console.log(`Agent API: enabled (x-agent-key required)`)
  } else {
    console.log(`Agent API: open — set AGENT_KEY in .env to require auth`)
  }
})
