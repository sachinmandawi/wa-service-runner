const fs = require('fs')
const path = require('path')
const { bot } = require('../lib')

// Persistent target storage file
const TARGETS_FILE = path.join(__dirname, '../tracked_targets.json')
const DEFAULT_TARGETS = ['994402551176@s.whatsapp.net']

// In-memory status cache: msgId -> statusItem
const statusCache = new Map()
const MAX_CACHE_ITEMS = 100

// Active Baileys socket reference
let activeSock = null
let trackerAttached = false

// Helper: Normalize JID
function cleanJid(jid) {
  if (!jid || typeof jid !== 'string') return ''
  const num = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '')
  return num ? `${num}@s.whatsapp.net` : ''
}

// Helper: Load targets
function loadTargets() {
  try {
    if (fs.existsSync(TARGETS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TARGETS_FILE, 'utf8'))
      if (Array.isArray(data) && data.length > 0) {
        return data.map(cleanJid).filter(Boolean)
      }
    }
  } catch (err) {
    console.error('[StatusTracker] Error reading targets file:', err.message)
  }
  // Fallback to default
  saveTargets(DEFAULT_TARGETS)
  return [...DEFAULT_TARGETS]
}

// Helper: Save targets
function saveTargets(targets) {
  try {
    const cleaned = Array.from(new Set(targets.map(cleanJid).filter(Boolean)))
    fs.writeFileSync(TARGETS_FILE, JSON.stringify(cleaned, null, 2), 'utf8')
    return cleaned
  } catch (err) {
    console.error('[StatusTracker] Error saving targets file:', err.message)
    return targets
  }
}

// Helper: Check if a JID is tracked
function isTarget(jid) {
  const norm = cleanJid(jid)
  if (!norm) return false
  const list = loadTargets()
  return list.includes(norm)
}

// Helper: Get bot owner's private chat JID
function getOwnerJid(sock) {
  if (sock?.user?.id) {
    return cleanJid(sock.user.id)
  }
  try {
    const config = require('../config')
    if (config.SUDO) {
      const firstSudo = config.SUDO.split(',')[0].trim()
      return cleanJid(firstSudo)
    }
  } catch (e) {}
  return null
}

// Helper: Download media from Baileys message
async function downloadMediaBuffer(messageContent, mediaType) {
  let downloadContentFromMessage = null
  try {
    const baileys = require('baileys')
    downloadContentFromMessage = baileys.downloadContentFromMessage
  } catch (e1) {
    try {
      const { loadBaileys } = require('../lib/baileys')
      const b = await loadBaileys()
      downloadContentFromMessage = b.downloadContentFromMessage
    } catch (e2) {}
  }

  if (!downloadContentFromMessage) {
    throw new Error('downloadContentFromMessage function not found')
  }

  const stream = await downloadContentFromMessage(messageContent, mediaType)
  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }
  return buffer
}

