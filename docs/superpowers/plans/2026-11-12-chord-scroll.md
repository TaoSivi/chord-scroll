# Chord Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A userscript for dochord.com song pages that listens to the mic, follows which chord is being played, and smooth-scrolls when the player reaches the last 2 visible chord rows.

**Architecture:** One file, `chord-scroll.user.js`. Pure functions (chord parsing, chroma, follower, scroll decision) sit at the top and are exported under `if (typeof module !== 'undefined')` so `node test.js` can check them. The DOM/audio part runs only when `document` exists.

**Tech Stack:** Plain JavaScript, Web Audio API (`AnalyserNode`), no dependencies, no build step. Tests: `node test.js` using `node:assert`.

**Spec:** `docs/superpowers/specs/2026-11-12-chord-scroll-design.md`

## Global Constraints

- `@match https://www.dochord.com/*`, `@grant none`, no `@require`.
- Chords are read from `span.c_chord` `textContent` (not `data-std`), so the site's own key change is respected.
- Never store, copy or send chord/lyric content or audio anywhere.
- `getUserMedia` audio constraints: `echoCancellation:false, noiseSuppression:false, autoGainControl:false`.
- No git commit or push without asking the user first.

## Review Focus

1. Mic permission denied → button shows an error label, page keeps working, no uncaught rejection.
2. Page with no `span.c_chord` (home, category pages) → no button injected.
3. User changes key on the site while running → steps are rebuilt, current position kept.
4. Unparseable chord text (`N.C.`, `*`, empty) → skipped, never crashes the follower.
5. Silence or talking between songs → position does not advance.

Lines 3–5 are pinned by tests in Task 1; 1–2 by the manual check in Task 2.

---

### Task 1: Pure logic + self-check

**Files:**
- Create: `chord-scroll/chord-scroll.user.js` (logic section + userscript header)
- Create: `chord-scroll/test.js`

**Interfaces (Produces):**
- `chordPitchClasses(name: string, capo: number): number[] | null` — triad pitch classes 0–11 (C=0), shifted up by `capo`. Bass after `/` ignored; 7ths/extensions ignored. Quality: `dim`→[0,3,6], `sus4`/`sus`→[0,5,7], `sus2`→[0,2,7], `m` not followed by `aj`→[0,3,7], else [0,4,7]. Unparseable → `null`.
- `chromaFromSpectrum(db: Float32Array, sampleRate: number, fftSize: number): number[]` — length 12, linear magnitude (`10^(dB/20)`) summed per pitch class over bins between 80 Hz and 1000 Hz. Not normalised.
- `score(chroma: number[], pcs: number[]): number` — sum of chroma at `pcs` ÷ total; 0 when total is 0.
- `buildSteps(names: string[], capo: number): {pcs: number[], first: number}[]` — drops unparseable names, collapses consecutive identical chords; `first` is the index into `names`.
- `createFollower(steps, opts?: {hold=3, margin=0.1, minEnergy=0.01})` → `{index: number, feed(chroma): number, jump(i: number): void}`. Each `feed`: if chroma total < `minEnergy`, reset the hold counter and return. Otherwise candidate = whichever of `index+1`, `index+2` scores highest, if that score > score(current) + `margin`. The same candidate for `hold` consecutive feeds → `index = candidate`. Never moves backwards, never past the last step.
- `scrollTarget(rowTops: number[], curTop: number, scrollY: number, viewH: number, rowH: number): number | null` — visible rows are those with `top >= scrollY && top + rowH <= scrollY + viewH`. If `curTop` is one of the last 2 visible rows and at least one row lies below the visible ones → return `curTop - 0.15 * viewH`; else `null`.

- [ ] **Step 1: Write `test.js`** with these assertions:

