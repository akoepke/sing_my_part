(() => {
"use strict";
const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[<>&"]/g, "");   // names from files, put into HTML
const JSZIP_URL = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
const OSMD_URL = "https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@2.1.3/build/opensheetmusicdisplay.min.js";
const LATENCY = 0.05; // seconds of mic + analysis delay compensated when grading
// time until scheduled sound actually leaves the speakers (large on some phones and Bluetooth)
function outLat(){ try { return Math.min(0.5, Math.max(0, (ctx.outputLatency || 0) + (ctx.baseLatency || 0))); } catch(e){ return 0; } }

// ---------- Music model ----------
const LETTERS = ["C","D","E","F","G","A","B"];
const PC = [0,2,4,5,7,9,11];
const KEYS = { C:{n:0,t:0}, G:{n:1,t:4}, D:{n:2,t:1}, A:{n:3,t:5}, E:{n:4,t:2}, F:{n:-1,t:3}, Bb:{n:-2,t:6}, Eb:{n:-3,t:2}, Ab:{n:-4,t:5} };
const SHARP_ORDER = [3,0,4,1,5,2,6], FLAT_ORDER = [6,2,5,1,4,0,3];
const CLEFS = {
  treble:{ bottom:30, min:27, max:40, tonic:[28,34], sharps:[38,35,39,36,33,37,34], flats:[34,37,33,36,32,35,31] },
  bass:  { bottom:18, min:16, max:29, tonic:[17,23], sharps:[24,21,25,22,19,23,20], flats:[20,23,19,22,18,21,17] }
};
const SHARP_NAMES = ["C","C♯","D","D♯","E","F","F♯","G","G♯","A","A♯","B"];
const FLAT_NAMES  = ["C","D♭","D","E♭","E","F","G♭","G","A♭","A","B♭","B"];
const SEMI_IV = ["unison","half step","whole step","minor 3rd","major 3rd","4th","tritone","5th","minor 6th","major 6th","minor 7th","major 7th","octave"];
const DIA_IV = ["unison","2nd","3rd","4th","5th","6th","7th","octave"];

function accFor(letter, key){
  const n = KEYS[key].n;
  if (n > 0 && SHARP_ORDER.slice(0,n).includes(letter)) return 1;
  if (n < 0 && FLAT_ORDER.slice(0,-n).includes(letter)) return -1;
  return 0;
}
function midiOf(d, key){ return 12*(Math.floor(d/7)+1) + PC[d%7] + accFor(d%7, key); }
function useFlats(){ return S.src === "piece" && PIECE ? PIECE.fifths < 0 : KEYS[S.key].n < 0; }
function nameOf(midi, withOct=true){
  const names = useFlats() ? FLAT_NAMES : SHARP_NAMES;
  const m = Math.round(midi);
  return names[((m%12)+12)%12] + (withOct ? (Math.floor(m/12)-1) : "");
}
function writtenName(d){
  const a = accFor(d%7, S.key);
  return LETTERS[d%7] + (a>0?"♯":a<0?"♭":"") + (Math.floor(d/7));
}
function targetName(nt){ return nt.name || writtenName(nt.d); }

// ---------- Settings ----------
const S = { src:"gen", key:"C", clef:"treble", diff:"steps", measures:2, tempo:72, clicks:false, partName:"", view:"full", fade:false, zoomAdj:1, settingsOpen:false, along:[], guide:false, alongVol:60, headphones:false, ec:false, micId:"", guideVol:60, alongChosen:false, aRef:440, sound:"piano", clickVol:50, v:0 };
try { const saved = JSON.parse(localStorage.getItem("sst-settings")||"null"); if (saved) Object.assign(S, saved); } catch(e){}
function saveSettings(){ try { localStorage.setItem("sst-settings", JSON.stringify(S)); } catch(e){} }
// settings version 2: metronome off and full play-along (all parts, including yours) by default
if ((S.v || 0) < 2){ S.clicks = false; S.alongChosen = false; S.v = 2; }
// settings version 3: the grand piano is the default sound
if (S.v < 3){ S.sound = "piano"; S.v = 3; saveSettings(); }
if (!KEYS[S.key]) S.key = "C";
if (!CLEFS[S.clef]) S.clef = "treble";
S.src = "piece"; // open on My score; a score has to be loaded each visit
S.settingsOpen = false; // Settings always start collapsed
$("key").value = S.key; $("clef").value = S.clef; $("diff").value = S.diff; $("measures").value = String(S.measures);
if (![440,442,415].includes(+S.aRef)) S.aRef = 440;
$("aRef").value = String(S.aRef);
if (!["simple","oo","piano"].includes(S.sound)) S.sound = "piano";
$("sound").value = S.sound;
$("phones").checked = !!S.headphones; $("ecBox").checked = !!S.ec;
$("view").value = S.view === "part" ? "part" : "full"; $("fade").checked = !!S.fade;
$("tempo").value = S.tempo; $("tempoVal").textContent = S.tempo; $("clicks").checked = S.clicks;

function showError(msg){ $("error").textContent = msg; }
function updateCard(){ $("card").hidden = !($("error").textContent.trim() || $("result").textContent.trim()); }
for (const id of ["error", "result"]) new MutationObserver(updateCard).observe($(id), { childList:true, characterData:true, subtree:true });
$("cardClose").addEventListener("click", () => { $("error").textContent = ""; $("result").innerHTML = ""; });

// ---------- Exercise state ----------
// EX.notes: {midi, start, beats, status, label, readings, ...}; generated notes also carry d/deg, score notes carry g/bar/name
let EX = { notes: [], total: 0 };
const noPiece = () => ({ kind:"piece", notes:[], total:0, barStarts:[], countIn:4, keyChord:[], playShift:0, aMidi:69 });
const rnd = a => a[Math.floor(Math.random()*a.length)];
function weighted(pairs){ let r = Math.random()*pairs.reduce((s,p)=>s+p[1],0); for (const [v,w] of pairs){ if ((r-=w) <= 0) return v; } return pairs[0][0]; }

function generate(){
  const cfg = CLEFS[S.clef], k = KEYS[S.key];
  let tonic = cfg.tonic[0]; while (tonic % 7 !== k.t) tonic++;
  const lo = Math.max(cfg.min - tonic, -4), hi = Math.min(cfg.max - tonic, 9);
  const durs = [];
  for (let m = 0; m < S.measures; m++){
    const last = m === S.measures-1;
    let pat;
    if (S.diff === "steps") pat = last ? [1,1,2] : [1,1,1,1];
    else pat = last ? rnd([[1,1,2],[2,2],[1,1,2]]) : rnd([[1,1,1,1],[1,1,1,1],[2,1,1],[1,1,2],[1,2,1],[2,2]]);
    durs.push(...pat);
  }
  const n = durs.length;
  const weights = {
    steps: [[1,.78],[2,.22]],
    skips: [[1,.5],[2,.3],[3,.1],[4,.1]],
    leaps: [[1,.32],[2,.24],[3,.16],[4,.16],[5,.06],[7,.06]]
  }[S.diff];
  const deg = [S.diff === "steps" ? 0 : rnd([0,0,2,4])];
  for (let i = 1; i < n-2; i++){
    const cur = deg[i-1];
    let next, tries = 0;
    do {
      const iv = weighted(weights);
      const upBias = cur < 1 ? .75 : cur > 5 ? .25 : .5;
      next = cur + (Math.random() < upBias ? iv : -iv);
      tries++;
    } while ((next < lo || next > hi || (tries < 8 && next === deg[i-2])) && tries < 40);
    if (next < lo || next > hi) next = cur + (cur > 2 ? -1 : 1);
    deg.push(next);
  }
  const prev = deg[deg.length-1];
  const cands = [1,-1,6,8].filter(c => c >= lo && c <= hi);
  const pen = cands.sort((a,b)=>Math.abs(a-prev)-Math.abs(b-prev))[0];
  deg.push(pen, (pen===6||pen===8) ? 7 : 0);
  let b = 0;
  EX = {
    kind: "gen",
    notes: deg.map((dg,i) => { const d = tonic + dg; const nt = { d, deg:dg, midi: midiOf(d, S.key), start:b, beats:durs[i] }; b += durs[i]; return nt; }),
    total: b, barStarts: Array.from({length:S.measures}, (_,i)=>i*4), countIn: 4,
    keyChord: [tonic, tonic+2, tonic+4].map(d => midiOf(d, S.key)),
    playShift: 0, aMidi: S.clef === "bass" ? 57 : 69
  };
  resetMarks();
}

// what singing a note records; clearNote() gets a note ready to be sung (again)
const unsung = () => ({ status:null, label:"", readings:[], frames:0, trace:[], med:null });
function clearNote(nt){ Object.assign(nt, unsung()); }
function resetMarks(){
  EX.notes.forEach(clearNote);
  $("result").innerHTML = "";
}

// ---------- Generated-exercise rendering ----------
const SP = 10, HS = 5, ROW_H = 148, STAFF_TOP = 52, BEAT_W = 46, PADL = 18, MEAS_W = PADL + 4*BEAT_W + 6;
let perRow = 2, rows = 1;
function x0(row){ return 44 + Math.abs(KEYS[S.key].n)*9 + (row===0 ? 26 : 8); }
function bottomY(row){ return row*ROW_H + STAFF_TOP + 4*SP; }
function yOf(d, row){ return bottomY(row) - (d - CLEFS[S.clef].bottom)*HS; }
function posForBeat(b){
  const m = Math.min(Math.max(Math.floor(b/4),0), S.measures-1);
  const row = Math.floor(m/perRow);
  return { row, x: x0(row) + (m - row*perRow)*MEAS_W + PADL + (b - 4*m)*BEAT_W };
}

function renderGen(){
  const svg = $("staff"), cfg = CLEFS[S.clef], keyN = KEYS[S.key].n;
  const w = svg.parentElement.clientWidth || 800;
  perRow = (S.measures > 2 && w < 760) ? 2 : S.measures;
  rows = Math.ceil(S.measures / perRow);
  const W = x0(0) + perRow*MEAS_W + 6, H = rows*ROW_H;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  let s = "";
  for (let r = 0; r < rows; r++){
    const by = bottomY(r), ty = by - 4*SP;
    const mCount = Math.min(perRow, S.measures - r*perRow);
    const endX = x0(r) + mCount*MEAS_W;
    for (let i = 0; i < 5; i++) s += `<line x1="4" x2="${endX}" y1="${by-i*SP}" y2="${by-i*SP}" stroke="var(--staff)" stroke-width="1"/>`;
    s += `<line x1="4" x2="4" y1="${ty}" y2="${by}" stroke="var(--staff)" stroke-width="1.2"/>`;
    const clefGlyph = S.clef === "treble" ? "\u{1D11E}" : "\u{1D122}";
    const clefBase = S.clef === "treble" ? by : by - 4;
    s += `<text x="9" y="${clefBase}" font-family="MusicGlyphs" font-size="40" fill="var(--ink)">${clefGlyph}</text>`;
    const pos = keyN > 0 ? cfg.sharps : cfg.flats;
    for (let i = 0; i < Math.abs(keyN); i++){
      const y = yOf(pos[i], r) + (keyN > 0 ? 5.2 : 4);
      s += `<text x="${44 + i*9}" y="${y}" font-family="MusicGlyphs" font-size="40" fill="var(--ink)">${keyN>0?"♯":"♭"}</text>`;
    }
    if (r === 0){
      const tx = 44 + Math.abs(keyN)*9 + 9;
      s += `<text x="${tx}" y="${ty+SP+7.5}" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="21" text-anchor="middle" fill="var(--ink)">4</text>`;
      s += `<text x="${tx}" y="${ty+3*SP+7.5}" font-family="Georgia, 'Times New Roman', serif" font-weight="700" font-size="21" text-anchor="middle" fill="var(--ink)">4</text>`;
    }
    for (let m = 1; m <= mCount; m++){
      const bx = x0(r) + m*MEAS_W;
      const final = (r*perRow + m) === S.measures;
      if (final){
        s += `<line x1="${bx-5}" x2="${bx-5}" y1="${ty}" y2="${by}" stroke="var(--staff)" stroke-width="1.2"/>`;
        s += `<rect x="${bx-2.5}" y="${ty}" width="3.5" height="${4*SP}" fill="var(--staff)"/>`;
      } else s += `<line x1="${bx}" x2="${bx}" y1="${ty}" y2="${by}" stroke="var(--staff)" stroke-width="1.2"/>`;
    }
  }
  s += `<line id="playhead" x1="0" x2="0" y1="0" y2="0" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" opacity="0"/>`;
  EX.notes.forEach((nt, i) => {
    const { row, x } = posForBeat(nt.start);
    const y = yOf(nt.d, row), bd = cfg.bottom, top = bd + 8;
    let g = `<g class="note" id="n${i}">`;
    for (let k = bd-2; k >= nt.d; k -= 2) g += `<line x1="${x-10}" x2="${x+10}" y1="${yOf(k,row)}" y2="${yOf(k,row)}" stroke="currentColor" stroke-width="1.2"/>`;
    for (let k = top+2; k <= nt.d; k += 2) g += `<line x1="${x-10}" x2="${x+10}" y1="${yOf(k,row)}" y2="${yOf(k,row)}" stroke="currentColor" stroke-width="1.2"/>`;
    const hollow = nt.beats >= 2;
    g += `<ellipse cx="${x}" cy="${y}" rx="${hollow?5.6:6}" ry="${hollow?3.9:4.3}" transform="rotate(-20 ${x} ${y})" fill="${hollow?"none":"currentColor"}" stroke="currentColor" stroke-width="${hollow?1.9:0.6}"/>`;
    if (nt.beats < 4){
      if (nt.d >= bd + 4) g += `<line x1="${x-5.5}" x2="${x-5.5}" y1="${y+1}" y2="${y+34}" stroke="currentColor" stroke-width="1.3"/>`;
      else g += `<line x1="${x+5.5}" x2="${x+5.5}" y1="${y-1}" y2="${y-34}" stroke="currentColor" stroke-width="1.3"/>`;
    }
    g += `</g><text class="lbl" id="l${i}" x="${x}" y="${bottomY(row)+38}"></text>`;
    s += g;
  });
  for (let r = 0; r < rows; r++) s += `<path id="trace${r}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>`;
  s += `<circle id="liveDot" r="4.5" fill="var(--accent)" opacity="0"/>`;
  svg.innerHTML = s;
  EX.notes.forEach((_, i) => paintNote(i));
  drawTrace();
  showFirstTarget();
}

function traceY(nt, c, row){
  const steps = Math.max(-3.5, Math.min(3.5, (c/100) * 7/12));
  return yOf(nt.d, row) - steps*HS;
}
function drawTrace(){
  if (EX.kind !== "gen") return;
  const paths = Array.from({length:rows}, () => "");
  const last = Array(rows).fill(false);
  for (const nt of EX.notes){
    for (const p of nt.trace){
      if (!p){ last.fill(false); continue; }
      const { row, x } = posForBeat(p.b);
      const y = traceY(nt, p.c, row);
      paths[row] += (last[row] ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      last.fill(false); last[row] = true;
    }
  }
  for (let r = 0; r < rows; r++){ const el = $("trace"+r); if (el) el.setAttribute("d", paths[r]); }
}

// ---------- Score (MusicXML) ----------
let OSMD = null, PIECE = null;
// adds a library's script tag once; calls while it loads share the same promise, a failed load can be retried
const scriptLoads = {};
function loadScript(url, loaded){
  if (loaded()) return Promise.resolve();
  return scriptLoads[url] = scriptLoads[url] || new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = url; s.onload = res; s.onerror = () => { delete scriptLoads[url]; rej(new Error("load")); };
    document.head.appendChild(s);
  });
}
const loadOSMDLib = () => loadScript(OSMD_URL, () => window.opensheetmusicdisplay);
const loadJSZip = () => loadScript(JSZIP_URL, () => window.JSZip);
// Unzips .mxl and plain .zip archives (IMSLP/CPDL zips often lack the MusicXML container file)
async function unzipScore(file){
  await loadJSZip();
  const buf = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
  const zip = await window.JSZip.loadAsync(buf);
  let path = null;
  const container = zip.file("META-INF/container.xml");
  if (container){
    const c = await container.async("text");
    const m = c.match(/full-path="([^"]+)"/);
    if (m && zip.file(m[1])) path = m[1];
  }
  if (!path){
    const cands = Object.values(zip.files).filter(f => !f.dir && !/^(__MACOSX|META-INF)\//.test(f.name) && /\.(musicxml|xml)$/i.test(f.name));
    cands.sort((a, b) => (b._data && b._data.uncompressedSize || 0) - (a._data && a._data.uncompressedSize || 0));
    if (cands.length) path = cands[0].name;
    else {
      const inner = Object.values(zip.files).find(f => !f.dir && /\.mxl$/i.test(f.name));
      if (inner){ const blob = await inner.async("blob"); return unzipScore(new File([blob], inner.name)); }
    }
  }
  if (!path) throw new Error("no musicxml in zip");
  return (await zip.file(path).async("text")).replace(/^\uFEFF/, "");
}

async function loadFile(file){
  if (!file) return;
  if (RUN) stop();
  showError("");
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (["mscz","mscx","pdf","mid","midi","ly","sib","musx","dorico"].includes(ext)){
    showError("That file type can't be read here. Export the score as MusicXML (.musicxml, .xml, or .mxl) from your notation program, then load that file.");
    return;
  }
  $("fileName").textContent = "Reading " + file.name + "… large scores can take a few seconds";
  try { await loadOSMDLib(); }
  catch(e){ $("fileName").textContent = ""; showError("The notation library couldn't load. Check your internet connection, then choose the file again."); return; }
  if (!OSMD){
    OSMD = new window.opensheetmusicdisplay.OpenSheetMusicDisplay($("score"), {
      autoResize:false, backend:"svg", drawTitle:false, drawSubtitle:false, drawComposer:false, drawCredits:false,
      drawPartNames:true, drawLyricist:false, followCursor:false,
      cursorsOptions:[{ type:0, color:"#1772D0", alpha:0.28, follow:false }]
    });
  }
  try {
    let content = file;
    if (ext === "mxl" || ext === "zip"){
      try { content = await unzipScore(file); }
      catch(err){ if (ext === "zip") throw err; content = file; }
    } else {
      const txt = (await readText(file)).replace(/^\uFEFF/, "");
      if (/<score-(partwise|timewise)/.test(txt)) content = txt;
    }
    await OSMD.load(content);
  }
  catch(e){
    $("fileName").textContent = "";
    showError("That file couldn't be read as MusicXML. A .zip needs a .musicxml or .xml score inside it. In MuseScore use File → Export → MusicXML, then load the .musicxml or .mxl file here.");
    return;
  }
  const sh = OSMD.Sheet;
  const instNames = sh.Instruments.map((ins, i) => (ins.Name || "").trim().replace(/\s+/g, " ") || ("Part " + (i+1)));
  // double-choir scores often repeat names (Sopran, Alt… twice): number them so each part is distinct
  const seen = {}, total = {};
  instNames.forEach(n => total[n] = (total[n] || 0) + 1);
  instNames.forEach((n, i) => { if (total[n] > 1){ seen[n] = (seen[n] || 0) + 1; instNames[i] = n + " " + seen[n]; } });
  // a stave carrying two or three lines (e.g. Soprano 1 and 2) becomes one part per line
  const lines = countLines(sh, instNames), parts = [], subs = [];
  instNames.forEach((n, k) => (lines[k] > 1 ? lineNames(n, lines[k]) : [n]).forEach((name, L) => { parts.push(name); subs.push({ inst: k, line: L, lines: lines[k] }); }));
  let fifths = 0, minor = false;
  try {
    const ki = sh.SourceMeasures[0].FirstInstructionsStaffEntries[0].Instructions.find(x => x.keyTypeOriginal !== undefined);
    if (ki){ fifths = ki.Key; minor = ki.Mode === 1; }
  } catch(e){}
  PIECE = {
    fileName: file.name, parts, subs, fifths, minor,
    bars: sh.SourceMeasures.map((m, i) => ({ i, num: m.MeasureNumber, start: m.AbsoluteTimestamp.RealValue*4, dur: m.Duration.RealValue*4 }))
  };
  $("fileName").textContent = file.name;
  const sel = $("part");
  sel.innerHTML = parts.map((p, i) => `<option value="${i}">${p.replace(/[<>&]/g, "")}</option>`).join("");
  const savedIdx = parts.indexOf(S.partName);
  const voiceIdx = parts.findIndex(n => /sopr|sopran|alt|ten|bass|basso|cant/i.test(n) && !/continuo|violon|contrabass/i.test(n));
  // same voice type as last time (Sopran 1 → Soprano, Bass 2 → Bass …)
  const typ = (S.partName || "").slice(0, 3).toLowerCase();
  const typeIdx = typ ? parts.findIndex(n => n.slice(0, 3).toLowerCase() === typ) : -1;
  sel.value = String(savedIdx >= 0 ? savedIdx : typeIdx >= 0 ? typeIdx : voiceIdx >= 0 ? voiceIdx : 0);
  sel.disabled = false;
  // play along with all the other parts unless you've made your own choice before
  if (!S.alongChosen){ const mine = +sel.value || 0; S.along = parts.filter((_, i) => i !== mine); S.guide = true; saveSettings(); }
  const first = PIECE.bars[0].num, last = PIECE.bars[PIECE.bars.length-1].num;
  for (const id of ["fromBar","toBar"]){ const el = $(id); el.min = first; el.max = last; el.disabled = false; }
  // sections end at double or final barlines (movements, big sections)
  PIECE.sections = [];
  let a0 = 0;
  sh.SourceMeasures.forEach((m, i) => {
    const bs = m.endingBarStyleEnum;
    const isEnd = i === sh.SourceMeasures.length - 1 || (bs !== undefined && bs !== 0 && bs !== 6 && bs !== 7 && bs !== 8);
    if (isEnd && (i - a0 >= 3 || i === sh.SourceMeasures.length - 1)){ PIECE.sections.push({ a: a0, b: i }); a0 = i + 1; }
  });
  if (PIECE.sections.length === 1) PIECE.sections = [];
  // drawing a long full score takes a while, so a long piece opens at its first section
  $("fromBar").value = first; $("toBar").value = last;
  // only very long pieces open at a section or chunk; anything up to 200 bars opens whole
  if (PIECE.bars.length > 200){
    const sec = PIECE.sections[0];
    if (sec && sec.b - sec.a < 200){ $("fromBar").value = PIECE.bars[sec.a].num; $("toBar").value = PIECE.bars[sec.b].num; }
    else $("toBar").value = PIECE.bars[Math.min(PIECE.bars.length-1, 59)].num;
  }
  const bpm = sh.DefaultStartTempoInBpm;
  if (bpm >= 30 && bpm <= 240) setTempo(Math.min(200, Math.round(bpm/2)*2));
  $("emptyScore").hidden = true;
  $("topLoad").hidden = false;
  if (S.settingsOpen) showSettings(false);
  updatePager();
  fillRange();
  buildPiece(true);
  renderAlong();
}

function readText(file){
  if (file.text) return file.text();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(file); });
}

