// Unit tests for the prompt filters. Run: npm test
// The fixture is a real Code Mode system part captured from OpenCode 2.1 with the
// deepwiki, everything and memory MCP servers connected.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { filterCatalog, filterInstructions, filterText } from "../mcp-on-demand.ts"

const fixture = readFileSync(new URL("./fixtures/system-with-servers.txt", import.meta.url), "utf8")
const entries = (text: string) => [...text.matchAll(/^- ([A-Za-z0-9_-]+) \(\d+ tools?/gm)].map((m) => m[1])
const blocks = (text: string) => [...text.matchAll(/<server name="([^"]+)">/g)].map((m) => m[1])
const hide = (...names: string[]) => (name: string) => names.includes(name)

test("fixture has the servers the tests rely on", () => {
  assert.deepEqual(entries(fixture).slice(0, 3), ["deepwiki", "everything", "memory"])
  assert.deepEqual(blocks(fixture), ["deepwiki", "everything"])
})

test("hidden servers lose their catalog entries and instructions; the rest is untouched", () => {
  const out = filterText(fixture, hide("everything", "memory"))
  assert.deepEqual(entries(out), entries(fixture).filter((name) => !["everything", "memory"].includes(name)))
  assert.deepEqual(blocks(out), ["deepwiki"])
  assert.ok(!out.includes("tools.everything"), "no everything signatures left")
  assert.ok(!out.includes("tools.memory"), "no memory signatures left")
  assert.ok(out.includes("tools.opencode"), "plugin namespaces stay")
  assert.ok(out.startsWith("# Code Mode"), "header stays")
})

test("hiding every server drops the empty <mcp_instructions> wrapper", () => {
  const out = filterText(fixture, hide("deepwiki", "everything", "memory"))
  assert.deepEqual(blocks(out), [])
  assert.ok(!out.includes("<mcp_instructions>"))
  assert.deepEqual(entries(out), entries(fixture).filter((name) => !["deepwiki", "everything", "memory"].includes(name)))
})

test("hiding nothing returns the text unchanged", () => {
  assert.equal(filterText(fixture, () => false), fixture)
})

test("text without a recognised catalog or blocks is left exactly as is", () => {
  const odd = "Some instructions\n- not a catalog entry\n<server>unnamed</server>\n"
  assert.equal(filterText(odd, () => true), odd)
})

test("a catalog entry ends at the next entry, a blank line or a tag", () => {
  const text = [
    "## Available tools",
    "",
    "- alpha (2 tools, 1 shown)",
    "  - tools.alpha.one({",
    "  x: string,",
    "}): Promise<unknown> // One",
    "- beta (1 tool)",
    "  - tools.beta.two(): Promise<unknown>",
    "",
    "<mcp_instructions>",
    '  <server name="alpha">',
    "    Use alpha.",
    "  </server>",
    '  <server name="beta">',
    "    Use beta.",
    "  </server>",
    "</mcp_instructions>",
    "after",
  ].join("\n")
  const out = filterText(text, hide("alpha"))
  assert.equal(
    out,
    [
      "## Available tools",
      "",
      "- beta (1 tool)",
      "  - tools.beta.two(): Promise<unknown>",
      "",
      "<mcp_instructions>",
      '  <server name="beta">',
      "    Use beta.",
      "  </server>",
      "</mcp_instructions>",
      "after",
    ].join("\n"),
  )
  assert.equal(filterCatalog("- alpha (1 tool)\n  x\n\nkeep", hide("alpha")), "\nkeep")
  assert.equal(filterInstructions('<mcp_instructions>\n  <server name="a">\n  x\n  </server>\n</mcp_instructions>\nz', hide("a")), "z")
})

test("mid-session catalog update messages filter the same way", () => {
  const message = `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n${fixture}`
  const out = filterText(message, hide("everything"))
  assert.ok(out.startsWith("The Code Mode tool catalog has changed."))
  assert.ok(!entries(out).includes("everything"))
  assert.ok(entries(out).includes("memory"))
})
