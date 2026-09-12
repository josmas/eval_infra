import Fastify from 'fastify'
import { Readable } from 'node:stream'

const PORT = Number(process.env.PORT || 5000)
const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL
const LITELLM_VIRTUAL_KEY = process.env.LITELLM_VIRTUAL_KEY
const PLUGIN_API_KEYS = new Set(
  (process.env.PLUGIN_API_KEYS || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean),
)

for (const [name, value] of Object.entries({ LITELLM_BASE_URL, LITELLM_VIRTUAL_KEY })) {
  if (!value) throw new Error(`${name} must be set`)
}
if (PLUGIN_API_KEYS.size === 0) {
  throw new Error('PLUGIN_API_KEYS must be set (comma-separated list)')
}

const app = Fastify({ logger: true })

app.get('/healthz', async () => ({ ok: true }))

// Pure passthrough: check the plugin's own key, then forward as-is to
// LiteLLM using the virtual key minted for this backend. No other logic -
// extend only when a real need shows up.
app.post('/v1/chat/completions', async (request, reply) => {
  const authHeader = request.headers.authorization || ''
  const providedKey = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : ''

  if (!PLUGIN_API_KEYS.has(providedKey)) {
    return reply.code(401).send({ error: 'invalid or missing plugin API key' })
  }

  const upstream = await fetch(`${LITELLM_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${LITELLM_VIRTUAL_KEY}`,
    },
    body: JSON.stringify(request.body),
  })

  reply.code(upstream.status)
  const contentType = upstream.headers.get('content-type')
  if (contentType) reply.header('content-type', contentType)

  return reply.send(upstream.body ? Readable.fromWeb(upstream.body) : null)
})

app.listen({ port: PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err)
  process.exit(1)
})