function rangeIdx(){
  const bars = PIECE.bars;
  let from = parseInt($("fromBar").value, 10), to = parseInt($("toBar").value, 10);
  if (isNaN(from)) from = bars[0].num;
  if (isNaN(to)) to = bars[bars.length-1].num;
  if (to < from) [from, to] = [to, from];
  let ia = bars.findIndex(b => b.num >= from); if (ia < 0) ia = bars.length-1;
  let ib = -1; for (let i = bars.length-1; i >= 0; i--) if (bars[i].num <= to){ ib = i; break; }
  if (ib < ia) ib = ia;
  return { ia, ib };
}

function spell(n){
  try {
    const p = n.Pitch, f = p.FundamentalNote, oct = p.Octave + 3;
    const letter = LETTERS[PC.indexOf(f)];
    const alter = n.halfTone - (f + 12*oct);
    const acc = { "1":"♯", "-1":"♭", "2":"𝄪", "-2":"𝄫" }[alter] || "";
    if (!letter) return nameOf(n.halfTone + 12);
    return letter + acc + oct;
  } catch(e){ return nameOf(n.halfTone + 12); }
}

function buildPiece(rerender, keepMarks){
  if (!OSMD || !PIECE) return;
  const sh = OSMD.Sheet, pi = +$("part").value || 0;
  const SUNG = Object.keys(unsung());
  const old = keepMarks ? EX.notes.map(n => Object.fromEntries(SUNG.map(k => [k, n[k]]))) : null, oldStart = EX.startBeat;
  S.partName = PIECE.parts[pi]; saveSettings();
  const { ia, ib } = rangeIdx();
  if (rerender){
    const full = S.view !== "part";
    sh.Instruments.forEach((ins, i) => { ins.Visible = full || i === PIECE.subs[pi].inst; });
    OSMD.setOptions({ drawFromMeasureNumber: ia + 1, drawUpToMeasureNumber: ib + 1 });
    // one page = the visible score area, so the score turns like pages instead of scrolling
    const box = $("pieceView");
    const W = Math.max(240, box.clientWidth), H = Math.max(200, box.clientHeight);
    const nStaves = full ? sh.Instruments.reduce((a, ins) => a + ins.Staves.length, 0) : sh.Instruments[PIECE.subs[pi].inst].Staves.length;
    // a system's height (in notation units): estimated from the staves, or as measured once it has been drawn
    const viewKey = full ? "full" : "part:" + PIECE.subs[pi].inst, sysUnits = (PIECE.sysUnits || {})[viewKey] || (nStaves * 10.5 + 12);
    const fit = H / (10 * sysUnits);
    // Size: big enough to read, small enough that whole bars fit across the page.
    // (Too large and a system gets wider than the screen, cutting bars off on the right.)
    const narrow = W < 600;
    OSMD.setOptions({ drawPartNames: !narrow, drawPartAbbreviations: !narrow });
    const minUnits = narrow ? 95 : 120;                 // page width (in notation units) a system needs
    const widthCap = W / (10 * minUnits);
    const minZoom = narrow ? 0.45 : 0.4;
    const z = Math.min(widthCap, Math.max(minZoom, Math.min(1.15, fit))) * (S.zoomAdj || 1);
    OSMD.Zoom = z;
    // if one system is taller than the screen at that size, make pages taller (the page then scrolls)
    const need = 10 * z * sysUnits;
    OSMD.setCustomPageFormat(W, Math.max(H, Math.ceil(need)));
    try { OSMD.cursor.hide(); } catch(e){}
    const r0 = performance.now();
    OSMD.render();
    // the height of a system is only estimated above; low bass notes or lyrics can make it taller, cutting
    // the bottom stave off. So measure what was drawn: if it doesn't fit the score area, draw it again
    // smaller so it does (or, if you zoomed in, keep the size and make the page tall enough to scroll)
    // (the measured height is remembered for this score and view, so later redraws get it right first time)
    const drawn = drawnHeight() + 8;
    if (drawn > H + 1){
      PIECE.sysUnits = PIECE.sysUnits || {};
      PIECE.sysUnits[viewKey] = drawn * 1.05 / (10 * z);                  // with room for the page's bottom margin
      if ((S.zoomAdj || 1) <= 1){ OSMD.Zoom = Math.max(0.3, z * H * 0.95 / drawn); OSMD.setCustomPageFormat(W, H); OSMD.render(); }
      const again = drawnHeight() + 8;
      if (again > H + 1){ OSMD.setCustomPageFormat(W, Math.ceil(again * 1.05)); OSMD.render(); }
    }
    renderMs = performance.now() - r0;
    try { OSMD.cursor.hide(); } catch(e){}
    applyFade();
    lastBox = box.clientWidth + "x" + box.clientHeight;
  }
  const visits = measureVisits(ia, ib);
  const T = buildTimeline(visits, pi);
  const notes = T.mine;
  if (!notes.length){
    EX = noPiece();
    showError("There are no notes to sing for this part in the chosen bars. Pick another part or widen the bar range.");
    return;
  }
  showError("");
  const barStarts = visits.map(v => v.start);
  const total = Math.max(T.total, ...notes.map(n => n.start + n.beats));
  // count-in: a pickup (upbeat) comes in on its proper beat, e.g. 4/4 with one upbeat → "1, 2, 3", sing on 4
  const d0 = visits[0].dur, d1 = visits.length > 1 ? visits[1].dur : d0;
  let countIn;
  if (d0 < d1 - 1e-6){ countIn = Math.round(d1 - d0); if (countIn < 2) countIn += Math.round(d1); }
  else countIn = Math.round(d0);
  countIn = Math.min(8, Math.max(2, countIn));
  // octave handling for playback: tenor parts written in treble clef sound an octave lower
  const sorted = notes.map(n => n.midi).sort((a,b)=>a-b), median = sorted[sorted.length>>1];
  const tenorish = /ten/i.test(S.partName) && median >= 60;
  const playShift = tenorish ? -12 : 0;
  const sounding = median + playShift;
  const tonicPc = (((7*PIECE.fifths) % 12) + 12 + (PIECE.minor ? 9 : 0)) % 12;
  let tonic = 12*Math.floor(sounding/12) + tonicPc; if (tonic > sounding + 2) tonic -= 12; if (tonic < sounding - 10) tonic += 12;
  const keyChord = [tonic, tonic + (PIECE.minor ? 3 : 4), tonic + 7];
  EX = { kind:"piece", notes, total, barStarts, countIn, keyChord, playShift, aMidi: sounding >= 60 ? 69 : 57, parts: T.parts, visits, geo: measureGeometry() };
  resetMarks();
  if (old && old.length === notes.length){ notes.forEach((n, i) => Object.assign(n, old[i])); if (oldStart) EX.startBeat = oldStart; }
  notes.forEach(n => { n.page = pageOf(n.g[0]); });
  setTimeout(showStartChip, 0);
  notes.forEach((_, i) => paintNote(i));
  showFirstTarget();
  showPage(notes[0].page || 1);
}

