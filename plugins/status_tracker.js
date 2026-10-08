const { bot, setVar, getVars, delVar } = require('../lib')

// In-memory status cache: msgId -> statusItem
const statusCache = new Map()
const MAX_CACHE_ITEMS = 200

// In-memory target cache for 0ms lookup latency
let cachedTargets = []

// Active Baileys socket reference
let activeSock = null
let trackerAttached = false
const attachedSockets = new WeakSet()

// Helper: Normalize any JID or phone number to pure WhatsApp JID
function cleanJid(jid) {
  if (!jid || typeof jid !== 'string') return ''
  const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
  return num ? `${num}@s.whatsapp.net` : ''
}

// Helper: Parse multiple JIDs from string (comma, newline, or space separated)
function parseJids(input) {
  if (!input || typeof input !== 'string') return []
  const tokens = input.split(/[\s,]+/).filter(Boolean)
  const results = []
  for (const token of tokens) {
    const cleaned = cleanJid(token)
    if (cleaned && !results.includes(cleaned)) {
      results.push(cleaned)
    }
  }
  return results
}

// Sync cached targets from process.env on boot
if (process.env.STATUS_TRACKER) {
  cachedTargets = parseJids(process.env.STATUS_TRACKER)
}

// Helper: Load targets from Levanter's vars / database
async function loadTargets(messageId) {
  try {
    const vars = await getVars(messageId)
    const raw = vars?.STATUS_TRACKER || process.env.STATUS_TRACKER || ''
    const list = parseJids(raw)
    cachedTargets = list
    return list
  } catch (err) {
    if (process.env.STATUS_TRACKER) {
      cachedTargets = parseJids(process.env.STATUS_TRACKER)
      return cachedTargets
    }
    return cachedTargets
  }
}

// Helper: Save targets via Levanter setVar (persists to Render and displays in .allvar)
async function saveTargets(targets, messageId) {
  const cleaned = Array.from(new Set(targets.map(cleanJid).filter(Boolean)))
  cachedTargets = cleaned
  const val = cleaned.join(',')

  try {
    if (cleaned.length > 0) {
      await setVar({ STATUS_TRACKER: val }, messageId)
      process.env.STATUS_TRACKER = val
    } else {
      await delVar('STATUS_TRACKER', messageId)
      delete process.env.STATUS_TRACKER
    }
  } catch (err) {
    console.error('[StatusTracker] Error saving targets via setVar:', err.message)
    process.env.STATUS_TRACKER = val
  }
  return cleaned
}

// Helper: Check if a JID is tracked
function isTarget(jid) {
  const norm = cleanJid(jid)
  if (!norm) return false
  return cachedTargets.includes(norm)
}

// Helper: Get bot owner's private chat JIDs (both SUDO and bot number to guarantee delivery)
function getAlertRecipients(sock) {
  const recipients = new Set()
  try {
    const config = require('../config')
    if (config.SUDO) {
      const sudos = config.SUDO.split(',').map(cleanJid).filter(Boolean)
      for (const s of sudos) recipients.add(s)
    }
  } catch (e) {}

  if (sock?.user?.id) {
    const botNum = cleanJid(sock.user.id)
    if (botNum) recipients.add(botNum)
  }
  return Array.from(recipients)
}

// Helper: Download media from Baileys message
async function downloadMediaBuffer(messageContent, mediaType) {
  let downloadFn = null
  try {
    const baileys = require('baileys')
    downloadFn = baileys.downloadContentFromMessage
  } catch (e1) {
    try {
      const { loadBaileys } = require('../lib/baileys')
      const b = await loadBaileys()
      downloadFn = b.downloadContentFromMessage
    } catch (e2) {
      try {
        const baileys = require('@whiskeysockets/baileys')
        downloadFn = baileys.downloadContentFromMessage
      } catch (e3) {}
    }
  }

  if (!downloadFn) {
    throw new Error('downloadContentFromMessage function not found in baileys')
  }

  const stream = await downloadFn(messageContent, mediaType)
  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }
  return buffer
}

