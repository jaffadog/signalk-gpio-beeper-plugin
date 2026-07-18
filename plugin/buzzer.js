const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const GPIO_ROOT = "/sys/class/gpio";

// Labels seen for the main BCM pinctrl chip across Pi OS releases.
// rp1 (Pi 5) is intentionally excluded - sysfs GPIO does not work there.
const BCM_CHIP_LABEL_PATTERNS = [/^pinctrl-bcm2835$/, /^pinctrl-bcm2711$/];

function isGpiosetAvailable() {
  try {
    execFileSync("gpioset", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Primary implementation: shells out to `gpioset` (libgpiod-tools), which
 * ships by default on Raspberry Pi OS Bookworm and later (including Pi 5,
 * where the sysfs GPIO interface has been removed entirely). No native
 * addon compilation is involved, so it's compatible with App Store
 * installs that run `npm install --ignore-scripts`.
 *
 * `gpioset -m signal` holds the line at the requested value until the
 * process receives SIGTERM/SIGINT, so "on" spawns a background process
 * and "off" kills it - this is the closest match to onoff's writeSync(1/0)
 * semantics that a subprocess-based tool can offer.
 */
class GpiosetBuzzer {
  constructor({ chip = "gpiochip0", pin = 17 } = {}) {
    this.chip = chip;
    this.pin = pin;
    this.child = null;
  }

  on() {
    if (this.child) return; // already on
    this.child = spawn(
      "gpioset",
      ["-m", "signal", this.chip, `${this.pin}=1`],
      { stdio: "ignore" },
    );
    this.child.on("error", () => {
      this.child = null;
    });
  }

  off() {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }

  cleanup() {
    this.off();
  }
}

/**
 * Fallback implementation: raw sysfs writes. Used when `gpioset` isn't
 * installed (e.g. older Raspberry Pi OS releases such as Buster, which
 * predate libgpiod-tools being a default package). No native addon
 * compilation involved either - just plain `fs` calls.
 *
 * Note: does not work on Pi 5 / CM5, where sysfs GPIO has been removed.
 * Also note: on newer kernels (Trixie, 6.12+) the BCM pinctrl chip's base
 * offset may not be 0, so the BCM pin number and the sysfs gpio number can
 * differ - this class resolves the real offset by reading gpiochip labels
 * rather than assuming they're the same.
 */
class SysfsBuzzer {
  constructor({ pin = 17 } = {}) {
    this.bcmPin = pin;
    this.sysfsPin = null;
    this.exported = false;
  }

  _findBcmChipBase() {
    if (!fs.existsSync(GPIO_ROOT)) {
      throw new Error(
        `${GPIO_ROOT} does not exist - sysfs GPIO is unavailable on this kernel (expected on Pi 5 / CM5).`,
      );
    }
    const entries = fs
      .readdirSync(GPIO_ROOT)
      .filter((f) => f.startsWith("gpiochip"));
    for (const entry of entries) {
      const labelPath = path.join(GPIO_ROOT, entry, "label");
      const basePath = path.join(GPIO_ROOT, entry, "base");
      if (!fs.existsSync(labelPath) || !fs.existsSync(basePath)) continue;
      const label = fs.readFileSync(labelPath, "utf8").trim();
      if (BCM_CHIP_LABEL_PATTERNS.some((re) => re.test(label))) {
        return parseInt(fs.readFileSync(basePath, "utf8").trim(), 10);
      }
    }
    throw new Error(
      "Could not identify the main BCM pinctrl gpiochip under /sys/class/gpio.",
    );
  }

  _ensureExported() {
    if (this.exported) return;
    const base = this._findBcmChipBase();
    this.sysfsPin = base + this.bcmPin;
    const pinPath = `${GPIO_ROOT}/gpio${this.sysfsPin}`;
    if (!fs.existsSync(pinPath)) {
      fs.writeFileSync(`${GPIO_ROOT}/export`, String(this.sysfsPin));
      const start = Date.now();
      while (
        !fs.existsSync(`${pinPath}/direction`) &&
        Date.now() - start < 1000
      ) {
        // brief busy-wait for sysfs entries to appear
      }
    }
    fs.writeFileSync(`${pinPath}/direction`, "out");
    this.exported = true;
  }

  on() {
    this._ensureExported();
    fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "1");
  }

  off() {
    if (!this.exported) return;
    fs.writeFileSync(`${GPIO_ROOT}/gpio${this.sysfsPin}/value`, "0");
  }

  cleanup() {
    if (!this.exported) return;
    try {
      this.off();
      fs.writeFileSync(`${GPIO_ROOT}/unexport`, String(this.sysfsPin));
    } catch {
      // best-effort cleanup
    }
    this.exported = false;
  }
}

/**
 * Picks the best available buzzer implementation. Prefers `gpioset`
 * (present by default on Bookworm+, required on Pi 5), falls back to
 * sysfs (works on older releases like Buster/Bullseye, but not Pi 5).
 * Neither path requires native addon compilation.
 */
function createBuzzer(options = {}) {
  if (isGpiosetAvailable()) {
    return { impl: "gpioset", buzzer: new GpiosetBuzzer(options) };
  }
  return { impl: "sysfs", buzzer: new SysfsBuzzer(options) };
}

module.exports = { createBuzzer, GpiosetBuzzer, SysfsBuzzer };