// The bars in the order they are sung: repeats are followed (e.g. the repeated opening of a chorale).
function measureVisits(ia, ib){
  const sh = OSMD.Sheet, M = sh.SourceMeasures, cur = OSMD.cursor;
  let order = [];
  try {
    cur.resetIterator();
    const it = cur.Iterator;
    let prevMi = -1, prevOff = -1, k = 0;
    while (!it.EndReached && k < 200000){
      const mi = it.CurrentMeasureIndex;
      const off = it.CurrentSourceTimestamp.RealValue - M[mi].AbsoluteTimestamp.RealValue;
      if (mi !== prevMi || off < prevOff - 1e-9) order.push(mi);
      prevMi = mi; prevOff = off;
      it.moveToNextVisibleVoiceEntry(false); k++;
    }
    cur.resetIterator();
  } catch(e){ order = []; }
  // fill in bars the cursor had nothing to stop on
  const full = [];
  order.forEach((mi, j) => {
    const prev = full.length ? full[full.length-1] : -1;
    if (j > 0 && mi > prev + 1) for (let x = prev + 1; x < mi; x++) full.push(x);
    full.push(mi);
  });
  if (!full.length) for (let x = 0; x < M.length; x++) full.push(x);
  // keep the stretch from the first visit of bar ia until the music moves past ib
  const out = []; let started = false, t = 0;
  for (const mi of full){
    if (!started){ if (mi !== ia && !(mi > ia && mi <= ib)) continue; started = true; }
    if (mi > ib) break;
    if (mi < ia) continue;
    const dur = M[mi].Duration.RealValue * 4;
    out.push({ mi, start: t, dur }); t += dur;
  }
  if (!out.length){ for (let mi = ia; mi <= ib; mi++){ const dur = M[mi].Duration.RealValue*4; out.push({ mi, start: t, dur }); t += dur; } }
  return out;
}

// ---------- Several lines on one stave ----------
// Choral scores often put two lines on one stave (Soprano 1 and 2, or Soprano and Alto), either as
// two voices (stems up and down) or as chords. Each line becomes its own part: it follows its voice,
// or its note of a chord. Where only one line is written (unison), every line sings it.
const NOT_SPLIT = /piano|klavier|organ|orgel|cembalo|harpsi|continuo|guitar|gitarre|harp|harfe/i;

// Walks the score bar by bar, calling fn for every stave at every moment something starts on it,
// with the notes grouped by voice and the voices active then (starting a note or rest, or still holding one).
function scanScore(visits, fn, endFn){
  const sh = OSMD.Sheet, M = sh.SourceMeasures, busy = {};
  for (const v of visits){
    for (const c of M[v.mi].VerticalSourceStaffEntryContainers){
      const t = v.start + c.Timestamp.RealValue*4;
      c.StaffEntries.forEach((se, si) => {
        if (!se) return;
        const staff = sh.Staves[si], k = staff ? sh.Instruments.indexOf(staff.ParentInstrument) : -1;
        if (k < 0) return;
        const groups = new Map();
        for (const ve of se.VoiceEntries){
          if (ve.IsGrace) continue;
          const vid = ve.ParentVoice ? ve.ParentVoice.VoiceId : 1, key = si + ":" + vid;
          if (!groups.has(vid)) groups.set(vid, []);
          for (const n of ve.Notes){
            if (!n || n.IsGraceNote || n.IsCueNote) continue;
            busy[key] = Math.max(busy[key] || 0, t + n.Length.RealValue*4);
            if (!n.isRest() && n.Pitch) groups.get(vid).push(n);
          }
        }
        const V = new Set(groups.keys());
        for (const key in busy){ const [s, vid] = key.split(":"); if (+s === si && busy[key] > t + 1e-6) V.add(+vid); }
        fn(t, k, groups, [...V].sort((a, b) => a - b), v);
      });
      if (endFn) endFn(t, v);
    }
  }
}
// The note line L (0 = top) of N sings at this moment, or null if it starts nothing here.
function pickLine(groups, V, L, N){
  const hiLo = a => a.slice().sort((x, y) => y.halfTone - x.halfTone);
  const voiceOf = l => Math.min(V.length - 1, Math.floor(l * V.length / N));
  if (V.length >= 2){
    const vi = voiceOf(L), g = groups.get(V[vi]);
    if (!g || !g.length) return null;
    const same = []; for (let l = 0; l < N; l++) if (voiceOf(l) === vi) same.push(l);
    const ns = hiLo(g), r = same.indexOf(L);
    return ns[same.length > 1 ? Math.round(r * (ns.length - 1) / (same.length - 1)) : (vi === 0 ? 0 : ns.length - 1)];
  }
  const all = []; groups.forEach(g => all.push(...g));
  if (!all.length) return null;
  const ns = hiLo(all);
  return ns[N > 1 ? Math.round(L * (ns.length - 1) / (N - 1)) : 0];
}
// How many lines each part's stave carries (1–3). Keyboard parts and parts on several staves stay whole.
function countLines(sh, names){
  const visits = []; let t = 0;
  sh.SourceMeasures.forEach((m, mi) => { visits.push({ mi, start: t }); t += m.Duration.RealValue*4; });
  const lines = sh.Instruments.map(() => 1);
  const pitches = g => new Set((g || []).map(n => n.halfTone)).size;
  scanScore(visits, (t, k, groups, V) => {
    if (sh.Instruments[k].Staves.length !== 1 || NOT_SPLIT.test(names[k])) return;
    let n = 0;
    if (V.length >= 2) V.forEach(vid => n += Math.max(1, pitches(groups.get(vid))));
    else groups.forEach(g => n = Math.max(n, pitches(g)));
    lines[k] = Math.max(lines[k], Math.min(3, n));
  });
  return lines;
}
// "Sopran 1/2" → Sopran 1, Sopran 2; "Soprano/Alto" → Soprano, Alto; otherwise "Soprano (upper)" …
function lineNames(name, N){
  const bits = name.split(/\s*(?:\/|&|\+|\bund\b|\band\b)\s*/i).filter(Boolean);
  if (bits.length === N){
    const m = bits[0].match(/^(.*?)\s*(\d+|[IVX]+)\.?$/);
    return bits.map((b, i) => i > 0 && m && /^(\d+|[IVX]+)\.?$/.test(b) ? m[1] + " " + b : b);
  }
  return (N === 2 ? ["upper", "lower"] : ["top", "middle", "bottom"]).map(t => name + " (" + t + ")");
}

// Every part's notes on that timeline, straight from the score (independent of what is shown).
// Your part keeps its engraved notes so they can be highlighted and coloured.
function buildTimeline(visits, pi){
  const subs = PIECE.subs, my = subs[pi];
  let rules = null; try { rules = OSMD.cursor.rules || OSMD.EngravingRules; } catch(e){}
  const parts = subs.map((s, j) => ({ name: PIECE.parts[j], inst: s.inst, notes: [], shift: 0 }));
  const mine = [];
  const gOf = n => { try { const gn = rules && rules.GNote ? rules.GNote(n) : null; return gn && gn.getSVGGElement ? gn.getSVGGElement() : null; } catch(e){ return null; } };
  const isCont = n => { const tie = n.NoteTie; return !!(tie && tie.StartNote && tie.StartNote !== n); };
  const tiedBeats = n => { const tie = n.NoteTie; return ((tie && tie.StartNote === n && tie.Duration) ? tie.Duration.RealValue : n.Length.RealValue) * 4; };
  let top = null;
  // your part: a tied-over note belongs to the note it continues; otherwise it is a new note to sing
  const offerMine = (n, t) => {
    if (isCont(n)){
      const prev = mine[mine.length-1], g = gOf(n);
      if (prev && prev.midi === n.halfTone + 12){ if (g) prev.g.push(g); if (t + n.Length.RealValue*4 > prev.start + prev.beats) prev.beats = t + n.Length.RealValue*4 - prev.start; return; }
    }
    if (!top || n.halfTone > top.halfTone) top = n;
  };
  scanScore(visits, (t, k, groups, V) => {
    if (k === my.inst){
      if (my.lines > 1){ const n = pickLine(groups, V, my.line, my.lines); if (n) offerMine(n, t); }
      else groups.forEach(g => g.forEach(n => offerMine(n, t)));
    }
    subs.forEach((s, j) => {
      if (s.inst !== k) return;
      const add = n => { if (n && !isCont(n)) parts[j].notes.push({ midi: n.halfTone + 12, start: t, beats: tiedBeats(n) }); };
      if (s.lines > 1) add(pickLine(groups, V, s.line, s.lines));
      else groups.forEach(g => g.forEach(add));
    });
  }, (t, v) => {
    if (!top) return;
    const g = gOf(top);
    mine.push({ midi: top.halfTone + 12, start: t, beats: top.Length.RealValue*4, g: g ? [g] : [], bar: PIECE.bars[v.mi].num, name: spell(top) });
    top = null;
  });
  parts.forEach(p => {
    p.notes.sort((a, b) => a.start - b.start);
    const sm = p.notes.map(n => n.midi).sort((a, b) => a - b), med = sm[sm.length >> 1] || 60;
    p.shift = (/ten/i.test(p.name) && med >= 60) ? -12 : 0;
  });
  mine.sort((a, b) => a.start - b.start);
  const total = visits.length ? visits[visits.length-1].start + visits[visits.length-1].dur : 0;
  return { mine, parts, total };
}

