// ==UserScript==
// @name         Chord Scroll
// @namespace    chord-scroll
// @version      0.5.0
// @description  ຟັງສຽງກີຕ້າ ແລ້ວເລື່ອນໜ້າຄອດໃນ dochord.com ເອງ
// @match        *://*.dochord.com/*
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/TaoSivi/chord-scroll/main/chord-scroll.user.js
// @updateURL    https://raw.githubusercontent.com/TaoSivi/chord-scroll/main/chord-scroll.user.js
// ==/UserScript==

// ---------- logic (pure, checked by `node test.js`) ----------

const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Triad only: 7ths and slash bass add little for telling neighbouring chords apart.
function chordPitchClasses(name, capo) {
  const m = /^([A-G])([#b]?)([^/]*)/.exec((name || '').trim());
  if (!m) return null;
  const root = (NOTE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? 11 : 0) + capo) % 12;
  const q = m[3];
  const iv = /dim/.test(q) ? [0, 3, 6]
    : /sus2/.test(q) ? [0, 2, 7]
    : /sus/.test(q) ? [0, 5, 7]
    : /^m(?!aj)/.test(q) ? [0, 3, 7]
    : [0, 4, 7];
  return iv.map(i => (root + i) % 12);
}

function chromaFromSpectrum(db, sampleRate, fftSize) {
  const chroma = Array(12).fill(0);
  const hz = sampleRate / fftSize;
  for (let k = Math.ceil(80 / hz); k <= 1000 / hz && k < db.length; k++) {
    const midi = Math.round(12 * Math.log2(k * hz / 440) + 69);
    chroma[midi % 12] += 10 ** (db[k] / 20);
  }
  return chroma;
}

function score(chroma, pcs) {
  const total = chroma.reduce((a, b) => a + b, 0);
  return total ? pcs.reduce((a, p) => a + chroma[p], 0) / total : 0;
}

function buildSteps(names, capo) {
  const steps = [];
  names.forEach((name, first) => {
    const pcs = chordPitchClasses(name, capo);
    const prev = steps[steps.length - 1];
    if (pcs && !(prev && prev.pcs.join() === pcs.join())) steps.push({ pcs, first });
  });
  return steps;
}

// Lets the follower move by ear where players really deviate from the page:
// - a line marked "2 Times" / "x2" may be played again: its last chord can go back to its first;
// - an intro may be skipped: its first chord can go straight to the first chord after it.
// lineOf[i] is the line number of chord name i; lines[n] = { repeat, intro }.
function linkJumps(steps, lineOf, lines) {
  const line = s => lineOf[s.first];
  lines.forEach((l, n) => {
    const a = steps.findIndex(s => line(s) === n);
    if (a < 0) return;
    let b = a;
    while (steps[b + 1] && line(steps[b + 1]) === n) b++;
    if (l.repeat && b > a) steps[b].alts = [a];
    if (l.intro && steps[b + 1]) steps[a].alts = [...(steps[a].alts || []), b + 1];
  });
  return steps;
}

// Makes the chroma independent of mic level and of one loud note:
// - flat room noise adds the same to every pitch class, so the smallest value is removed;
// - a chord sounds at least three pitch classes, so everything is scaled to the third
//   strongest and clipped at 1. A sung melody note then counts as one note, however loud.
// Returns null when fewer than three pitch classes stand out (a lone voice, a single string).
function clean(chroma) {
  const floor = Math.min(...chroma);
  const v = chroma.map(x => x - floor);
  const top = [...v].sort((a, b) => b - a);
  return top[2] > top[0] * 0.1 ? v.map(x => Math.min(x / top[2], 1)) : null;
}

// Two layers:
// 1. Local: "does the sound fit one of the next two chords (or a repeat/skip target) better
//    than the current one?" Cheap and robust, it only has to tell a few chords apart.
// 2. Find-my-place: names the chord being played out of the song's own chords, remembers the
//    last three, and when that run is not where we are but does occur in the song, goes there.
//    This is what handles starting in the middle of the song.
// `tonal`: strongest pitch class vs the average. Noise and silence are flat (about 1), a chord
// is not, so this gate needs no volume calibration.
// `prefer(k)`: true for steps the player is likely at (the page passes "is on screen").
function createFollower(steps, { hold = 3, margin = 0.1, tonal = 1.5, prefer = () => false } = {}) {
  const key = s => s.pcs.join();
  const vocab = [...new Map(steps.map(s => [key(s), s.pcs])).values()];
  const heard = [];
  let cand = -1, count = 0, heardCand = '', heardCount = 0, slow = null, quiet = 0;
  const move = i => {
    f.index = Math.max(0, Math.min(steps.length - 1, i));
    count = 0; cand = -1;
  };
  function findPlace() {
    // only when the chord just heard is not the one we are on: while the page still explains
    // the sound, a missed chord in the memory must not send us to a look-alike passage
    if (heard.length < 3 || heard[heard.length - 1] === key(steps[f.index])) return;
    const run = heard.slice(-3).join('|');
    const endsAt = k => k >= 2 && [steps[k - 2], steps[k - 1], steps[k]].map(key).join('|') === run;
    // the same chords often occur in several verses and sound cannot tell them apart: take
    // the occurrence the player is looking at, else the next one after where we are, else
    // the last one before
    const ks = steps.map((_, k) => k).filter(endsAt);
    const k = ks.find(prefer) ?? ks.find(k => k > f.index) ?? ks[ks.length - 1];
    if (k != null) f.jump(k);
  }
  const f = {
    index: 0,
    feed(raw) {
      const mean = raw.reduce((a, b) => a + b, 0) / 12;
      const chroma = steps.length && mean && Math.max(...raw) / mean >= tonal ? clean(raw) : null;
      if (!chroma) {
        count = 0; heardCount = 0;
        // after about two seconds without a chord the player has stopped; what they played
        // before must not be joined to what they play next
        if (++quiet === 20) { heard.length = 0; slow = null; }
        return f.index;
      }
      quiet = 0;

      let best = -1, bestScore = score(chroma, steps[f.index].pcs) + margin;
      for (const i of [f.index + 1, f.index + 2, ...(steps[f.index].alts || [])]) {
        if (!steps[i]) continue;
        const s = score(chroma, steps[i].pcs);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      count = best >= 0 && best === cand ? count + 1 : best >= 0 ? 1 : 0;
      cand = best;
      if (best >= 0 && count >= hold) {
        // a repeat or intro skip breaks the run of chords, so what was heard before it must
        // not be matched against the page
        if (best < f.index || best > f.index + 2) heard.length = 0;
        move(best);
      }

      // Averaged over about a second: a strummed chord rings on while sung notes keep moving,
      // so the average keeps the chord and loses the melody. Also makes this layer react after
      // the local move.
      slow = slow ? slow.map((v, i) => v * 0.7 + chroma[i] * 0.3) : chroma;
      const ranked = vocab.map(p => [score(slow, p), p.join()]).sort((a, b) => b[0] - a[0]);
      const name = ranked.length > 1 && ranked[0][0] - ranked[1][0] < 0.08 ? '' : ranked[0][1];
      heardCount = name && name === heardCand ? heardCount + 1 : 1;
      heardCand = name;
      if (name && heardCount === hold && heard[heard.length - 1] !== name) {
        heard.push(name);
        findPlace();
      }
      return f.index;
    },
    // a tap, or a find-my-place jump: what was heard before no longer says where we are
    jump(i) { move(i); heard.length = 0; },
  };
  return f;
}

// Index of the first chord in the row `n` rows after chord `i` (rows = runs of equal top, in
// reading order, so it also works when the site lays the song out in two columns).
function rowAhead(tops, i, n = 2) {
  let rows = 0;
  for (let j = i + 1; j < tops.length; j++) {
    if (tops[j] !== tops[j - 1] && ++rows === n) return j;
  }
  return tops.length - 1;
}

if (typeof module !== 'undefined') {
  module.exports = { chordPitchClasses, chromaFromSpectrum, score, buildSteps, createFollower, rowAhead, clean, linkJumps };
}

// ---------- page ----------

if (typeof document !== 'undefined' && document.querySelector('span.c_chord')) (function () {
  const store = {
    get capo() { try { return +localStorage.getItem('chordScrollCapo') || 0; } catch { return 0; } },
    set capo(v) { try { localStorage.setItem('chordScrollCapo', v); } catch {} },
  };
  let capo = store.capo, spans = [], steps = [], follower = createFollower([]), run = null;
  let ourScrollUntil = 0, userInputUntil = 0, scrollTimer;

  const ui = document.createElement('div');
  ui.id = 'cs-ui';
  ui.innerHTML = `
    <style>
      #cs-ui{position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:6px;align-items:center;
        padding:8px;border-radius:12px;background:#1c1c1e;color:#fff;font:16px/1 system-ui,sans-serif;
        box-shadow:0 2px 12px rgba(0,0,0,.4)}
      #cs-ui button{min-width:44px;min-height:44px;border:0;border-radius:8px;background:#3a3a3c;color:#fff;font:inherit;cursor:pointer}
      #cs-ui #cs-go{padding:0 14px;background:#0a7d32}
      #cs-ui #cs-go[aria-pressed=true]{background:#b3261e}
      span.c_chord{cursor:pointer}
      /* the chord box extends down over the lyric line, so only paint its top strip */
      span.c_chord.cs-current{background:linear-gradient(#ffd60a,#ffd60a) top/100% 1.3em no-repeat;color:#000;border-radius:4px}
    </style>
    <button id="cs-go" aria-pressed="false">▶ ເລີ່ມ</button>
    <button id="cs-down" aria-label="ຫຼຸດ capo">−</button>
    <span id="cs-capo" aria-live="polite"></span>
    <button id="cs-up" aria-label="ເພີ່ມ capo">+</button>
    <span id="cs-dbg" style="font:12px monospace;white-space:pre"></span>`;
  document.body.appendChild(ui);
  const go = ui.querySelector('#cs-go'), capoLabel = ui.querySelector('#cs-capo');

  function readChords() {
    // the page can hold hidden duplicate chord blocks; only follow what is displayed
    spans = [...document.querySelectorAll('span.c_chord')].filter(s => s.offsetParent);
    // on dochord each song line is one parent element; repeats are written like "( 2 Times )"
    const parents = [...new Set(spans.map(s => s.parentElement))];
    steps = linkJumps(
      buildSteps(spans.map(s => s.textContent), capo),
      spans.map(s => parents.indexOf(s.parentElement)),
      parents.map(p => ({
        repeat: /\d\s*(times|รอบ|ครั้ง)|[x×]\s*\d/i.test(p.textContent),
        intro: /intro/i.test(p.textContent),
      })));
    const i = follower.index;
    follower = createFollower(steps, { prefer: k => inView(spans[steps[k].first]) });
    follower.jump(i);
    capoLabel.textContent = 'Capo ' + capo;
  }

  const pageTop = el => Math.round(el.getBoundingClientRect().top + scrollY);

  function inView(el) {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  }

  // on screen and not covered by a sticky header, ad or our own controls
  function seen(el) {
    const r = el.getBoundingClientRect();
    if (!inView(el)) return false;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (el.contains(hit) || hit.contains(el));
  }

  function show() {
    document.querySelector('.cs-current')?.classList.remove('cs-current');
    const first = steps[follower.index]?.first;
    const cur = spans[first];
    if (!cur) return;
    cur.classList.add('cs-current');
    // scroll once the row two below the current one can no longer be read
    const look = spans[rowAhead(spans.map(pageTop), first)];
    if (!seen(cur) || !seen(look)) {
      ourScrollUntil = Date.now() + 1500;
      scrollTo({ top: pageTop(cur) - 0.15 * innerHeight, behavior: 'smooth' });
    }
  }

  // The player scrolls to where they are about to play. If that took the current chord off
  // screen, continue from the first chord that is on screen.
  function syncToScreen() {
    const cur = spans[steps[follower.index]?.first];
    const i = cur && inView(cur) ? follower.index : steps.findIndex(s => inView(spans[s.first]));
    if (i < 0) return;
    follower.jump(i); // also forgets the chords heard before the player moved
    show();
  }

  function stop() {
    if (!run) return;
    clearInterval(run.timer);
    run.stream?.getTracks().forEach(t => t.stop());
    run.ctx.close();
    run.lock?.release();
    run = null;
    go.textContent = '▶ ເລີ່ມ';
    go.setAttribute('aria-pressed', 'false');
  }

  async function start() {
    const ctx = new AudioContext(); // created inside the tap so iOS lets it run
    run = { ctx };
    try {
      run.stream = await navigator.mediaDevices.getUserMedia({
        // browser voice processing mangles music
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      stop();
      go.textContent = 'ໄມໃຊ້ບໍ່ໄດ້';
      return;
    }
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 16384; // ~3 Hz bins, enough to separate semitones on the low strings
    an.smoothingTimeConstant = 0.5;
    ctx.createMediaStreamSource(run.stream).connect(an);
    const buf = new Float32Array(an.frequencyBinCount);
    run.timer = setInterval(() => {
      an.getFloatFrequencyData(buf);
      const before = follower.index;
      const chroma = chromaFromSpectrum(buf, ctx.sampleRate, an.fftSize);
      // temporary readout for tuning: volume, then fit of current / next / next+1 chord
      const cl = clean(chroma) || chroma;
      const fit = i => steps[i] ? spans[steps[i].first].textContent + ' ' + score(cl, steps[i].pcs).toFixed(2) : '';
      ui.querySelector('#cs-dbg').textContent = 'vol ' + chroma.reduce((a, b) => a + b, 0).toFixed(3) +
        ' | ' + fit(before) + ' > ' + fit(before + 1) + ' > ' + fit(before + 2);
      if (follower.feed(chroma) !== before) show();
    }, 100);
    // shortcut: wake lock is dropped if the tab is hidden and not re-requested; press start again
    navigator.wakeLock?.request('screen').then(l => run ? run.lock = l : l.release(), () => {});
    go.textContent = '■ ຢຸດ';
    go.setAttribute('aria-pressed', 'true');
    syncToScreen();
    show();
  }

  go.onclick = () => run ? stop() : start();
  const setCapo = d => { capo = (capo + d + 12) % 12; store.capo = capo; readChords(); };
  ui.querySelector('#cs-down').onclick = () => setCapo(-1);
  ui.querySelector('#cs-up').onclick = () => setCapo(1);

  // tap a chord to tell the follower where you are
  document.addEventListener('click', e => {
    const i = spans.indexOf(e.target.closest?.('span.c_chord'));
    if (i < 0) return;
    let s = 0;
    while (s + 1 < steps.length && steps[s + 1].first <= i) s++;
    follower.jump(s);
    show();
  }, true); // capture: the site's own chord click handler stops propagation

  // the site rewrites chord text when its key control is used
  // (observing only the chord block: our own UI lives in body and would retrigger it)
  const block = document.querySelector('span.c_chord').closest('.single-entry-content-cord, blockquote');
  if (block) new MutationObserver(readChords).observe(block, { subtree: true, childList: true, characterData: true });
  // A scroll is the player's only if their hand just did something. A time window after our
  // own scrollTo is not enough: a slow smooth scroll outlasts it and we would chase ourselves.
  for (const type of ['wheel', 'touchmove', 'keydown', 'pointerdown']) {
    addEventListener(type, e => {
      if (!ui.contains(e.target)) userInputUntil = Date.now() + 1500;
    }, { passive: true, capture: true });
  }
  addEventListener('scroll', () => {
    if (Date.now() > userInputUntil || Date.now() < ourScrollUntil) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(syncToScreen, 250);
  }, { passive: true });
  addEventListener('pagehide', stop);
  readChords();
})();
