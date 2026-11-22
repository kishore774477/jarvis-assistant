import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile, spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * JARVIS's hands on the Brave browser — open sites, search, click, type, read
 * pages, and play YouTube — so "open Brave, open YouTube, play the latest
 * Tamil song" is one spoken request.
 *
 * How: the Chrome DevTools Protocol, which Brave (Chromium) speaks when it is
 * started with --remote-debugging-port. Chromium refuses that flag on the
 * user's everyday profile, so JARVIS runs its own Brave profile in
 * %LOCALAPPDATA%\JARVIS\Brave Profile: a separate Brave window next to the
 * user's normal one. Sign in to YouTube or any site in that window once and it
 * stays signed in. The port listens on 127.0.0.1 only.
 *
 * Every failure is returned to the model as a plain sentence, never thrown, so
 * a closed browser is something JARVIS says, not a crashed turn.
 */

const PORT = Number(process.env.JARVIS_BRAVE_PORT ?? 9333)
const BASE = `http://127.0.0.1:${PORT}`
const LOCAL = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
const PROFILE_DIR = join(LOCAL, 'JARVIS', 'Brave Profile')

const BRAVE_PATHS = [
  process.env.ProgramFiles ?? 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
  LOCAL,
].map((d) => join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function braveExe() {
  for (const p of BRAVE_PATHS) if (await stat(p).catch(() => null)) return p
  return null
}

/* -------------------------------------------------------------------------- */
/* DevTools HTTP endpoints and a minimal WebSocket client                      */
/* -------------------------------------------------------------------------- */

async function http(path, method = 'GET') {
  const res = await fetch(BASE + path, { method, signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`Brave answered ${res.status} to ${path}`)
  const body = await res.text()
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

const isUp = () => http('/json/version').then(() => true, () => false)

/** Start JARVIS's Brave window if it is not already running. */
async function ensureBrave() {
  if (await isUp()) return
  const exe = await braveExe()
  if (!exe) throw new Error('Brave is not installed on this laptop.')
  spawn(
    exe,
    [
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Music and videos JARVIS starts should play without an extra click.
      '--autoplay-policy=no-user-gesture-required',
    ],
    { detached: true, stdio: 'ignore' },
  ).unref()
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    if (await isUp()) {
      await sleep(500)
      return
    }
  }
  throw new Error('Brave did not start.')
}

class Cdp {
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timer = setTimeout(() => reject(new Error('Brave did not answer.')), 5000)
      ws.onopen = () => {
        clearTimeout(timer)
        resolve(new Cdp(ws))
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('Could not connect to Brave.'))
      }
    })
  }

  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    ws.onmessage = (ev) => {
      let m
      try {
        m = JSON.parse(String(ev.data))
      } catch {
        return
      }
      const p = m.id && this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.error) p.reject(new Error(m.error.message))
      else p.resolve(m.result ?? {})
    }
    ws.onclose = () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Brave closed the connection.'))
      }
      this.pending.clear()
    }
  }

  send(method, params = {}, timeout = 20_000) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Brave took too long (${method}).`))
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already closed */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

/** The tab JARVIS last worked in, so "pause it" means the tab it just opened. */
let currentId = null

async function tabs() {
  const list = await http('/json/list')
  return (Array.isArray(list) ? list : []).filter(
    (t) => t.type === 'page' && !/^(devtools|chrome-extension|brave-extension):/.test(t.url),
  )
}

async function currentTab() {
  const list = await tabs()
  const tab = list.find((t) => t.id === currentId) ?? list[0]
  if (tab) {
    currentId = tab.id
    return tab
  }
  return newTab('about:blank')
}

async function newTab(url) {
  const t = await http(`/json/new?${encodeURIComponent(url)}`, 'PUT')
  currentId = t.id
  return t
}

/** Run `fn` against a tab with a live DevTools connection. */
async function withTab(fn, { tab: given } = {}) {
  await ensureBrave()
  const tab = given ?? (await currentTab())
  const cdp = await Cdp.open(tab.webSocketDebuggerUrl)
  try {
    return await fn(cdp, tab)
  } finally {
    cdp.close()
  }
}

async function evaluate(cdp, expression, timeout) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    timeout,
  )
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? 'The page script failed.')
  }
  return r.result?.value
}

async function waitLoaded(cdp, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const state = await evaluate(cdp, 'document.readyState').catch(() => null)
    if (state === 'complete' || state === 'interactive') return
    await sleep(300)
  }
}

async function navigate(cdp, url) {
  const r = await cdp.send('Page.navigate', { url })
  if (r.errorText) throw new Error(`Could not open ${url}: ${r.errorText}`)
  await sleep(400)
  await waitLoaded(cdp)
}

const FRONT_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'brave-front.ps1')

/** Put the tab, and JARVIS's Brave window, in front of the user. */
async function raise(cdp) {
  await cdp.send('Page.bringToFront').catch(() => {})
  if (process.platform !== 'win32') return
  // Page.bringToFront only picks the tab; Windows needs help to raise the window.
  await new Promise((done) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FRONT_SCRIPT],
      { timeout: 15_000, windowsHide: true },
      () => done(),
    ),
  )
}

const pageInfo = (cdp) => evaluate(cdp, '({ title: document.title, url: location.href })')

/* -------------------------------------------------------------------------- */
/* Where "open YouTube" goes                                                   */
/* -------------------------------------------------------------------------- */

const SITES = {
  youtube: 'https://www.youtube.com', 'youtube music': 'https://music.youtube.com',
  google: 'https://www.google.com', gmail: 'https://mail.google.com', mail: 'https://mail.google.com',
  'google drive': 'https://drive.google.com', drive: 'https://drive.google.com',
  maps: 'https://maps.google.com', 'google maps': 'https://maps.google.com',
  whatsapp: 'https://web.whatsapp.com', 'whatsapp web': 'https://web.whatsapp.com',
  instagram: 'https://www.instagram.com', facebook: 'https://www.facebook.com',
  twitter: 'https://x.com', x: 'https://x.com', linkedin: 'https://www.linkedin.com',
  github: 'https://github.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai',
  spotify: 'https://open.spotify.com', netflix: 'https://www.netflix.com',
  hotstar: 'https://www.hotstar.com', amazon: 'https://www.amazon.in', flipkart: 'https://www.flipkart.com',
  wikipedia: 'https://www.wikipedia.org', news: 'https://news.google.com',
}

/** A URL, a site name ("youtube"), or words to search for. */
export function toUrl(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return 'about:blank'
  const key = raw.toLowerCase().replace(/\s+(website|site|page)$/, '').replace(/\.com$/, '')
  if (SITES[key]) return SITES[key]
  if (/^(https?|file|about|brave):/i.test(raw)) return raw
  if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(raw)) return `https://${raw}`
  return `https://search.brave.com/search?q=${encodeURIComponent(raw)}`
}