function renderAlong(){
  const box = $("alongParts");
  if (!PIECE){ box.innerHTML = '<span class="muted">Load a score first</span>'; return; }
  const mine = +$("part").value || 0;
  box.innerHTML = PIECE.parts.map((name, i) => i === mine
    ? `<label class="chip mine"><input type="checkbox" data-guide="1" ${S.guide ? "checked" : ""}> ${esc(name)} (my part, as a guide)</label>`
    : `<label class="chip"><input type="checkbox" data-part="${esc(name)}" ${S.along.includes(name) ? "checked" : ""}> ${esc(name)}</label>`).join("")
    + '<button class="quick" id="alongAll" type="button">All others</button><button class="quick" id="alongNone" type="button">None</button>';
  syncTop();
  box.querySelectorAll("input").forEach(el => el.addEventListener("change", readAlong));
  $("alongAll").addEventListener("click", () => { box.querySelectorAll("input[data-part]").forEach(el => el.checked = true); readAlong(); });
  $("alongNone").addEventListener("click", () => { box.querySelectorAll("input").forEach(el => el.checked = false); readAlong(); });
}
function fillRange(){
  const sel = $("topRange"), bars = PIECE.bars, n = bars.length;
  let h = PIECE.sections.map((sec, k) => `<option value="${sec.a}-${sec.b}">Section ${k+1}: ${bars[sec.a].num}–${bars[sec.b].num}</option>`).join("");
  if (!PIECE.sections.length && n > 60){
    // no sections marked in the score: offer chunks of about 40 bars
    const size = 40;
    for (let a = 0; a < n; a += size){
      const b = Math.min(n - 1, a + size - 1);
      h += `<option value="${a}-${b}">Bars ${bars[a].num}–${bars[b].num}</option>`;
    }
  }
  h += `<option value="0-${n-1}">Whole piece: ${bars[0].num}–${bars[n-1].num}${n > 200 ? " (slow to draw)" : ""}</option>`;
  h += `<option value="custom">Custom…</option>`;
  sel.innerHTML = h;
}
function syncRange(){
  if (!PIECE) return;
  const { ia, ib } = rangeIdx(), v = ia + "-" + ib, sel = $("topRange");
  sel.value = Array.from(sel.options).some(o => o.value === v) ? v : "custom";
}
function rebuildNow(){
  setCount("Drawing the score…");
  return new Promise(res => setTimeout(() => { buildPiece(true, false); setCount(""); syncRange(); res(); }, 30));
}
function syncTop(){
  const on = S.src === "piece" && !!PIECE;
  $("topPartWrap").hidden = !on; $("topAlongWrap").hidden = !on; $("topRangeWrap").hidden = !on; $("dockVols").hidden = !on;
  if (!on) return;
  syncRange();
  const tp = $("topPart");
  if (tp.options.length !== PIECE.parts.length) tp.innerHTML = $("part").innerHTML;
  tp.value = $("part").value;
  const mine = +$("part").value || 0;
  const others = PIECE.parts.filter((_, i) => i !== mine);
  const allOn = others.length > 0 && others.every(n => S.along.includes(n));
  const noneOn = !others.some(n => S.along.includes(n));
  $("topAlong").value = noneOn && !S.guide ? "none" : allOn ? (S.guide ? "allguide" : "all") : "custom";
}
function readAlong(){
  const box = $("alongParts");
  const onPage = Array.from(box.querySelectorAll("input[data-part]"));
  const shown = onPage.map(el => el.dataset.part);
  S.along = S.along.filter(n => !shown.includes(n)).concat(onPage.filter(el => el.checked).map(el => el.dataset.part));
  const g = box.querySelector("input[data-guide]"); S.guide = !!(g && g.checked);
  S.alongChosen = true;
  saveSettings(); syncTop(); refreshPlayback();
}
function alongList(withMine){
  if (EX.kind !== "piece" || !EX.parts) return [];
  const mine = +$("part").value || 0, list = [];
  // lines sharing a stave often sing the same note (unison): play it once
  const played = new Set(), once = (p, n) => { const key = p.inst + ":" + n.midi + ":" + n.start; if (played.has(key)) return false; played.add(key); return true; };
  const my = EX.parts[mine];
  if (my && (withMine || S.guide)) EX.notes.forEach(n => { once(my, n); list.push({ midi: n.midi + EX.playShift, start: n.start, beats: n.beats, vol: 0.17, guide: true }); });
  EX.parts.forEach((p, i) => {
    if (i !== mine && S.along.includes(p.name)) p.notes.forEach(n => { if (once(p, n)) list.push({ midi: n.midi + p.shift, start: n.start, beats: n.beats, vol: 0.075 }); });
  });
  return list.sort((a, b) => a.start - b.start);
}

// Where each bar is drawn (page and box, in pixels), for the "where are we" marker and page turns
function measureGeometry(){
  const geo = {};
  try {
    const G = OSMD.GraphicSheet, M = OSMD.Sheet.SourceMeasures, pages = G.MusicPages, U = 10 * OSMD.Zoom;
    for (const row of G.MeasureList){
      const gms = (row || []).filter(g => g && g.ParentMusicSystem);
      if (!gms.length) continue;
      const mi = M.indexOf(gms[0].parentSourceMeasure); if (mi < 0) continue;
      const pg = pages.indexOf(gms[0].ParentMusicSystem.Parent) + 1; if (pg < 1) continue;
      const ps = gms[0].PositionAndShape;
      let top = Infinity, bot = -Infinity;
      for (const gm of gms){ const y = gm.PositionAndShape.AbsolutePosition.y; top = Math.min(top, y); bot = Math.max(bot, y + 4); }
      geo[mi] = { page: pg, x: ps.AbsolutePosition.x * U, w: ps.Size.width * U, bi: (gms[0].beginInstructionsWidth || 0) * U, top: (top - 2) * U, h: (bot - top + 4) * U };
    }
  } catch(e){}
  return geo;
}
function hideMarker(){ const b = $("playBand"); if (b) b.hidden = true; }
// show the bar being played and a line at the current beat, whatever your part is doing
function showPos(b){
  if (EX.kind !== "piece" || !EX.visits || !EX.visits.length || !EX.geo) return;
  const V = EX.visits;
  let k = (RUN && RUN.vk != null) ? RUN.vk : 0;
  if (k >= V.length || b < V[k].start) k = 0;
  while (k < V.length - 1 && V[k].start + V[k].dur <= b) k++;
  if (RUN) RUN.vk = k;
  const v = V[k], g = EX.geo[v.mi]; if (!g) return;
  const frac = Math.max(0, Math.min(1, (b - v.start) / v.dur));
  const pageEl = document.getElementById("osmdCanvasPage" + g.page); if (!pageEl) return;
  let band = $("playBand");
  if (!band){ band = document.createElement("div"); band.id = "playBand"; band.appendChild(document.createElement("i")); }
  if (band.parentNode !== pageEl){ pageEl.style.position = "relative"; pageEl.appendChild(band); }
  band.hidden = false;
  band.style.left = g.x + "px"; band.style.top = g.top + "px"; band.style.width = g.w + "px"; band.style.height = g.h + "px";
  band.firstChild.style.left = (g.bi + frac * Math.max(0, g.w - g.bi)) + "px";
}
function pageAtBeat(b){
  const V = EX.visits || []; for (const v of V) if (b < v.start + v.dur){ const g = EX.geo[v.mi]; return g ? g.page : null; }
  return null;
}

// ---------- Pages ----------
let page = 1, lastBox = "";
function pageEls(){ return Array.from(document.querySelectorAll('#score > div[id^="osmdCanvasPage"]')); }
const pageNum = el => parseInt(el.id.replace("osmdCanvasPage", ""), 10);
function pageOf(el){
  const pg = el && el.closest ? el.closest('div[id^="osmdCanvasPage"]') : null;
  const n = pg ? pageNum(pg) : 1;
  return isNaN(n) ? 1 : n;
}
function showPage(n){
  const els = pageEls(), total = Math.max(1, els.length);
  page = Math.min(Math.max(1, n), total);
  els.forEach(el => { el.style.display = pageNum(el) === page ? "" : "none"; });
  $("pageInfo").textContent = page + " / " + total;
  $("prevPage").disabled = page <= 1; $("nextPage").disabled = page >= total;
  $("tapPrev").hidden = page <= 1; $("tapNext").hidden = page >= total;
}
function turn(d){ if (S.src === "piece" && PIECE) showPage(page + d); }
function updatePager(){
  const on = S.src === "piece" && !!PIECE;
  $("pager").hidden = !on;
  if (!on){ $("tapPrev").hidden = true; $("tapNext").hidden = true; }
}

// How tall the drawn music on the tallest page is, in pixels (from the top of its page to its lowest mark)
function drawnHeight(){
  let most = 0;
  for (const pg of pageEls()){
    const svg = pg.querySelector("svg"); if (!svg) continue;
    const sr = svg.getBoundingClientRect(); let low = sr.top;
    for (const el of svg.querySelectorAll("path, text, rect")){
      const r = el.getBoundingClientRect();
      if ((r.width || r.height) && r.height < sr.height * 0.9) low = Math.max(low, r.bottom);   // not a page background
    }
    most = Math.max(most, low - sr.top);
  }
  return most;
}
function applyFade(){
  if (!OSMD || !PIECE) return;
  const inst = OSMD.Sheet.Instruments[PIECE.subs[+$("part").value || 0].inst];
  const myId = (inst.Name || "") + inst.Id + "-";
  const on = S.fade && S.view !== "part";
  document.querySelectorAll("#score g.staffline").forEach(g => g.classList.toggle("faded", on && !(g.id || "").startsWith(myId)));
}

// highlight the note to sing and keep it on screen
let curMark = -1;
function markCurrent(i){
  if (EX.kind !== "piece" || i === curMark) return;
  const prev = EX.notes[curMark];
  if (prev) prev.g.forEach(g => g.classList.remove("mk-current"));
  curMark = i;
  const nt = EX.notes[i];
  if (!nt || nt.status) return;
  nt.g.forEach(g => g.classList.add("mk-current"));
  // while singing, the page is turned by the clock (just before the next page's first note);
  // otherwise make sure the note is visible
  if (nt.page && nt.page !== page && !RUN) showPage(nt.page);
}
// ---------- Shared note display ----------
function paintNote(i){
  const nt = EX.notes[i]; if (!nt) return;
  if (EX.kind === "piece"){
    for (const g of nt.g){
      g.classList.remove("mk-good","mk-close","mk-miss","mk-silent");
      if (nt.status) g.classList.remove("mk-current");
      if (nt.status) g.classList.add("mk-" + nt.status);
    }
    return;
  }
  const g = $("n"+i), l = $("l"+i);
  if (!g) return;
  const cur = RUN && RUN.idx === i && !nt.status;
  g.setAttribute("class", "note" + (nt.status ? " "+nt.status : cur ? " current" : ""));
  l.setAttribute("class", "lbl" + (nt.status ? " "+nt.status : ""));
  l.textContent = nt.label || "";
}
function showFirstTarget(){
  const nt = EX.notes[0];
  $("target").textContent = nt ? targetName(nt) : "–";
  $("targetCap").textContent = "First note";
}
function setCount(t){ $(EX.kind === "piece" ? "countPiece" : "countGen").textContent = t; }

// ---------- Audio ----------
let accBus = null, guideBus = null;
let ctx = null, master = null, analyser = null, buf = null, stream = null, noiseBuf = null;
const scheduled = [];
let playingUntil = 0;
function ensureCtx(){
  if (!ctx){
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.8;
    // a gentle limiter so many voices at once never clip
    try {
      const lim = ctx.createDynamicsCompressor();
      lim.threshold.value = -12; lim.knee.value = 8; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.25;
      master.connect(lim); lim.connect(ctx.destination);
    } catch(e){ master.connect(ctx.destination); }
    accBus = ctx.createGain(); accBus.gain.value = S.alongVol/100; accBus.connect(master);
    guideBus = ctx.createGain(); guideBus.gain.value = S.guideVol/100; guideBus.connect(master);
    clickBus = ctx.createGain(); clickBus.gain.value = S.clickVol/100; clickBus.connect(master);
    mainBus = ctx.createGain(); mainBus.connect(master);
    // a small-room reverb, sent from each bus: the soft "oo" and the piano use a little of it
    const len = Math.floor(ctx.sampleRate * 1.6), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++){ const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random()*2 - 1) * Math.pow(1 - i/len, 3.5); }
    const conv = ctx.createConvolver(); conv.buffer = ir; conv.connect(master);
    sends = [accBus, guideBus, mainBus].map(b => { const g = ctx.createGain(); g.gain.value = 0; b.connect(g).connect(conv); return g; });
    applySoundFx();
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate*0.03), ctx.sampleRate);
    const ch = noiseBuf.getChannelData(0);
    for (let i = 0; i < ch.length; i++) ch[i] = (Math.random()*2-1) * Math.pow(1 - i/ch.length, 3);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}