// Helper: Send status item to owner's private DM
async function forwardStatusToOwner(sock, item, alertType) {
  if (!sock) return
  const recipients = getAlertRecipients(sock)
  if (recipients.length === 0) {
    console.error('[StatusTracker] No alert recipients found!')
    return
  }

  const postedTime = new Date(item.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  const eventTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })

  let header = ''
  if (alertType === 'deleted') {
    header =
      `🚨 *SECRET TARGET TRACKER — STATUS DELETED!* 🕵️‍♂️\n\n` +
      `👤 *Target JID:* ${item.targetJid}\n` +
      `📅 *Posted At:* ${postedTime}\n` +
      `🗑️ *Deleted At:* ${eventTime}\n` +
      `⚠️ *This status was just deleted by the target!*`
  } else {
    header =
      `⏳ *SECRET TARGET TRACKER — STATUS EXPIRED!* ⏱️\n\n` +
      `👤 *Target JID:* ${item.targetJid}\n` +
      `📅 *Posted At:* ${postedTime}\n` +
      `⌛ *Expired At:* ${eventTime}\n` +
      `ℹ️ *24 hours completed — status removed from WhatsApp.*`
  }

  for (const recipient of recipients) {
    try {
      if (item.type === 'image' && item.buffer) {
        const caption = `${header}\n\n📝 *Caption:* ${item.caption || '_(No Caption)_'}`
        await sock.sendMessage(recipient, { image: item.buffer, caption })
      } else if (item.type === 'video' && item.buffer) {
        const caption = `${header}\n\n📝 *Caption:* ${item.caption || '_(No Caption)_'}`
        await sock.sendMessage(recipient, { video: item.buffer, caption })
      } else if (item.type === 'audio' && item.buffer) {
        await sock.sendMessage(recipient, { text: header })
        await sock.sendMessage(recipient, { audio: item.buffer, mimetype: item.mimetype || 'audio/mp4', ptt: true })
      } else {
        const fullText = `${header}\n\n💬 *Status Text:*\n\n"${item.text || item.caption || '_(Empty Status)_'}"`
        await sock.sendMessage(recipient, { text: fullText })
      }
      console.log(`[StatusTracker] Successfully forwarded ${alertType} status of ${item.targetJid} to ${recipient}`)
    } catch (err) {
      console.error(`[StatusTracker] Failed to send status to ${recipient}:`, err.message)
    }
  }
}

// Process and cache incoming status
async function cacheIncomingStatus(sock, msg, targetJid) {
  const msgId = msg?.key?.id
  if (!msgId || statusCache.has(msgId)) return

  let m = msg.message
  if (!m) return
  if (m.viewOnceMessage?.message) m = m.viewOnceMessage.message
  if (m.viewOnceMessageV2?.message) m = m.viewOnceMessageV2.message
  if (m.ephemeralMessage?.message) m = m.ephemeralMessage.message

  let type = 'text'
  let buffer = null
  let text = ''
  let caption = ''
  let mimetype = ''

  try {
    if (m.imageMessage) {
      type = 'image'
      caption = m.imageMessage.caption || ''
      mimetype = m.imageMessage.mimetype || 'image/jpeg'
      buffer = await downloadMediaBuffer(m.imageMessage, 'image')
    } else if (m.videoMessage) {
      type = 'video'
      caption = m.videoMessage.caption || ''
      mimetype = m.videoMessage.mimetype || 'video/mp4'
      buffer = await downloadMediaBuffer(m.videoMessage, 'video')
    } else if (m.audioMessage) {
      type = 'audio'
      mimetype = m.audioMessage.mimetype || 'audio/mp4'
      buffer = await downloadMediaBuffer(m.audioMessage, 'audio')
    } else if (m.extendedTextMessage || m.conversation) {
      type = 'text'
      text = m.extendedTextMessage?.text || m.conversation || ''
    }
  } catch (err) {
    console.error(`[StatusTracker] Error downloading status media (${msgId}):`, err.message)
  }

  const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()
  const expireAt = timestamp + 24 * 60 * 60 * 1000 // 24 hours

  const item = {
    id: msgId,
    targetJid,
    timestamp,
    expireAt,
    type,
    caption,
    text,
    buffer,
    mimetype,
    forwarded: false,
    deleted: false,
  }

  // Prevent memory bloat
  if (statusCache.size >= MAX_CACHE_ITEMS) {
    const oldestKey = statusCache.keys().next().value
    statusCache.delete(oldestKey)
  }

  statusCache.set(msgId, item)
  console.log(`[StatusTracker] Cached new status (${type}) from ${targetJid}. ID: ${msgId}`)
}