/* -------------------------------------------------------------------------- */
/* Reading and acting on the page                                              */
/* -------------------------------------------------------------------------- */

/** Numbers every visible link, button and field so the model can say "click 7". */
const SNAPSHOT = `(() => {
  const seen = (el) => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' &&
      r.bottom > 0 && r.right > 0 && r.top < innerHeight * 2.5
  }
  const label = (el) => (el.getAttribute('aria-label') || el.innerText || el.value ||
    el.getAttribute('placeholder') || el.title || el.getAttribute('alt') || el.name || '')
    .trim().replace(/\\s+/g, ' ').slice(0, 90)
  document.querySelectorAll('[data-jarvis-id]').forEach((e) => e.removeAttribute('data-jarvis-id'))
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],' +
    '[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[role=searchbox],[role=textbox],[contenteditable=true],[contenteditable=""]'
  const items = []
  let n = 0
  for (const el of document.querySelectorAll(sel)) {
    if (!seen(el)) continue
    const tag = el.tagName.toLowerCase()
    const field = /input|textarea|select/.test(tag) || el.isContentEditable || /textbox|searchbox/.test(el.getAttribute('role') || '')
    const t = label(el)
    if (!t && !field) continue
    el.setAttribute('data-jarvis-id', ++n)
    const kind = field ? 'field' + (el.type ? '(' + el.type + ')' : '') : tag === 'a' ? 'link' : 'button'
    items.push('[' + n + '] ' + kind + ': ' + (t || '(empty)'))
    if (n >= 150) break
  }
  const text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').slice(0, 6000)
  return { title: document.title, url: location.href, text, items }
})()`

