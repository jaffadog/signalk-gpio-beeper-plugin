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

function notify(
  app,
  path,
  value,
  $source = "derived-data",
  context = "vessels.self",
) {
  app.onDelta({ context, updates: [{ $source, values: [{ path, value }] }] });
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

  it("stays quiet for a notification a rule silences", async () => {
    plugin.start({
      interval: 1000,
      duration: 300,
      rules: [
        { path: "**", source: "maretron.*", action: "silent" },
        { path: "electrical.**", action: "silent" },
      ],
    });
    notify(app, "notifications.navigation.anchor", ALARM, "maretron.can0.17");
    notify(app, "notifications.electrical.batteries.house", ALARM);
    mock.timers.tick(3000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(fake.calls(), []);
  });

  it("beeps for a notification a rule lets sound before a catch-all silences the rest", async () => {
    plugin.start({
      interval: 1000,
      duration: 300,
      rules: [
        { path: "navigation.anchor", action: "sound" },
        { path: "**", action: "silent" },
      ],
    });
    notify(app, "notifications.electrical.batteries.house", ALARM);
    mock.timers.tick(1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(fake.calls(), []);
    notify(app, "notifications.navigation.anchor", ALARM);
    mock.timers.tick(1000);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 300,0 17=1",
    ]);
  });

  it("keeps beeping for an alarm when a rule silences another source on the same path", async () => {
    plugin.start({
      interval: 1000,
      duration: 300,
      rules: [{ path: "**", source: "maretron.*", action: "silent" }],
    });
    notify(app, "notifications.navigation.anchor", ALARM);
    notify(app, "notifications.navigation.anchor", ALARM, "maretron.can0.17");
    mock.timers.tick(1000);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 300,0 17=1",
    ]);
  });

  it("keeps beeping when another vessel clears the same path", async () => {
    plugin.start({ interval: 1000, duration: 300 });
    notify(app, "notifications.navigation.anchor", ALARM);
    notify(
      app,
      "notifications.navigation.anchor",
      { ...ALARM, state: "normal" },
      "ais",
      "vessels.urn:mrn:imo:mmsi:123456789",
    );
    mock.timers.tick(1000);
    assert.deepEqual(await waitForCalls(fake, 1), [
      "-z -c gpiochip0 -t 300,0 17=1",
    ]);
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
