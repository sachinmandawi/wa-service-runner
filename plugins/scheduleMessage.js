const {
  bot,
  validateTime,
  createSchedule,
  delScheduleMessage,
  deleteScheduleTask,
  getScheduleMessage,
  parseSchedule,
  nlpSchedule,
  sleep,
  isGroup,
  jidToNum,
  lang,
} = require('../lib/')

// Helper to extract clean WhatsApp JIDs without greedily capturing trailing arguments
function extractJids(text = '') {
  if (!text) return []
  return (text.match(/[0-9]+(-[0-9]+|)@[a-zA-Z0-9.-]+/g) || []).map((j) => j.trim())
}

bot(
  {
    pattern: 'setschedule ?(.*)',
    desc: lang.plugins.setschedule.desc,
    type: 'schedule',
  },
  async (message, match) => {
    if (!match && !message.reply_message) {
      return await message.send(lang.plugins.setschedule.usage)
    }

    if (!message.reply_message) {
      return await message.send(lang.plugins.setschedule.no_reply)
    }

    const trimmedMatch = match ? match.trim() : ''
    const parts = trimmedMatch.split(',').map((p) => p.trim())
    const explicitJids = extractJids(trimmedMatch)
    const hasOnce = parts.some((p) => p.toLowerCase() === 'once')

    // Find valid time argument (e.g., 23-23-8-10, 0-7, 15-22, etc.)
    const timeCandidate = parts.find(
      (p) => p.toLowerCase() !== 'once' && !p.includes('@') && validateTime(p.trim())
    )

    let schedule = null

    if (timeCandidate) {
      schedule = {
        jids: explicitJids.length > 0 ? explicitJids : [message.jid],
        time: timeCandidate.trim(),
        once: hasOnce || (!parts.some((p) => p.toLowerCase() === 'daily') && parts.length > 1),
      }
    } else {
      // Try upstream parseSchedule
      schedule = parseSchedule(trimmedMatch)
      if (schedule && schedule.time) {
        schedule.time = schedule.time.trim()
      }
    }

    // Fallback to NLP if time is still not valid
    if (!schedule || !schedule.time || !validateTime(schedule.time.trim())) {
      const nlp = await nlpSchedule(trimmedMatch, message.id)
      if (nlp && nlp.time && validateTime(nlp.time.trim())) {
        schedule = nlp
      }
    }

    if (!schedule || !schedule.jids || !schedule.jids.length) {
      schedule = schedule || {}
      schedule.jids = explicitJids.length > 0 ? explicitJids : [message.jid]
    }

    const finalTime = schedule.time ? schedule.time.trim() : ''
    const isTimeValid = validateTime(finalTime)

    if (!schedule.jids.length || !isTimeValid) {
      return await message.send(lang.plugins.setschedule.usage)
    }

    for (let index = 0; index < schedule.jids.length; index++) {
      const jid = schedule.jids[index]
      const time = validateTime(finalTime, index + 1)
      const at = await createSchedule(jid, time, message, true, schedule.once, message.id)
      await message.send(
        lang.plugins.setschedule.scheduled.format(at, isGroup(jid) ? jid : jidToNum(jid)),
        {
          contextInfo: { mentionedJid: [jid] },
        }
      )
      if (schedule.jids.length > 1) await sleep(3000)
    }
  }
)

bot(
  {
    pattern: 'getschedule ?(.*)',
    desc: lang.plugins.getschedule.desc,
    type: 'schedule',
  },
  async (message, match) => {
    const [jid] = extractJids(match)
    const targetJid = jid || (match && match.includes('@') ? match.trim() : null)
    const schedules = await getScheduleMessage(targetJid, message.id)
    if (!schedules || schedules.length < 1) {
      return await message.send(lang.plugins.getschedule.not_found)
    }
    let msg = ''
    for (const schedule of schedules) {
      msg += `Jid : ${schedule.jid}\n${lang.plugins.getschedule.time.format(schedule.time)}\n\n`
    }
    return await message.send(msg.trim())
  }
)

bot(
  {
    pattern: 'delschedule ?(.*)',
    desc: lang.plugins.delschedule.desc,
    type: 'schedule',
  },
  async (message, match) => {
    if (!match) return await message.send(lang.plugins.delschedule.usage)
    const parts = match.split(',').map((p) => p.trim())
    const jidPart = parts[0]
    const timePart = parts[1] ? parts[1].trim() : null
    const [extractedJid] = extractJids(jidPart)
    let isJid = extractedJid || (jidPart === 'all' ? 'all' : jidPart)
    const isTimeValid = timePart ? validateTime(timePart) : null

    if (!isJid && match !== 'all') return await message.send(lang.plugins.delschedule.usage)
    if (!isJid) isJid = match

    const isDeleted = await delScheduleMessage(isJid, isTimeValid, message.id)
    if (!isDeleted) return await message.send(lang.plugins.delschedule.not_found)
    deleteScheduleTask(isJid, isTimeValid, message.id)
    return await message.send(lang.plugins.delschedule.deleted)
  }
)