/** Find a target — a number from the last read, or words on the element — scroll it into view and return its centre. */
const LOCATE = (target) => `(() => {
  const want = ${JSON.stringify(String(target))}.trim()
  let el = /^\\d+$/.test(want) ? document.querySelector('[data-jarvis-id="' + want + '"]') : null
  if (!el) {
    const w = want.toLowerCase()
    const sel = 'a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],' +
      '[role=option],[role=checkbox],[role=switch],[role=searchbox],[role=textbox],[contenteditable=true],[contenteditable=""],[onclick]'
    const label = (e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') ||
      e.title || e.getAttribute('alt') || e.name || '').trim().replace(/\\s+/g, ' ').toLowerCase()
    const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).visibility !== 'hidden' }
    const all = [...document.querySelectorAll(sel)].filter(shown)
    el = all.find((e) => label(e) === w) || all.find((e) => label(e).startsWith(w)) || all.find((e) => label(e).includes(w))
  }
  if (!el) return null
  el.scrollIntoView({ block: 'center', inline: 'center' })
  const r = el.getBoundingClientRect()
  const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.tagName)
    .trim().replace(/\\s+/g, ' ').slice(0, 80)
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, name }
})()`

async function clickAt(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function locate(cdp, target) {
  const hit = await evaluate(cdp, LOCATE(target))
  if (!hit) throw new Error(`Nothing matching "${target}" is on the page. Read the page to see what is there.`)
  await sleep(150)
  return hit
}

const KEYS = {
  enter: ['Enter', 'Enter', 13, '\r'], tab: ['Tab', 'Tab', 9], escape: ['Escape', 'Escape', 27],
  esc: ['Escape', 'Escape', 27], backspace: ['Backspace', 'Backspace', 8], delete: ['Delete', 'Delete', 46],
  space: [' ', 'Space', 32, ' '], up: ['ArrowUp', 'ArrowUp', 38], down: ['ArrowDown', 'ArrowDown', 40],
  left: ['ArrowLeft', 'ArrowLeft', 37], right: ['ArrowRight', 'ArrowRight', 39],
  arrowup: ['ArrowUp', 'ArrowUp', 38], arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37], arrowright: ['ArrowRight', 'ArrowRight', 39],
  pageup: ['PageUp', 'PageUp', 33], pagedown: ['PageDown', 'PageDown', 34], home: ['Home', 'Home', 36], end: ['End', 'End', 35],
}
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 }

