import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// mcp-on-demand: keeps OpenCode MCP servers disabled until a session asks for them
// with mcp_connect, and stops idle local servers. https://github.com/chrismaree/open-code-mcp-on-demand
//
// Settings: ~/.config/opencode/mcp-on-demand.json (or $OPENCODE_MCP_ON_DEMAND_CONFIG),
// merged with plugin `options` from opencode.json. Set "enabled": false to turn it off.
// The plugin only changes server state at runtime; if it fails to load, every server
// keeps its configured state.

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
const SETTINGS = process.env.OPENCODE_MCP_ON_DEMAND_CONFIG || join(CONFIG_HOME, "opencode/mcp-on-demand.json")
const LOG = join(DATA_HOME, "opencode/log/mcp-on-demand.log")
const CONNECT_TIMEOUT_MS = 60_000
const REAP_INTERVAL_MS = 5 * 60_000
const STALE_CALL_MS = 24 * 60 * 60_000

type Group = { description: string; servers: string[] }
type Settings = {
  enabled?: boolean
  alwaysOn?: string[]
  localIdleHours?: number
  /** Overrides localIdleHours; for testing the idle stop. */
  localIdleMinutes?: number
  groups?: Record<string, Group>
  autoConnect?: { directory: string; groups: string[] }[]
}

const log = (location: string, message: string) => {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, `${new Date().toISOString()} [${location}] ${message}\n`)
  } catch {}
}

const normalize = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_")

const expandHome = (path: string) => (path.startsWith("~") ? join(homedir(), path.slice(1)) : path)

// Matches the directory or any descendant; "*" matches within one path segment.
const matchesDirectory = (pattern: string, directory: string) => {
  const source = expandHome(pattern)
    .replace(/\/+$/, "")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*")
  return new RegExp(`^${source}(/|$)`).test(directory)
}