// streams long note lists a little ahead of time instead of scheduling everything at once
const PLAY = { list: [], idx: 0, t0: 0, beat: 0.5, timer: null, bus: null };
function startPlayer(list, t0, beat, bus){
  stopPlayer();
  if (!list.length) return;
  Object.assign(PLAY, { list, idx: 0, t0, beat, bus });
  PLAY.timer = setInterval(pump, 60); pump();
}
function pump(extra){
  if (!ctx) return;
  const now = ctx.currentTime, horizon = now + 0.7 + (extra || 0);
  while (PLAY.idx < PLAY.list.length){
    const n = PLAY.list[PLAY.idx], when = PLAY.t0 + n.start*PLAY.beat;
    if (when > horizon) break;
    if (when >= now - 0.03) tone(n.midi, Math.max(when, now), Math.max(0.07, n.beats*PLAY.beat*0.94), n.vol, n.guide ? guideBus : PLAY.bus);
    PLAY.idx++;
  }
  if (PLAY.idx >= PLAY.list.length) stopPlayer();
}
function stopPlayer(){ if (PLAY.timer){ clearInterval(PLAY.timer); PLAY.timer = null; } }
let hearTimer = null;
function stopScheduled(){
  stopPlayer(); clearTimeout(hearTimer);
  stopClicks();
  for (const s of scheduled){ try { s.stop(0); } catch(e){} }
  scheduled.length = 0; silencePianos(); playingUntil = 0; $("hearBtn").textContent = "Hear the melody";
}
// ---------- Sounds ----------
// "simple": a plain triangle tone. "oo": a soft sung "oo" with a little breath and vibrato.
// "piano": a recorded Steinway grand (Splendid Grand Piano, played by smplr), fetched the first
// time it's chosen; the simple tone stands in until it has loaded or if it can't load.
const SMPLR_URL = "https://cdn.jsdelivr.net/npm/smplr@1.0.0/dist/index.mjs";
let mainBus = null, clickBus = null, sends = [], pianos = null, spare = null, pianoKit = null, pianoLoading = null, ooWave = null, breathBuf = null;
const hzOf = midi => (S.aRef || 440) * Math.pow(2, (midi-69)/12);
function applySoundFx(){
  const wet = { simple: 0, oo: 0.22, piano: 0.12 }[S.sound] || 0;
  sends.forEach(g => g.gain.setTargetAtTime(wet, ctx.currentTime, 0.05));
}
function pianoDetune(){ return 1200 * Math.log2((S.aRef || 440) / 440); }
// A set of pianos: one per bus so the volume sliders work as usual, all sharing one set of samples.
// Notes go to the audio engine as soon as they're scheduled (long lookahead), so they play on time
// even while the page is busy, e.g. redrawing the score. Such notes can't be called back, so each set
// plays through its own gate: stopping fades the gate out, retires the set and swaps in a spare one.
function makePianoSet(){
  const { SplendidGrandPiano, Scheduler } = pianoKit;
  const opts = { loader: pianoKit.loader, scheduler: Scheduler(ctx, { lookaheadMs: 30000, intervalMs: 50 }), decayTime: 0.4, detune: pianoDetune(), volume: 127 };
  const set = { by: new Map(), gates: [], used: false };
  for (const b of [accBus, guideBus, mainBus]){
    const gate = ctx.createGain(); gate.connect(b); set.gates.push(gate);
    set.by.set(b, SplendidGrandPiano(ctx, Object.assign({ destination: gate }, opts)));
  }
  set.ready = Promise.all([...set.by.values()].map(p => p.ready));
  return set;
}
function prepareSpare(){ const s = makePianoSet(); s.ready.then(() => { if (spare) retireSet(s); else spare = s; }); }
function retireSet(set){
  const t = ctx.currentTime;
  set.gates.forEach(g => g.gain.setTargetAtTime(0, t, 0.03));
  setTimeout(() => { for (const p of set.by.values()) try { p.dispose(); } catch(e){} set.gates.forEach(g => { try { g.disconnect(); } catch(e){} }); }, 400);
}
function loadPiano(){
  if (pianos || pianoLoading) return;
  ensureCtx();
  setSoundNote("Loading the piano…");
  pianoLoading = import(SMPLR_URL).then(async lib => {
    pianoKit = { SplendidGrandPiano: lib.SplendidGrandPiano, Scheduler: lib.Scheduler, loader: lib.SampleLoader(ctx) };
    const set = makePianoSet(); await set.ready;
    pianos = set; prepareSpare(); setSoundNote("");
    refreshPlayback();
  }).catch(() => { pianoLoading = null; setSoundNote("The piano couldn't load, so the simple tone is used. Check your internet connection and choose Grand piano again."); });
}
function pianoStart(bus, opts){ pianos.used = true; return pianos.by.get(bus).start(opts); }
function setSoundNote(t){ const el = $("soundNote"); if (el){ el.textContent = t; el.hidden = !t; } }
// levels set by measuring the output, so each sound is about as loud as the simple tone
const OO_LEVEL = 0.55;
const velOf = vol => Math.max(20, Math.min(127, Math.round(30 + vol * 420)));
function track(node, end){
  node.stop(end);
  node.onended = () => { const k = scheduled.indexOf(node); if (k >= 0) scheduled.splice(k, 1); };
  scheduled.push(node);
}
function simpleVoice(midi, when, vol, bus){
  const f = hzOf(midi), o = ctx.createOscillator(), g = ctx.createGain(), lp = ctx.createBiquadFilter();
  o.type = "triangle"; o.frequency.value = f;
  lp.type = "lowpass"; lp.frequency.value = Math.min(4000, f*6);
  o.connect(lp).connect(g).connect(bus);
  o.start(when);
  return { g, nodes: [o] };
}
function ooVoice(midi, when, vol, bus){
  if (!ooWave){ const h = [0, 1, 0.18, 0.06, 0.02]; ooWave = ctx.createPeriodicWave(new Float32Array(h.length), new Float32Array(h)); }
  if (!breathBuf){ breathBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = breathBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random()*2 - 1; }
  const f = hzOf(midi), g = ctx.createGain(), o = ctx.createOscillator();
  o.setPeriodicWave(ooWave); o.frequency.value = f; o.connect(g);
  const n = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
  n.buffer = breathBuf; n.loop = true; bp.type = "bandpass"; bp.frequency.value = f * 2; bp.Q.value = 2; ng.gain.value = 0.05;
  n.connect(bp).connect(ng).connect(g);
  // vibrato fades in after the start of the note
  const lfo = ctx.createOscillator(), depth = ctx.createGain();
  lfo.frequency.value = 5; depth.gain.setValueAtTime(0, when); depth.gain.linearRampToValueAtTime(f * (Math.pow(2, 14/1200) - 1), when + 0.4);
  lfo.connect(depth).connect(o.frequency);
  g.connect(bus);
  [o, n, lfo].forEach(x => x.start(when));
  return { g, nodes: [o, n, lfo] };
}
function tone(midi, when, dur, vol=0.16, bus){
  bus = bus || mainBus;
  if (S.sound === "piano"){
    if (pianos){ pianoStart(bus, { note: midi, time: when, duration: dur, velocity: velOf(vol) }); return; }
    loadPiano();
  }
  if (S.sound === "oo"){
    const v = ooVoice(midi, when, vol, bus), g = v.g.gain, off = when + Math.max(0.1, dur - 0.08), a = vol * OO_LEVEL;
    g.setValueAtTime(0.0001, when); g.linearRampToValueAtTime(a, when + 0.09);
    g.setValueAtTime(a, off); g.linearRampToValueAtTime(0.0001, off + 0.15);
    v.nodes.forEach(x => track(x, off + 0.2));
    return;
  }
  const v = simpleVoice(midi, when, vol, bus), g = v.g.gain;
  g.setValueAtTime(0.0001, when);
  g.linearRampToValueAtTime(vol, when + 0.015);
  g.setTargetAtTime(vol*0.55, when + 0.03, 0.25);
  g.setTargetAtTime(0.0001, when + Math.max(0.04, dur - 0.05), 0.04);
  v.nodes.forEach(x => track(x, when + dur + 0.3));
}
function silencePianos(){
  if (!pianos || !pianos.used) return;
  retireSet(pianos);
  pianos = spare || makePianoSet(); spare = null;
  prepareSpare();
}
function click(when, accent){
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = noiseBuf; bp.type = "bandpass"; bp.frequency.value = accent ? 3200 : 2400; bp.Q.value = 1.2;
  g.gain.value = accent ? 0.9 : 0.55;
  src.connect(bp).connect(g).connect(clickBus);
  src.start(when); scheduled.push(src);
}

let micEC = null, micSrc = null, micDev = null;
async function ensureMic(){
  const ec = !!S.ec, dev = S.micId || "";
  if (analyser && micEC === ec && micDev === dev) return true;
  ensureCtx();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    showError("This browser can't use a microphone on this page. Try opening it in Chrome, Edge, Safari, or Firefox.");
    return false;
  }
  try {
    const base = { echoCancellation:ec, noiseSuppression:false, autoGainControl:false };
    let next;
    try { next = await navigator.mediaDevices.getUserMedia({ audio: dev ? Object.assign({ deviceId:{ exact: dev } }, base) : base }); }
    catch(err){ if (dev && err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")){ S.micId = ""; saveSettings(); next = await navigator.mediaDevices.getUserMedia({ audio: base }); } else throw err; }
    if (stream){ try { stream.getTracks().forEach(t => t.stop()); } catch(e){} }
    if (micSrc){ try { micSrc.disconnect(); } catch(e){} }
    stream = next;
  } catch (e){
    if (e && (e.name === "NotAllowedError" || e.name === "SecurityError"))
      showError("Microphone access is blocked. Allow the microphone for this page in your browser's site settings, then press Start again. If the page is embedded in another window, opening it in its own tab usually helps.");
    else if (e && e.name === "NotFoundError")
      showError("No microphone was found. Connect one or check your system sound settings, then press Start again.");
    else showError("The microphone couldn't start (" + (e && e.name || "unknown error") + "). Check that no other app is using it, then press Start again.");
    return false;
  }
  micSrc = ctx.createMediaStreamSource(stream);
  const first = !analyser;
  if (first){ analyser = ctx.createAnalyser(); analyser.fftSize = 2048; buf = new Float32Array(analyser.fftSize); }
  micSrc.connect(analyser);
  micEC = ec; micDev = S.micId || "";
  listMics();
  $("micStatus").classList.add("on"); $("micText").textContent = ec ? "Listening (echo cancellation on)" : "Listening";
  showError("");
  if (first) requestAnimationFrame(frame);
  return true;
}

async function listMics(){
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audioinput");
    const sel = $("micSel"), cur = S.micId || "";
    sel.innerHTML = '<option value="">System default</option>' + devs.filter(d => d.deviceId && d.deviceId !== "default")
      .map((d, i) => `<option value="${d.deviceId}">${(d.label || "Microphone " + (i+1)).replace(/[<>&]/g, "")}</option>`).join("");
    sel.value = Array.from(sel.options).some(o => o.value === cur) ? cur : "";
  } catch(e){}
}
if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", listMics);

// YIN pitch detection
let yinD = null, lastRms = 0, lvlTick = 0;
function detect(){
  analyser.getFloatTimeDomainData(buf);
  let rms = 0; for (let i = 0; i < buf.length; i++) rms += buf[i]*buf[i];
  rms = Math.sqrt(rms / buf.length);
  lastRms = rms;
  if (rms < 0.006) return null;
  const sr = ctx.sampleRate, W = Math.floor(buf.length/2);
  const tMin = Math.floor(sr/1100), tMax = Math.min(W-1, Math.floor(sr/65));
  if (!yinD || yinD.length !== tMax+1) yinD = new Float32Array(tMax+1);
  const d = yinD; d[0] = 1;
  let running = 0;
  for (let t = 1; t <= tMax; t++){
    let sum = 0;
    for (let i = 0; i < W; i++){ const v = buf[i] - buf[i+t]; sum += v*v; }
    running += sum;
    d[t] = running ? sum * t / running : 1;
  }
  let tau = -1;
  for (let t = tMin; t <= tMax; t++){
    if (d[t] < 0.13){ while (t+1 <= tMax && d[t+1] < d[t]) t++; tau = t; break; }
  }
  if (tau < 0) return null;
  let bt = tau;
  if (tau > 1 && tau < tMax){
    const a = d[tau-1], b = d[tau], c = d[tau+1], den = a + c - 2*b;
    if (den) bt = tau + (a - c) / (2*den);
  }
  const f = sr / bt;
  if (f < 65 || f > 1100) return null;
  return 69 + 12*Math.log2(f/(S.aRef || 440));
}