/** Press a key or combination: "Enter", "k", "shift+n", "ctrl+a". */
export async function pressKey(cdp, combo) {
  const parts = String(combo).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean)
  const main = parts.pop() ?? ''
  const modifiers = parts.reduce((m, p) => m | (MODS[p] ?? 0), 0)
  let def = KEYS[main]
  if (!def && main.length === 1) {
    const ch = modifiers & 8 ? main.toUpperCase() : main
    const code = /[a-z]/.test(main) ? `Key${main.toUpperCase()}` : /\d/.test(main) ? `Digit${main}` : ''
    def = [ch, code, main.toUpperCase().charCodeAt(0), modifiers & ~8 ? undefined : ch]
  } else if (!def && /^f\d{1,2}$/.test(main)) {
    def = [main.toUpperCase(), main.toUpperCase(), 111 + Number(main.slice(1))]
  }
  if (!def) throw new Error(`Unknown key "${combo}".`)
  const [key, code, vk, text] = def
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers }
  // Shortcuts that are editing commands need naming, or a synthetic key only fires keydown.
  const commands = modifiers & 2 ? { a: ['selectAll'], c: ['copy'], x: ['cut'], v: ['paste'], z: ['undo'] }[main] : undefined
  await cdp.send('Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(text ? { text } : {}),
    ...(commands ? { commands } : {}),
  })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

/* -------------------------------------------------------------------------- */
/* YouTube                                                                     */
/* -------------------------------------------------------------------------- */

/** First real video on a results page: ads, Shorts and channels skipped. */
const FIRST_VIDEO = `(() => {
  const walk = (o, d) => {
    if (!o || typeof o !== 'object' || d > 45) return null
    const v = o.videoRenderer
    if (v && v.videoId) return { id: v.videoId, title: ((v.title && v.title.runs) || []).map((r) => r.text).join('') }
    for (const k in o) { const r = walk(o[k], d + 1); if (r) return r }
    return null
  }
  let r = walk(window.ytInitialData, 0)
  if (!r) {
    const a = [...document.querySelectorAll('a[href*="/watch?v="]')].find((a) =>
      !a.closest('ytd-ad-slot-renderer, ytd-promoted-video-renderer, ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model') &&
      (a.title || a.innerText || '').trim())
    if (a) r = { id: new URL(a.href, location.href).searchParams.get('v'), title: (a.title || a.innerText).trim() }
  }
  return r
})()`

