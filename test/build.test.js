/**
 * The boot line's build=<version>+<sha> is how a deploy is verified, from a
 * checkout under launchd and from the image alike.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildId } from "../src/build.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

function root(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "build-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), '{"version":"0.4.0"}');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test("a loose ref, a packed ref, a detached HEAD, and no .git at all", (t) => {
  assert.equal(
    buildId(root(t, { ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${SHA}\n` })),
    "0.4.0+0123456",
  );
  assert.equal(
    buildId(
      root(t, { ".git/HEAD": "ref: refs/heads/main\n", ".git/packed-refs": `# pack-refs\n${SHA} refs/heads/main\n` }),
    ),
    "0.4.0+0123456",
    "a fresh clone keeps its refs packed",
  );
  assert.equal(buildId(root(t, { ".git/HEAD": `${SHA}\n` })), "0.4.0+0123456", "CI builds a tag detached");
  assert.equal(buildId(root(t, {})), "0.4.0");
});
