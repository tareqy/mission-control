# Mission Control

A Claude Code mod that keeps one calm pane beside the chat with what needs you right now:

- **Monitoring**: PRTG sensors that are down, then warnings
- **Merge requests**: your open GitLab merge requests, failing CI first
- **Plane**: your open work items that are overdue, due today or urgent, across several workspaces
- **Today**: the rest of today's Google Calendar

A single line at the top reads **All clear**, or names what needs you (`1 down · 2 failing · 3 overdue`). Each section shows three rows, with the rest behind "Show all". Colour is used only for things that need attention.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install mission-control --marketplace tareqy/mission-control
```

From a shell:

```bash
claude plugin install mission-control --marketplace tareqy/mission-control
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `tareqy/mission-control`, then **Add plugin**.

## Set it up

Every source is optional. A section appears only when its option is set, in `/config` under Mission Control (or when the install asks).

| Option | What to put | Needs |
| --- | --- | --- |
| `prtgServer` | Name of your PRTG MCP server, as `/mcp` lists it | An MCP server with a `prtg_get_alarms` tool |
| `gitlabHost` | Your GitLab host, such as `gitlab.com` | [`glab`](https://gitlab.com/gitlab-org/cli) signed in to that host |
| `planeUrl` | Your Plane address, such as `https://app.plane.so` | Used for item links |
| `planeServers` | Comma-separated Plane MCP server names, one per workspace | MCP servers with `member`, `workspace`, `project` and `workitem` tools |
| `calendarServer` | Name of your Google Calendar MCP server | A server with a `list_events` tool |

## How it behaves

- In the desktop app the pane opens by itself as a sidebar. In a terminal, type `/mission`.
- It refreshes every 3 minutes, and Plane every 15 (Plane is paged project by project). **Refresh** and `/mission` fetch fresh data at once.
- Several open sessions share what one of them fetched, so your servers are asked about once per cycle, not once per session.
- It fetches only once the pane has been drawn, so runs with nothing to draw on (`claude -p`, scripts) fetch nothing.
- When the desktop app shrinks the pane to a widget, it shows a three-line glance.
- Data goes only through your own MCP servers and `glab`. Nothing is sent anywhere else.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

The pane is one hooks module, `hooks/register.tsx`, written against the Claude Code function hooks API.

## License

MIT
