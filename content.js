/*
 * Udemy Video Recovery  —  fully automatic, no controls.
 * ------------------------------------------------------
 * Watches the Udemy course <video> element. When playback stalls (typically
 * behind an "Are you still watching?" style pop-up / modal overlay, or a
 * frozen frame), it automatically:
 *   1. Confirms the stall persists for CONFIRM_DELAY_MS (so a brief buffer
 *      pause is not treated as a stall).
 *   2. Saves the current playback time + lecture id to chrome.storage.local.
 *   3. Reloads the page.
 *   4. After reload, seeks to (savedTime - REWIND_SECONDS) and resumes play.
 *
 * There is no UI and nothing to configure. The constants below are the only
 * knobs and they are intentionally not user-facing.
 */

(() => {
  "use strict";

  // ---- fixed settings (no UI) -----------------------------------------
  const CONFIRM_DELAY_MS = 4000; // a stall must persist this long before we act
  const REWIND_SECONDS = 5; // seek back this many seconds after reload
  const POLL_INTERVAL_MS = 1000; // how often we check video state
  const RESUME_WINDOW_MS = 60000; // ignore a saved resume point older than this
  const SEEK_TIMEOUT_MS = 30000; // how long to wait for the player after reload
  const STARTUP_TIMEOUT_MS = 20000; // after a reload, video must be playing by now
  const PROGRESS_CONFIRM_S = 3; // seconds of real playback = "recovered"
  const MAX_RELOAD_ATTEMPTS = 5; // consecutive failed recoveries before giving up

  const STORAGE_PREFIX = "uvr:"; // resume-point key prefix (per lecture)
  const log = (...a) => console.log("[UdemyVideoRecovery]", ...a);

  // Resume point loaded after a reload. It stays here (and in storage) until
  // playback is confirmed healthy, so a repeat failure can still use it.
  let pending = null;
  let gaveUp = false;
  const pageLoadAt = Date.now();

  // ---- helpers ---------------------------------------------------------

  // A stable key per lecture so we only resume on the right page.
  function lectureKey() {
    // Udemy lecture URLs look like:
    // https://www.udemy.com/course/<slug>/learn/lecture/<id>
    const m = location.pathname.match(/\/lecture\/(\d+)/);
    const id = m ? m[1] : location.pathname;
    return STORAGE_PREFIX + id;
  }

  function getVideo() {
    // Udemy renders a single <video>; pick the one with the longest duration
    // in case of preview/ad elements.
    const vids = Array.from(document.querySelectorAll("video")).filter(
      (v) => !Number.isNaN(v.duration) && v.duration > 0
    );
    if (vids.length === 0) return document.querySelector("video");
    vids.sort((a, b) => (b.duration || 0) - (a.duration || 0));
    return vids[0];
  }

  // Detect the interruption pop-up. Udemy's "still watching" dialog is a modal
  // overlay. We match on known copy AND fall back to a generic visible-dialog
  // heuristic, so it keeps working if the wording changes.
  function popupPresent() {
    const texts = [
      "are you still watching",
      "still watching",
      "still here",
      "are you still there",
      "resume watching",
      // playback-error wording (e.g. when the player fails before starting)
      "something went wrong",
      "problem playing",
      "error playing",
      "playback error",
      "unable to play",
      "couldn't play",
      "could not play",
      "an error occurred",
      "try reloading",
      "reload the page",
      "refresh the page",
    ];
    const candidates = document.querySelectorAll(
      '[role="dialog"], [role="alert"], [class*="dialog"], [class*="modal"], [class*="error"], [data-purpose*="modal"], [data-purpose*="error"]'
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const t = (el.innerText || "").toLowerCase();
      // Skip big wrappers; we want the small overlay itself.
      if (t.length === 0 || t.length > 1000) continue;
      if (texts.some((s) => t.includes(s))) return true;
    }
    return false;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden" && st.opacity !== "0";
  }

  // ---- stall detection -------------------------------------------------

  let stallSince = null; // timestamp when we first saw a stall
  let lastTime = null; // last observed currentTime
  let lastTimeChangeAt = Date.now();
  let acting = false; // guard so we reload only once

  // Has playback made real progress since the last resume point? (Only
  // meaningful while `pending` is set, i.e. right after an auto-reload.)
  function hasProgressed(video) {
    if (!pending || !video) return false;
    const base = typeof pending.base === "number" ? pending.base : pending.time;
    return !video.paused && video.currentTime >= base + PROGRESS_CONFIRM_S;
  }

  function isStalled(video) {
    // Explicit signal: the pop-up / error overlay is up. Checked FIRST and
    // independent of the video element, since an error can replace the player.
    if (popupPresent()) return true;

    // Right after a reload: the video must start playing within a reasonable
    // time. Covers errors that appear before playback ever begins.
    if (pending && Date.now() - pageLoadAt > STARTUP_TIMEOUT_MS) {
      if (!video) return true;
      const loadedButPaused = video.paused && video.readyState >= 3;
      if (!hasProgressed(video) && !loadedButPaused) return true;
    }

    if (!video) return false;
    if (video.error) return true; // MediaError from the element itself

    // Heuristic signal: the player believes it is playing but the frame is
    // frozen (currentTime not advancing). We deliberately do NOT fire on a
    // manual pause (video.paused with no pop-up) so we don't fight the user.
    const now = Date.now();
    if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastTimeChangeAt = now;
      return false;
    }
    const notAdvancingMs = now - lastTimeChangeAt;
    if (video.ended) return false;
    if (video.seeking) return false;
    if (!video.paused && notAdvancingMs > CONFIRM_DELAY_MS) return true;

    return false;
  }

  // Was the page in fullscreen (OS-level) when the stall happened? Udemy puts
  // an element into the native Fullscreen API, so document.fullscreenElement is
  // non-null while the lecture is maximized.
  function isFullscreenNow() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  // Returns true if a reload should go ahead, false if we've given up.
  async function saveResumePoint(video) {
    const attempts = (pending ? pending.attempts || 0 : 0) + 1;
    if (attempts > MAX_RELOAD_ATTEMPTS) {
      log("Recovery failed " + MAX_RELOAD_ATTEMPTS + " times in a row; giving up.");
      gaveUp = true;
      await chrome.storage.local.remove(lectureKey());
      return false;
    }

    const cur = video && isFinite(video.currentTime) ? video.currentTime : 0;
    // If we never got past the previous resume point, keep THAT position
    // instead of overwriting it with ~0 from a video that never started.
    const time =
      pending && !hasProgressed(video)
        ? pending.time
        : Math.max(0, cur - REWIND_SECONDS);

    const data = {
      time,
      rawTime: cur,
      savedAt: Date.now(),
      href: location.href,
      attempts,
      // Fullscreen was lost on the previous reload and maybe never restored.
      wasFullscreen: isFullscreenNow() || !!(pending && pending.wasFullscreen),
    };
    await chrome.storage.local.set({ [lectureKey()]: data });
    log("Saved resume point", data);
    return true;
  }

  function handleStall(video) {
    if (acting || gaveUp) return;

    if (stallSince === null) {
      stallSince = Date.now();
      log("Potential stall detected; confirming…");
      return;
    }

    if (Date.now() - stallSince >= CONFIRM_DELAY_MS) {
      acting = true;
      log("Stall confirmed. Saving position and reloading.");
      saveResumePoint(video)
        .then((ok) => {
          if (ok) {
            // small delay to ensure storage write flushes before reload
            setTimeout(() => location.reload(), 150);
          } else {
            acting = false;
          }
        })
        .catch((e) => {
          log("Save failed; reloading anyway", e);
          setTimeout(() => location.reload(), 150);
        });
    }
  }

  function clearStall() {
    stallSince = null;
  }

  function tick() {
    if (gaveUp) return;
    const video = getVideo();

    // Playback is healthy again after a reload: the resume point has done its
    // job, so clear it and reset the failure counter.
    if (pending && hasProgressed(video)) {
      log("Playback recovered; clearing resume point.");
      pending = null;
      chrome.storage.local.remove(lectureKey());
    }

    // NOTE: no early return when there is no <video> — an error can replace
    // the player entirely, and we still need to see it.
    if (isStalled(video)) {
      handleStall(video);
    } else {
      clearStall();
    }
  }

  // ---- fullscreen restore ---------------------------------------------

  // Find Udemy's own fullscreen toggle so we can trigger the player's native
  // requestFullscreen the same way a real click on that control would.
  function findFullscreenButton() {
    const selectors = [
      'button[data-purpose="fullscreen-toggle"]', // verified on live Udemy DOM
      '[data-purpose="fullscreen-button"]',
      'button[aria-label*="ullscreen"]', // "Fullscreen" / "fullscreen"
      'button[aria-label*="ull screen"]',
      'button[title*="ullscreen"]',
      '[class*="fullscreen"] button',
      'button[class*="fullscreen"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  // Try to enter fullscreen WITHOUT a user gesture. Some Chrome builds allow
  // extensions to do this; most reject it. Returns true if we're in fullscreen
  // shortly after trying.
  function tryEnterFullscreenNoGesture() {
    if (isFullscreenNow()) return true;
    const btn = findFullscreenButton();
    if (btn) {
      try {
        btn.click();
      } catch (e) {
        /* ignore */
      }
    }
    if (!isFullscreenNow()) {
      // Direct API attempt on the player container as a fallback.
      const video = getVideo();
      const target =
        (video &&
          (video.closest('[class*="video-viewer"]') ||
            video.closest('[data-purpose*="video"]') ||
            video.parentElement)) ||
        video;
      const req =
        target &&
        (target.requestFullscreen ||
          target.webkitRequestFullscreen ||
          target.webkitRequestFullScreen);
      if (req) {
        try {
          const r = req.call(target);
          if (r && r.catch) r.catch(() => {});
        } catch (e) {
          /* gesture required — expected on most builds */
        }
      }
    }
    return isFullscreenNow();
  }

  let hintEl = null;
  function showHint(text) {
    if (hintEl) return;
    hintEl = document.createElement("div");
    hintEl.textContent = text;
    Object.assign(hintEl.style, {
      position: "fixed",
      zIndex: "2147483647",
      left: "50%",
      top: "16px",
      transform: "translateX(-50%)",
      background: "rgba(20,20,20,0.92)",
      color: "#fff",
      font: "13px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "8px 14px",
      borderRadius: "6px",
      boxShadow: "0 2px 10px rgba(0,0,0,0.4)",
      pointerEvents: "none",
    });
    document.documentElement.appendChild(hintEl);
  }
  function removeHint() {
    if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
    hintEl = null;
  }

  // Restore fullscreen after a reload. First try the gesture-free path; if the
  // browser blocks it, arm a one-shot listener so the user's VERY NEXT click or
  // keypress (e.g. hitting space to play, or just clicking the video) re-enters
  // fullscreen through Udemy's own control — which counts as a user gesture.
  function restoreFullscreen() {
    if (tryEnterFullscreenNoGesture()) {
      log("Restored fullscreen without a gesture.");
      return;
    }

    log("Fullscreen needs a user gesture; arming one-shot restore.");
    showHint("Click or press any key to restore fullscreen");

    let done = false;
    const cleanup = () => {
      document.removeEventListener("click", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
      document.removeEventListener("pointerdown", onGesture, true);
      removeHint();
      clearTimeout(timer);
    };
    const onGesture = (ev) => {
      if (done) return;
      done = true;
      // If the user clicked the fullscreen button themselves, let it work
      // naturally; clicking it again would toggle fullscreen back off.
      const btn = findFullscreenButton();
      if (btn && ev && ev.target && btn.contains(ev.target)) {
        cleanup();
        return;
      }
      // We're inside a user-gesture event now, so this is allowed.
      tryEnterFullscreenNoGesture();
      log("Fullscreen restore triggered by user gesture.");
      cleanup();
    };
    document.addEventListener("click", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    document.addEventListener("pointerdown", onGesture, true);

    // Give up quietly after a while so the hint doesn't linger forever.
    const timer = setTimeout(cleanup, 20000);
  }

  // ---- resume after reload --------------------------------------------

  async function maybeResume() {
    const key = lectureKey();
    const stored = await chrome.storage.local.get(key);
    const data = stored[key];
    if (!data) return;

    // Only resume if it was saved recently (avoid seeking on a fresh visit).
    if (Date.now() - data.savedAt > RESUME_WINDOW_MS) {
      await chrome.storage.local.remove(key);
      return;
    }

    log("Resume point found; waiting for video to be ready…", data);
    pending = data; // stays set until playback is confirmed healthy (see tick)

    const deadline = Date.now() + SEEK_TIMEOUT_MS;
    const trySeek = async () => {
      const video = getVideo();
      if (video && video.readyState >= 1 && video.duration > 0) {
        try {
          video.currentTime = Math.min(data.time, video.duration - 1);
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
          pending.base = video.currentTime; // progress is measured from here
          log("Resumed at", video.currentTime);
        } catch (e) {
          log("Seek failed", e);
        }
        // NOTE: the stored resume point is intentionally NOT removed here. It
        // is cleared in tick() once playback has actually progressed, so a
        // second failure before that can still use it.
        if (data.wasFullscreen) {
          // Let the player settle a beat before trying to re-maximize.
          setTimeout(restoreFullscreen, 500);
        }
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(trySeek, 500);
      } else {
        // Player never loaded. Keep `pending`; the startup watchdog in
        // isStalled() will trigger another recovery attempt.
        log("Player not ready after waiting; startup watchdog will retry.");
      }
    };
    trySeek();
  }

  // ---- bootstrap -------------------------------------------------------

  (async () => {
    log("Active (automatic mode)");
    await maybeResume();
    setInterval(tick, POLL_INTERVAL_MS);
  })();
})();
