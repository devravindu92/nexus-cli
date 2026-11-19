import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeState, validEmail } from "./sanitize.js";

test("drops everything that is not on the list", () => {
  const out = sanitizeState({
    workspaces: [{ id: "w", name: "App", path: "~/app", secret: "x", accent: "javascript:1" }],
    sessions: [
      { id: "s", workspaceId: "w", name: "Dev", kind: "command", args: ["--token", "abc"], cwd: "/x", env: { K: "v" }, state: "running", output: "..." },
    ],
    hosts: [{ id: "h", name: "DEV", target: "dev", identityFile: "~/.ssh/id", password: "p" }],
    terminalOutput: "secret",
  });
  const text = JSON.stringify(out);
  for (const leaked of ["secret", "--token", "abc", "identityFile", "password", '"env"', '"cwd"', '"args"', "output", "javascript"])
    assert.ok(!text.includes(leaked), `leaked ${leaked}`);
  assert.equal(out.sessions[0].kind, "command");
  assert.equal(out.workspaces[0].accent, "");
});

test("caps sizes and tolerates junk", () => {
  assert.deepEqual(sanitizeState(null), { workspaces: [], sessions: [], hosts: [], activity: [] });
  const many = sanitizeState({ sessions: Array.from({ length: 900 }, () => ({ name: "x".repeat(999), state: "weird" })) });
  assert.equal(many.sessions.length, 500);
  assert.equal(many.sessions[0].name.length, 120);
  assert.equal(many.sessions[0].state, "exited");
});

test("email check", () => {
  assert.ok(validEmail("a@b.co"));
  assert.ok(!validEmail("nope"));
  assert.ok(!validEmail({}));
});
