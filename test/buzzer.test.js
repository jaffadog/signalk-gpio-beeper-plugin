const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { installFakeGpioset, waitForCalls } = require("./fake-gpioset");
const { createBuzzer, GpiosetBuzzer } = require("../plugin/buzzer");

// The stand-in gpioset is a shell script.
const skip = process.platform === "win32" && "needs a POSIX shell";
const savedPath = process.env.PATH;

describe("GpiosetBuzzer", { skip }, () => {
  let fake;
  afterEach(() => {
    process.env.PATH = savedPath;
    fake?.remove();
  });

  it("sets and toggles the line back to 0 with libgpiod v2", async () => {
    fake = installFakeGpioset("2.2.1");
    const { impl, buzzer } = createBuzzer({ chip: "gpiochip0", pin: 17 });
    assert.equal(impl, "gpioset");
    buzzer.beep(300);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 300,0 17=1",
    ]);
  });

  it("holds the line for the duration with libgpiod v1", async () => {
    fake = installFakeGpioset("1.6.3");
    const buzzer = new GpiosetBuzzer({ chip: "gpiochip4", pin: 22 });
    assert.equal(buzzer.version, 1);
    buzzer.beep(100);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-b -m time -u 100000 gpiochip4 22=1",
    ]);
  });

  it("throws when gpioset is missing", () => {
    process.env.PATH = "";
    assert.throws(() => new GpiosetBuzzer(), /gpioset not found/);
  });
});