// Handle deleted / revoked status
async function handleStatusRevoked(sock, statusId) {
  const item = statusCache.get(statusId)
  if (!item || item.forwarded) return

  item.forwarded = true
  item.deleted = true
  await forwardStatusToOwner(sock, item, 'deleted')
  statusCache.delete(statusId)
}

// Background worker: check for 24-hour expiration every 30 seconds
setInterval(async () => {
  if (!activeSock) return
  const now = Date.now()

  for (const [statusId, item] of statusCache.entries()) {
    if (!item.forwarded && !item.deleted && now >= item.expireAt) {
      item.forwarded = true
      await forwardStatusToOwner(activeSock, item, 'expired')
      statusCache.delete(statusId)
    }
  }
}, 30000)

// Attach tracker to Baileys socket
function attachTracker(sock) {
  if (!sock || !sock.ev) return
  activeSock = sock
  if (attachedSockets.has(sock)) return
  attachedSockets.add(sock)
  trackerAttached = true

  console.log('[StatusTracker] Successfully hooked into WhatsApp Baileys socket!')

  // 1. messages.upsert (Detect new statuses & protocol revokes)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (!Array.isArray(messages)) return
      for (const msg of messages) {
        if (!msg || !msg.key) continue

        const remoteJid = msg.key.remoteJid
        const participant = msg.key.participant || msg.participant || (msg.key.fromMe ? sock.user?.id : '')

        // Check incoming status
        if (remoteJid === 'status@broadcast' && participant) {
          const normPart = cleanJid(participant)
          if (isTarget(normPart)) {
            console.log(`[StatusTracker] Status detected from target: ${normPart}`)
            await cacheIncomingStatus(sock, msg, normPart)
          }
        }

        // Check protocolMessage for delete (REVOKE = 0)
        const protoMsg = msg.message?.protocolMessage
        if (protoMsg && (protoMsg.type === 0 || protoMsg.type === 'REVOKE')) {
          const revKey = protoMsg.key
          if (revKey?.id && statusCache.has(revKey.id)) {
            console.log(`[StatusTracker] Status revoke detected via protocolMessage: ${revKey.id}`)
            await handleStatusRevoked(sock, revKey.id)
          }
        }
      }
    } catch (err) {
      console.error('[StatusTracker] Upsert handler error:', err.message)
    }
  })

  // 2. messages.update (Backup check for message delete events)
  sock.ev.on('messages.update', async (updates) => {
    try {
      if (!Array.isArray(updates)) return
      for (const u of updates) {
        const id = u?.key?.id
        if (id && statusCache.has(id)) {
          if (u.update?.message === null || u.update?.status === 0 || u.update?.messageStubType === 1) {
            console.log(`[StatusTracker] Status revoke detected via messages.update: ${id}`)
            await handleStatusRevoked(sock, id)
          }
        }
      }
    } catch (err) {
      console.error('[StatusTracker] Update handler error:', err.message)
    }
  })
}

