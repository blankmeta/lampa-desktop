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
      desktop_vlc_sync_failed: {
        ru: "Связь с VLC потеряна. Lampa пытается восстановить синхронизацию.",
        en: "VLC is not responding. Lampa is trying to reconnect.",
        uk: "Зв'язок із VLC втрачено. Lampa намагається відновити синхронізацію.",
      },
    });

    const playerApi = window.electronAPI.player;
    const timelines = new Map();
    const versions = new Map();
    let launchVersion = 0;

    function applyProgress(progress) {
      const meta = progress.timeline;
      if (!meta || meta.storageKey !== Lampa.Timeline.filename()) {
        if (progress.ended) timelines.delete(progress.id);
        return;
      }
      try {
        const seen = versions.get(progress.id) || 0;
        const timeline = timelines.get(progress.id);
        if (
          progress.version > seen &&
          Number.isFinite(progress.time) &&
          progress.duration > 0 &&
          !timeline?.stop_recording
        ) {
          const saved = Lampa.Timeline.view(meta.hash, meta);
          if (seen || progress.updatedAt >= (saved.updated || 0)) {
            if (timeline) {
              timeline.time = progress.time;
              timeline.duration = progress.duration;
              timeline.percent = progress.percent;
            }
            const handler = timeline?.handler || saved.handler;
            handler(progress.percent, progress.time, progress.duration);
          }
          versions.set(progress.id, progress.version);
          if (versions.size > 100)
            versions.delete(versions.keys().next().value);
        }
        if (progress.ended) timelines.delete(progress.id);
        void playerApi
          .acknowledgeMacVlcTimecode(progress.id, progress.version)
          .catch((error) =>
            console.error("VLC timecode acknowledgement:", error),
          );
      } catch (error) {
        // Leave the checkpoint pending if Lampa could not persist it.
        console.error("VLC timecode save failed:", error);
      }
    }

    async function restoreTimecodes() {
      const pending = await playerApi.getMacVlcTimecodes();
      pending.forEach(applyProgress);
    }

    playerApi.onMacVlcProgress(applyProgress);
    playerApi.onMacVlcWarning(function () {
      Lampa.Noty.show(Lampa.Lang.translate("desktop_vlc_sync_failed"));
    });
    function restore() {
      void restoreTimecodes().catch((error) => {
        console.error("VLC timecode restore failed:", error);
      });
    }
    restore();
    Lampa.Timeline.listener.follow("read", restore);

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
      const version = ++launchVersion;
      const storageKey = Lampa.Timeline.filename();
      try {
        await restoreTimecodes();
        if (storageKey !== Lampa.Timeline.filename()) return;
        const url =
          data.quality && !iptv
            ? Lampa.Player.getUrlQuality(data.quality, false) || data.url
            : data.url;
        const timeline = !iptv && data.timeline;
        let startTime = 0;
        if (timeline) {
          // Re-read storage: the object in an open results list can be stale.
          const fresh = Lampa.Timeline.view(timeline.hash, timeline);
          if (
            timeline.profile !== undefined &&
            timeline.profile !== fresh.profile
          ) {
            timeline.handler = fresh.handler;
          }
          Object.assign(timeline, {
            time: fresh.time,
            duration: fresh.duration,
            percent: fresh.percent,
            profile: fresh.profile,
          });
          if (fresh.percent < 90) {
            startTime =
              fresh.time || (fresh.duration * fresh.percent) / 100 || 0;
          }
          const mode = Lampa.Storage.field("player_timecode");
          if (mode === "again") startTime = 0;
          else if (mode === "ask" && startTime > 0) {
            const controller = Lampa.Controller.enabled().name;
            startTime = await new Promise((resolve) => {
              Lampa.Select.show({
                title: Lampa.Lang.translate("title_action"),
                items: [
                  {
                    title:
                      Lampa.Lang.translate("player_start_from") +
                      " " +
                      Lampa.Utils.secondsToTime(startTime) +
                      "?",
                    resume: true,
                  },
                  { title: Lampa.Lang.translate("settings_param_no") },
                ],
                onSelect: function (item) {
                  Lampa.Controller.toggle(controller);
                  resolve(item.resume ? startTime : 0);
                },
                onBack: function () {
                  Lampa.Controller.toggle(controller);
                  resolve(null);
                },
              });
            });
          }
        }
        if (
          startTime === null ||
          version !== launchVersion ||
          storageKey !== Lampa.Timeline.filename()
        )
          return;
        const recordTimeline =
          timeline && !timeline.stop_recording && timeline.hash;
        const fullscreen = Lampa.Storage.field("player_external_fullscreen");
        const result = await playerApi.openMacVlc({
          url: Lampa.Torserver.toPlayUrl(url),
          startTime,
          fullscreen: fullscreen === true || fullscreen === "true",
          timeline: recordTimeline
            ? Object.assign(
                { storageKey },
                ...["hash", "profile", "card", "season", "episode"]
                  .filter((key) => timeline[key] !== undefined)
                  .map((key) => ({ [key]: timeline[key] })),
              )
            : null,
        });
        if (!result.success) throw new Error(result.error);
        if (recordTimeline) timelines.set(result.id, timeline);
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
