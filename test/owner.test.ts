// Run: npm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { ownerOf } from "../mcp-on-demand.ts"

const servers = ["firecrawl", "firecrawl_lab", "firecrawl_compact", "otb_data", "otb_data_sandbox", "mem0", "mem0_cloud"]

test("a tool belongs to the server with the longest matching name, never to a shorter one sharing its prefix", () => {
  assert.equal(ownerOf("firecrawl_lab_firecrawl_scrape", servers), "firecrawl_lab")
  assert.equal(ownerOf("firecrawl_compact_firecrawl_search", servers), "firecrawl_compact")
  assert.equal(ownerOf("firecrawl_firecrawl_scrape", servers), "firecrawl")
  assert.equal(ownerOf("otb_data_sandbox_run_sql", servers), "otb_data_sandbox")
  assert.equal(ownerOf("otb_data_run_sql", servers), "otb_data")
  assert.equal(ownerOf("mem0_cloud_search_memories", servers), "mem0_cloud")
  assert.equal(ownerOf("mem0_add_memory", servers), "mem0")
})

test("order of the server list does not matter", () => {
  assert.equal(ownerOf("firecrawl_lab_firecrawl_scrape", [...servers].reverse()), "firecrawl_lab")
})

test("tools of no server, and bare server names, have no owner", () => {
  assert.equal(ownerOf("mcp_connect", servers), undefined)
  assert.equal(ownerOf("firecrawl", servers), undefined)
  assert.equal(ownerOf("firecrawlx_scrape", servers), undefined)
})
