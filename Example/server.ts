import { Boom } from '@hapi/boom'
import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import qrcode from 'qrcode-terminal'
import http, { IncomingMessage, ServerResponse } from 'http'
import { URL } from 'url'
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, proto, useMultiFileAuthState, WAMessageContent, WAMessageKey } from '../src'
import type { CacheStore } from '../src/Types/Socket'

// Logger similar to example
const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }, P.destination('./wa-logs.txt'))
logger.level = 'trace'

// Adapt NodeCache to CacheStore
const nodeCache = new NodeCache()
const msgRetryCounterCache: CacheStore = {
  get: (key) => nodeCache.get(key) as any,
  set: (key, value) => void nodeCache.set(key, value as any),
  del: (key) => void nodeCache.del(key),
  flushAll: () => void nodeCache.flushAll(),
}

let sock: ReturnType<typeof makeWASocket> | null = null

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: true,
    getMessage,
  })

  sock.ev.process(async (events) => {
    if (events['connection.update']) {
      const update = events['connection.update']
      const { connection, lastDisconnect } = update
      if (update.qr) {
        console.log('Escaneie o QR abaixo:')
        qrcode.generate(update.qr, { small: true })
      }
      if (connection === 'close') {
        if ((lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
          startSock()
        } else {
          console.log('Connection closed. You are logged out.')
        }
      }
      if (connection) {
        console.log('connection update', update)
      }
    }
    if (events['creds.update']) {
      await saveCreds()
    }
  })
}

async function getMessage(key: WAMessageKey): Promise<WAMessageContent | undefined> {
  return proto.Message.fromObject({ conversation: 'test' })
}

// Helpers
function parseJSONBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => {
      if (!data) return resolve({})
      try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON body')) }
    })
    req.on('error', reject)
  })
}

function sendJSON(res: ServerResponse, status: number, payload: any) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body).toString() })
  res.end(body)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJSON(res, 200, { ok: true, status: sock ? 'ready' : 'starting' })
  }

  if (req.method === 'POST' && url.pathname === '/createCommunity') {
    try {
      if (!sock) return sendJSON(res, 503, { error: 'Socket not ready' })
      const body = await parseJSONBody(req)
      const { name, description } = body || {}
      // Placeholder: implement your creation logic using sock
      return sendJSON(res, 200, { ok: true, route: 'createCommunity', received: { name, description } })
    } catch (err: any) {
      logger.error({ err }, 'createCommunity failed')
      return sendJSON(res, 400, { error: err?.message || 'Bad Request' })
    }
  }

  if (req.method === 'POST' && url.pathname === '/createGroupCommunity') {
    try {
      if (!sock) return sendJSON(res, 503, { error: 'Socket not ready' })
      const body = await parseJSONBody(req)
      const { name, contacts } = body || {}
      // Placeholder: implement your group logic using sock
      return sendJSON(res, 200, { ok: true, route: 'createGroupCommunity', received: { name, contacts } })
    } catch (err: any) {
      logger.error({ err }, 'createGroupCommunity failed')
      return sendJSON(res, 400, { error: err?.message || 'Bad Request' })
    }
  }

  if (req.method === 'POST' && url.pathname === '/getInviteInfo') {
    try {
      if (!sock) return sendJSON(res, 503, { error: 'Socket not ready' })
      const body = await parseJSONBody(req)
      const { code } = body || {}
      if (!code) return sendJSON(res, 400, { error: 'Missing code parameter' })
      const imageUrl = await sock.getGroupPictureByInviteCode(code)
      return sendJSON(res, 200, { ok: true, route: 'getInviteInfo', received: { code, imageUrl } })
    } catch (err: any) {
      logger.error({ err }, 'getInviteInfo failed')
      return sendJSON(res, 400, { error: err?.message || 'Bad Request' })
    }
  }

  sendJSON(res, 404, { error: 'Not Found' })
})

async function main() {
  await startSock()
  const PORT = Number(process.env.PORT || 9000)
  server.listen(PORT, () => {
    console.log(`HTTP server listening on http://localhost:${PORT}`)
  })
}

main().catch((e) => {
  console.error('Fatal start error', e)
  process.exit(1)
})
