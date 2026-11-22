import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'

/**
 * Spoken reminders — "remind me to call the client at five".
 *
 * Saved in ~/.jarvis-reminders.json so they survive a restart. A clock in the
 * bridge checks every ten seconds; when one is due it is spoken on the JARVIS
 * screen (a `reminder` frame to every connected screen) and also shown as a
 * Windows notification, so it still reaches you when the JARVIS tab is closed
 * or muted. Reminders that fell due while JARVIS was not running are given
 * the next time it starts, marked as missed, if they are under a day old.
 */

const FILE = join(homedir(), '.jarvis-reminders.json')
const TICK_MS = 10_000
const MISSED_LIMIT_MS = 24 * 60 * 60 * 1000

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

export async function loadReminders() {
  try {
    const list = JSON.parse(await readFile(FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

async function saveReminders(list) {
  // Keep the file small: fired reminders older than a week go.
  const cutoff = Date.now() - 7 * MISSED_LIMIT_MS
  await writeFile(FILE, JSON.stringify(list.filter((r) => !r.fired || r.due > cutoff), null, 2), 'utf8')
}

/**
 * When is "at"? Accepts "17:30", "5:30 pm", "5pm", "5 30 pm", or a full date
 * and time ("2026-11-22T09:00"). A clock time that has already passed today
 * means tomorrow.
 */
export function parseWhen({ at, in_minutes: inMinutes, tomorrow }, now = new Date()) {
  if (inMinutes != null && Number.isFinite(Number(inMinutes))) {
    return new Date(now.getTime() + Number(inMinutes) * 60_000)
  }
  const raw = String(at ?? '').trim().toLowerCase().replace(/\./g, '')
  if (!raw) throw new Error('Give a time (like "5:30 pm") or a number of minutes.')
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const d = new Date(raw)
    if (Number.isNaN(d.getTime())) throw new Error(`"${at}" is not a date and time I can read.`)
    return d
  }
  const m = raw.match(/^(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm)?$/)
  if (!m) throw new Error(`"${at}" is not a time I can read. Use something like "5:30 pm" or "17:30".`)
  let h = Number(m[1])
  const min = Number(m[2] ?? 0)
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) throw new Error(`"${at}" is not a real time.`)
  const d = new Date(now)
  d.setHours(h, min, 0, 0)
  if (tomorrow) d.setDate(d.getDate() + 1)
  else if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d
}

export function sayWhen(d, now = new Date()) {
  const time = d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  const days = Math.floor((d.getTime() - day0.getTime()) / 86_400_000)
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  return `${time} ${day}`
}

export async function addReminder(text, when) {
  const list = await loadReminders()
  const r = { id: newId(), text: String(text).trim(), due: when.getTime(), fired: false, createdAt: Date.now() }
  list.push(r)
  await saveReminders(list)
  return r
}

/** Windows notification, so a reminder still reaches you with the JARVIS tab closed. */
export function toast(title, body) {
  if (process.platform !== 'win32') return
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "''")
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml('<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>${esc(title)}</text><text>${esc(body)}</text></binding></visual><actions><action content="Done" arguments="dismiss" activationType="system"/></actions><audio src="ms-winsoundevent:Notification.Reminder"/></toast>')
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15_000 }, () => {})
}

/**
 * Start the reminder clock. `broadcast(frame)` sends a frame to every JARVIS
 * screen that is connected; it returns how many received it.
 */
export function startReminderClock(broadcast) {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const list = await loadReminders()
      const now = Date.now()
      const due = list.filter((r) => !r.fired && r.due <= now)
      if (!due.length) return
      for (const r of due) {
        r.fired = true
        const missed = now - r.due > 2 * 60_000
        if (missed && now - r.due > MISSED_LIMIT_MS) continue
        const text = missed ? `Earlier, at ${sayWhen(new Date(r.due))}: ${r.text}` : r.text
        broadcast({ type: 'reminder', text, missed })
        toast('J.A.R.V.I.S. reminder', text)
        console.log(`[jarvis] reminder: ${text}`)
      }
      await saveReminders(list)
    } catch (err) {
      console.log(`[jarvis] reminder clock: ${err?.message ?? err}`)
    } finally {
      busy = false
    }
  }
  // First check a little after start, so a screen that is reconnecting gets it.
  setTimeout(tick, 8000)
  return setInterval(tick, TICK_MS)
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

export function reminderServer() {
  return createSdkMcpServer({
    name: 'jarvis_reminders',
    version: '1.0.0',
    instructions: 'Spoken reminders at a time of day or after some minutes.',
    tools: [
      tool(
        'reminder_set',
        'Set a reminder that JARVIS will say out loud (and show as a Windows notification) ' +
          'when it is due. Give either `in_minutes` ("in 20 minutes") or `at`, a clock time ' +
          'like "5:30 pm" or "17:30" (a time already past today means tomorrow), or a full ' +
          'date and time "2026-11-22T09:00". `text` is what to remind them of, in a few words.',
        {
          text: z.string().min(1).describe('What to remind them of, e.g. "call the client".'),
          at: z.string().optional().describe('Clock time or date-time, e.g. "5 pm", "17:30", "2026-11-22T09:00".'),
          in_minutes: z.number().optional().describe('Minutes from now, e.g. 20.'),
          tomorrow: z.boolean().optional().describe('true when they said "tomorrow" with a clock time.'),
        },
        async (args) => {
          try {
            const when = parseWhen(args)
            if (when.getTime() < Date.now() - 60_000) return refuse('That time has already passed.')
            const r = await addReminder(args.text, when)
            const mins = Math.round((r.due - Date.now()) / 60_000)
            return ok(`Reminder set for ${sayWhen(when)} (in ${mins} minutes): ${r.text}.`)
          } catch (err) {
            return refuse(String(err?.message ?? err))
          }
        },
      ),
      tool(
        'reminder_list',
        'List the reminders still to come, with their times.',
        {},
        async () => {
          const list = (await loadReminders()).filter((r) => !r.fired).sort((a, b) => a.due - b.due)
          if (!list.length) return ok('There are no reminders set.')
          return ok(`Now: ${sayWhen(new Date())}.\n` + list.map((r, i) => `${i + 1}. ${sayWhen(new Date(r.due))}: ${r.text}`).join('\n'))
        },
      ),
      tool(
        'reminder_cancel',
        'Cancel a reminder by a word or two from it, or "all" to cancel every one.',
        { which: z.string().min(1).describe('Words from the reminder, or "all".') },
        async ({ which }) => {
          const list = await loadReminders()
          const want = which.trim().toLowerCase()
          const pending = list.filter((r) => !r.fired)
          const hit = want === 'all' ? pending : pending.filter((r) => r.text.toLowerCase().includes(want)).slice(0, 1)
          if (!hit.length) return refuse(`No upcoming reminder matches "${which}".`)
          const ids = new Set(hit.map((r) => r.id))
          await saveReminders(list.filter((r) => !ids.has(r.id)))
          return ok(`Cancelled: ${hit.map((r) => r.text).join('; ')}.`)
        },
      ),
    ],
  })
}
