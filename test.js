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

// the three cases found by feeding synthetic chords through the real page:
const g = L.createFollower(steps);
for (let i = 0; i < 3; i++) g.feed(pc(7, 11, 2).map(v => v * 0.0001));
a.strictEqual(g.index, 1);                    // a quiet mic still advances
for (let i = 0; i < 10; i++) g.feed(Array(12).fill(0.3).map((v, k) => v + 0.02 * (k % 3)));
a.strictEqual(g.index, 1);                    // flat room noise does not
const sung = pc(9, 0, 4); sung[7] = 5;        // Am strummed, loud G sung over it (G is in the current chord)
for (let i = 0; i < 3; i++) g.feed(sung);
a.strictEqual(g.index, 2);                    // one loud note cannot hold it back
const solo = Array(12).fill(0); solo[5] = 1; solo[0] = 0.1; solo[9] = 0.05; // lone sung F with overtones
for (let i = 0; i < 10; i++) g.feed(solo);
a.strictEqual(g.index, 2);                    // singing without guitar does not move it to F

// intro marked "2 Times" on line 0, verse on line 1
const song = () => L.linkJumps(L.buildSteps(['F', 'Am', 'C', 'Dm', 'Am'], 0), [0, 0, 0, 1, 1],
  [{ repeat: true, intro: true }, { repeat: false, intro: false }]);
const play = (fl, ...chords) => chords.forEach(c => { for (let i = 0; i < 3; i++) fl.feed(c); });
const F = pc(5, 9, 0), Am = pc(9, 0, 4), C = pc(0, 4, 7), Dm = pc(2, 5, 9);
let h = L.createFollower(song());
play(h, Dm); a.strictEqual(h.index, 3);             // intro skipped, straight into the verse
h = L.createFollower(song());
play(h, Am, C, F); a.strictEqual(h.index, 0);       // intro played again
play(h, Am, C, Dm); a.strictEqual(h.index, 3);      // ...then the verse
h = L.createFollower(song());
play(h, Am, C, Dm, Am); a.strictEqual(h.index, 4);  // intro once, then the verse

// find-my-place: verse C G Am F twice, then a chorus Dm G E Am
const long = () => L.buildSteps(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'Dm', 'G', 'E', 'Am'], 0);
const G = pc(7, 11, 2), E = pc(4, 8, 11);
const strum = (fl, ...chords) => chords.forEach(c => { for (let i = 0; i < 6; i++) fl.feed(c); });
h = L.createFollower(long());
strum(h, Dm, G, E); a.strictEqual(h.index, 10);     // started at the chorus: found after 3 chords
h = L.createFollower(long());
strum(h, C, G, Am, F, C, G, Am, F, Dm, G, E, Am);
a.strictEqual(h.index, 11);                         // playing straight through never jumps away
h = L.createFollower(long());
h.jump(4); strum(h, C, G, Am); a.strictEqual(h.index, 6); // tapped verse 2: stays in verse 2

// two identical verses; the player has verse 2 on screen (steps 4-7) and plays Am F C? no:
// plays G Am F, which ends at step 3 and at step 7. The screen decides.
const twice = () => L.buildSteps(['C', 'G', 'Am', 'F', 'C', 'G', 'Am', 'F', 'Dm'], 0);
h = L.createFollower(twice(), { prefer: k => k >= 4 && k <= 7 });
h.jump(8); strum(h, G, Am, F); a.strictEqual(h.index, 7);  // on-screen verse wins
h = L.createFollower(twice());
h.jump(8); strum(h, G, Am, F); a.strictEqual(h.index, 7);  // no screen hint: last one before
h = L.createFollower(twice(), { prefer: k => k <= 3 });
h.jump(8); strum(h, G, Am, F); a.strictEqual(h.index, 3);  // verse 1 on screen: verse 1

// a pause splits the memory: Dm G, two seconds of silence, then E must not be read as "Dm G E"
h = L.createFollower(long());
strum(h, Dm, G);
for (let i = 0; i < 25; i++) h.feed(Array(12).fill(0));
const before = h.index;
strum(h, E); a.strictEqual(h.index, before);

const tops = [10, 10, 10, 10, 40, 80, 120];
a.strictEqual(L.rowAhead(tops, 0), 5);                 // two rows below the intro row
a.strictEqual(L.rowAhead(tops, 5), 6);                 // only one row left -> last chord
a.strictEqual(L.rowAhead(tops, 6), 6);
a.strictEqual(L.rowAhead([100, 200, 300, 50, 150], 1), 3); // wraps into the next column
console.log('ok');