// Early socket capture: hook into Base and Message class constructors
try {
  const basePath = require.resolve('../lib/class/Base')
  const OriginalBase = require(basePath)
  if (OriginalBase) {
    function WrappedBase(client) {
      if (client) {
        try { attachTracker(client) } catch (e) {}
      }
      return Reflect.construct(OriginalBase, [client], new.target || WrappedBase)
    }
    WrappedBase.prototype = Object.create(OriginalBase.prototype)
    WrappedBase.prototype.constructor = WrappedBase
    require.cache[basePath].exports = WrappedBase
  }
} catch (e) {}

try {
  const msgPath = require.resolve('../lib/class/Message')
  const OriginalMessage = require(msgPath)
  if (OriginalMessage) {
    function WrappedMessage(client, data) {
      if (client) {
        try { attachTracker(client) } catch (e) {}
      }
      return Reflect.construct(OriginalMessage, [client, data], new.target || WrappedMessage)
    }
    WrappedMessage.prototype = Object.create(OriginalMessage.prototype)
    WrappedMessage.prototype.constructor = WrappedMessage
    require.cache[msgPath].exports = WrappedMessage
  }
} catch (e) {}

// Global message event listeners to guarantee socket attachment on ANY message
bot({ on: 'message', fromMe: false }, async (message) => {
  if (message?.client) attachTracker(message.client)
})
bot({ on: 'message', fromMe: true }, async (message) => {
  if (message?.client) attachTracker(message.client)
})
bot({ on: 'text', fromMe: false }, async (message) => {
  if (message?.client) attachTracker(message.client)
})
bot({ on: 'text', fromMe: true }, async (message) => {
  if (message?.client) attachTracker(message.client)
})

