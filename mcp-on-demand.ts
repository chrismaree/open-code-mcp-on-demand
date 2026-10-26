import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

// mcp-on-demand: keeps OpenCode MCP servers disabled until a session asks for them
// with mcp_connect, scopes them to the sessions that asked, and stops idle servers.
// https://github.com/chrismaree/open-code-mcp-on-demand
//
// Settings: ~/.config/opencode/mcp-on-demand.json (or $OPENCODE_MCP_ON_DEMAND_CONFIG),
// merged with plugin `options` from opencode.json. Set "enabled": false to turn it off.
// The plugin only changes server state at runtime; if it fails to load, every server
// keeps its configured state.
//
// OpenCode connects MCP servers per directory, so a server is running while any session
// in the directory holds it. Each session only sees, and can only call, the servers it
// connected: the plugin removes the others from that session's Code Mode catalog, MCP
// instructions and tool list on every model request, and refuses their calls.

const CONFIG_HOME = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
const DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
const SETTINGS = process.env.OPENCODE_MCP_ON_DEMAND_CONFIG || join(CONFIG_HOME, "opencode/mcp-on-demand.json")
const LOG = join(DATA_HOME, "opencode/log/mcp-on-demand.log")
const CONNECT_TIMEOUT_MS = 60_000
const REAP_INTERVAL_MS = 5 * 60_000
const STALE_CALL_MS = 24 * 60 * 60_000
const DEFAULT_IDLE_MINUTES = 60

type Group = { description: string; servers: string[] }
type Settings = {
  enabled?: boolean
  alwaysOn?: string[]
  /** A session drops a server it has not used for this long; the server stops once no session holds it. */
  idleMinutes?: number
  /** Deprecated: read when idleMinutes is not set. */
  localIdleHours?: number
  /** Deprecated: read when idleMinutes is not set. */
  localIdleMinutes?: number
  /** Child sessions (subagents) start with their parent's servers. Default false: they start lean. */
  inheritToChildSessions?: boolean
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

// ── Prompt filtering ────────────────────────────────────────────────────────────
// OpenCode renders connected servers into the session's system prompt (Code Mode
// catalog entries and <mcp_instructions> blocks) and appends system messages when the
// catalog changes mid-session. These helpers remove one session's hidden servers from
// that text. They only remove blocks they recognise exactly; anything else is left as is.

const CATALOG_ENTRY = /^- ([A-Za-z0-9_-]+) \(\d+ tools?\b/
const SERVER_BLOCK = /^[ \t]*<server name="([^"]+)">\n[\s\S]*?^[ \t]*<\/server>[ \t]*\n?/gm
const EMPTY_INSTRUCTIONS = /<mcp_instructions>\s*<\/mcp_instructions>\n?/g