/** Play whatever <video>/<audio> is on the page, unmuted; keep clicking YouTube's own "Skip" button on ads. */
const START_PLAYBACK = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const title = () => document.title.replace(/^\\(\\d+\\)\\s*/, '').replace(/ - YouTube$/, '')
  if (!window.__jarvisSkip) {
    window.__jarvisSkip = setInterval(() => {
      const b = document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')
      if (b) b.click()
    }, 1000)
  }
  // Up to ~12 s: the player loads, maybe shows an ad, then starts the video.
  for (let i = 0; i < 48; i++) {
    const p = document.querySelector('#movie_player')
    const v = document.querySelector('video, audio')
    if (p && p.playVideo) {
      if (p.isMuted && p.isMuted()) p.unMute()
      if (p.getVolume && p.getVolume() === 0) p.setVolume(80)
      const s = p.getPlayerState ? p.getPlayerState() : -1   // 1 = playing
      if (s === 1) return { playing: true, title: title() }
      if (i % 8 === 0 && s !== 3) p.playVideo()                 // 3 = buffering
    } else if (v) {
      v.muted = false
      if (!v.paused) return { playing: true, title: title() }
      if (i % 8 === 0) v.play().catch(() => {})
    }
    await wait(250)
  }
  const v = document.querySelector('video, audio')
  return { playing: !!(v && !v.paused), title: title() }
})()`

/** Find the tab with media on it: the current one if it has some, else any YouTube tab. */
async function mediaTab() {
  await ensureBrave()
  const list = await tabs()
  const cur = list.find((t) => t.id === currentId)
  if (cur && /youtube\.com\/watch|music\.youtube|open\.spotify/.test(cur.url)) return cur
  return list.find((t) => /youtube\.com\/watch|music\.youtube/.test(t.url)) ?? cur ?? list[0]
}

const MEDIA_SCRIPT = (action) => `(() => {
  const v = document.querySelector('video, audio')
  if (!v) return 'There is no video or music on this page.'
  const a = ${JSON.stringify(action)}
  const p = document.querySelector('#movie_player')
  const title = () => document.title.replace(/^\\(\\d+\\)\\s*/, '').replace(/ - YouTube$/, '')
  if (p && p.playVideo) {
    // YouTube's own player API: its buttons and volume slider stay in step.
    const vol = p.getVolume()
    if (a === 'pause') p.pauseVideo()
    else if (a === 'play' || a === 'resume') { p.unMute(); p.playVideo() }
    else if (a === 'toggle') p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo()
    else if (a === 'mute') p.mute()
    else if (a === 'unmute') p.unMute()
    else if (a === 'volume_up') { p.unMute(); p.setVolume(Math.min(100, vol + 15)) }
    else if (a === 'volume_down') p.setVolume(Math.max(0, vol - 15))
    else if (a === 'forward') p.seekTo(p.getCurrentTime() + 10, true)
    else if (a === 'back') p.seekTo(Math.max(0, p.getCurrentTime() - 10), true)
    else if (a === 'restart') { p.seekTo(0, true); p.playVideo() }
    else if (a === 'next') p.nextVideo()
    const playing = a === 'pause' ? false : a === 'play' || a === 'resume' || a === 'restart' ? true : p.getPlayerState() === 1
    return (playing ? 'Playing' : 'Paused') + ': ' + title() + ' (volume ' + p.getVolume() + '%' + (p.isMuted() ? ', muted' : '') + ')'
  }
  if (a === 'pause') v.pause()
  else if (a === 'play' || a === 'resume') { v.muted = false; v.play() }
  else if (a === 'toggle') v.paused ? v.play() : v.pause()
  else if (a === 'mute') v.muted = true
  else if (a === 'unmute') v.muted = false
  else if (a === 'volume_up') { v.muted = false; v.volume = Math.min(1, v.volume + 0.15) }
  else if (a === 'volume_down') v.volume = Math.max(0, v.volume - 0.15)
  else if (a === 'forward') v.currentTime += 10
  else if (a === 'back') v.currentTime = Math.max(0, v.currentTime - 10)
  else if (a === 'restart') { v.currentTime = 0; v.play() }
  else if (a === 'next') {
    const b = document.querySelector('.ytp-next-button')
    if (!b) return 'There is no next button on this page.'
    b.click()
  }
  const t = document.title.replace(/^\\(\\d+\\)\\s*/, '').replace(/ - YouTube$/, '')
  return (v.paused ? 'Paused' : 'Playing') + ': ' + t + ' (volume ' + Math.round(v.volume * 100) + '%' + (v.muted ? ', muted' : '') + ')'
})()`

/* -------------------------------------------------------------------------- */
/* The tools                                                                   */
/* -------------------------------------------------------------------------- */

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] })

/** Close a tab showing in the user's own Brave/Chrome/Edge window (scripts/windows.ps1). */
const WINDOWS_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'scripts', 'windows.ps1')
function closeOwnBrowserTab(match) {
  return new Promise((done) =>
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WINDOWS_SCRIPT, '-Action', 'closetab', '-Match', match],
      { timeout: 20_000, windowsHide: true },
      (_err, stdout) => {
        try {
          const r = JSON.parse(String(stdout).trim().split('\n').pop())
          done(r.ok ? ok(`Closed the tab in your own browser: ${[].concat(r.closed).join('; ')}.`) : refuse(r.error))
        } catch {
          done(refuse(`No tab matching "${match}" was found in JARVIS's Brave or your own browsers.`))
        }
      },
    ),
  )
}
const guard = (fn) => async (args) => {
  try {
    return await fn(args ?? {})
  } catch (err) {
    return refuse(err)
  }
}

export function braveServer() {
  return createSdkMcpServer({
    name: 'jarvis_brave',
    version: '1.0.0',
    instructions:
      "Drive JARVIS's Brave browser window: open sites, search, read pages, click, type, " +
      'and play YouTube. Chain the tools to finish whole tasks the user asks for.',
    tools: braveTools(),
  })
}

