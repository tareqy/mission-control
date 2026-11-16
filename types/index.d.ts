export type Alarm = {
  id: number
  name: string
  device: string
  status: string
  message: string
}

export type PrtgSection = {
  down: number
  warning: number
  unusual: number
  rows: Alarm[]
  error?: string
}

export type MergeRequest = {
  ref: string
  title: string
  url: string
  // One word a person reads: failed, conflict, rebase, running, draft, ready, open
  status: string
  rank: number
}

export type GitlabSection = {
  rows: MergeRequest[]
  error?: string
}

export type PlaneItem = {
  ref: string
  name: string
  url: string
  due: string
  isOverdue: boolean
  priority: string
}

export type PlaneSection = {
  open: number
  rows: PlaneItem[]
  errors: string[]
}

export type CalendarEvent = {
  time: string
  title: string
}

export type CalendarSection = {
  rows: CalendarEvent[]
  error?: string
}

export type Meta = {
  updatedAt: string
  isBusy: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'mission-control': {
      prtg: Shaped<PrtgSection | null>
      gitlab: Shaped<GitlabSection | null>
      plane: Shaped<PlaneSection | null>
      calendar: Shaped<CalendarSection | null>
      meta: Shaped<Meta>
      expanded: Shaped<string[]>
    }
  }
}
