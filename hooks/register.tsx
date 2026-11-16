import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  Alarm,
  CalendarSection,
  GitlabSection,
  MergeRequest,
  Meta,
  PlaneItem,
  PlaneSection,
  PrtgSection,
} from '../types'

const PANE = 'mission-control'
const TITLE = 'Mission Control'
const COLLAPSED_ROWS = 3

// What the person set in the plugin's options; an empty value turns its section off.
type Config = {
  prtgServer: string
  gitlabHost: string
  planeUrl: string
  planeServers: string[]
  calendarServer: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function readConfig(options: Record<string, unknown>): Config {
  return {
    prtgServer: text(options.prtgServer),
    gitlabHost: text(options.gitlabHost),
    planeUrl: text(options.planeUrl).replace(/\/+$/, ''),
    planeServers: text(options.planeServers)
      .split(',')
      .map(x => x.trim())
      .filter(Boolean),
    calendarServer: text(options.calendarServer),
  }
}

let cfg: Config = readConfig({})

const REFRESH_MS = 3 * 60_000
// Plane is slow (it pages every project), so it refreshes on every 5th tick: 15 minutes.
const PLANE_EVERY_TICKS = 5

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const prtg = atom({ plugin: 'mission-control', key: 'prtg' } as const, null as PrtgSection | null, { shape: 'prtg-1' })
const gitlab = atom({ plugin: 'mission-control', key: 'gitlab' } as const, null as GitlabSection | null, { shape: 'gitlab-1' })
const plane = atom({ plugin: 'mission-control', key: 'plane' } as const, null as PlaneSection | null, { shape: 'plane-1' })
const calendar = atom({ plugin: 'mission-control', key: 'calendar' } as const, null as CalendarSection | null, { shape: 'calendar-1' })
const meta = atom({ plugin: 'mission-control', key: 'meta' } as const, { updatedAt: '', isBusy: false } as Meta, { shape: 'meta-1' })
const expanded = atom({ plugin: 'mission-control', key: 'expanded' } as const, [] as string[], { shape: 'expanded-1' })

type $T = EngineInterface

// ---------- helpers ----------

const errorText = (err: unknown): string =>
  ((err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '').slice(0, 120)

async function mcpJson($: $T, server: string, tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await $.mcp.call(server, tool, args)
  const text = res.content
    .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('')
  if (res.isError) throw new Error(text || `${tool} failed`)
  return JSON.parse(text)
}

async function run($: $T, argv: [string, ...string[]], timeoutMs = 30_000): Promise<string> {
  let lastError: unknown
  // The host's PATH may not hold Homebrew, so try the bare name, then the usual install folders.
  for (const bin of [argv[0], `/opt/homebrew/bin/${argv[0]}`, `/usr/local/bin/${argv[0]}`]) {
    try {
      const out = await $.process.run([bin, ...argv.slice(1)], { timeoutMs })
      if (out.exitCode !== 0) throw new Error(out.stderr.trim() || `${argv[0]} exited ${out.exitCode}`)
      return out.stdout
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

async function localNow($: $T): Promise<string> {
  // The host's own clock and time zone, as 2026-11-16T10:04:00.
  return (await run($, ['date', '+%Y-%m-%dT%H:%M:%S'])).trim()
}

// ---------- PRTG ----------

async function loadPrtg($: $T): Promise<PrtgSection> {
  try {
    const data = await mcpJson($, cfg.prtgServer, 'prtg_get_alarms', {
      response_format: 'json',
      include_unusual: true,
      include_warnings: true,
      limit: 500,
    })
    const alarms: any[] = data.alarms ?? []
    const isDown = (a: any) => String(a.status).startsWith('Down')
    const count = (pred: (a: any) => boolean) => alarms.filter(pred).length
    const rows: Alarm[] = alarms
      .filter(a => isDown(a) || a.status === 'Warning')
      .map(a => ({
        id: a.objid,
        name: a.name,
        device: a.device,
        status: a.status,
        message: a.message ?? '',
      }))
    return {
      down: count(isDown),
      warning: count(a => a.status === 'Warning'),
      unusual: count(a => a.status === 'Unusual'),
      rows,
    }
  } catch (err) {
    return { down: 0, warning: 0, unusual: 0, rows: [], error: errorText(err) }
  }
}

// ---------- GitLab ----------

function rankMr(pipeline: string | undefined, mergeStatus: string, isDraft: boolean, hasConflicts: boolean): { status: string; rank: number } {
  if (pipeline === 'failed') return { status: 'failed', rank: 0 }
  if (hasConflicts || mergeStatus === 'conflict') return { status: 'conflict', rank: 1 }
  if (mergeStatus === 'need_rebase') return { status: 'rebase', rank: 2 }
  if (pipeline === 'running' || pipeline === 'pending' || mergeStatus === 'ci_still_running') return { status: 'running', rank: 3 }
  if (isDraft) return { status: 'draft', rank: 5 }
  if (mergeStatus === 'mergeable') return { status: 'ready', rank: 4 }
  return { status: 'open', rank: 4 }
}

async function loadGitlab($: $T): Promise<GitlabSection> {
  try {
    const glab = (path: string) => run($, ['glab', 'api', '--hostname', cfg.gitlabHost, path])
    const mrs: any[] = JSON.parse(await glab('merge_requests?scope=created_by_me&state=opened&per_page=50'))
    const rows: MergeRequest[] = await Promise.all(
      mrs.map(async mr => {
        let pipeline: string | undefined
        try {
          const list = JSON.parse(await glab(`projects/${mr.project_id}/merge_requests/${mr.iid}/pipelines?per_page=1`))
          pipeline = list[0]?.status
        } catch {
          pipeline = undefined
        }
        const { status, rank } = rankMr(pipeline, mr.detailed_merge_status ?? '', Boolean(mr.draft), Boolean(mr.has_conflicts))
        return {
          ref: mr.references?.full ?? `!${mr.iid}`,
          title: String(mr.title).replace(/^Draft:\s*/i, ''),
          url: mr.web_url,
          status,
          rank,
        }
      }),
    )
    rows.sort((a, b) => a.rank - b.rank)
    return { rows }
  } catch (err) {
    return { rows: [], error: errorText(err) }
  }
}

// ---------- Plane ----------

const OPEN_GROUPS = new Set(['backlog', 'unstarted', 'started'])

async function loadPlaneWorkspace($: $T, server: string, today: string): Promise<{ open: number; rows: PlaneItem[] }> {
  const me = await mcpJson($, server, 'member', { action: 'me' })
  const ws = await mcpJson($, server, 'workspace', { action: 'retrieve' })
  const slug: string = ws.slug ?? ws.result?.slug ?? ''
  const projects: any[] = (await mcpJson($, server, 'project', { action: 'list', per_page: 100 })).result?.results ?? []

  let open = 0
  const rows: PlaneItem[] = []
  for (const project of projects) {
    let cursor = ''
    // Plane CE has no server-side filter: page through and keep what is mine.
    for (let page = 0; page < 5; page++) {
      const res = (
        await mcpJson($, server, 'workitem', {
          action: 'list',
          project_id: project.id,
          per_page: 100,
          cursor,
          expand: 'state',
          fields: 'id,name,sequence_id,target_date,priority,assignees,state',
        })
      ).result
      for (const item of res?.results ?? []) {
        const assignees: string[] = (item.assignees ?? []).map((a: any) => (typeof a === 'string' ? a : a?.id))
        if (!assignees.includes(me.id)) continue
        if (!OPEN_GROUPS.has(item.state?.group)) continue
        open++
        const due: string = item.target_date ?? ''
        const isDueNow = due !== '' && due <= today
        if (!isDueNow && item.priority !== 'urgent') continue
        const ref = `${project.identifier}-${item.sequence_id}`
        rows.push({
          ref,
          name: item.name,
          url: `${cfg.planeUrl}/${slug}/browse/${ref}/`,
          due,
          isOverdue: due !== '' && due < today,
          priority: item.priority ?? 'none',
        })
      }
      if (!res?.next_page_results || !res?.next_cursor) break
      cursor = res.next_cursor
    }
  }
  return { open, rows }
}

async function loadPlane($: $T, today: string): Promise<PlaneSection> {
  const results = await Promise.all(
    cfg.planeServers.map(async server => {
      try {
        return { server, ...(await loadPlaneWorkspace($, server, today)) }
      } catch (err) {
        return { server, open: 0, rows: [] as PlaneItem[], error: errorText(err) }
      }
    }),
  )
  const rows = results.flatMap(r => r.rows)
  rows.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) return a.isOverdue ? -1 : 1
    return (a.due || '9999') < (b.due || '9999') ? -1 : 1
  })
  return {
    open: results.reduce((sum, r) => sum + r.open, 0),
    rows,
    errors: results.flatMap(r => ('error' in r && r.error ? [`${r.server}: ${r.error}`] : [])),
  }
}

// ---------- Calendar ----------

async function loadCalendar($: $T, now: string): Promise<CalendarSection> {
  try {
    const data = await mcpJson($, cfg.calendarServer, 'list_events', {
      startTime: now,
      endTime: `${now.slice(0, 10)}T23:59:59`,
      orderBy: 'startTime',
      pageSize: 20,
    })
    const items: any[] = data.events ?? data.items ?? []
    return {
      rows: items.map(ev => {
        const start: string = ev.start?.dateTime ?? ev.start?.date ?? ''
        return { time: start.includes('T') ? start.slice(11, 16) : 'all day', title: ev.summary ?? '(no title)' }
      }),
    }
  } catch (err) {
    return { rows: [], error: errorText(err) }
  }
}

// ---------- refresh ----------

let isRefreshing = false
let wantPlane = false
// Set the first time the pane is drawn: only then is there anyone to fetch for.
let hasDrawn = false

// Every open session runs this mod, so fetched data is shared through $.store:
// a session reuses what another fetched recently instead of asking again.
type Cached<T> = { at: number; local: string; value: T }
const FAST_MAX_AGE_MS = REFRESH_MS - 30_000
const PLANE_MAX_AGE_MS = REFRESH_MS * PLANE_EVERY_TICKS - 30_000

async function cached<T>(
  $: $T,
  key: string,
  maxAgeMs: number,
  force: boolean,
  local: string,
  load: () => Promise<T>,
  isGood: (value: T) => boolean,
): Promise<Cached<T>> {
  const now = await $.clock.now()
  if (!force) {
    const hit = (await $.store.get(key).catch(() => undefined)) as Cached<T> | undefined
    if (hit && typeof hit.at === 'number' && now - hit.at < maxAgeMs) return hit
  }
  const fresh: Cached<T> = { at: now, local, value: await load() }
  // A failed fetch is shown here but not shared, so another session tries again.
  if (isGood(fresh.value)) await $.store.set(key, fresh).catch(() => undefined)
  return fresh
}

async function refresh($: $T, withPlane: boolean, force = false): Promise<void> {
  if (isRefreshing) {
    // A refresh is running: remember a Plane request so it runs right after.
    if (withPlane) wantPlane = true
    return
  }
  isRefreshing = true
  wantPlane = false
  try {
    await update($, meta, m => ({ ...m, isBusy: true }))
    const now = await localNow($).catch(() => new Date().toISOString().slice(0, 19))
    const today = now.slice(0, 10)
    const hhmm = now.slice(11, 16)
    const stamps: string[] = []
    const put = async <T,>(c: Cached<T>, write: (v: T) => Promise<unknown>) => {
      stamps.push(c.local)
      await write(c.value)
    }
    const skip = Promise.resolve()
    await Promise.all([
      cfg.prtgServer
        ? cached($, 'cache:prtg-1', FAST_MAX_AGE_MS, force, hhmm, () => loadPrtg($), v => !v.error).then(c =>
            put(c, v => update($, prtg, () => v)),
          )
        : skip,
      cfg.gitlabHost
        ? cached($, 'cache:gitlab-1', FAST_MAX_AGE_MS, force, hhmm, () => loadGitlab($), v => !v.error).then(c =>
            put(c, v => update($, gitlab, () => v)),
          )
        : skip,
      cfg.calendarServer
        ? cached($, `cache:calendar-1:${today}`, FAST_MAX_AGE_MS, force, hhmm, () => loadCalendar($, now), v => !v.error).then(c =>
            put(c, v => update($, calendar, () => v)),
          )
        : skip,
      withPlane && cfg.planeServers.length > 0
        ? cached($, `cache:plane-1:${today}`, PLANE_MAX_AGE_MS, force, hhmm, () => loadPlane($, today), v => v.errors.length === 0).then(
            c => update($, plane, () => c.value),
          )
        : skip,
    ])
    // The oldest of the fast sources, so the time never claims more than it holds.
    const updatedAt = stamps.sort()[0] ?? hhmm
    await update($, meta, () => ({ updatedAt, isBusy: false }))
  } finally {
    isRefreshing = false
    await update($, meta, m => ({ ...m, isBusy: false })).catch(() => undefined)
  }
  if (wantPlane) await refresh($, true)
}

const openPane = ($: $T) => $.ui.open({ id: PANE, title: TITLE })

// ---------- register ----------

export const register: Register = (on, options) => {
  cfg = readConfig(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'mission',
      description: 'Open Mission Control: alarms, merge requests and CI, tasks due, today',
    })
    // The desktop app docks it as a sidebar; a terminal waits for /mission.
    // A run with nothing to draw on (claude -p) never draws it, so never fetches.
    if (e.surface !== 'terminal') void openPane($)
    let tick = 0
    $.clock.every(REFRESH_MS, () => {
      tick++
      if (!hasDrawn) return
      void refresh($, tick % PLANE_EVERY_TICKS === 0)
    })

    return next(e)
  })

  on('command.run', { command: 'mission' }, async $ => {
    await openPane($)
    void refresh($, true, true)

    return { text: 'Mission Control opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (!hasDrawn) {
      hasDrawn = true
      // Fetch outside the drawing, which may not write state.
      $.clock.after(0, () => void refresh($, true))
    }
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Link } = table
    const Svg = 'Svg' in table ? table.Svg : undefined
    const [p, g, pl, c, m, open] = await Promise.all([
      read($, prtg),
      read($, gitlab),
      read($, plane),
      read($, calendar),
      read($, meta),
      read($, expanded),
    ])

    // ----- what needs attention, worked out once -----
    const isDown = (a: Alarm) => a.status.startsWith('Down')
    const failing = g?.rows.filter(r => r.status === 'failed').length ?? 0
    const overdue = pl?.rows.filter(r => r.isOverdue).length ?? 0
    const down = p?.down ?? 0

    const toggle = (id: string) => () =>
      update($, expanded, list => (list.includes(id) ? list.filter(x => x !== id) : [...list, id]))
    const limit = <T,>(id: string, rows: T[]) => (open.includes(id) ? rows : rows.slice(0, COLLAPSED_ROWS))

    // ----- the widget: a three-line glance -----
    if (e.props.placement === 'widget') {
      const line = (isBad: boolean, color: string, text: string) => (
        <Box flexDirection="row" gap={1}>
          <Text color={isBad ? color : undefined} dimColor={!isBad}>
            ●
          </Text>
          <Text>{text}</Text>
        </Box>
      )
      return (
        <Box flexDirection="column">
          {cfg.prtgServer ? line(down > 0, 'error', p ? `${down} down` : '…') : null}
          {cfg.gitlabHost ? line(failing > 0, 'error', g ? `${failing} failing` : '…') : null}
          {cfg.planeServers.length > 0 ? line(overdue > 0, 'warning', pl ? `${overdue} overdue` : '…') : null}
        </Box>
      )
    }

    // ----- building blocks, kept small like the session rail -----
    const width = Math.max(10, e.props.bodyColumns ?? 40)
    const separator = (id: string) =>
      Svg ? (
        <Box key={`sep-${id}`} marginY={1}>
          <Svg
            alt="divider"
            height={1}
            source={'<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1"><rect width="4000" height="1" fill="rgba(128,128,128,0.28)"/></svg>'}
          />
        </Box>
      ) : (
        <Text key={`sep-${id}`} dimColor>
          {'─'.repeat(width)}
        </Text>
      )

    // A section title: small grey words on the left, a short count on the right.
    const title = (label: string, count?: string, countColor?: string) => (
      <Box flexDirection="row" justifyContent="space-between" marginBottom={1}>
        <Text size="footnote" weight="medium" dimColor>
          {label}
        </Text>
        {count ? (
          <Text size="footnote" color={countColor} dimColor={!countColor} tabular>
            {count}
          </Text>
        ) : null}
      </Box>
    )

    // One row: what it is on the left, cut to fit; its state on the right.
    const row = (left: unknown, right?: string, rightColor?: string) => (
      <Box flexDirection="row" justifyContent="space-between" gap={2}>
        <Box flexDirection="row" gap={1} flexShrink={1}>
          {left as any}
        </Box>
        {right ? (
          <Text size="footnote" color={rightColor} dimColor={!rightColor} wrap="truncate-end">
            {right}
          </Text>
        ) : null}
      </Box>
    )

    const note = (text: string, color?: string) => (
      <Text size="footnote" color={color} dimColor={!color} wrap="truncate-end">
        {text}
      </Text>
    )

    const showAll = (id: string, total: number) =>
      total > COLLAPSED_ROWS ? (
        <Box marginTop={1}>
          <Button key={`more-${id}`} plain dimColor onPress={toggle(id)}>
            {open.includes(id) ? 'Show less' : `Show all ${total}`}
          </Button>
        </Box>
      ) : null

    const section = (id: string, head: unknown, body: unknown[]) => (
      <Box key={`section-${id}`} flexDirection="column">
        {head as any}
        {body as any}
      </Box>
    )

    // ----- Monitoring (PRTG) -----
    const prtgShown = p ? (down > 0 ? p.rows.filter(isDown) : p.rows) : []
    const monitoring = section(
      'prtg',
      title('Monitoring', p && !p.error ? (down > 0 ? `${down} down` : `${p.warning} warnings`) : undefined, down > 0 ? 'error' : undefined),
      !p
        ? [note('Loading…')]
        : p.error
          ? [note(`Could not reach PRTG: ${p.error}`, 'error')]
          : [
              ...(down === 0 ? [note('Nothing down.')] : []),
              ...limit('prtg', prtgShown).map(a =>
                row(
                  [
                    <Text wrap="truncate-end">
                      {a.device}
                      <Text dimColor> · {a.name}</Text>
                    </Text>,
                  ],
                  isDown(a) ? 'down' : 'warning',
                  isDown(a) ? 'error' : undefined,
                ),
              ),
              showAll('prtg', prtgShown.length),
            ],
    )

    // ----- Merge requests (GitLab) -----
    const statusColor = (s: string) => (s === 'failed' || s === 'conflict' ? 'error' : s === 'rebase' ? 'warning' : undefined)
    const shortRef = (ref: string) => ref.split('/').pop() ?? ref
    const mergeRequests = section(
      'gitlab',
      title('Merge requests', g && !g.error ? (failing > 0 ? `${failing} failing` : `${g.rows.length} open`) : undefined, failing > 0 ? 'error' : undefined),
      !g
        ? [note('Loading…')]
        : g.error
          ? [note(`Could not reach GitLab: ${g.error}`, 'error')]
          : g.rows.length === 0
            ? [note('No open merge requests.')]
            : [
                ...limit('gitlab', g.rows).map(mr =>
                  row(
                    [
                      <Link href={mr.url} label={shortRef(mr.ref)} />,
                      <Text dimColor wrap="truncate-end">
                        {mr.title}
                      </Text>,
                    ],
                    mr.status,
                    statusColor(mr.status),
                  ),
                ),
                showAll('gitlab', g.rows.length),
              ],
    )

    // ----- Plane -----
    const plan = section(
      'plane',
      title('Plane', pl ? (overdue > 0 ? `${overdue} overdue` : `${pl.rows.length} due`) : undefined, overdue > 0 ? 'warning' : undefined),
      !pl
        ? [note('Loading…')]
        : [
            ...(pl.rows.length === 0 && pl.errors.length === 0 ? [note('Nothing due today.')] : []),
            ...limit('plane', pl.rows).map(it =>
              row(
                [
                  <Link href={it.url} label={it.ref} />,
                  <Text dimColor wrap="truncate-end">
                    {it.name}
                  </Text>,
                ],
                it.due ? (it.isOverdue ? it.due.slice(5) : 'today') : it.priority,
                it.isOverdue ? 'warning' : undefined,
              ),
            ),
            showAll('plane', pl.rows.length),
            ...pl.errors.map(err => note(err, 'error')),
          ],
    )

    // ----- Today (calendar) -----
    const today = section(
      'calendar',
      title('Today', c && !c.error && c.rows.length > 0 ? `${c.rows.length} left` : undefined),
      !c
        ? [note('Loading…')]
        : c.error
          ? [note(`Could not reach the calendar: ${c.error}`, 'error')]
          : c.rows.length === 0
            ? [note('Nothing else on today.')]
            : [
                ...limit('calendar', c.rows).map(ev =>
                  row(
                    [<Text wrap="truncate-end">{ev.title}</Text>],
                    ev.time,
                  ),
                ),
                showAll('calendar', c.rows.length),
              ],
    )

    // ----- the status line on top -----
    const needs = [
      down > 0 ? `${down} down` : '',
      failing > 0 ? `${failing} failing` : '',
      overdue > 0 ? `${overdue} overdue` : '',
    ].filter(Boolean)
    const isLoaded = (!cfg.prtgServer || Boolean(p)) && (!cfg.gitlabHost || Boolean(g)) && (cfg.planeServers.length === 0 || Boolean(pl))
    const status = !isLoaded ? 'Checking…' : needs.length === 0 ? 'All clear' : needs.join(' · ')
    const statusDot = !isLoaded ? undefined : down > 0 || failing > 0 ? 'error' : overdue > 0 ? 'warning' : 'success'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" gap={2}>
          <Box flexDirection="row" gap={1}>
            <Text color={statusDot} dimColor={!statusDot}>
              ●
            </Text>
            <Text weight="medium">{status}</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text size="footnote" dimColor>
              {m.isBusy ? 'Refreshing…' : m.updatedAt}
            </Text>
            <Button key="refresh" plain dimColor onPress={() => void refresh($, true, true)}>
              Refresh
            </Button>
          </Box>
        </Box>
        {[
          cfg.prtgServer ? { id: 'prtg', node: monitoring } : null,
          cfg.gitlabHost ? { id: 'gitlab', node: mergeRequests } : null,
          cfg.planeServers.length > 0 ? { id: 'plane', node: plan } : null,
          cfg.calendarServer ? { id: 'calendar', node: today } : null,
        ]
          .filter(x => x !== null)
          .flatMap(x => [separator(x.id), x.node])}
        {!cfg.prtgServer && !cfg.gitlabHost && cfg.planeServers.length === 0 && !cfg.calendarServer ? (
          <Box marginTop={1}>{note('Nothing is set up yet. Set the options in /config under Mission Control.')}</Box>
        ) : null}
      </Box>
    )
  })
}