// ---------- Live loop ----------
let hist = [], voiced = null, traceTick = 0;
function median(a){ const s = [...a].sort((x,y)=>x-y), m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
function fold(midi, target){ const diff = midi - target; return (diff - 12*Math.round(diff/12)) * 100; }

function frame(){
  requestAnimationFrame(frame);
  const now = ctx.currentTime;
  const raw = detect();
  if (raw == null){ hist = []; voiced = null; }
  else {
    hist.push(raw); if (hist.length > 3) hist.shift();
    const m = median(hist);
    voiced = (voiced != null && Math.abs(m - voiced) > 1.5 && hist.length < 3) ? voiced : m;
  }
  heardAlong = false;
  if (voiced != null && RUN && RUN.along && !S.headphones) rejectBleed(now);
  if (RUN) stepRun(now);
  if (playingUntil && now > playingUntil){ playingUntil = 0; $("hearBtn").textContent = "Hear the melody"; }
  updateMeter();
  if (++lvlTick % 3 === 0){ const lv = $("lvl"); if (lv) lv.style.width = Math.min(100, Math.sqrt(lastRms) * 260) + "%"; }
  if (++traceTick % 2 === 0 && RUN) drawTrace();
}

// Without headphones the mic also hears the play-along. A pitch that matches a part sounding
// right now, but not the note you should sing, is treated as the speakers rather than you.
let heardAlong = false;
function alongSounding(t){
  const out = [];
  for (let j = Math.max(0, PLAY.idx - 160); j < PLAY.idx; j++){
    const n = PLAY.list[j]; if (!n) continue;
    const w = PLAY.t0 + n.start*PLAY.beat, e = w + Math.max(0.07, n.beats*PLAY.beat*0.94) + 0.2;
    if (w <= t && t <= e) out.push(n.midi);
  }
  return out;
}
function rejectBleed(now){
  const snd = alongSounding(now - outLat() - LATENCY);
  if (!snd.length) return;
  const notes = EX.notes, be = (now - outLat() - RUN.t0 - LATENCY) / RUN.beat;
  let tn = null;
  if (RUN.gi < notes.length && be >= notes[RUN.gi].start) tn = notes[RUN.gi].midi;
  else if (RUN.idx >= 0) tn = notes[RUN.idx].midi;
  if (tn != null && Math.abs(fold(voiced, tn)) <= 45) return;
  if (snd.some(m => Math.abs(fold(voiced, m)) <= 45)){ voiced = null; heardAlong = true; RUN.bleed++; }
}

// The meter shows a steadied reading so the needle and note don't flicker: the pitch is smoothed a
// little, and dropouts shorter than a quarter second (vibrato, a moment of play-along) are bridged.
// Grading uses the unsmoothed readings.
let shown = null, shownAt = 0;
function updateMeter(){
  const needle = $("needle"), now = performance.now() / 1000;
  if (voiced != null){ shown = shown == null || Math.abs(voiced - shown) > 0.7 ? voiced : shown + (voiced - shown) * 0.3; shownAt = now; }
  else if (now - shownAt > 0.25) shown = null;
  if (shown == null){
    $("sung").firstChild.nodeValue = "–"; $("cents").textContent = heardAlong ? "play-along" : "";
    needle.style.background = "var(--idle)"; return;
  }
  let target = null;
  if (RUN && RUN.idx >= 0 && RUN.idx < EX.notes.length) target = EX.notes[RUN.idx].midi;
  const c = target != null ? fold(shown, target) : (shown - Math.round(shown))*100;
  $("sung").firstChild.nodeValue = nameOf(shown);
  const cr = Math.round(c);
  $("cents").textContent = target != null && Math.abs(c) > 150 ? "wrong note" : (cr > 0 ? "+" : cr < 0 ? "−" : "±") + Math.abs(cr) + "¢";
  const clamped = Math.max(-50, Math.min(50, c));
  needle.style.left = (50 + clamped) + "%";
  needle.style.background = Math.abs(c) <= 30 ? "var(--good)" : Math.abs(c) <= 50 ? "var(--close)" : "var(--miss)";
}

// ---------- Runs ----------
let RUN = null;
function setPlayhead(b){
  if (EX.kind !== "gen") return;
  const ph = $("playhead"); if (!ph) return;
  if (b == null){ ph.setAttribute("opacity","0"); return; }
  const { row, x } = posForBeat(Math.min(b, EX.total - 0.01));
  ph.setAttribute("x1", x); ph.setAttribute("x2", x);
  ph.setAttribute("y1", bottomY(row) - 4*SP - 14); ph.setAttribute("y2", bottomY(row) + 14);
  ph.setAttribute("opacity", ".55");
}
function showLiveDot(nt, b){
  if (EX.kind !== "gen") return;
  const dot = $("liveDot"); if (!dot) return;
  if (voiced == null){ dot.setAttribute("opacity","0"); return; }
  const { row, x } = posForBeat(b);
  dot.setAttribute("cx", x); dot.setAttribute("cy", traceY(nt, fold(voiced, nt.midi), row));
  dot.setAttribute("opacity","1");
}
const CONTROL_IDS = ["aBtn","keyBtn","firstBtn","hearBtn","newBtn"];

async function start(){
  if (RUN){ if (RUN.paused) resumeRun(); else pauseRun(); return; }
  if (!EX.notes.length){ showError(S.src === "piece" ? "Load a MusicXML score first, then press Start." : ""); return; }
  const along = EX.kind === "piece" ? alongList(false) : [];
  if (!(await ensureMic())) return;
  if (S.settingsOpen){ setSettingsOpen(false, true); }
  stopScheduled();
  resetMarks();
  EX.notes.forEach((_, i) => paintNote(i));
  drawTrace();
  curMark = -1;
  const sb = (EX.kind === "piece" && EX.startBeat) || 0;
  if (EX.kind === "piece" && !sb){ const pg = pageAtBeat(0) || (EX.notes[0] && EX.notes[0].page); if (pg) showPage(pg); markCurrent(0); showPos(0); }
  const beat = 60 / S.tempo, n = EX.countIn, t0 = ctx.currentTime + 0.15 + n*beat;
  RUN = { t0, beat, idx:-1, vi:0, gi:0, vpi:0, vk:0, b0:0, bleed:0, alongList:along, along:along.length > 0 };
  startClicks(-n);
  if (RUN.along) startPlayer(along, t0, beat, accBus);
  if (sb){ stopClicks(); stopPlayer(); RUN.paused = true; RUN.resumeAt = sb; resumeRun(); }
  updateRunButtons();
  CONTROL_IDS.forEach(id => $(id).disabled = true);
  paintNote(0);
}

function stop(msg){
  let html = "";
  if (RUN){
    if (!RUN.paused && ctx){
      // grade the notes you've finished singing before stopping
      const be = (ctx.currentTime - outLat() - RUN.t0 - LATENCY) / RUN.beat;
      EX.notes.forEach((n, i) => { if (!n.status && n.frames > 0 && n.start + n.beats <= be + 0.05) gradeTimed(i); });
    }
    takeSegment();
    html = summaryHTML(RUN.segments || [], RUN);
  }
  RUN = null; stopScheduled();
  updateRunButtons();
  CONTROL_IDS.forEach(id => $(id).disabled = false);
  setCount(""); setPlayhead(null);
  if (EX.kind === "piece"){ EX.notes.forEach(n => n.g && n.g.forEach(g => g.classList.remove("mk-current"))); curMark = -1; hideMarker(); }
  const dot = $("liveDot"); if (dot) dot.setAttribute("opacity","0");
  EX.notes.forEach((_, i) => paintNote(i));
  showFirstTarget();
  if (html) $("result").innerHTML = html;
  else if (msg) $("result").innerHTML = `<p class="sub">${msg}</p>`;
  if (EX.kind === "piece" && EX.startBeat) showPos(EX.startBeat);
}

// ---------- Start anywhere: tap a bar to start (or continue) from there ----------
function visitAtPoint(e){
  const pageEl = e.target.closest && e.target.closest('div[id^="osmdCanvasPage"]');
  if (!pageEl || !EX.geo || !EX.visits) return -1;
  const pg = pageNum(pageEl);
  const r = pageEl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  let best = -1, bestD = 1e9;
  EX.visits.forEach((v, i) => {
    const g = EX.geo[v.mi]; if (!g || g.page !== pg) return;
    if (y < g.top || y > g.top + g.h) return;
    const d = x < g.x ? g.x - x : x > g.x + g.w ? x - (g.x + g.w) : 0;
    // prefer the next time this bar comes round after where you are now (for repeats)
    const cur = RUN && RUN.t0 ? (ctx.currentTime - RUN.t0) / RUN.beat : -1;
    const score = d * 1000 + (v.start < cur ? 1 : 0);
    if (score < bestD){ bestD = score; best = i; }
  });
  return bestD < 30000 ? best : -1;
}
function showStartChip(){
  const on = EX.kind === "piece" && EX.startBeat > 0;
  $("startChip").hidden = !on;
  if (on){ const v = EX.visits.find(x => Math.abs(x.start - EX.startBeat) < 1e-6); $("startChipText").textContent = "Starting at bar " + (v ? PIECE.bars[v.mi].num : "?"); }
}
function jumpTo(i){
  const V = EX.visits; if (!V || !V[i]) return;
  const at = V[i].start;
  if (!RUN){
    EX.startBeat = at > 0 ? at : 0;
    showStartChip();
    const g = EX.geo[V[i].mi]; if (g) showPage(g.page);
    if (EX.startBeat) showPos(at); else hideMarker();
    let k = EX.notes.findIndex(n => n.start >= at - 1e-6); if (k < 0) k = 0;
    $("targetCap").textContent = "First note"; $("target").textContent = EX.notes[k] ? targetName(EX.notes[k]) : "–";
    return;
  }
  // during a run: keep what you've sung so far, then carry on from the new spot
  const running = !RUN.paused;
  if (running) pauseRun();
  takeSegment();
  EX.notes.forEach((n, j) => { if (n.status){ clearNote(n); paintNote(j); } });
  RUN.resumeAt = at;
  const g = EX.geo[V[i].mi]; if (g) showPage(g.page);
  showPos(at);
  EX.startBeat = at > 0 ? at : 0; showStartChip();
  if (running) resumeRun(); else setCount("Paused, will resume at bar " + PIECE.bars[V[i].mi].num);
}

// ---------- Changing settings while you sing ----------
// what the other parts play during this run, from the current play-along choices
function useAlong(){ RUN.alongList = alongList(false); RUN.along = RUN.alongList.length > 0; }
// the beat you're at
function runBeat(){ return RUN.paused ? RUN.resumeAt || 0 : (ctx.currentTime - RUN.t0) / RUN.beat; }
// Sound, pitch, play-along and headphones: re-schedule what's still to come from where you are now.
function refreshPlayback(){
  if (!RUN) return;
  if (EX.kind === "piece") useAlong();
  if (!RUN.paused) retime(true);
}
// Redrawing the score (Show, zoom, window size): the notes and the timing stay the same, so the
// music carries on; only the drawing, the page you're on and the current-note highlight are redone.
let renderMs = 1500;
function redrawDuringRun(){
  // drawing blocks the page for a moment: hand the next few seconds of music and clicks to the
  // audio engine first, so they play on time while the score is redrawn
  if (RUN && !RUN.paused){ const ahead = (renderMs * 1.5 + 1000) / 1000; pump(ahead); clickPump(ahead); }
  buildPiece(true, true);
  if (!RUN) return;
  const b = runBeat();
  const pg = pageAtBeat(Math.max(0, b)); if (pg) showPage(pg);
  const cur = curMark; curMark = -1;
  markCurrent(cur);
  showPos(Math.max(0, b));
}
// redraw the score where it is, e.g. at another size; while singing, the music carries on
function redraw(){ if (RUN) redrawDuringRun(); else buildPiece(true, true); }
// New music to sing (other bars, a new exercise): stop, apply, and start again from the top.
async function restartWith(apply){
  if (!RUN){ apply(); return; }
  stop();
  await apply();
  if (EX.kind === "piece"){ EX.startBeat = 0; showStartChip(); }
  start();
}

// The metronome is streamed a moment ahead, so switching it on/off or changing tempo applies at once.
// The count-in always clicks; after that it follows the Metronome setting.
let clickTimer = null;
function startClicks(fromBeat){
  stopClicks();
  if (!RUN) return;
  RUN.clickBeat = fromBeat;
  RUN.accents = new Set(EX.barStarts.map(x => Math.round(x*1000)));
  clickTimer = setInterval(clickPump, 40); clickPump();
}
function stopClicks(){ if (clickTimer){ clearInterval(clickTimer); clickTimer = null; } }
function clickPump(extra){
  if (!RUN || RUN.paused || !ctx){ stopClicks(); return; }
  const now = ctx.currentTime;
  while (RUN.clickBeat < EX.total - 1e-6){
    const k = RUN.clickBeat, t = RUN.t0 + k*RUN.beat;
    if (t > now + 0.25 + (extra || 0)) break;
    if (t >= now - 0.02){
      const b0 = RUN.b0 || 0;
      if (k < b0 - 1e-6) click(t, Math.abs(k - (b0 - EX.countIn)) < 1e-6);
      else if (S.clicks) click(t, RUN.accents.has(Math.round(k*1000)));
    }
    RUN.clickBeat = k + 1;
  }
}
// change tempo mid-run: keep the current position, re-time everything from here
function retime(force){
  if (!RUN || RUN.paused || !ctx) return;
  const now = ctx.currentTime, nb = 60 / S.tempo;
  if (!force && Math.abs(nb - RUN.beat) < 1e-6) return;
  const b = (now - RUN.t0) / RUN.beat;
  stopPlayer();
  for (const x of scheduled.slice()){ try { x.stop(0); } catch(e){} }
  silencePianos();
  RUN.t0 = now - b*nb; RUN.beat = nb;
  startClicks(Math.ceil(b - 1e-6));
  if (RUN.along){
    const list = RUN.alongList.filter(x => x.start + x.beats > b + 0.05)
      .map(x => x.start < b ? Object.assign({}, x, { start: b, beats: x.start + x.beats - b }) : x);
    startPlayer(list, RUN.t0, nb, accBus);
  }
}

function updateRunButtons(){
  const b = $("startBtn"), st = $("stopBtn");
  if (!RUN){ b.textContent = "Start"; b.classList.remove("stop"); st.hidden = true; }
  else if (RUN.paused){ b.textContent = "Resume"; b.classList.remove("stop"); st.hidden = false; }
  else { b.textContent = "Pause"; b.classList.add("stop"); st.hidden = false; }
}
// Pause keeps your place; Resume counts in again from the start of the bar where you paused
function pauseRun(){
  if (!RUN || RUN.paused) return;
  const now = ctx.currentTime;
  stopScheduled();
  const b = (now - RUN.t0) / RUN.beat;
  let rb = RUN.b0 || 0;
  if (b > rb) for (const bs of EX.barStarts) if (bs <= b + 1e-6 && bs >= rb) rb = bs;
  RUN.resumeAt = Math.min(rb, Math.max(0, EX.total - 1e-3));
  RUN.paused = true;
  setCount("Paused");
  updateRunButtons();
}
function resumeRun(){
  if (!RUN || !RUN.paused) return;
  ensureCtx();
  RUN.paused = false; setCount("");
  const notes = EX.notes, b0 = RUN.resumeAt || 0, beat = RUN.beat, n = EX.countIn;
  const t0 = ctx.currentTime + 0.15 + n*beat - b0*beat;
  let k = notes.findIndex(nt => nt.start >= b0 - 1e-6); if (k < 0) k = notes.length;
  for (let i = 0; i < k; i++) if (!notes[i].status && notes[i].frames > 0) gradeTimed(i);
  for (let i = k; i < notes.length; i++){ clearNote(notes[i]); paintNote(i); }
  const V = EX.visits || [];
  let vp = V.findIndex(v => v.start + v.dur > b0 + 1e-6); if (vp < 0) vp = V.length;
  Object.assign(RUN, { t0, b0, gi: k, vi: Math.min(k, notes.length - 1), idx: -1, vpi: vp, vk: 0 });
  if (EX.kind === "piece"){ const pg = pageAtBeat(b0); if (pg) showPage(pg); showPos(b0); }
  startClicks(b0 - n);
  if (RUN.along) startPlayer(RUN.alongList.filter(x => x.start >= b0 - 1e-6), t0, beat, accBus);
  if (EX.kind === "piece" && notes[k]){ curMark = -1; markCurrent(k); }
  updateRunButtons();
}

function stepRun(now){
  if (RUN.paused) return;
  const notes = EX.notes, N = notes.length;
  const ol = outLat();
  const b = (now - ol - RUN.t0) / RUN.beat;             // what you are hearing now
  const be = (now - ol - RUN.t0 - LATENCY) / RUN.beat;  // what the mic is hearing now
  if (b < RUN.b0){
    const n = Math.ceil(RUN.b0 - b);
    setCount(n <= EX.countIn ? "Count-in " + (EX.countIn + 1 - n) + " of " + EX.countIn : "");
    if (EX.kind === "piece") showPos(RUN.b0 || 0);
    const nx = notes[Math.min(RUN.gi, N - 1)];
    $("targetCap").textContent = "Get ready for"; $("target").textContent = nx ? targetName(nx) : "–";
    return;
  }
  setCount("");
  // grade notes the mic has finished hearing
  while (RUN.gi < N && notes[RUN.gi].start + notes[RUN.gi].beats <= be){
    if (!notes[RUN.gi].status) gradeTimed(RUN.gi);
    if (notes[RUN.gi].trace) notes[RUN.gi].trace.push(null);
    RUN.gi++;
  }
  if (be >= EX.total){ while (RUN.gi < N){ if (!notes[RUN.gi].status) gradeTimed(RUN.gi); RUN.gi++; } finish(); return; }
  // visual position
  while (RUN.vi < N - 1 && notes[RUN.vi].start + notes[RUN.vi].beats <= b) RUN.vi++;
  const vn = notes[RUN.vi];
  const inNote = b >= vn.start && b < vn.start + vn.beats;
  const newIdx = inNote ? RUN.vi : -1;
  if (newIdx !== RUN.idx){
    const prev = RUN.idx; RUN.idx = newIdx;
    if (prev >= 0) paintNote(prev);
    if (newIdx >= 0){ paintNote(newIdx); $("targetCap").textContent = "Sing"; $("target").textContent = targetName(vn); }
    else { $("targetCap").textContent = b < vn.start ? "Rest, then" : "Rest"; $("target").textContent = b < vn.start ? targetName(vn) : "–"; }
  }
  if (!inNote && b < vn.start){
    const cv = EX.visits && EX.visits[RUN.vk || 0], bl = (cv && cv.dur) || 4;
    const bars = Math.ceil((vn.start - b) / bl - 1e-6);
    $("targetCap").textContent = bars > 1 ? `Rest ${bars} bars, then` : "Rest, then";
  }
  if (EX.kind === "piece"){
    markCurrent(inNote ? RUN.vi : (b < vn.start ? RUN.vi : RUN.vi + 1));
    // turn about 0.4 s before the first bar of the next page (going by the bars, not only your notes)
    const lead = 0.4 / RUN.beat, V = EX.visits || [];
    while (RUN.vpi < V.length && V[RUN.vpi].start <= b + lead){
      const g = EX.geo[V[RUN.vpi].mi];
      if (g && g.page !== page) showPage(g.page);
      RUN.vpi++;
    }
    showPos(b);
  }
  else setPlayhead(b);
  // readings for the note the mic is hearing
  if (RUN.gi < N){
    const nt = notes[RUN.gi];
    if (be >= nt.start){
      const secIn = (be - nt.start) * RUN.beat, secDur = nt.beats * RUN.beat;
      const grace = Math.min(0.2*secDur, 0.18);
      if (secIn >= grace && secIn <= secDur - 0.03){
        nt.frames++;
        if (voiced != null) nt.readings.push(fold(voiced, nt.midi));
      }
      if (EX.kind === "gen"){
        if (voiced != null) nt.trace.push({ b: be, c: fold(voiced, nt.midi) });
        else if (nt.trace.length && nt.trace[nt.trace.length-1]) nt.trace.push(null);
      }
    }
  }
  if (inNote) showLiveDot(vn, b); else showLiveDot(vn, vn.start);
}

function centsLabel(c){ const r = Math.round(c); return (r > 0 ? "+" : r < 0 ? "−" : "±") + Math.abs(r) + "¢"; }

function gradeTimed(i){
  const nt = EX.notes[i], r = nt.readings;
  if (r.length < Math.max(2, nt.frames*0.25)){ nt.status = "silent"; nt.label = "—"; paintNote(i); return; }
  const med = median(r); nt.med = med;
  const inTune = r.filter(c => Math.abs(c) <= 40).length / r.length;
  if (Math.abs(med) >= 70){
    nt.status = "miss"; nt.label = "sang " + nameOf(nt.midi + Math.round(med/100), false);
  } else if (Math.abs(med) <= 30 && inTune >= 0.5){ nt.status = "good"; nt.label = centsLabel(med); }
  else if (Math.abs(med) <= 55){ nt.status = "close"; nt.label = centsLabel(med); }
  else { nt.status = "miss"; nt.label = centsLabel(med); }
  paintNote(i);
}

function moveText(i){
  const notes = EX.notes, n = notes[i], p = notes[i-1];
  if (EX.kind === "gen"){
    const step = n.deg - p.deg; if (step === 0) return null;
    return `${step > 0 ? "up" : "down"} a ${DIA_IV[Math.min(Math.abs(step),7)]} into note ${i+1}`;
  }
  const semis = n.midi - p.midi; if (semis === 0) return null;
  const a = Math.abs(semis), name = a <= 12 ? SEMI_IV[a] : "leap of " + a + " half steps";
  const art = name.startsWith("octave") ? "an" : "a";
  return `${semis > 0 ? "up" : "down"} ${art} ${name} in bar ${n.bar}`;
}

// Scoring covers what you actually sang: from where you started to where you stopped,
// kept separately for each part if you switched parts along the way.
function takeSegment(){
  if (!RUN) return;
  const notes = EX.notes, sung = [];
  notes.forEach((n, i) => {
    if (!n.status) return;
    sung.push({ status: n.status, med: n.med, bar: n.bar, move: (i > 0 && (n.status === "miss" || n.status === "close")) ? moveText(i) : null, first: i === 0 });
  });
  if (!sung.length) return;
  RUN.segments = RUN.segments || [];
  RUN.segments.push({ part: EX.kind === "piece" ? S.partName : "", notes: sung });
}
function summaryHTML(segs, run){
  const lines = [], all = [].concat(...segs.map(g => g.notes));
  if (!all.length) return "";
  const barsOf = ns => { const b = ns.map(n => n.bar).filter(x => x != null); return b.length ? (Math.min(...b) === Math.max(...b) ? "bar " + b[0] : "bars " + Math.min(...b) + "–" + Math.max(...b)) : ""; };
  const line = (ns, label) => {
    const good = ns.filter(n => n.status === "good").length;
    return `${label}${good} of ${ns.length} notes in tune (${Math.round(100*good/ns.length)}%)`;
  };
  if (segs.length === 1){
    const g = segs[0], where = barsOf(g.notes);
    lines.push(`<p>${line(g.notes, "")}${where ? ` <span class="sub">(${g.part ? g.part + ", " : ""}${where})</span>` : ""}.</p>`);
  } else {
    segs.forEach(g => lines.push(`<p>${line(g.notes, `<b>${g.part}</b>, ${barsOf(g.notes)}: `)}.</p>`));
  }
  const silent = all.filter(n => n.status === "silent").length;
  if (silent) lines.push(`<p class="sub">${silent} ${silent===1?"note":"notes"} had no clear pitch. Sing a little louder, move closer to the mic, or lower the tempo for fast passages.</p>`);
  const tuned = all.filter(n => (n.status === "good" || n.status === "close") && n.med != null);
  if (tuned.length >= 2){
    const avg = tuned.reduce((a, n) => a + n.med, 0) / tuned.length;
    if (avg > 8) lines.push(`<p class="sub">You leaned sharp, about ${Math.round(avg)} cents on average.</p>`);
    else if (avg < -8) lines.push(`<p class="sub">You leaned flat, about ${Math.round(-avg)} cents on average.</p>`);
    else lines.push(`<p class="sub">Your tuning was well centered on the notes you found.</p>`);
  }
  const hard = all.map(n => n.move).filter(Boolean);
  if (hard.length) lines.push(`<p class="sub">Moves to practice: ${hard.slice(0,4).join("; ")}${hard.length > 4 ? `, and ${hard.length-4} more` : ""}.</p>`);
  if (EX.kind === "piece"){
    const byBar = {};
    all.forEach(n => { if (n.status === "miss" || n.status === "silent") byBar[n.bar] = (byBar[n.bar] || 0) + 1; });
    const worst = Object.entries(byBar).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]).sort((a, b) => a - b);
    if (worst.length) lines.push(`<p class="sub">Bars with the most misses: ${worst.join(", ")}. Set From and To bar to loop them.</p>`);
  }
  if (run && run.along && !S.headphones && run.bleed > 30) lines.push(`<p class="sub">The mic picked up the play-along from your speakers, and those sounds were ignored. For the most reliable grading, use headphones and tick "I'm wearing headphones" in Settings.</p>`);
  const f = all.find(n => n.first);
  if (f && (f.status === "miss" || f.status === "close")) lines.push(`<p class="sub">The first note was off, so try Play first note before you start.</p>`);
  return lines.join("");
}
function finish(){ stop(); }

