import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import {
  lockPc, muteSystem, openApp, openFolder, setBrightness, setDarkMode, setVolume, unmuteSystem, wifiSet,
} from './pccontrol.mjs'
import { braveTools } from './brave.mjs'
import { addReminder, parseWhen, sayWhen } from './reminders.mjs'

/**
 * Protocols — one spoken command runs a whole routine, like Tony Stark's
 * "House Party Protocol". "Jarvis, initiate work protocol" opens the editors,
 * starts focus music and sets the volume, in one go.
 *
 * A protocol is a list of steps, and a step can only be one of a fixed set of
 * safe actions (ACTIONS below): open or politely close an app, open a folder or
 * site, play music, volume, brightness, dark mode, Wi-Fi, power mode, lock, a
 * reminder, a spoken line, a short wait. Nothing here runs arbitrary commands,
 * so a protocol the user dictates by voice can never do more than these.
 *
 * Saved in ~/.jarvis-protocols.json. Five come built in (work, gaming, study,
 * night, lockdown); saving one with the same name replaces it.
 */

const FILE = join(homedir(), '.jarvis-protocols.json')
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), 'scripts')
const execFileAsync = promisify(execFile)

async function runPs(script, args) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, script), ...args],
    { timeout: 15_000, windowsHide: true },
  )
  const r = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  if (!r.ok) throw new Error(r.error || `${script} failed`)
  return r
}

export const BUILT_IN = {
  work: {
    description: 'Coding focus: editors open, focus music, calm volume, best performance.',
    steps: [
      { action: 'power_mode', mode: 'performance' },
      { action: 'open_app', name: 'Visual Studio Code' },
      { action: 'open_app', name: 'Antigravity' },
      { action: 'play_youtube', query: 'lofi coding music focus 2026' },
      { action: 'volume', level: 30 },
      { action: 'say', text: 'Work protocol engaged.' },
    ],
  },
  gaming: {
    description: 'Best performance, louder sound, Epic Games and OMEN Gaming Hub open.',
    steps: [
      { action: 'power_mode', mode: 'performance' },
      { action: 'close_app', name: 'Visual Studio Code' },
      { action: 'open_app', name: 'OMEN Gaming Hub' },
      { action: 'open_app', name: 'Epic Games Launcher' },
      { action: 'volume', level: 70 },
      { action: 'brightness', level: 100 },
      { action: 'say', text: 'Gaming protocol engaged. Good hunting.' },
    ],
  },
  study: {
    description: 'Study folder, quiet focus music, a break reminder in fifty minutes.',
    steps: [
      { action: 'power_mode', mode: 'balanced' },
      { action: 'open_folder', name: 'Study' },
      { action: 'play_youtube', query: 'deep focus study music no lyrics' },
      { action: 'volume', level: 20 },
      { action: 'reminder', text: 'take a ten minute break', in_minutes: 50 },
      { action: 'say', text: 'Study protocol engaged. I will call a break in fifty minutes.' },
    ],
  },
  night: {
    description: 'Dim screen, dark mode, low volume, power saving.',
    steps: [
      { action: 'brightness', level: 30 },
      { action: 'dark_mode', on: true },
      { action: 'volume', level: 15 },
      { action: 'power_mode', mode: 'efficiency' },
      { action: 'say', text: 'Night protocol engaged. Rest well.' },
    ],
  },
  lockdown: {
    description: 'Mute the laptop and lock it.',
    steps: [
      { action: 'mute', on: true },
      { action: 'say', text: 'Lockdown.' },
      { action: 'lock_pc' },
    ],
  },
}

const keyOf = (name) =>
  String(name ?? '').toLowerCase().replace(/\bprotocol\b/g, '').replace(/[^a-z0-9 ]/g, '').trim().replace(/\s+/g, '-')

export async function loadProtocols() {
  let saved = {}
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'))
    if (raw && typeof raw === 'object') saved = raw
  } catch {
    /* none saved yet */
  }
  return { ...BUILT_IN, ...saved }
}

