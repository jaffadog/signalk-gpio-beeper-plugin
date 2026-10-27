// Puts a stand-in `gpioset` first on PATH that reports the libgpiod version
// given in FAKE_GPIOSET_VERSION and appends each call's arguments to
// FAKE_GPIOSET_LOG, so the plugin runs its real code paths without a GPIO
// chip.
const fs = require("fs");
const os = require("os");
const path = require("path");

function installFakeGpioset(version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gpioset-"));
  const log = path.join(dir, "calls.log");
  const script = path.join(dir, "gpioset");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  echo "gpioset (libgpiod) v$FAKE_GPIOSET_VERSION"',
      "  exit 0",
      "fi",
      'echo "$*" >> "$FAKE_GPIOSET_LOG"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  process.env.FAKE_GPIOSET_VERSION = version;
  process.env.FAKE_GPIOSET_LOG = log;
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
  return {
    calls() {
      return fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
        : [];
    },
    remove() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The buzzer spawns gpioset detached and does not wait for it.
async function waitForCalls(fake, count) {
  for (let i = 0; i < 100; i++) {
    if (fake.calls().length >= count) return fake.calls();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return fake.calls();
}

module.exports = { installFakeGpioset, waitForCalls };