// ---------- Playback ----------
function playA(){ ensureCtx(); stopScheduled(); tone(EX.aMidi || 69, ctx.currentTime + 0.05, 1.6, 0.17); }
function playKey(){
  if (!EX.keyChord || !EX.keyChord.length) return;
  ensureCtx(); stopScheduled();
  const t = ctx.currentTime + 0.05;
  EX.keyChord.forEach(m => tone(m, t, 1.3, 0.11));
}
function playFirst(){
  if (!EX.notes.length) return;
  ensureCtx(); stopScheduled();
  tone(EX.notes[0].midi + EX.playShift, ctx.currentTime + 0.05, 1.4, 0.17);
}
function playMelody(){
  if (!EX.notes.length) return;
  ensureCtx();
  if (playingUntil){ stopScheduled(); return; }
  stopScheduled();
  const beat = 60 / S.tempo, t = ctx.currentTime + 0.08;
  if (EX.kind === "piece"){
    startPlayer(alongList(true), t, beat, accBus);
  } else EX.notes.forEach(n => tone(n.midi + EX.playShift, t + n.start*beat, Math.max(0.08, n.beats*beat*0.92)));
  playingUntil = t + EX.total*beat + 0.3;
  $("hearBtn").textContent = "Stop playback";
  hearTimer = setTimeout(() => { playingUntil = 0; $("hearBtn").textContent = "Hear the melody"; }, (EX.total*beat + 0.6)*1000);
}