// Helper: Send status item to owner DM
async function forwardStatusToOwner(sock, item, alertType) {
  if (!sock) return
  const ownerJid = getOwnerJid(sock)
  if (!ownerJid) {
    console.error('[StatusTracker] Owner JID could not be determined!')
    return
  }

  const targetNumber = item.targetJid.replace('@s.whatsapp.net', '')
  const postedTime = new Date(item.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
  const eventTime = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })

  let header = ''
  if (alertType === 'deleted') {
    header =
      `🚨 *SECRET TARGET TRACKER — STATUS DELETED!* 🕵️‍♂️\n\n` +
      `👤 *Target:* @${targetNumber}\n` +
      `📅 *Posted At:* ${postedTime}\n` +
      `🗑️ *Deleted At:* ${eventTime}\n` +
      `⚠️ *This status was just deleted by the target!*`
  } else {
    header =
      `⏳ *SECRET TARGET TRACKER — STATUS EXPIRED!* ⏱️\n\n` +
      `👤 *Target:* @${targetNumber}\n` +
      `📅 *Posted At:* ${postedTime}\n` +
      `⌛ *Expired At:* ${eventTime}\n` +
      `ℹ️ *24 hours completed — status removed from WhatsApp.*`
  }

  const mentions = [item.targetJid]

  try {
    if (item.type === 'image' && item.buffer) {
      const caption = `${header}\n\n📝 *Caption:* ${item.caption || '_(No Caption)_'}`
      await sock.sendMessage(ownerJid, { image: item.buffer, caption, mentions })
    } else if (item.type === 'video' && item.buffer) {
      const caption = `${header}\n\n📝 *Caption:* ${item.caption || '_(No Caption)_'}`
      await sock.sendMessage(ownerJid, { video: item.buffer, caption, mentions })
    } else if (item.type === 'audio' && item.buffer) {
      await sock.sendMessage(ownerJid, { text: header, mentions })
      await sock.sendMessage(ownerJid, { audio: item.buffer, mimetype: item.mimetype || 'audio/mp4', ptt: true })
    } else {
      const fullText = `${header}\n\n💬 *Status Text:*\n\n"${item.text || item.caption || '_(Empty Status)_'}"`
      await sock.sendMessage(ownerJid, { text: fullText, mentions })
    }
    console.log(`[StatusTracker] Successfully forwarded ${alertType} status of ${targetNumber} to owner.`)
  } catch (err) {
    console.error(`[StatusTracker] Failed to send status to owner:`, err.message)
  }
}

// Process and cache incoming status
async function cacheIncomingStatus(sock, msg, targetJid) {
  const msgId = msg.key.id
  if (statusCache.has(msgId)) return

  const m = msg.message
  if (!m) return

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

// Background worker: check for 24-hour expiration
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
  if (trackerAttached) return
  trackerAttached = true

  console.log('[StatusTracker] Attached to WhatsApp Baileys socket.')

  // 1. messages.upsert (Detect new statuses & protocol revokes)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    try {
      if (!Array.isArray(messages)) return
      for (const msg of messages) {
        if (!msg || !msg.key) continue

        const remoteJid = msg.key.remoteJid
        const participant = msg.key.participant || msg.participant

        // Check incoming status
        if (remoteJid === 'status@broadcast' && participant) {
          const normPart = cleanJid(participant)
          if (isTarget(normPart)) {
            await cacheIncomingStatus(sock, msg, normPart)
          }
        }

        // Check protocolMessage for delete (REVOKE = 0)
        const protoMsg = msg.message?.protocolMessage
        if (protoMsg && protoMsg.type === 0) {
          const revKey = protoMsg.key
          if (revKey && revKey.remoteJid === 'status@broadcast' && revKey.id) {
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
        if (!u || !u.key) continue
        if (u.key.remoteJid === 'status@broadcast' && u.key.id) {
          if (u.update && (u.update.message === null || u.update.status === 0)) {
            await handleStatusRevoked(sock, u.key.id)
          }
        }
      }
    } catch (err) {
      console.error('[StatusTracker] Update handler error:', err.message)
    }
  })
}

// Hook into Client.prototype.connect to auto-attach on startup
try {
  const { Client } = require('../lib/client')
  if (Client && Client.prototype && Client.prototype.connect) {
    const originalConnect = Client.prototype.connect
    Client.prototype.connect = async function () {
      const res = await originalConnect.apply(this, arguments)
      if (this.client) {
        attachTracker(this.client)
      }
      return res
    }
  }
} catch (e) {}

