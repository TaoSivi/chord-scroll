// ==UserScript==
// @name         Chord Scroll
// @namespace    chord-scroll
// @version      0.1.3
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

// Only asks "does the sound fit one of the next two chords better than the current one?"
// shortcut: minEnergy/margin are untuned guesses, calibrate against a real mic + guitar.
function createFollower(steps, { hold = 3, margin = 0.1, minEnergy = 0.01 } = {}) {
  let cand = -1, count = 0;
  const f = {
    index: 0,
    feed(chroma) {
      const total = chroma.reduce((a, b) => a + b, 0);
      if (!steps.length || total < minEnergy) { count = 0; return f.index; }
      let best = -1, bestScore = score(chroma, steps[f.index].pcs) + margin;
      for (let i = f.index + 1; i <= f.index + 2 && i < steps.length; i++) {
        const s = score(chroma, steps[i].pcs);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best < 0) { count = 0; cand = -1; return f.index; }
      count = best === cand ? count + 1 : 1;
      cand = best;
      if (count >= hold) f.jump(best);
      return f.index;
    },
    jump(i) {
      f.index = Math.max(0, Math.min(steps.length - 1, i));
      count = 0; cand = -1;
    },
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
  module.exports = { chordPitchClasses, chromaFromSpectrum, score, buildSteps, createFollower, rowAhead };
}

// ---------- page ----------

if (typeof document !== 'undefined' && document.querySelector('span.c_chord')) (function () {
  const store = {
    get capo() { try { return +localStorage.getItem('chordScrollCapo') || 0; } catch { return 0; } },
    set capo(v) { try { localStorage.setItem('chordScrollCapo', v); } catch {} },
  };
  let capo = store.capo, spans = [], steps = [], follower = createFollower([]), run = null;

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
    steps = buildSteps(spans.map(s => s.textContent), capo);
    const i = follower.index;
    follower = createFollower(steps);
    follower.jump(i);
    capoLabel.textContent = 'Capo ' + capo;
  }

  const pageTop = el => Math.round(el.getBoundingClientRect().top + scrollY);

  // on screen and not covered by a sticky header, ad or our own controls
  function seen(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight) return false;
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
    if (!seen(cur) || !seen(look)) scrollTo({ top: pageTop(cur) - 0.15 * innerHeight, behavior: 'smooth' });
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
      const fit = i => steps[i] ? spans[steps[i].first].textContent + ' ' + score(chroma, steps[i].pcs).toFixed(2) : '';
      ui.querySelector('#cs-dbg').textContent = 'vol ' + chroma.reduce((a, b) => a + b, 0).toFixed(3) +
        ' | ' + fit(before) + ' > ' + fit(before + 1) + ' > ' + fit(before + 2);
      if (follower.feed(chroma) !== before) show();
    }, 100);
    // shortcut: wake lock is dropped if the tab is hidden and not re-requested; press start again
    navigator.wakeLock?.request('screen').then(l => run ? run.lock = l : l.release(), () => {});
    go.textContent = '■ ຢຸດ';
    go.setAttribute('aria-pressed', 'true');
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
  addEventListener('pagehide', stop);
  readChords();
})();