async function saveCustom(mutate) {
  let saved = {}
  try {
    saved = JSON.parse(await readFile(FILE, 'utf8')) ?? {}
  } catch {
    /* first save */
  }
  mutate(saved)
  await writeFile(FILE, JSON.stringify(saved, null, 2), 'utf8')
}

/* -------------------------------------------------------------------------- */
/* The actions a step may take                                                 */
/* -------------------------------------------------------------------------- */

let brave = null
const braveTool = async (name, args) => {
  brave ??= Object.fromEntries(braveTools().map((t) => [t.name, t.handler]))
  const r = await brave[name](args, {})
  const text = r.content?.find((c) => c.type === 'text')?.text ?? ''
  if (r.isError) throw new Error(text)
  return text
}

const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v))))

const ACTIONS = {
  open_app: async (s) => `${(await openApp(s.name)).name} opened`,
  close_app: async (s) => {
    const r = await runPs('close-app.ps1', ['-Name', String(s.name)])
    return `closed ${[].concat(r.closed ?? []).join(', ') || s.name}`
  },
  open_folder: async (s) => `opened folder ${(await openFolder(s.name)).path}`,
  open_site: async (s) => braveTool('brave_open', { target: s.target, new_tab: true }),
  play_youtube: async (s) => braveTool('youtube_play', { query: s.query }),
  volume: async (s) => `volume ${(await setVolume(pct(s.level))).percent}%`,
  mute: async (s) => ((s.on ?? true) ? (await muteSystem(), 'muted') : (await unmuteSystem(), 'unmuted')),
  brightness: async (s) => {
    const r = await setBrightness(pct(s.level))
    return r.unsupported ? 'brightness not adjustable on this screen' : `brightness ${r.percent}%`
  },
  dark_mode: async (s) => `theme ${(await setDarkMode(s.on ?? true)).mode}`,
  wifi: async (s) => {
    const r = await wifiSet(Boolean(s.on), true)
    if (!r.ok) throw new Error(r.error)
    return `Wi-Fi ${r.on ? 'on' : 'off'}`
  },
  power_mode: async (s) => `power mode ${(await runPs('power-mode.ps1', ['-Mode', String(s.mode)])).mode}`,
  lock_pc: async () => {
    lockPc()
    return 'laptop locked'
  },
  reminder: async (s) => {
    const when = parseWhen({ at: s.at, in_minutes: s.in_minutes })
    await addReminder(s.text, when)
    return `reminder "${s.text}" at ${sayWhen(when)}`
  },
  say: async (s) => `SAY: ${s.text}`,
  wait: async (s) => {
    await new Promise((r) => setTimeout(r, Math.min(30, Math.max(0, Number(s.seconds) || 1)) * 1000))
    return `waited ${s.seconds}s`
  },
}

const ACTION_HELP =
  'Each step is {action, ...}: ' +
  'open_app {name}; close_app {name} (closes politely, like clicking X); open_folder {name}; ' +
  'open_site {target: site name, URL or search words}; play_youtube {query}; volume {level 0-100}; ' +
  'mute {on: true|false}; brightness {level 0-100}; dark_mode {on}; wifi {on}; ' +
  'power_mode {mode: "performance"|"balanced"|"efficiency"}; lock_pc {}; ' +
  'reminder {text, in_minutes or at: "5:30 pm"}; say {text} (a line for you to speak at the end); ' +
  'wait {seconds, at most 30}.'

