import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { watch } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import si from 'systeminformation'
import { checkInternet } from './pccontrol.mjs'
import { toast } from './reminders.mjs'

/**
 * Guardian mode — JARVIS watching your back and speaking up by himself:
 * battery running low or the charger pulled, the graphics card running hot,
 * the CPU or memory maxed out for minutes on end, the disk nearly full, the
 * internet dropping and coming back, and downloads finishing.
 *
 * Each warning has a cooldown so he says it once, not every thirty seconds.
 * Spoken through every connected JARVIS screen (an `announce` frame); the
 * serious ones (battery critical, overheating) also raise a Windows
 * notification, so they land even with the screen closed.
 *
 * On by default; "Jarvis, guardian off" turns it off, and that choice is kept
 * in ~/.jarvis-settings.json.
 */

const SETTINGS = join(homedir(), '.jarvis-settings.json')
const TICK_MS = 30_000
const DOWNLOADS = join(homedir(), 'Downloads')

let enabled = true
let learning = true // the first reading only learns the starting state
let broadcast = () => 0
const last = {} // alert key -> time it was last said
const state = {
  ac: null, // charger connected, last reading
  lowStep: 100, // lowest battery threshold already warned about this discharge
  fullSaid: false,
  online: true,
  offlineTicks: 0,
  cpu: [], // recent CPU load readings
  gpuTemp: null,
  readings: {},
}

async function loadEnabled() {
  try {
    const s = JSON.parse(await readFile(SETTINGS, 'utf8'))
    if (typeof s.guardian === 'boolean') enabled = s.guardian
  } catch {
    /* default on */
  }
}

async function saveEnabled() {
  let s = {}
  try {
    s = JSON.parse(await readFile(SETTINGS, 'utf8')) ?? {}
  } catch {
    /* first write */
  }
  s.guardian = enabled
  await writeFile(SETTINGS, JSON.stringify(s, null, 2), 'utf8')
}

/** Say something, at most once per `cooldownMs` for the same `key`. */
function alert(key, text, { cooldownMs = 10 * 60_000, urgent = false } = {}) {
  if (!enabled || learning) return
  const now = Date.now()
  if (last[key] && now - last[key] < cooldownMs) return
  last[key] = now
  console.log(`[jarvis] guardian: ${text}`)
  broadcast({ type: 'announce', text })
  if (urgent) toast('J.A.R.V.I.S.', text)
}

function gpuTemperature() {
  return new Promise((done) =>
    execFile(
      'nvidia-smi',
      ['--query-gpu=temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 5000, windowsHide: true },
      (err, out) => {
        if (err) return done(null)
        const [t, u] = String(out).split('\n')[0].split(',').map((x) => Number(x.trim()))
        done(Number.isFinite(t) ? { temp: t, load: u } : null)
      },
    ),
  )
}

async function tick() {
  if (!enabled) return
  const [battery, load, mem, disks, gpu, net] = await Promise.all([
    si.battery().catch(() => null),
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => []),
    gpuTemperature(),
    checkInternet().catch(() => ({ online: false })),
  ])

  // Battery and charger.
  if (battery?.hasBattery) {
    const pct = Math.round(battery.percent)
    const ac = Boolean(battery.acConnected || battery.isCharging)
    if (state.ac === true && !ac) alert('unplugged', `Sir, the charger has been disconnected. Battery at ${pct} percent.`, { cooldownMs: 60_000 })
    if (state.ac === false && ac) {
      state.lowStep = 100
      alert('plugged', `Charger connected. Battery at ${pct} percent.`, { cooldownMs: 60_000 })
    }
    if (ac) {
      if (pct >= 100 && !state.fullSaid) {
        state.fullSaid = true
        alert('full', 'The battery is fully charged, sir. You may unplug.', { cooldownMs: 60 * 60_000 })
      }
      if (pct < 95) state.fullSaid = false
    } else {
      for (const step of [5, 10, 20]) {
        if (pct <= step && state.lowStep > step) {
          state.lowStep = step
          alert(`low${step}`, `Sir, battery at ${pct} percent and not charging.${step <= 10 ? ' Plug in soon.' : ''}`, {
            cooldownMs: 0,
            urgent: step <= 10,
          })
          break
        }
      }
    }
    state.ac = ac
    state.readings.battery = `${pct}%${ac ? ' (charger connected)' : ' (on battery)'}`
  }

  // CPU: only a sustained maximum counts — two minutes above ninety percent.
  if (load) {
    state.cpu = [...state.cpu, load.currentLoad].slice(-4)
    const avg = state.cpu.reduce((a, b) => a + b, 0) / state.cpu.length
    if (state.cpu.length === 4 && avg >= 90) alert('cpu', `Sir, the processor has been above ninety percent for two minutes.`, { cooldownMs: 15 * 60_000 })
    state.readings.cpu = `${Math.round(load.currentLoad)}%`
  }

  // Memory.
  if (mem?.total) {
    const free = (mem.available / mem.total) * 100
    if (free < 8) alert('ram', `Sir, memory is nearly full — only ${Math.round(free)} percent left.`, { cooldownMs: 15 * 60_000 })
    state.readings.memory = `${Math.round(100 - free)}% used`
  }

  // System drive.
  const c = (Array.isArray(disks) ? disks : []).find((d) => /^c:/i.test(d.mount ?? ''))
  if (c) {
    const freeGb = (c.size - c.used) / 1e9
    if (freeGb < 5) alert('disk', `Sir, drive C has only ${freeGb.toFixed(1)} gigabytes free.`, { cooldownMs: 6 * 60 * 60_000 })
    state.readings.disk = `${freeGb.toFixed(0)} GB free on C`
  }

  // Graphics card temperature (the RTX's own sensor; Windows hides the CPU's).
  if (gpu) {
    if (gpu.temp >= 87) alert('gpuhot', `Sir, the graphics card is at ${gpu.temp} degrees.`, { cooldownMs: 10 * 60_000, urgent: true })
    state.readings.gpu = `${gpu.temp}°C, ${gpu.load}% busy`
  }

  // Internet: two failed checks in a row (a minute) before calling it down.
  if (net) {
    if (!net.online) {
      state.offlineTicks++
      if (state.offlineTicks === 2 && state.online) {
        state.online = false
        alert('offline', 'Sir, the internet connection is down.', { cooldownMs: 0 })
      }
    } else {
      if (!state.online) alert('online', 'The internet connection is back.', { cooldownMs: 0 })
      state.online = true
      state.offlineTicks = 0
    }
    state.readings.internet = state.online ? 'online' : 'offline'
  }
}

