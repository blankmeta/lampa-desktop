(function () {
  "use strict";

  if (window.desktopMacVlcPlugin || !Lampa.Platform.macOS()) return;
  window.desktopMacVlcPlugin = true;

  let initialized = false;
  function init() {
    if (initialized) return;
    initialized = true;
    ["player", "player_torrent", "player_iptv"].forEach(function (name) {
      Lampa.Params.select(
        name,
        Object.assign({}, Lampa.Params.values[name], { vlc: "VLC" }),
        Lampa.Params.defaults[name],
      );
    });

    Lampa.Lang.add({
      desktop_vlc_failed: {
        ru: "Не удалось открыть видео в VLC.",
        en: "Could not open the video in VLC.",
        uk: "Не вдалося відкрити відео у VLC.",
      },
    });

    let forcedPlayer = "";
    const originalRunas = Lampa.Player.runas;
    Lampa.Player.runas = function (need) {
      forcedPlayer = need;
      return originalRunas.apply(this, arguments);
    };
    Lampa.Player.listener.follow("close", function () {
      forcedPlayer = "";
    });

    function useVlc(data, iptv) {
      const override = data.launch_player || forcedPlayer;
      if (override === "lampa" || override === "inner") return false;

      const setting = iptv
        ? "player_iptv"
        : data.torrent_hash
          ? "player_torrent"
          : "player";
      if (override !== "vlc" && Lampa.Storage.field(setting) !== "vlc") {
        return false;
      }
      return !Lampa.PlayerVideo.verifyTube(data.url);
    }

    async function launch(data, iptv) {
      try {
        const url =
          data.quality && !iptv
            ? Lampa.Player.getUrlQuality(data.quality, false) || data.url
            : data.url;
        const result = await window.electronAPI.player.openMacVlc(
          Lampa.Torserver.toPlayUrl(url),
        );
        if (!result.success) throw new Error(result.error);
        Lampa.Player.listener.send("external", data);
      } catch (error) {
        console.error("VLC launch failed:", error.message);
        Lampa.Noty.show(Lampa.Lang.translate("desktop_vlc_failed"));
      }
    }

    // The create hook also covers calls made inside Lampa's playlist module.
    Lampa.Player.listener.follow("create", function (event) {
      if (!useVlc(event.data, false)) return;
      event.abort();
      void launch(event.data);
    });

    // IPTV has its own entry point and does not emit the create event.
    const originalIptv = Lampa.Player.iptv;
    Lampa.Player.iptv = function (data) {
      if (!useVlc(data, true)) return originalIptv.apply(this, arguments);
      Lampa.PlayerIPTV.locked(data, function () {
        void launch(data, true);
      });
    };
  }

  if (window.appready) init();
  else {
    Lampa.Listener.follow("app", function (event) {
      if (event.type === "ready") init();
    });
  }
})();
