# Udemy Video Recovery

A Chrome extension (Manifest V3) that **automatically** detects when a Udemy
course video stalls — typically behind an "Are you still watching?" style
pop-up or a frozen frame — then reloads the page and resumes playback from
**5 seconds before** where it stopped.

It is fully automatic. There is no popup, no settings, nothing to click. Install
it once and it just works on Udemy lecture pages.

## How it works

A content script (`content.js`) runs on `https://*.udemy.com/course/*` pages and:

1. Polls the `<video>` element every 1s.
2. Flags a **stall** when either:
   - a visible modal/dialog matching known pop-up copy (e.g. "are you still
     watching", "still here") is present, **or**
   - the player believes it is playing (`!video.paused`, not seeking/ended) but
     `currentTime` hasn't advanced for ~4s (frozen frame).
3. Waits ~4s to confirm the stall is real and not a brief buffer pause.
4. Saves `currentTime - 5s` and the lecture id to `chrome.storage.local`, then
   reloads the page.
5. After reload, finds the fresh resume point (only if saved within the last
   60s), waits for the player to be ready, seeks to the saved time, and resumes
   play. The resume point is then cleared.

The resume point is keyed by the lecture id in the URL, so a reload resumes the
correct lecture and a normal visit to a different lecture is unaffected. A
manual pause (no pop-up) is never treated as a stall, so the extension won't
fight you when you pause on purpose.

## Fullscreen restore

If the video was in fullscreen when the stall happened, the reload drops out of
fullscreen (unavoidable — a page reload always exits fullscreen). After the
resume, the extension tries to re-enter fullscreen by clicking Udemy's own
fullscreen control.

Note a hard browser rule: Chrome only allows entering true (OS-level)
fullscreen from a genuine user gesture, so a script cannot silently re-maximize
after a reload on most builds. The extension handles this gracefully:

- It first attempts a gesture-free restore (works on some Chrome builds).
- If the browser blocks that, it shows a small banner —
  *"Click or press any key to restore fullscreen"* — and arms a one-shot
  listener. Your very next click or keypress (e.g. the spacebar you'd press to
  play) re-enters fullscreen through Udemy's control. That one interaction is
  the required gesture. The banner auto-dismisses after 20s.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this folder (`udemy-video-recovery`).
4. Open a Udemy lecture. The extension is active automatically — nothing else
   to do.

## Tuning (only if needed)

All behaviour is hardcoded at the top of `content.js`:

- `CONFIRM_DELAY_MS` (4000) — how long a stall must persist before acting. Raise
  it if slow buffering triggers reloads too eagerly.
- `REWIND_SECONDS` (5) — how far back to seek after reload.
- `POLL_INTERVAL_MS`, `RESUME_WINDOW_MS`, `SEEK_TIMEOUT_MS` — timing internals.

If the pop-up on your account uses different wording, add the exact text to the
`texts` array in `popupPresent()`. The frozen-frame heuristic works regardless
of wording.

## Files

- `manifest.json` — MV3 manifest.
- `content.js` — detection + recovery logic (the whole extension).
- `make_icons.py` — regenerates the PNG icons in `icons/`.
