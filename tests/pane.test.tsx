import { expect, mock, test } from 'claude-code/testing'

const OPTIONS = {
  options: {
    prtgServer: 'prtg',
    gitlabHost: 'gitlab.example.com',
    planeUrl: 'https://plane.example.com',
    planeServers: 'plane, plane-2',
    calendarServer: 'calendar',
  },
}

const PANE = {
  plugin: 'mission-control',
  component: 'Pane',
  requestId: 'mission-control',
  props: {
    title: 'Mission Control',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const json = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })

const ME = 'user-1'

// Each hook here stands for the engine and the outside world beneath the mod.
function world(on: any, opts: { prtgFails?: boolean; calm?: boolean } = {}) {
  const clock = mock.clock(on)
  mock.store(on)
  const calls = { workitem: 0, mrList: 0, registered: [] as string[] }
  on('command.register', (_: unknown, e: any) => {
    calls.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))

  on('process.run', (_: unknown, e: any) => {
    const argv: string[] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'date') return ok('2026-11-16T10:04:00\n')
    const path = argv[argv.length - 1] ?? ''
    if (path.startsWith('merge_requests')) {
      calls.mrList++
      return ok(
        JSON.stringify([
          { project_id: 1, iid: 7, title: 'Ready one', web_url: 'https://gitlab.example.com/a/b/-/merge_requests/7', references: { full: 'a/b!7' }, detailed_merge_status: 'mergeable', draft: false, has_conflicts: false },
          { project_id: 1, iid: 8, title: 'Broken one', web_url: 'https://gitlab.example.com/a/b/-/merge_requests/8', references: { full: 'a/b!8' }, detailed_merge_status: 'ci_must_pass', draft: false, has_conflicts: false },
        ]),
      )
    }
    if (path.includes('/merge_requests/8/pipelines')) return ok(JSON.stringify([{ status: opts.calm ? 'success' : 'failed' }]))
    return ok(JSON.stringify([{ status: 'success' }]))
  })

  on('mcp.call', (_: unknown, e: any) => {
    if (e.server === 'prtg') {
      if (opts.prtgFails) return { value: { content: [{ type: 'text', text: 'connection refused' }], isError: true } }
      return json({
        alarms: [
          ...(opts.calm ? [] : [{ objid: 1, name: 'Ping', device: 'web-1', status: 'Down', message: 'timeout' }]),
          { objid: 2, name: 'Disk /boot', device: 'db-1', status: 'Warning', message: '20 %' },
          { objid: 3, name: 'Traffic', device: 'switch', status: 'Unusual', message: 'low' },
        ],
      })
    }
    if (e.server.startsWith('plane')) {
      if (e.server !== 'plane') return json({ result: { results: [] }, id: ME, slug: 'x' })
      if (e.tool === 'member') return json({ id: ME })
      if (e.tool === 'workspace') return json({ slug: 'acme' })
      if (e.tool === 'project') return json({ result: { results: [{ id: 'p1', identifier: 'OPS' }] } })
      if (e.tool === 'workitem') {
        calls.workitem++
        return json({
          result: {
            results: [
              { name: 'Late task', sequence_id: 4, target_date: opts.calm ? '2026-11-16' : '2026-11-10', priority: 'high', assignees: [ME], state: { group: 'started' } },
              { name: 'Later task', sequence_id: 5, target_date: '2026-12-01', priority: 'low', assignees: [ME], state: { group: 'unstarted' } },
              { name: 'Done task', sequence_id: 6, target_date: '2026-11-01', priority: 'high', assignees: [ME], state: { group: 'completed' } },
              { name: 'Not mine', sequence_id: 7, target_date: '2026-11-01', priority: 'high', assignees: ['other'], state: { group: 'started' } },
            ],
            next_page_results: false,
          },
        })
      }
    }
    // Calendar
    return json({ events: [{ summary: 'Standup', start: { dateTime: '2026-11-16T11:00:00+02:00' } }] })
  })
  return { clock, calls }
}

test('the pane shows every section, failing CI first, on desktop and terminal', OPTIONS, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ type: 'Text', text: /^1 down · 1 failing · 1 overdue$/ }))?.text).toBeTruthy()
    for (const label of ['Monitoring', 'Merge requests', 'Plane', 'Today']) {
      expect((await ui.find({ type: 'Text', text: new RegExp(`^${label}$`) }))?.text).toBe(label)
    }
    expect((await ui.find({ type: 'Text', text: /^web-1 · Ping$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^failed$/ }))?.text).toBe('failed')
    expect((await ui.find({ type: 'Text', text: /^Broken one$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^1 overdue$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^11-10$/ }))?.text).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Not mine|Done task/ })).toBeFalsy()
    expect((await ui.find({ type: 'Text', text: /^Standup$/ }))?.text).toBeTruthy()
    expect((await ui.find({ type: 'Text', text: /^11:00$/ }))?.text).toBeTruthy()
    await ui.unmount()
  }
})

test('a source that fails says so and the rest still draw', OPTIONS, async ($, on) => {
  world(on, { prtgFails: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ type: 'Text', text: /Could not reach PRTG: connection refused/ }))?.text).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /^1 failing$/ }))?.text).toBeTruthy()
  await ui.unmount()
})

test('a calm day says All clear', OPTIONS, async ($, on) => {
  world(on, { calm: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^All clear$/ }))?.text).toBe('All clear')
  await ui.unmount()
})

test('the widget shows a three-line glance', OPTIONS, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const full = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await full.press({ key: 'refresh' })
  await full.unmount()

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^1 down$/ }))?.text).toBe('1 down')
  expect((await ui.find({ type: 'Text', text: /^1 failing$/ }))?.text).toBe('1 failing')
  expect((await ui.find({ type: 'Text', text: /^1 overdue$/ }))?.text).toBe('1 overdue')
  await ui.unmount()
})

test('Plane refreshes by itself every 15 minutes, and the rest every 3', OPTIONS, async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  const afterStart = calls.workitem
  expect(afterStart).toBeGreaterThan(0)

  await clock.advance(12 * 60_000)
  expect(calls.workitem).toBe(afterStart)

  await clock.advance(3 * 60_000)
  expect(calls.workitem).toBeGreaterThan(afterStart)
  await ui.unmount()
})

test('a session that never draws the pane fetches nothing', OPTIONS, async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await clock.advance(20 * 60_000)
  expect(calls.mrList).toBe(0)
})

test('with nothing set up, the pane says how to set it up and fetches nothing', async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(20 * 60_000)
  expect(calls.mrList).toBe(0)
  expect(calls.workitem).toBe(0)

  expect((await ui.find({ type: 'Text', text: /Nothing is set up yet/ }))?.text).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^Monitoring$/ })).toBeFalsy()
  await ui.unmount()
})

test('a Plane link uses the address and workspace from the options', OPTIONS, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const link = await ui.find({ type: 'Link', text: /OPS-4/ })
  expect(link?.props?.href).toBe('https://plane.example.com/acme/browse/OPS-4/')
  await ui.unmount()
})

test('in the desktop app (an SDK host, not interactive) /mission works and the pane fills by itself', OPTIONS, async ($, on) => {
  const { clock, calls } = world(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(calls.registered).toContain('mission')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.settle()
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /^1 down · 1 failing · 1 overdue$/ }))?.text).toBeTruthy()
  await ui.unmount()
})