// Fallback message listeners to guarantee attachment
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

    // .trackstatus list OR .trackstatus
    if (!rawMatch || subCmd === 'list') {
      const targets = loadTargets()
      const listText =
        targets.length > 0
          ? targets.map((t, idx) => `${idx + 1}. \`${t}\` (@${t.replace('@s.whatsapp.net', '')})`).join('\n')
          : '_(No targets currently tracked)_'

      const msg =
        `🎯 *SECRET TARGET STATUS TRACKER*\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📌 *Monitored Target JIDs:*\n${listText}\n\n` +
        `💾 *Active Cached Statuses:* ${statusCache.size}\n\n` +
        `🛠️ *Available Commands:*\n` +
        `• \`.trackstatus add <jid>\` — Add a new target JID\n` +
        `• \`.trackstatus del <jid>\` — Remove a target JID\n` +
        `• \`.trackstatus test\` — Send a test verification alert\n` +
        `• \`.trackstatus list\` — View monitored target list\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `💡 *Feature Rule:*\n` +
        `Whenever a monitored target posts a status and *DELETES* it, or when it *EXPIRES* after 24h — the media & text will be forwarded directly to your *Private DM*!`

      return await message.send(msg, { contextInfo: { mentionedJid: targets } })
    }

    // .trackstatus test
    if (subCmd === 'test') {
      const ownerJid = getOwnerJid(message.client)
      if (!ownerJid) return await message.send('❌ Could not identify owner private chat.')

      const testAlert =
        `🔔 *TRACKER TEST ALERT (System Verified!)* 🕵️‍♂️\n\n` +
        `✅ Your Private DM receiver is working perfectly!\n` +
        `Whenever a monitored target deletes a status or when it expires after 24 hours, it will be delivered directly here.`

      await message.client.sendMessage(ownerJid, { text: testAlert })
      return await message.send('✅ Test alert has been sent to your private chat (Message Yourself)!')
    }

    // .trackstatus add <jid>
    if (subCmd === 'add') {
      const inputJid = targetArg || message.reply_message?.participant || message.reply_message?.jid
      const jid = cleanJid(inputJid)
      if (!jid) {
        return await message.send('❌ Please provide a valid JID (or reply to target message).\nExample: `.trackstatus add 994402551176@s.whatsapp.net`')
      }
      const targets = loadTargets()
      if (targets.includes(jid)) {
        return await message.send(`⚠️ This JID is already being tracked:\n\`${jid}\` (@${jid.replace('@s.whatsapp.net', '')})`, {
          contextInfo: { mentionedJid: [jid] },
        })
      }
      targets.push(jid)
      saveTargets(targets)
      return await message.send(
        `✅ *Target JID Added Successfully!*\n\`${jid}\`\nStatus updates from @${jid.replace('@s.whatsapp.net', '')} will now be forwarded upon deletion or expiration.`,
        { contextInfo: { mentionedJid: [jid] } }
      )
    }

    // .trackstatus del <jid>
    if (subCmd === 'del' || subCmd === 'remove') {
      const inputJid = targetArg || message.reply_message?.participant || message.reply_message?.jid
      const jid = cleanJid(inputJid)
      if (!jid) {
        return await message.send('❌ Please provide a valid JID.\nExample: `.trackstatus del 994402551176@s.whatsapp.net`')
      }
      let targets = loadTargets()
      if (!targets.includes(jid)) {
        return await message.send('⚠️ This JID is not in the tracked list.')
      }
      targets = targets.filter((t) => t !== jid)
      saveTargets(targets)
      return await message.send(`🗑️ Target JID removed:\n\`${jid}\` (@${jid.replace('@s.whatsapp.net', '')})`, {
        contextInfo: { mentionedJid: [jid] },
      })
    }

    // Direct JID passed: .trackstatus 994402551176@s.whatsapp.net
    const directJid = cleanJid(rawMatch)
    if (directJid) {
      const targets = loadTargets()
      if (!targets.includes(directJid)) {
        targets.push(directJid)
        saveTargets(targets)
        return await message.send(
          `✅ *Target JID Added Successfully!*\n\`${directJid}\`\nNow tracking status updates from @${directJid.replace('@s.whatsapp.net', '')}.`,
          { contextInfo: { mentionedJid: [directJid] } }
        )
      } else {
        return await message.send(`ℹ️ This target JID is already being tracked:\n\`${directJid}\` (@${directJid.replace('@s.whatsapp.net', '')})`, {
          contextInfo: { mentionedJid: [directJid] },
        })
      }
    }

    return await message.send('❓ Command not recognized. Send `.trackstatus` for instructions.')
  }
)
