/* F.A.S.P.A.S shared question bank loader + exam picker.
   Reads the questions straight from the deployed subject pages (physics.html etc.),
   so when you update a subject page, Full CBT and Revise pick it up automatically.
   KEEP the subject pages' structure: `var SUBJECT_BANK = [ ... ]`, optional
   `SUBJECT_BANK.push(...)`, `var PASSAGES = {...}` (English), `var IMG = {...}` (Chemistry). */
(function (root) {
  'use strict';

  var SUBJECTS = {
    english:   { label: 'Use of English', file: 'english.html',   count: 60 },
    math:      { label: 'Mathematics',    file: 'math.html',      count: 40 },
    physics:   { label: 'Physics',        file: 'physics.html',   count: 40 },
    chemistry: { label: 'Chemistry',      file: 'chemistry.html', count: 40 },
    biology:   { label: 'Biology',        file: 'biology.html',   count: 40 }
  };

  /* ---------- extraction from page source ---------- */
  function matchEnd(s, i) {
    var depth = 0;
    for (var k = i; k < s.length; k++) {
      var c = s[k];
      if (c === '"' || c === "'" || c === '`') {
        var q = c; k++;
        while (k < s.length && s[k] !== q) { if (s[k] === '\\') k++; k++; }
        continue;
      }
      if (c === '/' && s[k + 1] === '/') { while (k < s.length && s[k] !== '\n') k++; continue; }
      if (c === '/' && s[k + 1] === '*') { k = s.indexOf('*/', k + 2) + 1; if (k === 0) return -1; continue; }
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') { depth--; if (depth === 0) return k; }
    }
    return -1;
  }

  function parseSubjectPage(subject, html) {
    var code = '', m, o, e, name;
    ['IMG', 'PASSAGES'].forEach(function (n) {
      m = html.indexOf('var ' + n + ' = ');
      if (m >= 0) {
        o = html.indexOf('{', m); e = matchEnd(html, o);
        if (e > 0) code += 'var ' + n + '=' + html.slice(o, e + 1) + ';\n';
      }
    });
    m = html.indexOf('var SUBJECT_BANK = [');
    if (m < 0) throw new Error('bank not found in ' + subject);
    o = html.indexOf('[', m); e = matchEnd(html, o);
    if (e < 0) throw new Error('bank not closed in ' + subject);
    code += 'var SUBJECT_BANK=' + html.slice(o, e + 1) + ';\n';
    var p = e;
    while ((p = html.indexOf('SUBJECT_BANK.push(', p)) >= 0) {
      var o2 = html.indexOf('(', p), e2 = matchEnd(html, o2);
      if (e2 < 0) break;
      code += html.slice(p, e2 + 1) + ';\n';
      p = e2;
    }
    var r = new Function(code + ';return {b:SUBJECT_BANK,P:(typeof PASSAGES!=="undefined"?PASSAGES:{}),I:(typeof IMG!=="undefined"?IMG:{})}')();
    return cleanBank(subject, r.b, r.P, r.I);
  }

  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(36);
  }

  function cleanBank(subject, raw, passages, imgs) {
    var out = [], seen = {};
    raw.forEach(function (q) {
      if (!q || !q.q || !q.options || q.options.length !== 4) return;
      if (!(q.correct >= 0 && q.correct < 4)) return;
      if (q.needsImage && !q.diagramSrc) return;           // same rule as the biology page
      if (/^\[Diagram\/unreadable/.test(q.q)) return;
      var id = subject.slice(0, 3) + '_' + fnv(q.q + '|' + q.options.join('|') + '|' + (q.year || ''));
      if (seen[id]) return; seen[id] = 1;
      var c = {};
      for (var k in q) c[k] = q[k];
      c.id = id; c.subject = subject;
      if (!c.img && c.diagramSrc) c.imgSrc = c.diagramSrc;
      out.push(c);
    });
    return { subject: subject, bank: out, passages: passages || {}, imgs: imgs || {} };
  }

  var cache = {};
  function load(subject) {
    if (cache[subject]) return cache[subject];
    var file = SUBJECTS[subject].file;
    cache[subject] = fetch(file, { cache: 'no-cache' })
      .then(function (r) { if (!r.ok) throw new Error('load ' + file); return r.text(); })
      .then(function (t) { return parseSubjectPage(subject, t); })
      .catch(function (err) { delete cache[subject]; throw err; });
    return cache[subject];
  }

  /* ---------- random helpers ---------- */
  function rnd() { return Math.random(); }
  function shuffle(a) {
    a = a.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ---------- seen memory ---------- */
  function seenKey(s) { return 'faspas_seen_' + s; }
  function getSeen(s) { try { return JSON.parse(localStorage.getItem(seenKey(s)) || '{}'); } catch (e) { return {}; } }
  function markSeen(s, ids) {
    try {
      var m = getSeen(s);
      ids.forEach(function (id) { m[id] = Math.min(3, (m[id] || 0) + 1); });
      var keys = Object.keys(m);
      if (keys.length > 4000) { keys.slice(0, keys.length - 4000).forEach(function (k) { delete m[k]; }); }
      localStorage.setItem(seenKey(s), JSON.stringify(m));
    } catch (e) {}
  }

  /* ---------- weighted picking ---------- */
  function recentYears(bank) {
    var ys = {};
    bank.forEach(function (q) { if (q.year) ys[q.year] = 1; });
    var arr = Object.keys(ys).map(Number).sort(function (a, b) { return b - a; });
    var set = {}; arr.slice(0, 5).forEach(function (y) { set[y] = 1; });
    return set;
  }

  function pickWeighted(items, n, seen, recent) {
    var chosen = [], yearCount = {}, pool = items.slice();
    while (chosen.length < n && pool.length) {
      var ws = pool.map(function (q) {
        var w = 1;
        if (q.year && recent[q.year]) w *= 2;
        w *= Math.pow(0.4, seen[q.id] || 0);
        if (q.year) w *= Math.pow(0.6, yearCount[q.year] || 0);
        return Math.max(w, 0.001);
      });
      var tot = ws.reduce(function (a, b) { return a + b; }, 0), r = rnd() * tot, i = 0;
      for (; i < ws.length - 1; i++) { r -= ws[i]; if (r <= 0) break; }
      var q = pool.splice(i, 1)[0];
      chosen.push(q);
      if (q.year) yearCount[q.year] = (yearCount[q.year] || 0) + 1;
    }
    return chosen;
  }

  /* topic-proportional slots with randomised largest remainder */
  function allocate(groups, n) {
    var names = Object.keys(groups), total = 0;
    names.forEach(function (t) { total += groups[t].length; });
    var slots = {}, rem = [], used = 0;
    names.forEach(function (t) {
      var exact = n * groups[t].length / total, f = Math.floor(exact);
      slots[t] = f; used += f; rem.push({ t: t, r: exact - f + rnd() * 0.5 });
    });
    rem.sort(function (a, b) { return b.r - a.r; });
    for (var i = 0; used < n && i < rem.length; i++, used++) slots[rem[i].t]++;
    return slots;
  }

  function groupBy(items, fn) {
    var g = {};
    items.forEach(function (q) { var k = fn(q); (g[k] = g[k] || []).push(q); });
    return g;
  }

  /* English: fixed blueprint, passage questions stay together as blocks */
  var ENGLISH_PLAN = [
    { key: 'Lexis & Structure', n: 15 },
    { key: 'Synonyms', n: 5 },
    { key: 'Antonyms', n: 5 },
    { key: 'Comprehension', n: 15, passage: true },
    { key: 'Comprehension (Cloze)', n: 5, passage: true },
    { key: 'Oral', n: 10, oral: true },
    { key: 'Novel', n: 5, novel: true }
  ];
  var ORAL_SPLIT = { 'Vowel Sounds': 3, 'Consonant Sounds': 2, 'Rhymes': 1, 'Stress': 2, 'Emphatic Stress': 2 };

  function pickPassageBlocks(items, n, seen, recent) {
    var blocks = groupBy(items.filter(function (q) { return q.p; }), function (q) { return q.p; });
    var keys = shuffle(Object.keys(blocks)), out = [], got = 0, tries = 0;
    // prefer blocks never seen, recent years
    keys.sort(function (a, b) {
      function sc(k) {
        var qs = blocks[k], s = 0, r = 0;
        qs.forEach(function (q) { s += (seen[q.id] || 0); if (q.year && recent[q.year]) r++; });
        return (s / qs.length) - (r / qs.length) * 0.5 + rnd() * 0.8;
      }
      return sc(a) - sc(b);
    });
    for (var i = 0; i < keys.length && got < n; i++) {
      var qs = blocks[keys[i]].slice();
      if (got + qs.length > n + 1 && tries < 6) { tries++; continue; }
      if (got + qs.length > n) qs = qs.slice(0, n - got);
      out.push(qs); got += qs.length;
    }
    if (got < n) { // top up with loose questions of same kind
      var loose = items.filter(function (q) { return !q.p; });
      pickWeighted(loose, n - got, seen, recent).forEach(function (q) { out.push([q]); });
    }
    return out;
  }

  function pickEnglish(L) {
    var seen = getSeen('english'), bank = L.bank, recent = recentYears(bank), units = [];
    var byTopic = groupBy(bank, function (q) { return q.topic; });
    ENGLISH_PLAN.forEach(function (pl) {
      if (pl.passage) {
        pickPassageBlocks(byTopic[pl.key] || [], pl.n, seen, recent).forEach(function (u) { units.push(u); });
      } else if (pl.oral) {
        Object.keys(ORAL_SPLIT).forEach(function (k) {
          pickWeighted(byTopic['Oral English — ' + k] || [], ORAL_SPLIT[k], seen, recent).forEach(function (q) { units.push([q]); });
        });
      } else if (pl.novel) {
        var nov = [];
        Object.keys(byTopic).forEach(function (t) { if (t.indexOf('The Lekki Headmaster') === 0) nov = nov.concat(byTopic[t]); });
        pickWeighted(nov, pl.n, seen, recent).forEach(function (q) { units.push([q]); });
      } else {
        pickWeighted(byTopic[pl.key] || [], pl.n, seen, recent).forEach(function (q) { units.push([q]); });
      }
    });
    return units;
  }

  function pickGeneric(L, n) {
    var seen = getSeen(L.subject), recent = recentYears(L.bank);
    var groups = groupBy(L.bank, function (q) { return q.topic || 'General'; });
    var slots = allocate(groups, n), chosen = [];
    Object.keys(slots).forEach(function (t) {
      pickWeighted(groups[t], slots[t], seen, recent).forEach(function (q) { chosen.push(q); });
    });
    if (chosen.length < n) { // topics too small: top up
      var have = {}; chosen.forEach(function (q) { have[q.id] = 1; });
      var rest = L.bank.filter(function (q) { return !have[q.id]; });
      chosen = chosen.concat(pickWeighted(rest, n - chosen.length, seen, recent));
    }
    return chosen.map(function (q) { return [q]; });
  }

  /* ---------- balanced answer positions ---------- */
  var LET = ['A', 'B', 'C', 'D'];
  var FIXED_RE = /(all of (the )?(above|these)|none of (the )?(above|these)|both\s|\bboth$|neither|\b[A-D]\s*(and|&|,)\s*[A-D]\b|i and ii|ii and iii|i,? ii|only i\b)/i;

  function isFixed(q) {
    if (q.fix) return true;
    for (var i = 0; i < q.options.length; i++) if (FIXED_RE.test(String(q.options[i]))) return true;
    return false;
  }

  function remapExplanation(text, map) {
    if (!text) return text;
    return String(text)
      .replace(/\b((?:option|options|answer|choice)\s+)\(?([A-D])\)?/gi, function (m, pre, l) {
        var u = l.toUpperCase(); return pre + (map[u] || u);
      })
      .replace(/\(([A-D])\)/g, function (m, l) { return '(' + (map[l] || l) + ')'; });
  }

  function balanceTargets(count) {
    var base = Math.floor(count / 4), extra = count % 4, arr = [];
    var order = shuffle([0, 1, 2, 3]);
    for (var i = 0; i < 4; i++) for (var k = 0; k < base + (i < extra ? 1 : 0); k++) arr.push(order[i]);
    for (var t = 0; t < 60; t++) {
      arr = shuffle(arr);
      var run = 1, ok = true;
      for (var j = 1; j < arr.length; j++) { run = arr[j] === arr[j - 1] ? run + 1 : 1; if (run > 3) { ok = false; break; } }
      if (ok) break;
    }
    return arr;
  }

  /* units: array of [q,...]; returns flat list with shuffled option order */
  function arrange(units, L) {
    units = shuffle(units);
    var flat = [];
    units.forEach(function (u) { u.forEach(function (q) { flat.push(q); }); });
    var movable = flat.filter(function (q) { return !isFixed(q); });
    var fixedCount = [0, 0, 0, 0];
    flat.forEach(function (q) { if (isFixed(q)) fixedCount[q.correct]++; });
    // targets for movable ones, balanced overall (fixed ones counted first)
    var total = flat.length, want = [0, 0, 0, 0], per = Math.floor(total / 4), extra = total % 4;
    var order = shuffle([0, 1, 2, 3]);
    for (var i = 0; i < 4; i++) want[order[i]] = per + (i < extra ? 1 : 0);
    var targets = [];
    for (var d = 0; d < 4; d++) { var c = Math.max(0, want[d] - fixedCount[d]); for (var k = 0; k < c; k++) targets.push(d); }
    while (targets.length < movable.length) targets.push(Math.floor(rnd() * 4));
    targets = shuffle(targets).slice(0, movable.length);
    var ti = 0;
    return flat.map(function (q) {
      if (isFixed(q)) return applyOrder(q, [0, 1, 2, 3]);
      var tgt = targets[ti++], others = [];
      for (var x = 0; x < 4; x++) if (x !== q.correct) others.push(x);
      others = shuffle(others);
      var newOrder = [], oi = 0; // newOrder[newPos] = oldIdx
      for (var pos = 0; pos < 4; pos++) newOrder.push(pos === tgt ? q.correct : others[oi++]);
      return applyOrder(q, newOrder);
    });
  }

  /* ord[newPos] = oldIdx. Saved with the session so a resumed exam looks identical. */
  function applyOrder(q, ord) {
    var o = {};
    for (var k in q) o[k] = q[k];
    var map = {};
    ord.forEach(function (oldIdx, newPos) { map[LET[oldIdx]] = LET[newPos]; });
    o.ord = ord.slice();
    o.options = ord.map(function (oldIdx) { return q.options[oldIdx]; });
    o.correct = ord.indexOf(q.correct);
    if (ord.join() !== '0,1,2,3') o.explanation = remapExplanation(q.explanation, map);
    return o;
  }

  /* rebuild a saved paper: items = [{id, ord}] */
  function rebuild(L, items) {
    var byId = {};
    L.bank.forEach(function (q) { byId[q.id] = q; });
    var out = [];
    items.forEach(function (it) { if (byId[it.id]) out.push(applyOrder(byId[it.id], it.ord)); });
    return out;
  }

  /* ---------- public: build one subject's paper ---------- */
  function buildPaper(L) {
    var units = L.subject === 'english' ? pickEnglish(L) : pickGeneric(L, SUBJECTS[L.subject].count);
    var list = arrange(units, L);
    markSeen(L.subject, list.map(function (q) { return q.id; }));
    return list;
  }

  /* ---------- rendering helpers (mirrors the subject pages) ---------- */
  function rich(s, imgs, small) {
    return String(s == null ? '' : s).replace(/\{\{IMG:(\w+)\}\}/g, function (m, n) {
      var d = imgs && imgs[n];
      if (!d) return '';
      return '<img src="' + d + '" alt="figure" draggable="false" style="display:block;margin:8px auto;max-width:' +
        (small ? '210px' : '100%') + ';height:auto;background:#fff;border-radius:6px;pointer-events:none">';
    });
  }

  var api = {
    SUBJECTS: SUBJECTS, load: load, parseSubjectPage: parseSubjectPage, buildPaper: buildPaper,
    rich: rich, rebuild: rebuild, applyOrder: applyOrder, getSeen: getSeen, shuffle: shuffle, isFixed: isFixed, _pickGeneric: pickGeneric, _pickEnglish: pickEnglish, _arrange: arrange
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FaspasBank = api;
})(typeof window !== 'undefined' ? window : globalThis);
