const { execFile } = require("node:child_process");
const { existsSync } = require("node:fs");
const { homedir } = require("node:os");
const path = require("node:path");

function openMacVlc(url, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const exists = dependencies.existsSync ?? existsSync;
  const execute = dependencies.execFile ?? execFile;
  const home = dependencies.home ?? homedir();

  if (platform !== "darwin") {
    return Promise.resolve({ success: false, error: "macOS is required" });
  }

  try {
    if (typeof url !== "string" || /\p{Cc}/u.test(url)) {
      throw new Error("Invalid video URL");
    }
    if (!["http:", "https:"].includes(new URL(url).protocol)) {
      throw new Error("Only HTTP and HTTPS video URLs are supported");
    }
  } catch (error) {
    return Promise.resolve({ success: false, error: error.message });
  }

  const application = [
    "/Applications/VLC.app",
    path.join(home, "Applications", "VLC.app"),
  ].find((candidate) => exists(path.join(candidate, "Contents/MacOS/VLC")));

  if (!application) {
    return Promise.resolve({ success: false, error: "VLC is not installed" });
  }

  // Launch Services also delivers the URL to an already running VLC instance.
  // Keep the original URL intact: encoding it again breaks signed stream URLs.
  return new Promise((resolve) => {
    execute("/usr/bin/open", ["-a", application, "--url", url], (error) => {
      resolve(
        error ? { success: false, error: error.message } : { success: true },
      );
    });
  });
}

module.exports = { openMacVlc };
