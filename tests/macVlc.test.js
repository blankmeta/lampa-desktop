const test = require("node:test");
const assert = require("node:assert/strict");
const { openMacVlc } = require("../src/modules/macVlc");

function nativeOpen(overrides = {}) {
  const calls = [];
  return {
    calls,
    dependencies: {
      platform: "darwin",
      home: "/Users/test",
      existsSync: (file) => file === "/Applications/VLC.app/Contents/MacOS/VLC",
      execFile: (...args) => {
        calls.push(args.slice(0, 2));
        args[2](null);
      },
      ...overrides,
    },
  };
}

test("passes a signed stream URL unchanged to the installed VLC", async () => {
  const native = nativeOpen();
  const url =
    "http://localhost:8090/stream/Серия%201.mkv?play&index=2&token=a%2Bb%26c";
  assert.deepEqual(await openMacVlc(url, native.dependencies), {
    success: true,
  });
  assert.deepEqual(native.calls, [
    ["/usr/bin/open", ["-a", "/Applications/VLC.app", "--url", url]],
  ]);
});

test("supports VLC installed in the user's Applications folder", async () => {
  const native = nativeOpen({
    existsSync: (file) =>
      file === "/Users/test/Applications/VLC.app/Contents/MacOS/VLC",
  });
  assert.equal(
    (await openMacVlc("https://example.com/video.mp4", native.dependencies))
      .success,
    true,
  );
  assert.equal(native.calls[0][1][1], "/Users/test/Applications/VLC.app");
});

test("rejects non-video protocols and malformed URLs without starting a process", async () => {
  const native = nativeOpen();
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "vlc://video",
    "--args",
    "http://localhost/x\n--args",
    null,
  ]) {
    assert.equal((await openMacVlc(url, native.dependencies)).success, false);
  }
  assert.equal(native.calls.length, 0);
});

test("reports a missing VLC installation and native launch errors", async () => {
  const absent = nativeOpen({ existsSync: () => false });
  assert.equal(
    (await openMacVlc("https://example.com/video.mp4", absent.dependencies))
      .success,
    false,
  );
  assert.equal(absent.calls.length, 0);

  const failed = nativeOpen({
    execFile: (_command, _args, done) =>
      done(new Error("Launch Services failed")),
  });
  assert.deepEqual(
    await openMacVlc("https://example.com/video.mp4", failed.dependencies),
    {
      success: false,
      error: "Launch Services failed",
    },
  );
});

test("does not launch a native player on other operating systems", async () => {
  const native = nativeOpen({ platform: "linux" });
  assert.equal(
    (await openMacVlc("https://example.com/video.mp4", native.dependencies))
      .success,
    false,
  );
  assert.equal(native.calls.length, 0);
});