// ---------- Sample scores (zipped MusicXML files in the "assets" folder, e.g. assets/bwv225.zip) ----------
const SAMPLES = {
  bwv225: { title: "Bach: Singet dem Herrn ein neues Lied, BWV 225", file: "bwv225.zip" },
  bwv228: { title: "Bach: Fürchte dich nicht, BWV 228", file: "bwv228.zip" },
  softvoices: { title: "Bridge: Music, when soft voices die", file: "music-when-soft-voices-die.mxl" },
  amner: { title: "Amner: Come, let's rejoice", file: "come-lets-rejoice-john-amner.mxl" },
  lewandowski: { title: "Lewandowski: Hallelujah", file: "hallelujah-louis-lewandowsky.mxl" }
};
async function fetchFile(url, name){
  const r = await fetch(url); if (!r.ok) throw new Error(r.status);
  return new File([await r.blob()], name);
}
// the page's link opens what you're singing: ?piece=…, ?chorale=… (see loadFromUrl)
function setLink(key, value){
  try { const u = new URL(location.href); ["piece", "chorale", "score"].forEach(k => u.searchParams.delete(k)); u.searchParams.set(key, value); history.replaceState(null, "", u); } catch(e){}
}
async function loadSample(key){
  const smp = SAMPLES[key]; if (!smp) return;
  const prev = $("fileName").textContent;
  $("fileName").textContent = "Opening " + smp.title + "…";
  let file;
  try { file = await fetchFile(ASSETS + smp.file, smp.file); }
  catch(e){ $("fileName").textContent = prev; libraryError(); return; }
  await loadFile(file);
  if (PIECE){ PIECE.fileName = smp.title; $("fileName").textContent = smp.title; }
  setLink("piece", key);
}
document.querySelectorAll("[data-sample]").forEach(b => b.addEventListener("click", () => { closeScoreMenu(); if (RUN) stop(); loadSample(b.dataset.sample); }));
function closeScoreMenu(){ $("scoreMenu").hidden = true; $("scoreMenuBtn").setAttribute("aria-expanded", "false"); }
$("scoreMenuBtn").addEventListener("click", e => {
  e.stopPropagation();
  const open = $("scoreMenu").hidden;
  $("scoreMenu").hidden = !open; $("scoreMenuBtn").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", e => { if (!e.target.closest || !e.target.closest("#topLoad")) closeScoreMenu(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeScoreMenu(); });
$("scoreMenu").querySelector(".fileinput").addEventListener("change", closeScoreMenu);
// ---------- Bach chorale library ----------
// Chorales live in the "assets" folder next to this page: assets/chorales.json lists them,
// and each chorale is its own MusicXML file (e.g. assets/bwv269.mxl). Add or fix files there.
const ASSETS = "assets/";
let CHORALES = null;       // [id, bwv, title, riemenschneider, file]
async function getChoraleIndex(){
  if (CHORALES) return CHORALES;
  const r = await fetch(ASSETS + "chorales.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("index " + r.status);
  const j = await r.json();
  const list = Array.isArray(j) ? j : j.chorales;
  CHORALES = list.map(c => [c.id, String(c.bwv), c.title || ("BWV " + c.bwv), c.riemenschneider || 0, c.file || (c.id + ".mxl")]);
  return CHORALES;
}
function choraleLabel(c){ return "Bach: " + c[2] + ", BWV " + c[1]; }
function libraryError(){
  showError(location.protocol === "file:"
    ? "The chorales are read from the assets folder next to this page, which browsers don't allow for pages opened straight from your disk. Open the page from your website (or a local web server) instead."
    : "The chorale library couldn't be loaded. Check that the assets folder (with chorales.json and the chorale files) sits next to this page.");
}
async function loadChorale(id){
  let list; try { list = await getChoraleIndex(); } catch(e){ libraryError(); return; }
  const c = list.find(x => x[0] === id); if (!c) return;
  closeChooser();
  $("fileName").textContent = "Opening " + c[2] + "…";
  let file;
  try { file = await fetchFile(ASSETS + c[4], c[4]); }
  catch(e){ $("fileName").textContent = PIECE ? PIECE.fileName : ""; libraryError(); return; }
  await loadFile(file);
  if (PIECE){ PIECE.fileName = choraleLabel(c); $("fileName").textContent = choraleLabel(c); }
  setLink("chorale", id);
}
let chooserBuilt = false;
async function openChooser(){
  if (RUN) stop();
  closeScoreMenu();
  if (!CHORALES){
    try { await getChoraleIndex(); } catch(e){ libraryError(); return; }
  }
  if (!chooserBuilt){
    $("chList").innerHTML = CHORALES.map(c => `<button type="button" class="chitem" data-ch="${c[0]}"><span class="n">BWV ${esc(c[1])}</span><span class="t">${esc(c[2])}</span>${c[3] ? `<span class="r">R ${c[3]}</span>` : ""}</button>`).join("");
    $("chList").addEventListener("click", e => { const b = e.target.closest("[data-ch]"); if (b) loadChorale(b.dataset.ch); });
    chooserBuilt = true;
  }
  $("chooser").hidden = false; filterChorales();
  setTimeout(() => $("chSearch").focus(), 30);
}
function closeChooser(){ $("chooser").hidden = true; }
function filterChorales(){
  const q = $("chSearch").value.trim().toLowerCase().replace(/^bwv\s*/, "");
  const rq = q.match(/^r\s*(\d+)$/);
  let shown = 0;
  $("chList").querySelectorAll(".chitem").forEach(b => {
    const c = CHORALES.find(x => x[0] === b.dataset.ch);
    const ok = !q || (rq ? String(c[3]) === rq[1] : (c[2].toLowerCase().includes(q) || c[1].startsWith(q)));
    b.hidden = !ok; if (ok) shown++;
  });
  $("chCount").textContent = shown === CHORALES.length ? CHORALES.length + " chorales" : shown + " of " + CHORALES.length;
}
document.querySelectorAll("[data-open-chorales]").forEach(b => b.addEventListener("click", openChooser));
$("chClose").addEventListener("click", closeChooser);
$("chSearch").addEventListener("input", filterChorales);
$("chSearch").addEventListener("keydown", e => {
  if (e.key === "Escape") closeChooser();
  if (e.key === "Enter"){ const first = $("chList").querySelector(".chitem:not([hidden])"); if (first) loadChorale(first.dataset.ch); }
});

// ?piece=bwv225 opens a sample; ?chorale=bwv66.6 opens a chorale; ?score=path/to/file.musicxml (or .mxl/.zip) loads a score from the same site
async function loadFromUrl(){
  let q; try { q = new URLSearchParams(location.search); } catch(e){ return; }
  const piece = q.get("piece"), score = q.get("score");
  if (piece && SAMPLES[piece]) return loadSample(piece);
  const ch = q.get("chorale");
  if (ch) return loadChorale(ch);
  if (score){
    try { await loadFile(await fetchFile(score, decodeURIComponent(score.split("/").pop().split("?")[0]) || "score.musicxml")); }
    catch(e){ showError("The score at " + score + " couldn't be loaded. Check that the file exists next to this page."); }
  }
}

// ---------- Wiring ----------
function newExercise(){ generate(); renderGen(); }
function onSetting(){
  S.key = $("key").value; S.clef = $("clef").value; S.diff = $("diff").value;
  S.measures = +$("measures").value; S.tempo = +$("tempo").value; S.clicks = $("clicks").checked;
  $("tempoVal").textContent = S.tempo;
  saveSettings();
}
function setSource(src){
  if (RUN) stop();
  S.src = src;
  const piece = src === "piece";
  $("genSettings").hidden = piece; $("pieceSettings").hidden = !piece;
  $("genView").hidden = piece; $("pieceView").hidden = !piece;
  $("newBtn").hidden = piece;
  $("hearBtn").hidden = piece;
  $("topLoad").hidden = !(piece && PIECE);
  updatePager(); syncTop();
  $("result").innerHTML = ""; showError("");
  if (piece){
    if (PIECE) buildPiece(false, true);
    else { EX = noPiece(); showFirstTarget(); }
    loadOSMDLib().catch(() => {});
  } else newExercise();
}
["key","clef","diff","measures"].forEach(id => $(id).addEventListener("change", () => restartWith(() => { onSetting(); newExercise(); })));
$("tempo").addEventListener("input", () => setTempo(+$("tempo").value));
$("clicks").addEventListener("change", () => setClicks($("clicks").checked));
document.querySelectorAll("input[name=src]").forEach(el => el.addEventListener("change", () => setSource(el.value)));
document.querySelectorAll(".fileinput").forEach(inp => inp.addEventListener("change", e => { loadFile(e.target.files[0]); e.target.value = ""; }));
function partChanged(){
  const mode = $("topAlong").value; // keep "all other parts" meaning all others of the new part
  const rebuild = () => {
    buildPiece(true);
    if (PIECE && (mode === "all" || mode === "allguide")){ const mine = +$("part").value || 0; S.along = PIECE.parts.filter((_, i) => i !== mine); saveSettings(); }
    renderAlong();
  };
  if (!RUN){ rebuild(); return; }
  // switching parts while singing: keep your place (score so far is kept per part)
  const running = !RUN.paused;
  if (running) pauseRun();
  takeSegment();
  const segs = RUN.segments, pos = RUN.resumeAt;
  rebuild();
  RUN.segments = segs;
  useAlong();
  RUN.resumeAt = pos || 0;
  if (running) resumeRun(); else { updateRunButtons(); setCount("Paused"); }
}
$("part").addEventListener("change", partChanged);
$("topPart").addEventListener("change", () => { $("part").value = $("topPart").value; partChanged(); });
$("topAlong").addEventListener("change", () => {
  const v = $("topAlong").value;
  if (!PIECE) return;
  if (v === "custom"){ if (!S.settingsOpen) setSettingsOpen(true); syncTop(); return; }
  const mine = +$("part").value || 0;
  const others = PIECE.parts.filter((_, i) => i !== mine);
  S.along = v === "none" ? [] : others.slice();
  S.guide = v === "allguide";
  S.alongChosen = true;
  saveSettings(); renderAlong(); refreshPlayback();
});
$("aRef").addEventListener("change", () => {
  S.aRef = +$("aRef").value; saveSettings(); $("aBtn").title = "Play A (" + S.aRef + " Hz)";
  for (const set of [pianos, spare]) if (set) for (const p of set.by.values()) p.setDetune(pianoDetune());
  refreshPlayback();
});
const warmPiano = () => { if (S.sound === "piano") loadPiano(); };
document.addEventListener("pointerdown", warmPiano, { once: true, capture: true });
document.addEventListener("keydown", warmPiano, { once: true, capture: true });
$("sound").addEventListener("change", () => {
  S.sound = $("sound").value; saveSettings();
  if (ctx) applySoundFx();
  if (S.sound === "piano") loadPiano(); else setSoundNote("");
  refreshPlayback();
});
$("aBtn").title = "Play A (" + (S.aRef || 440) + " Hz)";
$("phones").addEventListener("change", () => { S.headphones = $("phones").checked; saveSettings(); refreshPlayback(); });
$("ecBox").addEventListener("change", () => { S.ec = $("ecBox").checked; saveSettings(); if (analyser) ensureMic(); });
$("micSel").addEventListener("change", () => { S.micId = $("micSel").value; saveSettings(); if (analyser) ensureMic(); });
["fromBar","toBar"].forEach(id => $(id).addEventListener("change", () => restartWith(rebuildNow)));
$("topRange").addEventListener("change", () => {
  const v = $("topRange").value;
  if (v === "custom"){ if (!S.settingsOpen) setSettingsOpen(true); $("fromBar").focus(); return; }
  const [a, b] = v.split("-").map(Number);
  $("fromBar").value = PIECE.bars[a].num; $("toBar").value = PIECE.bars[b].num;
  restartWith(rebuildNow);
});
$("view").addEventListener("change", () => { S.view = $("view").value; $("fadeField").classList.toggle("disabled", S.view === "part"); saveSettings(); if (RUN) redrawDuringRun(); else buildPiece(true); });
$("fade").addEventListener("change", () => { S.fade = $("fade").checked; saveSettings(); applyFade(); });
$("fadeField").classList.toggle("disabled", S.view === "part");
function showSettings(open){
  S.settingsOpen = open; saveSettings();
  $("settingsPanel").hidden = !open;
  $("settingsBtn").setAttribute("aria-expanded", String(open));
  $("settingsBtn").textContent = open ? "Hide settings" : "Settings";
}
// opening or closing Settings changes the room for the score, so it's redrawn to fit
function setSettingsOpen(open, sync){
  showSettings(open);
  if (S.src === "piece" && PIECE){
    if (sync) redraw(); else requestAnimationFrame(redraw);
  } else if (S.src === "gen") renderGen();
}
$("settingsBtn").addEventListener("click", () => setSettingsOpen(!S.settingsOpen));
$("prevPage").addEventListener("click", () => turn(-1));
$("nextPage").addEventListener("click", () => turn(1));
$("tapPrev").addEventListener("click", () => turn(-1));
$("tapNext").addEventListener("click", () => turn(1));
function zoomBy(f){
  S.zoomAdj = Math.max(0.5, Math.min(2.2, (S.zoomAdj || 1) * f)); saveSettings();
  if (PIECE) redraw();
}
$("zoomOut").addEventListener("click", () => zoomBy(1/1.15));
$("startChipX").addEventListener("click", () => { EX.startBeat = 0; showStartChip(); if (!RUN) hideMarker(); });
$("score").addEventListener("click", e => {
  if (S.src !== "piece" || !PIECE || !EX.visits) return;
  const i = visitAtPoint(e); if (i >= 0) jumpTo(i);
});
$("zoomIn").addEventListener("click", () => zoomBy(1.15));
let tx = null;
$("pieceView").addEventListener("touchstart", e => { tx = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive:true });
$("pieceView").addEventListener("touchend", e => {
  if (tx == null) return;
  const dx = e.changedTouches[0].clientX - tx; tx = null;
  if (Math.abs(dx) > 50) turn(dx < 0 ? 1 : -1);
}, { passive:true });
$("startBtn").addEventListener("click", start);
$("stopBtn").addEventListener("click", () => stop("Stopped. Press Start to begin again."));
// each volume has a slider in Settings (with a % label) and one at the bottom of the screen
const VOLS = { alongVol: ["dAlongVol", () => accBus], guideVol: ["dGuideVol", () => guideBus], clickVol: ["dClickVol", () => clickBus] };
function setVol(key, v){
  const [dock, bus] = VOLS[key];
  S[key] = v; $(key).value = v; $(dock).value = v; $(key + "Val").textContent = v + "%";
  if (bus()) bus().gain.value = v/100;
  saveSettings();
}
if (!(S.clickVol >= 0 && S.clickVol <= 100)) S.clickVol = 50;
for (const key in VOLS){
  setVol(key, S[key]);
  for (const id of [key, VOLS[key][0]]) $(id).addEventListener("input", () => setVol(key, +$(id).value));
}
let retimeT = null;
function setTempo(v){
  S.tempo = v; $("tempo").value = v; $("dTempo").value = v; $("tempoVal").textContent = v; $("dTempoVal").textContent = v; saveSettings();
  clearTimeout(retimeT); retimeT = setTimeout(retime, 120);
}
function setClicks(on){ S.clicks = on; $("clicks").checked = on; $("dClicks").checked = on; saveSettings(); }
$("dTempo").value = S.tempo; $("dTempoVal").textContent = S.tempo; $("dClicks").checked = S.clicks;
$("dTempo").addEventListener("input", () => setTempo(+$("dTempo").value));
$("dClicks").addEventListener("change", () => setClicks($("dClicks").checked));
$("aBtn").addEventListener("click", playA);
$("keyBtn").addEventListener("click", playKey);
$("firstBtn").addEventListener("click", playFirst);
$("hearBtn").addEventListener("click", playMelody);
$("newBtn").addEventListener("click", newExercise);
document.addEventListener("keydown", e => {
  if (e.target.closest && e.target.closest("select, input, button")) return;
  if (e.code === "Space"){ e.preventDefault(); start(); }
  else if (e.key === "Escape" && RUN){ stop("Stopped. Press Start to begin again."); }
  else if (e.key === "n" && !RUN && S.src === "gen") newExercise();
  else if (e.key === "ArrowRight" || e.key === "PageDown"){ e.preventDefault(); turn(1); }
  else if (e.key === "ArrowLeft" || e.key === "PageUp"){ e.preventDefault(); turn(-1); }
});
let rt = null, rtBox = null;
if (window.ResizeObserver) new ResizeObserver(() => { clearTimeout(rtBox); rtBox = setTimeout(() => {
  const box = $("pieceView");
  if (S.src === "piece" && OSMD && PIECE && box.clientHeight > 0 && box.clientWidth + "x" + box.clientHeight !== lastBox) redraw();
}, 250); }).observe($("pieceView"));
window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => {
  if (S.src === "gen"){
    const w = $("staff").parentElement.clientWidth;
    const want = (S.measures > 2 && w < 760) ? 2 : S.measures;
    if (want !== perRow) renderGen();
  } else if (OSMD && PIECE){
    const box = $("pieceView");
    if (box.clientWidth + "x" + box.clientHeight !== lastBox) redraw();
  }
}, 250); });

onSetting();
setTimeout(loadFromUrl, 0);
setSource("piece");
})();