/** The tool list on its own, so tests can call a handler directly. */
export function braveTools() {
  return [
      tool(
        'brave_open',
        'Open Brave (starting it if needed) and go to a website, a URL, or a web search. ' +
          'Pass a site name ("youtube", "gmail", "instagram"), a URL, or words to search ' +
          'for. Leave it empty to just open Brave. Opens in the current tab unless new_tab is true.',
        {
          target: z.string().optional().describe('Site name, URL or search words. Empty just opens Brave.'),
          new_tab: z.boolean().optional().describe('true to open in a new tab.'),
        },
        guard(async ({ target, new_tab }) => {
          await ensureBrave()
          const url = toUrl(target)
          const tab = new_tab ? await newTab('about:blank') : await currentTab()
          return withTab(
            async (cdp, t) => {
              if (url !== 'about:blank' || new_tab) await navigate(cdp, url)
              await raise(cdp, t)
              const p = await pageInfo(cdp)
              return ok(`Brave is showing "${p.title || p.url}" (${p.url}).`)
            },
            { tab },
          )
        }),
      ),

      tool(
        'youtube_play',
        'Search YouTube in Brave and play the top video for the query — songs, music, ' +
          'trailers, anything. Put the language, movie, artist and year in the query, e.g. ' +
          '"latest Tamil song 2026". newest=true sorts by upload date instead of relevance.',
        {
          query: z.string().min(1).describe('What to play, e.g. "Anirudh new Tamil song 2026".'),
          newest: z.boolean().optional().describe('true to pick the most recently uploaded match.'),
        },
        guard(async ({ query, newest }) => {
          await ensureBrave()
          const list = await tabs()
          // Reuse a YouTube tab if one is open, so songs don't pile up in tabs.
          const tab = list.find((t) => t.id === currentId && /youtube\.com/.test(t.url)) ??
            list.find((t) => /youtube\.com/.test(t.url)) ??
            (await currentTab())
          currentId = tab.id
          return withTab(
            async (cdp, t) => {
              const sp = newest ? '&sp=CAI%253D' : ''
              await navigate(cdp, `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}${sp}`)
              let video = null
              for (let i = 0; i < 20 && !video; i++) {
                video = await evaluate(cdp, FIRST_VIDEO).catch(() => null)
                if (!video) await sleep(400)
              }
              if (!video?.id) {
                await raise(cdp, t)
                return refuse(`YouTube showed no playable video for "${query}". The results page is open in Brave.`)
              }
              await navigate(cdp, `https://www.youtube.com/watch?v=${video.id}`)
              const r = await evaluate(cdp, START_PLAYBACK, 20_000)
              await raise(cdp, t)
              return ok(
                `${r?.playing ? 'Playing' : 'Opened (press play if it has not started)'}: ` +
                  `"${r?.title || video.title}" on YouTube in Brave.`,
              )
            },
            { tab },
          )
        }),
      ),

      tool(
        'media_control',
        'Control the video or music playing in Brave (YouTube or any page): pause, play, ' +
          'next song, mute, volume up/down, skip forward/back ten seconds, restart, fullscreen.',
        {
          action: z.enum([
            'pause', 'play', 'toggle', 'next', 'mute', 'unmute', 'volume_up', 'volume_down',
            'forward', 'back', 'restart', 'fullscreen',
          ]),
        },
        guard(async ({ action }) => {
          const tab = await mediaTab()
          return withTab(
            async (cdp, t) => {
              if (action === 'fullscreen') {
                await raise(cdp, t)
                await pressKey(cdp, 'f')
                return ok('Toggled full screen.')
              }
              const r = await evaluate(cdp, MEDIA_SCRIPT(action))
              if (action === 'next') {
                await sleep(1500)
                const p = await evaluate(cdp, START_PLAYBACK, 20_000)
                return ok(`${p.playing ? 'Playing' : 'Opened'}: ${p.title}`)
              }
              return ok(r)
            },
            { tab },
          )
        }),
      ),

      tool(
        'brave_read',
        "Read the current Brave tab: its title, address, visible text, and a numbered list " +
          'of the links, buttons and fields on it. Use the numbers with brave_click and brave_type.',
        {},
        guard(() =>
          withTab(async (cdp) => {
            const s = await evaluate(cdp, SNAPSHOT)
            return ok(
              `Title: ${s.title}\nAddress: ${s.url}\n\nClickable things and fields:\n${s.items.join('\n') || '(none)'}` +
                `\n\nPage text:\n${s.text}`,
            )
          }),
        ),
      ),

      tool(
        'brave_click',
        'Click something on the current Brave page: a number from brave_read, or the ' +
          'words written on the link or button.',
        { target: z.string().min(1).describe('A number from brave_read, or the visible words, e.g. "Sign in".') },
        guard(({ target }) =>
          withTab(async (cdp) => {
            const hit = await locate(cdp, target)
            await clickAt(cdp, hit.x, hit.y)
            await sleep(1200)
            await waitLoaded(cdp, 8000)
            const p = await pageInfo(cdp)
            return ok(`Clicked "${hit.name}". Now on "${p.title}" (${p.url}).`)
          }),
        ),
      ),

      tool(
        'brave_type',
        'Type text into a field on the current Brave page. Give the field as a number from ' +
          'brave_read or its label/placeholder; leave it out to use the focused field or the ' +
          'first search box. submit=true presses Enter afterwards.',
        {
          text: z.string().describe('What to type.'),
          field: z.string().optional().describe('A number from brave_read, or the field label/placeholder.'),
          submit: z.boolean().optional().describe('true to press Enter after typing.'),
        },
        guard(({ text, field, submit }) =>
          withTab(async (cdp) => {
            let target = field
            if (!target) {
              target = await evaluate(
                cdp,
                `(() => {
                  const a = document.activeElement
                  const typing = a && a !== document.body && (/input|textarea/i.test(a.tagName) || a.isContentEditable)
                  const el = typing ? a : document.querySelector('input[type=search], input[name=q], input[name=search_query], ' +
                    'textarea, input[type=text], [contenteditable=true], [role=searchbox], [role=textbox]')
                  if (!el) return null
                  el.setAttribute('data-jarvis-id', 'focus')
                  return 'focus'
                })()`,
              )
              if (!target) throw new Error('There is no text field on this page. Read the page to find one.')
            }
            const hit =
              target === 'focus'
                ? await evaluate(
                    cdp,
                    `(() => { const e = document.querySelector('[data-jarvis-id="focus"]'); e.scrollIntoView({block:'center'});
                      const r = e.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2,
                      name: (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.name || 'the text field') } })()`,
                  )
                : await locate(cdp, target)
            await clickAt(cdp, hit.x, hit.y)
            await sleep(150)
            await pressKey(cdp, 'ctrl+a')
            await pressKey(cdp, 'backspace')
            await cdp.send('Input.insertText', { text })
            if (submit) {
              await sleep(200)
              await pressKey(cdp, 'enter')
              await sleep(1200)
              await waitLoaded(cdp, 8000)
            }
            const p = await pageInfo(cdp)
            return ok(`Typed into ${hit.name}${submit ? ' and pressed Enter' : ''}. Page: "${p.title}".`)
          }),
        ),
      ),

      tool(
        'brave_key',
        'Press a key or shortcut in the current Brave tab: "Enter", "Escape", "Tab", ' +
          '"space", arrows, "PageDown", a letter, or a combination like "ctrl+a" or "shift+n".',
        { key: z.string().min(1) },
        guard(({ key }) =>
          withTab(async (cdp) => {
            await pressKey(cdp, key)
            return ok(`Pressed ${key}.`)
          }),
        ),
      ),

      tool(
        'brave_scroll',
        'Scroll the current Brave page.',
        { direction: z.enum(['down', 'up', 'top', 'bottom']) },
        guard(({ direction }) =>
          withTab(async (cdp) => {
            const js = {
              down: 'scrollBy(0, innerHeight * 0.8)',
              up: 'scrollBy(0, -innerHeight * 0.8)',
              top: 'scrollTo(0, 0)',
              bottom: 'scrollTo(0, document.body.scrollHeight)',
            }[direction]
            await evaluate(cdp, js)
            return ok(`Scrolled ${direction}.`)
          }),
        ),
      ),

      tool(
        'brave_screenshot',
        'See the current Brave tab as an image — use it when the page text is not enough ' +
          'to understand what is on screen.',
        {},
        guard(() =>
          withTab(async (cdp) => {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 30_000)
            const p = await pageInfo(cdp)
            return {
              content: [
                { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
                { type: 'text', text: `"${p.title}" (${p.url})` },
              ],
            }
          }),
        ),
      ),

      tool(
        'brave_tabs',
        "List, switch to, or close tabs in JARVIS's Brave. Pick tabs by `tab` number from the " +
          'list, or by `match` — words from the tab title or site ("youtube", "wikipedia"), ' +
          '"current" (the tab JARVIS last used), "others" (every tab but the current one) or ' +
          '"all" (every tab, which closes the Brave window).',
        {
          action: z.enum(['list', 'switch', 'close']),
          tab: z.number().int().optional().describe('The tab number from the list.'),
          match: z.string().optional().describe('Title or site words, or "current", "others", "all".'),
        },
        guard(async ({ action, tab, match }) => {
          const m0 = String(match ?? '').trim()
          const named = m0 && !/^(all|current|this|others?)$/i.test(m0)
          // Listing or closing must never start Brave just to find it empty.
          if (!(await isUp())) {
            // A named tab that isn't in JARVIS's Brave is probably in the user's own browser.
            if (action === 'close' && named) return closeOwnBrowserTab(m0)
            return action === 'switch' ? refuse("JARVIS's Brave is not open.") : ok("JARVIS's Brave is not open, so there are no tabs.")
          }
          const list = await tabs()
          const show = () =>
            list.map((t, i) => `${i + 1}. ${t.title || t.url}${t.id === currentId ? '  (current)' : ''}`).join('\n')
          if (action === 'list') return ok(list.length ? show() : 'Brave has no tabs open.')

          let picked = []
          const m = String(match ?? '').trim().toLowerCase()
          if (tab != null) picked = [list[tab - 1]].filter(Boolean)
          else if (m === 'all') picked = list
          else if (m === 'current' || m === 'this' || m === '') picked = [list.find((t) => t.id === currentId) ?? list[0]].filter(Boolean)
          else if (m === 'others' || m === 'other') picked = list.filter((t) => t.id !== (currentId ?? list[0]?.id))
          else picked = list.filter((t) => `${t.title} ${t.url}`.toLowerCase().includes(m))
          if (!picked.length && action === 'close' && named) return closeOwnBrowserTab(m0)
          if (!picked.length) return refuse(`No tab matches${tab != null ? ` number ${tab}` : ` "${match}"`}. Tabs:\n${show()}`)

          if (action === 'close') {
            for (const t of picked) {
              await http(`/json/close/${t.id}`).catch(() => {})
              if (currentId === t.id) currentId = null
            }
            const left = list.length - picked.length
            return ok(
              `Closed ${picked.length === 1 ? `"${picked[0].title}"` : `${picked.length} tabs`}.` +
                (left ? ` ${left} tab${left === 1 ? '' : 's'} still open.` : ' Brave is closed.'),
            )
          }
          const t = picked[0]
          await http(`/json/activate/${t.id}`)
          currentId = t.id
          await withTab((cdp, x) => raise(cdp, x), { tab: t })
          return ok(`Switched to "${t.title}".`)
        }),
      ),
  ]
}
