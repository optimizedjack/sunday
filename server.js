require('dotenv').config()
const express = require('express')
const fetch   = require('node-fetch')
const cors    = require('cors')
const path    = require('path')
const https   = require('https')
const app     = express()

// ── Config ────────────────────────────────────────────────
const OLLAMA_URL   = process.env.OLLAMA_URL   || 'http://localhost:11434'
const OBSIDIAN_URL = process.env.OBSIDIAN_URL || 'https://localhost:27124'
const OBSIDIAN_KEY = process.env.OBSIDIAN_KEY
const MODEL         = process.env.OLLAMA_MODEL  || 'llama3.2'
const VAULT_FOLDER  = process.env.VAULT_FOLDER  || ''
const SKILLS_FOLDER = process.env.SKILLS_FOLDER || 'Sunday/Skills'
const PORT         = parseInt(process.env.PORT, 10) || 3000
const HOST         = process.env.HOST || '0.0.0.0'

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

  const activeModel   = (typeof modelOverride === 'string' && modelOverride.trim()) ? modelOverride.trim() : MODEL
  const safeContext   = typeof context === 'string' ? context.slice(0, 20000) : ''
  const safeCustom    = typeof customPrompt === 'string' ? customPrompt.slice(0, 5000) : ''
  const safeMode      = ['free', 'riff', 'stuck', 'critique'].includes(mode) ? mode : 'free'
  // customPrompt (from a skill) takes precedence over the built-in mode prompt
  const modeAddendum  = safeCustom ? `\n\n${safeCustom}` : (MODE_PROMPTS[safeMode] ? `\n\n${MODE_PROMPTS[safeMode]}` : '')
  const contextBlock  = safeContext
    ? `\n\nThe following are excerpts from the user's past conversations and saved notes. Use them to inform your responses — reference them when relevant, notice patterns, build on threads the user has already been pulling on. Do not recite them back verbatim.\n\n${safeContext}`
    : ''
  const system   = `${BASE_PROMPT}${modeAddendum}${contextBlock}`
  const messages = [...history, { role: 'user', content: prompt }]

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

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

// ── POST /save ──
app.post('/save', async (req, res) => {
  const { prompt, response, tags } = req.body
  if (!validateString(prompt)) return res.status(400).json({ error: 'Invalid prompt' })
  if (!validateString(response, 100000)) return res.status(400).json({ error: 'Invalid response' })

  const now     = new Date()
  const date    = now.toISOString().slice(0, 10)
  const time    = now.toTimeString().slice(0, 5)
  const tagList = tags && typeof tags === 'string'
    ? tags.split(',').map(t => t.trim().replace(/[^\w-]/g, '').slice(0, 50)).filter(Boolean).slice(0, 10)
    : ['brain']

  const isFilename = prompt.endsWith('.md')

  if (isFilename && !validateVaultPath(prompt)) {
    return res.status(400).json({ error: 'Invalid filename' })
  }

  const safeTitle = prompt.slice(0, 40).replace(/[\\/:*?"<>|#^[\]]/g, '').trim()
  const filename  = isFilename
    ? prompt
    : (VAULT_FOLDER ? `${VAULT_FOLDER}/${date} ${safeTitle}.md` : `${date} ${safeTitle}.md`)

  const content = isFilename
    ? `---\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n${response}`
    : `---\ntitle: "${safeTitle}"\ndate: ${date}\ntime: ${time}\ntags: [${tagList.join(', ')}]\nsource: sunday\n---\n\n# ${safeTitle}\n\n## Prompt\n${prompt}\n\n## Response\n${response}\n`

  try {
    const r = await fetch(vaultUrl(filename), {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}`, 'Content-Type': 'text/markdown' },
      body: content,
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    if (!r.ok) throw new Error(`Obsidian returned ${r.status}`)
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

// ── GET /notes ──
app.get('/notes', async (req, res) => {
  try {
    const r = await fetch(`${OBSIDIAN_URL}/vault/`, {
      headers: { 'Authorization': `Bearer ${OBSIDIAN_KEY}` },
      signal: AbortSignal.timeout(10_000),
      agent: obsidianAgent
    })
    const data  = await r.json()
    const files = (data.files || [])
      .filter(f => typeof f === 'string' && f.endsWith('.md'))
      .sort().reverse().slice(0, 20)
    res.json({ notes: files })
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
  { name: 'llama3.2',        description: 'Meta · 3B · fast everyday model',          size: '2.0 GB' },
  { name: 'llama3.2:1b',     description: 'Meta · 1B · ultra-fast, minimal RAM',       size: '1.3 GB' },
  { name: 'llama3.1',        description: 'Meta · 8B · strong general purpose',        size: '4.7 GB' },
  { name: 'llama3.1:70b',    description: 'Meta · 70B · best quality, needs ~48GB RAM', size: '40 GB'  },
  { name: 'mistral',         description: 'Mistral · 7B · fast and capable',           size: '4.1 GB' },
  { name: 'mistral-nemo',    description: 'Mistral · 12B · multilingual',              size: '7.1 GB' },
  { name: 'qwen2.5',         description: 'Alibaba · 7B · strong reasoning',           size: '4.7 GB' },
  { name: 'qwen2.5:14b',     description: 'Alibaba · 14B · coding and reasoning',      size: '9.0 GB' },
  { name: 'qwen2.5:32b',     description: 'Alibaba · 32B · near-frontier quality',     size: '20 GB'  },
  { name: 'gemma2',          description: 'Google · 9B · efficient and capable',       size: '5.5 GB' },
  { name: 'gemma2:2b',       description: 'Google · 2B · tiny, runs anywhere',         size: '1.6 GB' },
  { name: 'phi4',            description: 'Microsoft · 14B · strong reasoning',        size: '9.1 GB' },
  { name: 'phi3.5',          description: 'Microsoft · 3.8B · small but smart',        size: '2.2 GB' },
  { name: 'deepseek-r1',     description: 'DeepSeek · 7B · reasoning model',           size: '4.7 GB' },
  { name: 'deepseek-r1:14b', description: 'DeepSeek · 14B · stronger reasoning',       size: '9.0 GB' },
  { name: 'deepseek-r1:32b', description: 'DeepSeek · 32B · frontier-class reasoning', size: '19 GB'  },
  { name: 'llava',           description: 'LLaVA · 7B · vision + language',            size: '4.7 GB' },
  { name: 'codellama',       description: 'Meta · 7B · code generation',               size: '3.8 GB' },
  { name: 'nomic-embed-text',description: 'Nomic · text embeddings',                   size: '274 MB' },
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

app.listen(PORT, HOST, () => {
  console.log(`Sunday running on http://${HOST}:${PORT}`)
})