/** Removes `- name (N tools …)` catalog entries for hidden names, each up to the next entry, blank line or tag. */
export const filterCatalog = (text: string, hidden: (name: string) => boolean) => {
  if (!/^- [A-Za-z0-9_-]+ \(\d+ tools?\b/m.test(text)) return text
  const lines = text.split("\n")
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    const entry = CATALOG_ENTRY.exec(line)
    if (entry) skipping = hidden(entry[1])
    else if (skipping && (line.trim() === "" || line.startsWith("<") || line.startsWith("#") || line.startsWith("- "))) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join("\n")
}

/** Removes `<server name="…">` instruction blocks for hidden servers, and an emptied wrapper. */
export const filterInstructions = (text: string, hidden: (name: string) => boolean) => {
  if (!text.includes("<server name=")) return text
  return text.replace(SERVER_BLOCK, (block, name) => (hidden(name) ? "" : block)).replace(EMPTY_INSTRUCTIONS, "")
}

export const filterText = (text: string, hidden: (name: string) => boolean) =>
  filterInstructions(filterCatalog(text, hidden), hidden)

/** A server needs a reload when OpenCode has it disabled or has no record of it; failed or
 * auth-pending servers are left alone (reloading would not fix them). */
export const needsReload = (status: any) => status === undefined || status?.status === "disabled"

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
    const idleMs =
      (settings.idleMinutes ??
        settings.localIdleMinutes ??
        (settings.localIdleHours !== undefined ? settings.localIdleHours * 60 : DEFAULT_IDLE_MINUTES)) * 60_000
    const reapIntervalMs = Math.min(REAP_INTERVAL_MS, Math.max(15_000, idleMs / 4))
    const inherit = settings.inheritToChildSessions === true

    // Every configured server except alwaysOn is managed (dormant by default), so newly
    // added MCP servers start off without touching this plugin. Filled by the transform.
    const managed = new Set<string>()
    const byNormalized = new Map<string, string>()
    const grouped = new Set(Object.values(groups).flatMap((group) => group.servers))

    // sessionID -> server -> last use (ms). A server runs while any session holds it.
    const sessions = new Map<string, Map<string, number>>()
    // sessionID -> server -> call id -> start (ms): calls in progress are never reaped.
    const inflight = new Map<string, Map<string, Map<string, number>>>()
    const seeded = new Set<string>()

    const autoServers = new Set<string>()
    for (const rule of settings.autoConnect ?? []) {
      if (!matchesDirectory(rule.directory, directory)) continue
      for (const group of rule.groups) for (const server of groups[group]?.servers ?? []) autoServers.add(server)
    }

    const held = () => {
      const all = new Set<string>()
      for (const servers of sessions.values()) for (const server of servers.keys()) all.add(server)
      return all
    }
    const sessionServers = (sessionID: string) => sessions.get(sessionID) ?? new Map<string, number>()
    const holdServers = (sessionID: string, servers: Iterable<string>) => {
      const map = sessions.get(sessionID) ?? new Map<string, number>()
      for (const server of servers) map.set(server, Date.now())
      sessions.set(sessionID, map)
    }

    // New sessions get the directory's autoConnect servers, and optionally their parent's.
    const seed = async (sessionID: string) => {
      if (!sessionID || seeded.has(sessionID)) return false
      seeded.add(sessionID)
      const start = new Set(autoServers)
      if (inherit) {
        try {
          const info = await ctx.session.get({ sessionID })
          const parentID = (info?.data ?? info)?.parentID
          if (parentID) for (const server of sessionServers(parentID).keys()) start.add(server)
        } catch {}
      }
      if (start.size === 0) return false
      const before = held()
      holdServers(sessionID, start)
      return [...start].some((server) => !before.has(server))
    }

    // Transform callbacks run lazily on the next registry read, so seed the managed set now.
    const listed = await ctx.mcp.list().catch(() => undefined)
    for (const server of (listed?.data ?? listed ?? []) as any[]) {
      if (!server?.name || alwaysOn.has(server.name)) continue
      managed.add(server.name)
      byNormalized.set(normalize(server.name), server.name)
    }

    // The callback is replayed on every reload, so it always reflects the held set.
    await ctx.mcp.transform((editor: any) => {
      const running = held()
      for (const [name] of editor.list()) {
        if (alwaysOn.has(name)) continue
        managed.add(name)
        byNormalized.set(normalize(name), name)
        editor.update(name, (draft: any) => {
          draft.disabled = !running.has(name)
        })
      }
    })
    await ctx.mcp.reload()
    log(directory, `loaded; managed=${managed.size} idle=${idleMs / 60_000}m inherit=${inherit} auto=${[...autoServers].join(",") || "-"}`)

    const serverFor = (name: string) => byNormalized.get(name) ?? (managed.has(name) ? name : undefined)

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

    const groupsOf = (server: string) =>
      Object.entries(groups)
        .filter(([, group]) => group.servers.includes(server))
        .map(([name]) => name)

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

    // When another session already runs a server, connecting it here changes nothing
    // OpenCode tracks, so OpenCode posts no catalog update for this session: list the
    // tools in the result instead.
    const toolSummary = async (servers: string[]) => {
      const tools: any[] = await ctx.tool.list().catch(() => [])
      const lines: string[] = []
      for (const server of servers) {
        const prefix = `${normalize(server)}_`
        const names = tools
          .map((tool) => String(tool.id ?? tool.name ?? ""))
          .filter((id) => id.startsWith(prefix))
          .map((id) => id.slice(prefix.length))
        if (names.length > 0) lines.push(`- ${server}: ${names.sort().join(", ")}`)
      }
      return lines.length > 0 ? `\nTools (Code Mode: tools.<server>.<tool>; search(...) for signatures):\n${lines.join("\n")}` : ""
    }

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "mcp_connect",
        description:
          "Turn on dormant MCP server groups for this session. Call before using a dormant server, and again if its tools are missing (unused servers are dropped after a while). Safe to repeat. New tools appear from your next step.",
        input: targetsInput,
        options: { codemode: false },
        execute: async (input: any, context: any) => {
          const sessionID = String(context?.sessionID ?? "")
          const { servers, unknown } = resolve(asList(input))
          if (servers.length === 0) {
            return { content: `Nothing to connect. Unknown: ${unknown.join(", ") || "(none given)"}.\nGroups:\n${catalog()}` }
          }
          await seed(sessionID)
          const running = held()
          const started = servers.filter((server) => !running.has(server))
          holdServers(sessionID, servers)
          // Trust OpenCode's state, not ours: a server we think is held can still be disabled
          // (e.g. after a config reload replayed an older setup). Reload whenever a requested
          // server is not actually enabled, so a stale view can never leave it stuck.
          const before = await statuses().catch(() => new Map())
          const notRunning = servers.filter((server) => !started.includes(server) && needsReload(before.get(server)))
          if (started.length > 0 || notRunning.length > 0) await ctx.mcp.reload()
          log(
            directory,
            `connect ${servers.join(",")} (started: ${started.join(",") || "-"}${notRunning.length ? `; healed: ${notRunning.join(",")}` : ""}) session=${sessionID}`,
          )
          let current = await waitForSettled(servers, context?.signal)
          // Still disabled after one reload: replay the transform once more and wait again.
          const stuck = servers.filter((server) => current.get(server)?.status === "disabled")
          if (stuck.length > 0) {
            log(directory, `connect retry ${stuck.join(",")} still disabled session=${sessionID}`)
            await ctx.mcp.reload()
            current = await waitForSettled(servers, context?.signal)
          }
          const lines = servers.map((server) => `- ${server}: ${describe(current.get(server))}`)
          if (unknown.length > 0) lines.push(`Unknown targets ignored: ${unknown.join(", ")}`)
          return {
            content: `${lines.join("\n")}\nConnected for this session; tools are available from your next step (Code Mode: tools.<server>).${await toolSummary(servers)}`,
          }
        },
      })
      editor.add({
        name: "mcp_disconnect",
        description: "Turn MCP server groups back off for this session once you are finished with them.",
        input: targetsInput,
        options: { codemode: false },
        execute: async (input: any, context: any) => {
          const sessionID = String(context?.sessionID ?? "")
          const { servers, unknown } = resolve(asList(input))
          const mine = sessions.get(sessionID)
          const removed = servers.filter((server) => mine?.delete(server))
          const running = held()
          const stopped = removed.filter((server) => !running.has(server))
          if (stopped.length > 0) await ctx.mcp.reload()
          log(directory, `disconnect ${removed.join(",") || "-"} (stopped: ${stopped.join(",") || "-"}) session=${sessionID}`)
          return {
            content: `Disconnected for this session: ${removed.join(", ") || "nothing"}${unknown.length ? `\nUnknown: ${unknown.join(", ")}` : ""}`,
          }
        },
      })
      editor.add({
        name: "mcp_status",
        description: "Show dormant MCP groups and which servers this session has connected.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { codemode: false },
        execute: async (_input: any, context: any) => {
          const sessionID = String(context?.sessionID ?? "")
          const mine = sessionServers(sessionID)
          const running = held()
          const current = await statuses()
          const lines = [...current.keys()].sort().map((server) => {
            const role = !managed.has(server)
              ? "always-on"
              : mine.has(server)
                ? "connected (this session)"
                : running.has(server)
                  ? "dormant here (held by another session)"
                  : "dormant"
            return `- ${server} [${role}]: ${describe(current.get(server))}`
          })
          return { content: `Groups:\n${catalog()}\n\nServers:\n${lines.join("\n")}` }
        },
      })
    })

    const instructions = () =>
      [
        "Dormant MCP servers: most MCP servers are off until needed, to save memory and context.",
        `Before using one of these groups, call mcp_connect with the group name. Connections belong to this session and are dropped after ${idleMs / 60_000} minutes without use: if a server's tools are missing, or a call says it is not connected, call mcp_connect again rather than searching for them.`,
        "Only connect what the current task needs. Groups:",
        catalog(),
      ].join("\n")

    // A session sees only its own servers; every other managed server is cut from what
    // OpenCode rendered for the directory.
    const hiddenFor = (sessionID: string) => {
      const mine = sessionServers(sessionID)
      return (name: string) => {
        const server = serverFor(name)
        return server !== undefined && !mine.has(server)
      }
    }

    const filterPart = (part: any, hidden: (name: string) => boolean) => {
      if (typeof part === "string") return filterText(part, hidden)
      if (part && typeof part.text === "string") part.text = filterText(part.text, hidden)
      return part
    }

    await ctx.session.hook("context", async (event: any) => {
      if (managed.size === 0) return
      const sessionID = String(event.sessionID ?? "")
      if (await seed(sessionID)) await ctx.mcp.reload()
      const hidden = hiddenFor(sessionID)
      try {
        event.system = (event.system ?? []).map((part: any) => filterPart(part, hidden))
        for (const message of event.messages ?? []) {
          if (message?.role !== "system") continue
          if (typeof message.content === "string") message.content = filterText(message.content, hidden)
          else if (Array.isArray(message.content)) message.content = message.content.map((part: any) => filterPart(part, hidden))
        }
        for (const name of Object.keys(event.tools ?? {})) {
          for (const [normalized, server] of byNormalized) {
            if (name.startsWith(`${normalized}_`) && hidden(server)) delete event.tools[name]
          }
        }
      } catch (error) {
        log(directory, `filter failed, prompt left as is: ${error}`)
      }
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
      return [...found]
    }

    await ctx.tool.hook("execute.before", (event: any) => {
      const sessionID = String(event.sessionID ?? "")
      const servers = serversInCall(event.tool, event.input)
      if (servers.length === 0) return
      const mine = sessions.get(sessionID)
      // Code Mode reports each MCP call inside `execute` under the server's own tool name
      // (e.g. `everything_echo`), so the check sits on the real call, not on code parsing.
      const direct = servers.filter((server) => event.tool.startsWith(`${normalize(server)}_`))
      const blocked = direct.filter((server) => !mine?.has(server))
      if (blocked.length > 0) {
        const hint = blocked.map((server) => groupsOf(server)[0] ?? server)
        log(directory, `blocked ${blocked.join(",")} via ${event.tool} session=${sessionID}`)
        throw new Error(
          `MCP server ${blocked.join(", ")} is not connected in this session. Call mcp_connect with targets ${JSON.stringify([...new Set(hint)])} first.`,
        )
      }
      const used = servers.filter((server) => mine?.has(server))
      if (used.length > 0) log(directory, `use ${used.join(",")} via ${event.tool} session=${sessionID}`)
      for (const server of used) {
        mine!.set(server, Date.now())
        const calls = inflight.get(sessionID) ?? new Map<string, Map<string, number>>()
        inflight.set(sessionID, calls)
        if (!calls.has(server)) calls.set(server, new Map())
        calls.get(server)!.set(String(event.id), Date.now())
      }
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      const sessionID = String(event.sessionID ?? "")
      const mine = sessions.get(sessionID)
      for (const server of serversInCall(event.tool, event.input)) {
        if (!mine?.has(server)) continue
        mine.set(server, Date.now())
        inflight.get(sessionID)?.get(server)?.delete(String(event.id))
      }
    })

    // Local and remote alike: a session drops a server after idleMs without use, and a
    // server stops once no session holds it.
    const reap = async () => {
      const now = Date.now()
      const before = held()
      const dropped: string[] = []
      for (const [sessionID, servers] of sessions) {
        for (const [server, lastUsed] of servers) {
          const calls = inflight.get(sessionID)?.get(server)
          for (const [id, started] of calls ?? []) if (now - started > STALE_CALL_MS) calls!.delete(id)
          if (calls && calls.size > 0) continue
          if (now - lastUsed < idleMs) continue
          servers.delete(server)
          dropped.push(`${server}@${sessionID}`)
        }
        if (servers.size === 0) {
          sessions.delete(sessionID)
          inflight.delete(sessionID)
        }
      }
      if (dropped.length === 0) return
      const after = held()
      const stopped = [...before].filter((server) => !after.has(server))
      log(directory, `idle drop ${dropped.join(",")} (stopped: ${stopped.join(",") || "-"})`)
      if (stopped.length > 0) await ctx.mcp.reload()
    }

    const timer = setInterval(() => void reap().catch((error) => log(directory, `reap failed: ${error}`)), reapIntervalMs)
    return () => clearInterval(timer)
  },
}