```js
const a = require('node:assert');
const L = require('./chord-scroll.user.js');
a.deepStrictEqual(L.chordPitchClasses('C', 0), [0, 4, 7]);
a.deepStrictEqual(L.chordPitchClasses('Am', 0), [9, 0, 4]);
a.deepStrictEqual(L.chordPitchClasses('F#m7', 0), [6, 9, 1]);
a.deepStrictEqual(L.chordPitchClasses('Bb', 0), [10, 2, 5]);
a.deepStrictEqual(L.chordPitchClasses('G/B', 0), [7, 11, 2]);
a.deepStrictEqual(L.chordPitchClasses('Cmaj7', 0), [0, 4, 7]);
a.deepStrictEqual(L.chordPitchClasses('Dsus4', 0), [2, 7, 9]);
a.deepStrictEqual(L.chordPitchClasses('C', 2), [2, 6, 9]);
a.strictEqual(L.chordPitchClasses('N.C.', 0), null);
a.strictEqual(L.chordPitchClasses('', 0), null);

// spectrum with one peak at 440 Hz → pitch class 9 (A) dominates
const sr = 48000, n = 8192, db = new Float32Array(n / 2).fill(-120);
db[Math.round(440 * n / sr)] = 0;
const ch = L.chromaFromSpectrum(db, sr, n);
a.strictEqual(ch.indexOf(Math.max(...ch)), 9);

const pc = (...p) => { const c = Array(12).fill(0); p.forEach(i => c[i] = 1); return c; };
a.ok(L.score(pc(0, 4, 7), [0, 4, 7]) > L.score(pc(0, 4, 7), [7, 11, 2]));
a.strictEqual(L.score(Array(12).fill(0), [0, 4, 7]), 0);

const steps = L.buildSteps(['C', 'C', 'N.C.', 'G', 'Am', 'F'], 0);
a.deepStrictEqual(steps.map(s => s.first), [0, 3, 4, 5]);

const f = L.createFollower(steps);
f.feed(pc(7, 11, 2)); f.feed(pc(7, 11, 2));
a.strictEqual(f.index, 0);                    // 2 frames < hold
f.feed(pc(7, 11, 2));
a.strictEqual(f.index, 1);                    // advanced to G
for (let i = 0; i < 5; i++) f.feed(Array(12).fill(0));
a.strictEqual(f.index, 1);                    // silence does not advance
for (let i = 0; i < 3; i++) f.feed(pc(5, 9, 0));
a.strictEqual(f.index, 3);                    // skipped Am, recovered at F
for (let i = 0; i < 5; i++) f.feed(pc(0, 4, 7));
a.strictEqual(f.index, 3);                    // never past the end / backwards
f.jump(0); a.strictEqual(f.index, 0);

const rows = [0, 100, 200, 300, 400, 500, 600];
a.strictEqual(L.scrollTarget(rows, 100, 0, 450, 50), null);      // not near bottom
a.strictEqual(L.scrollTarget(rows, 300, 0, 450, 50), 300 - 67.5); // 2nd-last visible
a.strictEqual(L.scrollTarget(rows, 600, 250, 450, 50), null);    // nothing below
console.log('ok');
```

- [ ] **Step 2:** Run `node test.js` — expect failure (module missing).
- [ ] **Step 3:** Implement the six functions and the `module.exports` guard in `chord-scroll.user.js`, under the userscript header (`@name Chord Scroll`, `@match`, `@grant none`, `@version 0.1.0`).
- [ ] **Step 4:** Run `node test.js` — expect `ok`.

### Task 2: Page integration

**Files:**
- Modify: `chord-scroll/chord-scroll.user.js` (browser section)
- Create: `chord-scroll/README.md` (Lao: install steps per device, how to use, known limits from the spec)

**Interfaces (Consumes):** everything from Task 1.

- [ ] **Step 1:** Guard: run only when `typeof document !== 'undefined'` and `document.querySelector('span.c_chord')` exists.
- [ ] **Step 2:** Inject a fixed bottom-right control: Start/Stop button and capo `−` / number / `+` (0–11, saved in `localStorage` key `chordScrollCapo`). All styles inline in one injected `<style>`; current chord gets class `cs-current`.
- [ ] **Step 3:** `readChords()` — all `span.c_chord` in document order → names; `buildSteps`; row tops from each span's `getBoundingClientRect().top + scrollY`, rounded and de-duplicated. Re-run on a `MutationObserver` (characterData/childList on the chord container) and on capo change, keeping `follower.index` clamped.
- [ ] **Step 4:** Start: `getUserMedia` (constraints in Global Constraints) → `AudioContext` → `AnalyserNode` `fftSize 8192`, `smoothingTimeConstant 0.5`. Every 100 ms: `getFloatFrequencyData` → `chromaFromSpectrum` → `follower.feed`. On index change: move `cs-current`, then `scrollTarget(...)`; non-null → `window.scrollTo({top, behavior: 'smooth'})`. Request `navigator.wakeLock` if present. On rejection: button text `ໄມໃຊ້ບໍ່ໄດ້`, no throw.
- [ ] **Step 5:** Stop: stop tracks, close context, clear interval, release wake lock. Also stop on `pagehide`.
- [ ] **Step 6:** Click on any `span.c_chord` while running → `follower.jump` to the step containing it and move the highlight.
- [ ] **Step 7:** Verify in the browser pane on `https://www.dochord.com/399181/` by injecting the script: button appears; no button on the home page; clicking a chord moves the highlight; feeding synthetic chroma through the follower scrolls the page smoothly when the highlight reaches the last 2 visible rows. Record what was and was not verified (real mic and real guitar cannot be verified here).
- [ ] **Step 8:** Ask the user before `git init`, commit, creating the GitHub repo, or pushing.