/** Finished downloads: a browser writes "x.crdownload" (or .part) and renames it to "x" when done. */
function watchDownloads() {
  const TEMP = new Set(['.crdownload', '.part', '.tmp', '.download', '.partial', '.opdownload'])
  const seen = new Map()
  try {
    watch(DOWNLOADS, (_event, name) => {
      if (!name || TEMP.has(extname(name).toLowerCase()) || name.startsWith('.') || name.startsWith('~')) return
      clearTimeout(seen.get(name))
      seen.set(
        name,
        setTimeout(async () => {
          seen.delete(name)
          const s = await stat(join(DOWNLOADS, name)).catch(() => null)
          // Only files that appeared just now: an edit or a rename of an old file does not count.
          if (!s?.isFile() || Date.now() - s.birthtimeMs > 120_000 || s.size === 0) return
          const pretty = basename(name, extname(name)).replace(/[_-]+/g, ' ').slice(0, 60)
          alert(`dl:${name}`, `Your download is complete, sir: ${pretty}.`, { cooldownMs: 60 * 60_000 })
        }, 2500),
      )
    })
  } catch (err) {
    console.log(`[jarvis] guardian: cannot watch Downloads (${err?.message ?? err})`)
  }
}

export async function startGuardian(send) {
  broadcast = send
  await loadEnabled()
  watchDownloads()
  // The first reading only learns the starting state (charger in or out,
  // online or not) — announcing "charger connected" on every start is noise.
  setTimeout(async () => {
    await tick().catch(() => {})
    learning = false
    setInterval(() => tick().catch((err) => console.log(`[jarvis] guardian: ${err?.message ?? err}`)), TICK_MS)
  }, 5000)
  console.log(`[jarvis] guardian mode ${enabled ? 'on' : 'off'}`)
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function guardianServer() {
  return createSdkMcpServer({
    name: 'jarvis_guardian',
    version: '1.0.0',
    instructions: 'Guardian mode: JARVIS watching the laptop and warning by himself.',
    tools: [
      tool(
        'guardian_status',
        'Whether guardian mode is on, what it watches, and the latest readings.',
        {},
        async () =>
          ok(
            `Guardian mode is ${enabled ? 'ON' : 'OFF'}. It watches: battery and charger, graphics card ` +
              `temperature, CPU and memory, free space on C, the internet connection, and finished downloads.\n` +
              `Latest: ${Object.entries(state.readings).map(([k, v]) => `${k} ${v}`).join('; ') || 'no readings yet'}.`,
          ),
      ),
      tool(
        'guardian_set',
        'Turn guardian mode on or off — "guardian off", "stop the warnings", "guardian on".',
        { on: z.boolean() },
        async ({ on }) => {
          enabled = on
          await saveEnabled()
          return ok(`Guardian mode is now ${on ? 'on' : 'off'}.`)
        },
      ),
    ],
  })
}