const CODEMODE_REF = /tools\s*(?:\.\s*([A-Za-z0-9_$-]+)|\[\s*["'`]([^"'`]+)["'`]\s*\])/g

export default {
  id: "mcp-on-demand",
  async setup(ctx: any) {
    const directory: string = ctx.location?.directory ?? "?"
    // A missing settings file means defaults (everything dormant, no groups); an
    // unreadable one leaves MCP config untouched rather than guessing.
    let fileSettings: Settings = {}
    if (existsSync(SETTINGS)) {
      try {
        fileSettings = JSON.parse(readFileSync(SETTINGS, "utf8"))
      } catch (error) {
        log(directory, `settings unreadable, leaving MCP config untouched: ${error}`)
        return
      }
    }
    const settings: Settings = { ...fileSettings, ...(ctx.options ?? {}) }
    if (settings.enabled === false) return

    const alwaysOn = new Set(settings.alwaysOn ?? [])
    const groups = settings.groups ?? {}
    const idleMs = settings.localIdleMinutes
      ? settings.localIdleMinutes * 60_000
      : (settings.localIdleHours ?? 6) * 60 * 60_000
    const reapIntervalMs = Math.min(REAP_INTERVAL_MS, Math.max(15_000, idleMs / 4))

    // Every configured server except alwaysOn is managed (dormant by default), so newly
    // added MCP servers start off without touching this plugin. Filled by the transform.
    const managed = new Set<string>()
    const enabled = new Set<string>()
    const known = new Map<string, "local" | "remote">()
    const byNormalized = new Map<string, string>()
    const grouped = new Set(Object.values(groups).flatMap((group) => group.servers))
    const lastUsed = new Map<string, number>()
    const inflight = new Map<string, Map<string, number>>()

    for (const rule of settings.autoConnect ?? []) {
      if (!matchesDirectory(rule.directory, directory)) continue
      for (const group of rule.groups) for (const server of groups[group]?.servers ?? []) enabled.add(server)
    }
    for (const server of enabled) lastUsed.set(server, Date.now())

    // Transform callbacks run lazily on the next registry read, so seed the managed set now.
    const listed = await ctx.mcp.list().catch(() => undefined)
    for (const server of (listed?.data ?? listed ?? []) as any[]) {
      if (!server?.name || alwaysOn.has(server.name)) continue
      managed.add(server.name)
      byNormalized.set(normalize(server.name), server.name)
    }

    // The callback is replayed on every reload, so it always reflects `enabled`.
    await ctx.mcp.transform((editor: any) => {
      for (const [name, config] of editor.list()) {
        if (alwaysOn.has(name)) continue
        managed.add(name)
        byNormalized.set(normalize(name), name)
        known.set(name, config.type === "local" ? "local" : "remote")
        editor.update(name, (draft: any) => {
          draft.disabled = !enabled.has(name)
        })
      }
    })
    await ctx.mcp.reload()
    log(directory, `loaded; managed=${managed.size} auto=${[...enabled].join(",") || "-"}`)

    const resolve = (targets: string[]) => {
      const servers = new Set<string>()
      const unknown: string[] = []
      for (const target of targets) {
        if (groups[target]) groups[target].servers.forEach((server) => servers.add(server))
        else if (managed.has(target)) servers.add(target)
        else unknown.push(target)
      }
      return { servers: [...servers].filter((server) => managed.has(server)), unknown }
    }

    const statuses = async () => {
      const result = await ctx.mcp.list()
      const list: any[] = result?.data ?? result ?? []
      return new Map(list.map((server) => [server.name, server.status ?? {}]))
    }

    const describe = (status: any) =>
      status?.status === "failed" ? `failed: ${status.error}` : status?.status ?? "unknown"

    const waitForSettled = async (servers: string[], signal?: AbortSignal) => {
      const deadline = Date.now() + CONNECT_TIMEOUT_MS
      let current = await statuses()
      while (Date.now() < deadline && !signal?.aborted) {
        if (servers.every((server) => !["pending", undefined].includes(current.get(server)?.status))) break
        await new Promise((done) => setTimeout(done, 500))
        current = await statuses()
      }
      return current
    }

    const catalog = () => {
      const lines = Object.entries(groups).map(
        ([name, group]) => `- ${name} (${group.servers.join(", ")}): ${group.description}`,
      )
      const ungrouped = [...managed].filter((server) => !grouped.has(server)).sort()
      if (ungrouped.length > 0) {
        lines.push(`- Ungrouped servers (connect by server name): ${ungrouped.join(", ")}`)
      }
      return lines.join("\n")
    }

    const asList = (input: any): string[] =>
      (Array.isArray(input?.targets) ? input.targets : [input?.targets]).filter(
        (value: unknown): value is string => typeof value === "string" && value.length > 0,
      )

    const targetsInput = {
      type: "object",
      properties: {
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Group names (preferred) or individual MCP server names.",
        },
      },
      required: ["targets"],
      additionalProperties: false,
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "mcp_connect",
        description:
          "Turn on dormant MCP server groups for this directory. Call before using a dormant server, and again if its tools are missing (it may have been stopped while idle). Safe to repeat. New tools appear from your next step.",
        input: targetsInput,
        options: { codemode: false },
        execute: async (input: any, context: any) => {
          const { servers, unknown } = resolve(asList(input))
          if (servers.length === 0) {
            return { content: `Nothing to connect. Unknown: ${unknown.join(", ") || "(none given)"}.\nGroups:\n${catalog()}` }
          }
          const added = servers.filter((server) => !enabled.has(server))
          for (const server of servers) {
            enabled.add(server)
            lastUsed.set(server, Date.now())
          }
          if (added.length > 0) await ctx.mcp.reload()
          log(directory, `connect ${servers.join(",")} (new: ${added.join(",") || "-"}) session=${context?.sessionID}`)
          const current = await waitForSettled(servers, context?.signal)
          const lines = servers.map((server) => `- ${server}: ${describe(current.get(server))}`)
          if (unknown.length > 0) lines.push(`Unknown targets ignored: ${unknown.join(", ")}`)
          return {
            content: `${lines.join("\n")}\nConnected tools are available from your next step (Code Mode: tools.<server>).`,
          }
        },
      })
      editor.add({
        name: "mcp_disconnect",
        description: "Turn dormant MCP server groups back off for this directory once you are finished with them.",
        input: targetsInput,
        options: { codemode: false },
        execute: async (input: any) => {
          const { servers, unknown } = resolve(asList(input))
          const removed = servers.filter((server) => enabled.delete(server))
          if (removed.length > 0) await ctx.mcp.reload()
          log(directory, `disconnect ${removed.join(",") || "-"}`)
          return {
            content: `Disconnected: ${removed.join(", ") || "nothing"}${unknown.length ? `\nUnknown: ${unknown.join(", ")}` : ""}`,
          }
        },
      })
      editor.add({
        name: "mcp_status",
        description: "Show dormant MCP groups and which servers are currently connected in this directory.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async () => {
          const current = await statuses()
          const lines = [...current.keys()].sort().map((server) => {
            const role = !managed.has(server) ? "always-on" : enabled.has(server) ? "on-demand (on)" : "dormant"
            return `- ${server} [${role}]: ${describe(current.get(server))}`
          })
          return { content: `Groups:\n${catalog()}\n\nServers:\n${lines.join("\n")}` }
        },
      })
    })

    const instructions = () =>
      [
        "Dormant MCP servers: most MCP servers are off until needed, to save memory and context.",
        "Before using one of these groups, call mcp_connect with the group name. If a dormant server's tools are missing, call mcp_connect again.",
        "Only connect what the current task needs. Groups:",
        catalog(),
      ].join("\n")

    await ctx.session.hook("context", (event: any) => {
      if (managed.size === 0) return
      event.system.push({ type: "text", text: instructions() })
    })

    const serversInCall = (tool: string, input: any) => {
      const found = new Set<string>()
      for (const [normalized, server] of byNormalized) {
        if (tool.startsWith(`${normalized}_`)) found.add(server)
      }
      const code = typeof input?.code === "string" ? input.code : ""
      for (const match of code.matchAll(CODEMODE_REF)) {
        const server = byNormalized.get(match[1] ?? match[2] ?? "")
        if (server) found.add(server)
      }
      return [...found].filter((server) => enabled.has(server))
    }

    await ctx.tool.hook("execute.before", (event: any) => {
      const servers = serversInCall(event.tool, event.input)
      if (servers.length > 0) log(directory, `use ${servers.join(",")} via ${event.tool}`)
      for (const server of servers) {
        lastUsed.set(server, Date.now())
        if (!inflight.has(server)) inflight.set(server, new Map())
        inflight.get(server)!.set(String(event.id), Date.now())
      }
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      for (const server of serversInCall(event.tool, event.input)) {
        lastUsed.set(server, Date.now())
        inflight.get(server)?.delete(String(event.id))
      }
    })

    const reap = async () => {
      const now = Date.now()
      const stopped: string[] = []
      for (const server of enabled) {
        if (known.get(server) !== "local") continue
        const calls = inflight.get(server)
        for (const [id, started] of calls ?? []) if (now - started > STALE_CALL_MS) calls!.delete(id)
        if (calls && calls.size > 0) continue
        if (now - (lastUsed.get(server) ?? 0) < idleMs) continue
        enabled.delete(server)
        stopped.push(server)
      }
      if (stopped.length === 0) return
      await ctx.mcp.reload()
      log(directory, `idle stop ${stopped.join(",")}`)
    }

    const timer = setInterval(() => void reap().catch((error) => log(directory, `reap failed: ${error}`)), reapIntervalMs)
    return () => clearInterval(timer)
  },
}
