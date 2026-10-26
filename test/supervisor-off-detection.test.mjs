import { test } from "node:test"
import assert from "node:assert/strict"
import { detectSupervisorActionInText, getLastUserMessageText } from "../opencode/supervisor-impl.ts"

test("detectSupervisorActionInText detects off commands", () => {
  assert.equal(detectSupervisorActionInText('Command: "off"'), "off")
  assert.equal(detectSupervisorActionInText("Command: 'off'"), "off")
  assert.equal(detectSupervisorActionInText("/supervisor off"), "off")
  assert.equal(detectSupervisorActionInText("/supervisor:off"), "off")
  assert.equal(detectSupervisorActionInText("supervisor off"), "off")
  assert.equal(detectSupervisorActionInText("supervisor:off"), "off")
})

test("detectSupervisorActionInText detects on commands", () => {
  assert.equal(detectSupervisorActionInText('Command: "on"'), "on")
  assert.equal(detectSupervisorActionInText("Command: 'on'"), "on")
  assert.equal(detectSupervisorActionInText("/supervisor on"), "on")
  assert.equal(detectSupervisorActionInText("/supervisor:on"), "on")
  assert.equal(detectSupervisorActionInText("supervisor on"), "on")
  assert.equal(detectSupervisorActionInText("supervisor:on"), "on")
})

test("detectSupervisorActionInText ignores incidental mentions (no substring matching)", () => {
  assert.equal(detectSupervisorActionInText('The config uses command: "off" to disable it'), null)
  assert.equal(detectSupervisorActionInText('...it printed Command: "off" in the output'), null)
  assert.equal(detectSupervisorActionInText('Here is my log: {"command": "off"} please investigate'), null)
  assert.equal(detectSupervisorActionInText("run /supervisor off later, not now"), null)
  assert.equal(detectSupervisorActionInText("turn the supervisor off when done"), null)
  assert.equal(detectSupervisorActionInText(""), null)
  assert.equal(detectSupervisorActionInText(null), null)
})

test("getLastUserMessageText extracts latest non-supervisor user message text", () => {
  const messages = [
    { info: { role: "user" }, parts: [{ type: "text", text: "first message" }] },
    { info: { role: "assistant" }, parts: [{ type: "text", text: "reply" }] },
    { info: { role: "user" }, parts: [{ type: "text", text: 'Command: "off"' }] },
  ]
  assert.equal(getLastUserMessageText(messages), 'Command: "off"')
})