// User Commands: .trackstatus
bot(
  {
    pattern: 'trackstatus ?(.*)',
    desc: '🎯 Secret Target Status Tracker (Anti-Delete & 24h Expiry Forwarder)',
    type: 'whatsapp',
  },
  async (message, match) => {
    if (message?.client) attachTracker(message.client)

    const rawMatch = (match || '').trim()
    const parts = rawMatch.split(/\s+/)
    const subCmd = parts[0]?.toLowerCase()
    const targetArg = parts.slice(1).join(' ').trim()

    // 1. .trackstatus test
    if (subCmd === 'test') {
      const sock = message.client || activeSock
      const recipients = getAlertRecipients(sock)
      const current = await loadTargets(message.id)

      const testMsg =
        `🎯 *SECRET STATUS TRACKER — TEST VERIFICATION* 🕵️‍♂️\n\n` +
        `✅ Status Tracker socket listener is *ONLINE*.\n` +
        `📌 *Tracked Target JIDs (${current.length}):*\n${current.length > 0 ? current.map((t, i) => `${i + 1}. \`${t}\``).join('\n') : '_(None)_'}\n\n` +
        `💾 *Active Cached Statuses:* ${statusCache.size}\n` +
        `⚙️ *Database Variable:* \`STATUS_TRACKER\` (Visible in \`.allvar\`)\n` +
        `📬 *Delivery Recipient DMs:* ${recipients.join(', ')}\n\n` +
        `Whenever any monitored target posts a status and deletes it, or when 24 hours expire, the media & text will be forwarded to your DM here!`

      for (const r of recipients) {
        try {
          if (sock) await sock.sendMessage(r, { text: testMsg })
        } catch (e) {}
      }
      return await message.send(`✅ *Test verification alert dispatched!*\n\n📬 *Delivery DMs:* ${recipients.join(', ')}`)
    }

    // 2. .trackstatus add <jid/number>
    if (subCmd === 'add') {
      const inputJids = parseJids(targetArg)
      if (inputJids.length === 0) {
        return await message.send(
          `❌ *Invalid Target JID or Number!*\n\n` +
          `💡 *Usage:* \`.trackstatus add <number_or_jid>\`\n` +
          `📌 *Example (Single):* \`.trackstatus add 994402551176@s.whatsapp.net\`\n` +
          `📌 *Example (Multiple):* \`.trackstatus add 994402551176@s.whatsapp.net, 916264080665@s.whatsapp.net\``
        )
      }

      const current = await loadTargets(message.id)
      const newlyAdded = []
      for (const j of inputJids) {
        if (!current.includes(j)) {
          current.push(j)
          newlyAdded.push(j)
        }
      }

      if (newlyAdded.length === 0) {
        return await message.send(
          `⚠️ *Target(s) already in monitoring list!*\n\n` +
          `${current.map((t, i) => `${i + 1}. \`${t}\``).join('\n')}`
        )
      }

      // Persist to Levanter DB / Render env-vars so it appears in .allvar
      await saveTargets(current, message.id)

      const listStr = current.map((t, i) => `${i + 1}. \`${t}\``).join('\n')
      return await message.send(
        `✅ *Target(s) Successfully Added to Tracker!* 🎯\n\n` +
        `➕ *Newly Added:* ${newlyAdded.join(', ')}\n\n` +
        `📌 *Currently Monitored Targets (${current.length}):*\n${listStr}\n\n` +
        `💾 *Database Variable:* \`STATUS_TRACKER = ${current.join(',')}\` is now saved and active in \`.allvar\`!\n\n` +
        `💡 *Note:* Deleted & 24h expired statuses from these targets will be forwarded directly to your personal DM.`
      )
    }

    // 3. .trackstatus del <jid/number>
    if (subCmd === 'del' || subCmd === 'delete' || subCmd === 'remove') {
      const inputJids = parseJids(targetArg)
      if (inputJids.length === 0) {
        return await message.send(
          `❌ *Invalid Target JID or Number!*\n\n` +
          `💡 *Usage:* \`.trackstatus del <number_or_jid>\`\n` +
          `📌 *Example:* \`.trackstatus del 994402551176@s.whatsapp.net\``
        )
      }

      const current = await loadTargets(message.id)
      const remaining = current.filter(t => !inputJids.includes(t))

      if (remaining.length === current.length) {
        return await message.send(
          `⚠️ *Target(s) were not found in the monitored list.*\n\n` +
          `${current.length > 0 ? current.map((t, i) => `${i + 1}. \`${t}\``).join('\n') : '_(List is empty)_'}`
        )
      }

      await saveTargets(remaining, message.id)

      return await message.send(
        `🗑️ *Target(s) Successfully Removed!* 🎯\n\n` +
        `➖ *Removed:* ${inputJids.join(', ')}\n\n` +
        `📌 *Remaining Targets (${remaining.length}):*\n${remaining.length > 0 ? remaining.map((t, i) => `${i + 1}. \`${t}\``).join('\n') : '_(None)_'}\n\n` +
        `💾 *Database Updated:* \`STATUS_TRACKER\` in \`.allvar\` has been updated.`
      )
    }

    // 4. Default: .trackstatus OR .trackstatus list
    const targets = await loadTargets(message.id)
    const targetsListStr =
      targets.length > 0
        ? targets.map((t, i) => `${i + 1}. \`${t}\``).join('\n')
        : '_(No targets monitored yet)_'

    const helpText =
      `🎯 *SECRET TARGET STATUS TRACKER* 🕵️‍♂️\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📌 *Monitored Targets (${targets.length}):*\n` +
      `${targetsListStr}\n\n` +
      `💾 *Active Cached Statuses:* ${statusCache.size}\n` +
      `⚙️ *Database Variable:* \`STATUS_TRACKER\` (Visible in \`.allvar\`)\n\n` +
      `🛠️ *Available Commands:*\n` +
      `• \`.trackstatus add <number_or_jid>\` — Add target(s)\n` +
      `• \`.trackstatus del <number_or_jid>\` — Remove target(s)\n` +
      `• \`.trackstatus test\` — Send test verification alert to DM\n` +
      `• \`.trackstatus list\` — View monitored target list\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `💡 *Feature Rule:*\n` +
      `Whenever a monitored target posts a status and *DELETES* it, or when it *EXPIRES* after 24h — the photo, video, or text will be forwarded directly to your *Private DM*!`

    return await message.send(helpText)
  }
)
