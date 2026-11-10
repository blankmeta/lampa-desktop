const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const plugin = readFileSync(
  path.join(__dirname, "../src/macVlcPlugin.js"),
  "utf8",
);

function loadPlugin({
  mac = true,
  ready = true,
  launchResult = { success: true },
  unlock = (_data, callback) => callback(),
} = {}) {
  const events = new Map();
  const appEvents = [];
  const opened = [];
  const external = [];
  const messages = [];
  const settings = {
    player: "iina",
    player_torrent: "iina",
    player_iptv: "inner",
  };
  let nativeIptv = 0;
  const Lampa = {
    Platform: { macOS: () => mac },
    Params: {
      values: {},
      defaults: {},
      select(name, values, fallback) {
        this.values[name] = values;
        this.defaults[name] = fallback;
      },
    },
    Storage: { field: (name) => settings[name] },
    Lang: { add() {}, translate: (key) => key },
    Noty: { show: (message) => messages.push(message) },
    Listener: { follow: (_name, callback) => appEvents.push(callback) },
    Player: {
      runas() {},
      iptv: () => nativeIptv++,
      getUrlQuality: (quality) => quality["1080p"] || "",
      listener: {
        follow: (name, callback) =>
          events.set(name, [...(events.get(name) || []), callback]),
        send: (name, data) => {
          if (name === "external") external.push(data);
          for (const callback of events.get(name) || []) callback(data);
        },
      },
    },
    PlayerVideo: { verifyTube: (url) => url.includes("youtube.com") },
    PlayerIPTV: { locked: unlock },
    Torserver: { toPlayUrl: (url) => url.replace("/stream?", "/play?") },
  };
  for (const name of Object.keys(settings)) {
    Lampa.Params.values[name] = { inner: "Built-in", iina: "IINA" };
    Lampa.Params.defaults[name] = "inner";
  }
  const window = {
    appready: ready,
    electronAPI: {
      player: {
        openMacVlc: async (url) => {
          opened.push(url);
          return launchResult;
        },
      },
    },
  };
  const context = vm.createContext({ window, Lampa, console: { error() {} } });
  vm.runInContext(plugin, context);
  function play(data) {
    let aborted = false;
    Lampa.Player.listener.send("create", {
      data,
      abort: () => {
        aborted = true;
      },
    });
    return aborted;
  }
  return {
    Lampa,
    settings,
    opened,
    external,
    messages,
    appEvents,
    play,
    nativeIptv: () => nativeIptv,
    reinject: () => vm.runInContext(plugin, context),
  };
}

test("adds VLC to all three menus while preserving choices and defaults", () => {
  const app = loadPlugin();
  for (const name of Object.keys(app.settings)) {
    assert.equal(app.Lampa.Params.values[name].vlc, "VLC");
    assert.equal(app.Lampa.Params.values[name].iina, "IINA");
    assert.equal(app.Lampa.Params.defaults[name], "inner");
  }
  assert.equal(app.settings.player, "iina");
  app.reinject();
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), false);
});

test("opens online and torrent videos with their separate player selections", async () => {
  const app = loadPlugin();
  app.settings.player_torrent = "vlc";
  assert.equal(
    app.play({
      url: "http://localhost:8090/stream?index=2&play",
      torrent_hash: "hash",
    }),
    true,
  );
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), false);
  app.settings.player = "vlc";
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), true);
  await new Promise(setImmediate);
  assert.deepEqual(app.opened, [
    "http://localhost:8090/play?index=2&play",
    "https://example.com/movie.mp4",
  ]);
  assert.equal(app.external.length, 2);
});

test("respects an explicit internal player and YouTube playback", () => {
  const app = loadPlugin();
  app.settings.player = "vlc";
  assert.equal(app.play({ url: "https://youtube.com/watch?v=test" }), false);
  assert.equal(
    app.play({ url: "https://example.com/movie.mp4", launch_player: "inner" }),
    false,
  );
  app.Lampa.Player.runas("inner");
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), false);
  app.Lampa.Player.listener.send("close", {});
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), true);
});

test("uses the configured video quality and reports native launch failures", async () => {
  const app = loadPlugin({
    launchResult: { success: false, error: "Missing VLC" },
  });
  app.settings.player = "vlc";
  assert.equal(
    app.play({
      url: "https://example.com/480.mp4",
      quality: { "1080p": "https://example.com/1080.mp4" },
    }),
    true,
  );
  await new Promise(setImmediate);
  assert.deepEqual(app.opened, ["https://example.com/1080.mp4"]);
  assert.equal(app.external.length, 0);
  assert.equal(app.messages.length, 1);
});

test("routes IPTV to VLC only when selected for IPTV", async () => {
  const app = loadPlugin();
  const data = { url: "https://example.com/live.m3u8" };
  app.Lampa.Player.iptv(data);
  assert.equal(app.nativeIptv(), 1);
  app.settings.player_iptv = "vlc";
  app.Lampa.Player.iptv(data);
  await new Promise(setImmediate);
  assert.deepEqual(app.opened, [data.url]);
  assert.equal(app.nativeIptv(), 1);
});

test("waits for the existing IPTV parental-control check before opening VLC", async () => {
  let unlockChannel;
  const app = loadPlugin({
    unlock: (_data, callback) => {
      unlockChannel = callback;
    },
  });
  app.settings.player_iptv = "vlc";
  const data = { url: "https://example.com/locked.m3u8", locked: true };
  app.Lampa.Player.iptv(data);
  assert.equal(app.opened.length, 0);
  unlockChannel();
  await new Promise(setImmediate);
  assert.deepEqual(app.opened, [data.url]);
});

test("waits for app readiness and does not install on other platforms", () => {
  const app = loadPlugin({ ready: false });
  assert.equal(app.Lampa.Params.values.player.vlc, undefined);
  for (let i = 0; i < 2; i++) app.appEvents[0]({ type: "ready" });
  app.settings.player = "vlc";
  app.reinject();
  assert.equal(app.play({ url: "https://example.com/movie.mp4" }), true);
  assert.equal(app.opened.length, 1);
  assert.equal(
    loadPlugin({ mac: false }).Lampa.Params.values.player.vlc,
    undefined,
  );
});