/** Run a protocol's steps in order. One failing step never stops the rest. */
export async function runProtocol(name) {
  const all = await loadProtocols()
  const key = keyOf(name)
  const p = all[key]
  if (!p) throw new Error(`There is no ${name} protocol. Known: ${Object.keys(all).join(', ')}.`)
  const done = []
  const failed = []
  const lines = []
  // Locking goes last whatever order it was written in: nothing after it would be seen.
  const steps = [...p.steps].sort((a, b) => (a.action === 'lock_pc') - (b.action === 'lock_pc'))
  for (const step of steps) {
    const fn = ACTIONS[step.action]
    if (!fn) {
      failed.push(`${step.action}: not a known action`)
      continue
    }
    try {
      const r = await fn(step)
      if (r.startsWith('SAY: ')) lines.push(r.slice(5))
      else done.push(r)
    } catch (err) {
      failed.push(`${step.action}${step.name ? ` ${step.name}` : ''}: ${String(err?.message ?? err).split('\n')[0]}`)
    }
  }
  return { key, done, failed, lines }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (text) => ({ isError: true, content: [{ type: 'text', text }] })

const STEP = z
  .object({
    action: z.enum(Object.keys(ACTIONS)),
    name: z.string().optional(),
    target: z.string().optional(),
    query: z.string().optional(),
    level: z.number().optional(),
    on: z.boolean().optional(),
    mode: z.enum(['performance', 'balanced', 'efficiency']).optional(),
    text: z.string().optional(),
    in_minutes: z.number().optional(),
    at: z.string().optional(),
    seconds: z.number().optional(),
  })
  .describe(ACTION_HELP)

export function protocolServer() {
  return createSdkMcpServer({
    name: 'jarvis_protocols',
    version: '1.0.0',
    instructions: 'Named routines ("work protocol") that run many laptop actions in one command.',
    tools: [
      tool(
        'protocol_run',
        'Run a protocol by name — "initiate work protocol", "gaming protocol", "lockdown". ' +
          'Runs every step and reports what happened.',
        { name: z.string().min(1).describe('The protocol name, e.g. "work", "gaming", "night".') },
        async ({ name }) => {
          try {
            const r = await runProtocol(name)
            return ok(
              `Protocol ${r.key} ran.\nDone: ${r.done.join('; ') || 'nothing'}` +
                (r.failed.length ? `\nFailed: ${r.failed.join('; ')}` : '') +
                (r.lines.length ? `\nLine to speak: ${r.lines.join(' ')}` : ''),
            )
          } catch (err) {
            return refuse(String(err?.message ?? err))
          }
        },
      ),
      tool(
        'protocol_list',
        'List every protocol and what it does.',
        {},
        async () => {
          const all = await loadProtocols()
          return ok(
            Object.entries(all)
              .map(([k, p]) => `${k}: ${p.description ?? ''} [${p.steps.map((s) => s.action).join(', ')}]`)
              .join('\n'),
          )
        },
      ),
      tool(
        'protocol_save',
        'Create a new protocol, or replace one, from what the user dictates — "make a protocol ' +
          'called movie that dims the screen, sets volume to 60 and opens Netflix". ' + ACTION_HELP,
        {
          name: z.string().min(1).describe('One or two words, e.g. "movie".'),
          description: z.string().optional().describe('One line saying what it is for.'),
          steps: z.array(STEP).min(1).max(20),
        },
        async ({ name, description, steps }) => {
          const key = keyOf(name)
          if (!key) return refuse('The protocol needs a name.')
          await saveCustom((saved) => {
            saved[key] = { description: description ?? '', steps }
          })
          return ok(`Saved the ${key} protocol with ${steps.length} steps.`)
        },
      ),
      tool(
        'protocol_delete',
        'Delete a protocol the user made, or put a built-in one back to how it came.',
        { name: z.string().min(1) },
        async ({ name }) => {
          const key = keyOf(name)
          let existed = false
          await saveCustom((saved) => {
            existed = key in saved
            delete saved[key]
          })
          if (!existed) return refuse(`There is no saved ${name} protocol to delete.`)
          return ok(BUILT_IN[key] ? `The ${key} protocol is back to its original steps.` : `Deleted the ${key} protocol.`)
        },
      ),
    ],
  })
}
