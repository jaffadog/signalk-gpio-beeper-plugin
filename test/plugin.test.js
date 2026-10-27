const { describe, it, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");
const { installFakeGpioset, waitForCalls } = require("./fake-gpioset");
const createPlugin = require("../plugin/index");

const skip = process.platform === "win32" && "needs a POSIX shell";
const savedPath = process.env.PATH;

function fakeApp() {
  const app = {
    onDelta: null,
    statuses: [],
    errors: [],
    debug() {},
    error(msg) {
      app.errors.push(msg);
    },
    setPluginStatus(msg) {
      app.statuses.push(msg);
    },
    setPluginError(msg) {
      app.errors.push(msg);
    },
    subscriptionmanager: {
      subscribe(_command, unsubscribes, _onError, onDelta) {
        app.onDelta = onDelta;
        unsubscribes.push(() => {
          app.onDelta = null;
        });
      },
    },
  };
  return app;
}

function notify(app, path, value) {
  app.onDelta({ updates: [{ values: [{ path, value }] }] });
}

const ALARM = {
  state: "alarm",
  method: ["visual", "sound"],
  message: "Anchor dragging",
};

describe("plugin", { skip }, () => {
  let fake;
  let app;
  let plugin;

  beforeEach(() => {
    fake = installFakeGpioset("2.2.1");
    mock.timers.enable({ apis: ["setInterval"] });
    app = fakeApp();
    plugin = createPlugin(app);
  });

  afterEach(() => {
    plugin.stop();
    mock.timers.reset();
    process.env.PATH = savedPath;
    fake.remove();
  });

  it("beeps for an alarm that asks to be heard", async () => {
    plugin.start({ interval: 1000, duration: 300, gpioPin: 17 });
    notify(app, "notifications.navigation.anchor", ALARM);
    mock.timers.tick(1000);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 300,0 17=1",
    ]);
  });

  it("beeps a third as long for a warning", async () => {
    plugin.start({ interval: 1000, duration: 300 });
    notify(app, "notifications.environment.depth", {
      ...ALARM,
      state: "warn",
    });
    mock.timers.tick(1000);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 100,0 17=1",
    ]);
  });

  it("stays quiet for silenced, visual-only and cleared notifications", async () => {
    plugin.start({ interval: 1000, duration: 300 });
    notify(app, "notifications.a", { ...ALARM, status: { silenced: true } });
    notify(app, "notifications.b", { ...ALARM, method: ["visual"] });
    notify(app, "notifications.c", ALARM);
    notify(app, "notifications.c", { ...ALARM, state: "normal" });
    mock.timers.tick(3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(fake.calls(), []);
  });

  it("stops beeping once stopped", async () => {
    plugin.start({ interval: 1000, duration: 300 });
    notify(app, "notifications.navigation.anchor", ALARM);
    plugin.stop();
    assert.equal(app.onDelta, null);
    mock.timers.tick(3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(fake.calls(), []);
  });
});
