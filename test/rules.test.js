const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { compileRules, ruleAction } = require("../plugin/rules");

const ANCHOR = "notifications.navigation.anchor";

function action(rules, path, value = {}, source = undefined) {
  return ruleAction(compileRules(rules), path, value, source);
}

describe("rules", () => {
  it("lets the first matching rule decide", () => {
    const rules = [
      { path: "navigation.anchor", action: "sound" },
      { path: "**", action: "silent" },
    ];
    assert.equal(action(rules, ANCHOR), "sound");
    assert.equal(
      action(rules, "notifications.electrical.batteries.1"),
      "silent",
    );
  });

  it("leaves a notification no rule matches undecided", () => {
    assert.equal(
      action([{ path: "navigation.*", action: "silent" }], "notifications.mob"),
      undefined,
    );
    assert.equal(action([], ANCHOR), undefined);
  });

  it("matches one path part with * and any number with **", () => {
    assert.equal(
      action([{ path: "navigation.*", action: "silent" }], ANCHOR),
      "silent",
    );
    assert.equal(
      action(
        [{ path: "navigation.*", action: "silent" }],
        "notifications.navigation.course.perpendicularPassed",
      ),
      undefined,
    );
    assert.equal(
      action(
        [{ path: "navigation.**", action: "silent" }],
        "notifications.navigation.course.perpendicularPassed",
      ),
      "silent",
    );
  });

  it("lets ** stand for no part at all", () => {
    const rules = [{ path: "electrical.**.voltage", action: "silent" }];
    assert.equal(action(rules, "notifications.electrical.voltage"), "silent");
    assert.equal(
      action(rules, "notifications.electrical.batteries.1.voltage"),
      "silent",
    );
    assert.equal(
      action(
        [{ path: "**.voltage", action: "silent" }],
        "notifications.voltage",
      ),
      "silent",
    );
    assert.equal(
      action(
        [{ path: "a.**.b.**.c", action: "silent" }],
        "notifications.a.x.b.c",
      ),
      "silent",
    );
    assert.equal(action(rules, "notifications.electrical.current"), undefined);
  });

  it("accepts a path written with its notifications. prefix", () => {
    assert.equal(
      action(
        [{ path: "notifications.navigation.anchor", action: "silent" }],
        ANCHOR,
      ),
      "silent",
    );
  });

  it("matches the source with * across dots", () => {
    const rules = [{ path: "**", source: "maretron.*", action: "silent" }];
    assert.equal(action(rules, ANCHOR, {}, "maretron.can0.17"), "silent");
    assert.equal(action(rules, ANCHOR, {}, "derived-data"), undefined);
    assert.equal(action(rules, ANCHOR, {}, undefined), undefined);
  });

  it("matches text anywhere in the message, ignoring case", () => {
    const rules = [{ path: "**", message: "sensor fault", action: "silent" }];
    assert.equal(
      action(rules, ANCHOR, { message: "Depth SENSOR FAULT on loop 2" }),
      "silent",
    );
    assert.equal(
      action(rules, ANCHOR, { message: "Anchor dragging" }),
      undefined,
    );
    assert.equal(action(rules, ANCHOR, {}), undefined);
  });

  it("ignores rules a hand-edited configuration got wrong", () => {
    const rules = [
      null,
      { action: "silent" },
      { path: "", action: "silent" },
      { path: "**", action: "mute" },
      { path: "**", message: 3, action: "silent" },
      { path: "**", source: {}, action: "silent" },
    ];
    assert.equal(action(rules, ANCHOR, { message: "x" }), undefined);
    assert.deepEqual(compileRules("**"), []);
  });

  it("matches a pattern full of wildcards in linear time", () => {
    const rules = [{ path: "*".repeat(30) + "x", action: "silent" }];
    const started = Date.now();
    assert.equal(action(rules, "notifications." + "a".repeat(5000)), undefined);
    assert.ok(Date.now() - started < 1000);
  });
});
