// Run: npm test
import assert from "node:assert/strict"
import { test } from "node:test"
import { needsReload } from "../mcp-on-demand.ts"

test("mcp_connect reloads when OpenCode has the server disabled or unknown", () => {
  assert.equal(needsReload({ status: "disabled" }), true)
  assert.equal(needsReload(undefined), true)
})

test("mcp_connect leaves connected, pending, failed and auth-pending servers alone", () => {
  for (const status of ["connected", "pending", "failed", "needs_auth", "needs_client_registration"]) {
    assert.equal(needsReload({ status }), false, status)
  }
})
