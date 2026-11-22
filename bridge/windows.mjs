import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Closing what JARVIS (or the user) opened: windows, File Explorer folders,
 * apps, and browser tabs in the user's own browsers. JARVIS's own Brave tabs
 * are closed precisely by brave_tabs in brave.mjs; this covers everything else.
 *
 * Everything closes politely (WM_CLOSE / the app's own close, like clicking
 * X), so an app with unsaved work still asks before it goes. The taskbar, the
 * JARVIS screen and black window, and the Claude app are never touched — see
 * scripts/windows.ps1 and scripts/close-app.ps1.
 */

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), 'scripts')
const execFileAsync = promisify(execFile)

async function runPs(script, args) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(SCRIPTS, script), ...args],
    { timeout: 20_000, windowsHide: true },
  )
  const r = JSON.parse(stdout.trim().split('\n').pop() ?? '{}')
  if (!r.ok) throw new Error(r.error || `${script} failed`)
  return r
}

const ok = (text) => ({ content: [{ type: 'text', text }] })
const refuse = (err) => ({ isError: true, content: [{ type: 'text', text: String(err?.message ?? err) }] })

export function windowServer() {
  return createSdkMcpServer({
    name: 'jarvis_windows',
    version: '1.0.0',
    instructions: 'See and close the windows, folders, apps and browser tabs open on the laptop.',
    tools: [
      tool(
        'windows_list',
        'List the windows open on the laptop: which app, and the title (for a browser, the title ' +
          'of the tab it is showing; for File Explorer, the folder name).',
        {},
        async () => {
          try {
            const r = await runPs('windows.ps1', ['-Action', 'list'])
            const w = [].concat(r.windows ?? [])
            return ok(w.length ? w.map((x, i) => `${i + 1}. ${x.app}: ${x.title}`).join('\n') : 'No windows are open.')
          } catch (err) {
            return refuse(err)
          }
        },
      ),
      tool(
        'close_window',
        'Close windows whose title or app name contains `match` — a File Explorer folder ' +
          '("Downloads"), an app window ("Notepad", "Word"), a whole browser window, a video ' +
          'player. Closes politely, like clicking X. Use windows_list first if unsure of the name.',
        { match: z.string().min(1).describe('Words from the window title, or the app name.') },
        async ({ match }) => {
          try {
            const r = await runPs('windows.ps1', ['-Action', 'close', '-Match', match])
            return ok(`Closed: ${[].concat(r.closed).join('; ')}.`)
          } catch (err) {
            return refuse(err)
          }
        },
      ),
      tool(
        'close_browser_tab',
        "Close a tab in the user's OWN Brave, Chrome or Edge (not JARVIS's Brave — use " +
          'brave_tabs for that), e.g. the claude.ai tab build_in_claude_app opened. Works on ' +
          'the tab each browser window is showing, matched by words from its title.',
        { match: z.string().min(1).describe('Words from the tab title, e.g. "Claude", "YouTube".') },
        async ({ match }) => {
          try {
            const r = await runPs('windows.ps1', ['-Action', 'closetab', '-Match', match])
            return ok(`Closed the tab: ${[].concat(r.closed).join('; ')}.`)
          } catch (err) {
            return refuse(err)
          }
        },
      ),
      tool(
        'close_app',
        'Close an app completely by name — "close VS Code", "close Spotify", "close Epic Games". ' +
          'Politely, like clicking X, so unsaved work still gets asked about.',
        { name: z.string().min(1).describe('The app as the user said it.') },
        async ({ name }) => {
          try {
            const r = await runPs('close-app.ps1', ['-Name', name])
            return ok(`Closed ${[].concat(r.closed ?? []).join(', ') || name}.`)
          } catch (err) {
            return refuse(err)
          }
        },
      ),
    ],
  })
}
