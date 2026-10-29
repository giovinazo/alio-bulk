// 알리오 일괄 내려받기 — 화면 로직.
// 알리오 호출은 전부 같은 사이트의 중계 함수(/api/alio)를 거친다. 파일은 브라우저가 받아
// ZIP 으로 묶어 저장하거나(스트리밍) 폴더에 바로 쓴다.
import { makeZip, downloadZip } from './vendor/client-zip.js';

const API = '/api/alio';
const KIND = {
  regular: { label: '정기', title: '정기공시: 현재 공시된 보고서 PDF와 부속 첨부' },
  susi: { label: '수시', title: '수시공시: 기관별 글의 PDF와 첨부' },
  board: { label: '게시판', title: '게시판형: 글마다 첨부파일과 본문·링크 텍스트' },
  rule: { label: '규정', title: '내부규정: 규정마다 최신 파일' },
};
const MAX_LIST_PAGES = 30; // 수시·게시판 "전체" 범위에서 기관·항목당 훑는 최대 쪽수(10건/쪽)
// 한 번 실행에 받는 용량 상한(2GB). 넘으면 받은 것까지 저장하고 멈춘다.
// 주소에 ?limitMB=N 을 붙이면 상한을 낮출 수만 있다(시험용, 올릴 수는 없음).
const RUN_LIMIT_BYTES = Math.min(2 * 1024 ** 3, (Number(new URLSearchParams(location.search).get('limitMB')) || Infinity) * 1024 ** 2);
const LS_KEY = 'alio-bulk.v1';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const forceBlob = new URLSearchParams(location.search).has('blob');

const state = {
  items: [],
  organs: [],
  selItems: new Set(),
  selOrgans: new Set(),
  filteredOrgans: [],
  running: false,
  abort: null,
  ctx: null,
  failures: [],
  logLines: [],
};

// ─────────────────────────────────────────────────────────────
// 작은 도구
// ─────────────────────────────────────────────────────────────

function san(name, max = 120) {
  let s = String(name ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+|\.+$/g, '');
  if (!s) s = '이름없음';
  if (s.length > max) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 8 ? s.slice(dot) : '';
    s = s.slice(0, max - ext.length).trim() + ext;
  }
  return s;
}
function dateKey(d) {
  const m = String(d ?? '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
function yearOf(d) {
  const m = String(d ?? '').match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}
function fmtElapsed(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}
function isAbort(e) {
  return e?.name === 'AbortError';
}
function abortError() {
  return new DOMException('중지', 'AbortError');
}

async function runLimited(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** 생산자(내려받기)와 소비자(ZIP 쓰기) 사이의 작은 대기열. limit 를 넘으면 생산자가 기다린다. */
class AsyncQueue {
  constructor(limit) {
    this.limit = limit;
    this.buf = [];
    this.waitPull = [];
    this.waitPush = [];
    this.closed = false;
    this.cancelled = false;
  }
  _wake(list) {
    for (const r of list.splice(0)) r();
  }
  async push(v) {
    while (this.buf.length >= this.limit && !this.cancelled) await new Promise((r) => this.waitPush.push(r));
    if (this.cancelled) return;
    this.buf.push(v);
    this._wake(this.waitPull);
  }
  pushNow(v) {
    if (this.cancelled) return;
    this.buf.push(v);
    this._wake(this.waitPull);
  }
  close() {
    this.closed = true;
    this._wake(this.waitPull);
  }
  cancel() {
    this.cancelled = true;
    this.closed = true;
    this.buf = [];
    this._wake(this.waitPull);
    this._wake(this.waitPush);
  }
  async *iterate() {
    try {
      for (;;) {
        if (this.buf.length) {
          const v = this.buf.shift();
          this._wake(this.waitPush);
          yield v;
          continue;
        }
        if (this.closed) return;
        await new Promise((r) => this.waitPull.push(r));
      }
    } finally {
      this.cancel();
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 중계 함수 호출
// ─────────────────────────────────────────────────────────────

function httpError(res, body) {
  const err = new Error(body?.message || `HTTP ${res.status}`);
  err.status = res.status;
  err.code = body?.error;
  return err;
}
const noRetry = (e) => e.status && e.status < 500 && e.status !== 429;

async function api(op, params = {}, { signal, retries = 2 } = {}) {
  const url = `${API}?${new URLSearchParams({ op, ...params })}`;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, { signal });
      if (res.ok) return await res.json();
      const err = httpError(res, await res.json().catch(() => ({})));
      if (noRetry(err)) throw err;
      lastErr = err;
    } catch (e) {
      if (isAbort(e) || noRetry(e)) throw e;
      lastErr = e;
    }
    if (i < retries) await sleep(700 * (i + 1));
  }
  throw lastErr;
}

async function fetchFile(task, signal) {
  const url = `${API}?${new URLSearchParams({ op: 'download', ...task })}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw httpError(res, await res.json().catch(() => ({})));
  let name = '';
  try {
    name = decodeURIComponent(res.headers.get('X-File-Name') || '');
  } catch {
    /* 이름 복원 실패는 무시 */
  }
  const blob = await res.blob();
  return { name: name || task.name || `${task.kind}.bin`, blob };
}

// ─────────────────────────────────────────────────────────────
// 화면: 공통
// ─────────────────────────────────────────────────────────────

function setStatus(text, bad = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function log(line) {
  const t = new Date();
  const hh = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  state.logLines.push(`${hh} ${line}`);
  if (state.logLines.length > 600) state.logLines.splice(0, state.logLines.length - 600);
  const el = $('#log');
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  el.textContent = state.logLines.join('\n');
  if (stick) el.scrollTop = el.scrollHeight;
}

function updateSummary() {
  const nI = state.selItems.size;
  const nO = state.selOrgans.size;
  const el = $('#summary');
  if (!nI || !nO) {
    el.innerHTML = '항목과 기관을 고르면 작업량이 여기에 표시됩니다.';
  } else {
    const kinds = state.items.filter((i) => state.selItems.has(i.root)).map((i) => i.kind);
    const notes = [];
    if (kinds.includes('rule')) notes.push('내부규정은 기관당 규정 수백 건을 받으므로 기관이 많으면 오래 걸립니다');
    const range = $('input[name=range]:checked')?.value;
    if (range === 'all' && (kinds.includes('susi') || kinds.includes('board'))) notes.push('"전체" 범위는 글이 많은 항목(입찰공고 등)에서 수백 건이 될 수 있습니다');
    el.innerHTML = `기관 <b>${nO}</b>개 × 항목 <b>${nI}</b>개 = 단위 <b>${nO * nI}</b>건` + (notes.length ? `<br><small class="muted">${esc(notes.join('. '))}.</small>` : '');
  }
  $('#btnRun').disabled = state.running || !nI || !nO;
  $('#itemCount').textContent = `선택 ${nI}개`;
  $('#organCount').textContent = `선택 ${nO}개`;
  saveSelection();
}

function saveSelection() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ items: [...state.selItems], organs: [...state.selOrgans] }));
  } catch {
    /* 저장 못 해도 동작엔 지장 없음 */
  }
}
function loadSelection() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!d) return;
    const roots = new Set(state.items.map((i) => i.root));
    const ids = new Set(state.organs.map((o) => o.id));
    for (const r of d.items || []) if (roots.has(r)) state.selItems.add(r);
    for (const id of d.organs || []) if (ids.has(id)) state.selOrgans.add(id);
  } catch {
    /* 무시 */
  }
}

// ─────────────────────────────────────────────────────────────
// 화면: 1단계 항목
// ─────────────────────────────────────────────────────────────

function visibleItems() {
  const q = $('#itemSearch').value.trim();
  return state.items.filter((it) => !q || it.name.includes(q) || it.mid.includes(q) || it.group.includes(q));
}

function renderItems() {
  const tree = $('#itemTree');
  tree.innerHTML = '';
  const groups = new Map();
  for (const it of visibleItems()) {
    if (!groups.has(it.group)) groups.set(it.group, new Map());
    const g = groups.get(it.group);
    if (!g.has(it.mid)) g.set(it.mid, []);
    g.get(it.mid).push(it);
  }
  if (!groups.size) {
    tree.innerHTML = '<div class="empty">검색어에 맞는 항목이 없습니다.</div>';
    return;
  }
  for (const [gname, mids] of groups) {
    const all = [...mids.values()].flat();
    const selected = all.filter((i) => state.selItems.has(i.root)).length;
    const sec = document.createElement('section');
    sec.className = 'grp';
    const head = document.createElement('header');
    head.innerHTML = `<label><input type="checkbox" class="grp-chk" data-group="${esc(gname)}"> <b>${esc(gname)}</b></label><span class="muted">${selected}/${all.length}</span>`;
    const chk = $('.grp-chk', head);
    chk.checked = selected === all.length;
    chk.indeterminate = selected > 0 && selected < all.length;
    sec.appendChild(head);
    for (const [mid, items] of mids) {
      const row = document.createElement('div');
      row.className = 'mid';
      if (mid && mid !== gname) row.innerHTML = `<div class="mid-name">${esc(mid)}</div>`;
      const list = document.createElement('div');
      list.className = 'mid-items';
      for (const it of items) {
        const lab = document.createElement('label');
        lab.className = 'item';
        lab.innerHTML = `<input type="checkbox" data-root="${esc(it.root)}"${state.selItems.has(it.root) ? ' checked' : ''}> <span>${esc(it.name)}</span> <i class="tag k-${it.kind}" title="${esc(KIND[it.kind].title)}">${KIND[it.kind].label}</i>`;
        list.appendChild(lab);
      }
      row.appendChild(list);
      sec.appendChild(row);
    }
    tree.appendChild(sec);
  }
}

// ─────────────────────────────────────────────────────────────
// 화면: 2단계 기관
// ─────────────────────────────────────────────────────────────

function fillSelect(sel, values) {
  const el = $(sel);
  const keep = el.value;
  el.length = 1; // 첫 "전체" 선택지만 남기고 다시 채운다
  for (const v of values) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    el.appendChild(o);
  }
  if (values.includes(keep)) el.value = keep;
}
function fillOrganFilters() {
  const uniq = (key) => [...new Set(state.organs.map((o) => o[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'));
  fillSelect('#fType', uniq('type'));
  fillSelect('#fDept', uniq('dept'));
  const regions = uniq('region');
  if (regions.length) fillSelect('#fRegion', regions);
  else $('#fRegion').hidden = true;
}

function applyOrganFilter() {
  const t = $('#fType').value;
  const d = $('#fDept').value;
  const r = $('#fRegion').value;
  const q = $('#organSearch').value.trim();
  state.filteredOrgans = state.organs.filter(
    (o) => (!t || o.type === t) && (!d || o.dept === d) && (!r || o.region === r) && (!q || o.name.includes(q) || o.id.includes(q))
  );
  renderOrgans();
}

function renderOrgans() {
  const body = $('#organBody');
  body.innerHTML = '';
  if (!state.filteredOrgans.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">조건에 맞는 기관이 없습니다.</td></tr>';
    $('#organHead').checked = false;
    return;
  }
  const frag = document.createDocumentFragment();
  let selectedVisible = 0;
  for (const o of state.filteredOrgans) {
    const on = state.selOrgans.has(o.id);
    if (on) selectedVisible++;
    const tr = document.createElement('tr');
    if (on) tr.className = 'on';
    tr.innerHTML = `<td class="c-chk"><input type="checkbox" data-id="${esc(o.id)}"${on ? ' checked' : ''} aria-label="${esc(o.name)}"></td><td>${esc(o.name)}</td><td>${esc(o.type)}</td><td>${esc(o.dept)}</td><td>${esc(o.region)}</td>`;
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  const head = $('#organHead');
  head.checked = selectedVisible === state.filteredOrgans.length;
  head.indeterminate = selectedVisible > 0 && selectedVisible < state.filteredOrgans.length;
}

// ─────────────────────────────────────────────────────────────
// 실행: 저장 대상(싱크)
// ─────────────────────────────────────────────────────────────

function zipName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `알리오_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

async function openSink(mode) {
  if (mode === 'folder') {
    if (!window.showDirectoryPicker) throw new Error('이 브라우저는 폴더 저장을 지원하지 않습니다. 크롬·엣지를 쓰거나 ZIP 방식을 고르세요.');
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    return folderSink(dir);
  }
  if (window.showSaveFilePicker && !forceBlob) {
    const handle = await window.showSaveFilePicker({
      suggestedName: zipName(),
      types: [{ description: 'ZIP 파일', accept: { 'application/zip': ['.zip'] } }],
    });
    return streamZipSink(handle);
  }
  return blobZipSink();
}

function streamZipSink(handle) {
  return {
    label: `ZIP 파일 "${handle.name}"에 바로 씁니다`,
    async consume(gen) {
      const writable = await handle.createWritable();
      await makeZip(gen, { buffersAreUTF8: true }).pipeTo(writable);
    },
    async finish() {},
  };
}

function blobZipSink() {
  let blob = null;
  return {
    label: 'ZIP 파일을 메모리에 모은 뒤 저장합니다(크롬·엣지는 바로 쓰기 가능)',
    async consume(gen) {
      blob = await downloadZip(gen, { buffersAreUTF8: true }).blob();
    },
    async finish() {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = zipName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    },
  };
}

function folderSink(dir) {
  return {
    label: `폴더 "${dir.name}"에 바로 씁니다`,
    async consume(gen) {
      for await (const entry of gen) {
        const parts = entry.name.split('/');
        let d = dir;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(entry.input);
        await w.close();
      }
    },
    async finish() {},
  };
}

// ─────────────────────────────────────────────────────────────
// 실행: 작업 생성
// ─────────────────────────────────────────────────────────────

function readOptions() {
  return {
    saveMode: $('input[name=save]:checked').value,
    range: $('input[name=range]:checked').value,
    from: Number($('#yearFrom').value) || 2000,
    to: Number($('#yearTo').value) || 2100,
    pdf: $('#optPdf').checked,
    attach: $('#optAttach').checked,
    text: $('#optText').checked,
    concurrency: Number($('#optConc').value) || 3,
  };
}

function updateProgress(ctx) {
  const s = ctx.stats;
  const pct = s.units ? Math.round((s.unitsDone / s.units) * 100) : 0;
  $('#bar').style.width = `${pct}%`;
  $('#stats').textContent = `단위 ${s.unitsDone}/${s.units} · 파일 ${s.files}개 (${fmtBytes(s.bytes)}) · 실패 ${s.fail} · 없음 ${s.skip} · ${fmtElapsed(Date.now() - ctx.startedAt)}`;
}

async function gate(ctx) {
  while (ctx.pauseUntil > Date.now() && !ctx.signal.aborted) await sleep(1000);
  if (ctx.signal.aborted) throw abortError();
}

/** 한 번 실행의 용량 상한을 넘으면 멈춘다. */
function checkLimit(ctx) {
  if (ctx.capped || ctx.stats.bytes < RUN_LIMIT_BYTES) return;
  ctx.capped = true;
  log(`■ 한 번에 받을 수 있는 ${fmtBytes(RUN_LIMIT_BYTES)}에 이르러 멈춥니다. 받은 것까지는 저장됩니다. 나머지는 범위를 나눠 다시 받거나, 대량 수집은 파이썬 데스크톱판·MCP판을 쓰세요.`);
  state.abort.abort();
}

/** 연속 실패가 쌓이면 잠시 쉬고, 그래도 계속되면 멈춘다(알리오 거부·장애 대비). */
function noteFailure(ctx) {
  ctx.streak++;
  if (ctx.streak >= 12) {
    log('✗ 연속 실패가 계속되어 중단합니다. 잠시 뒤 [실패만 다시 받기]로 이어가세요.');
    state.abort.abort();
  } else if (ctx.streak >= 6 && ctx.pauseUntil < Date.now()) {
    ctx.pauseUntil = Date.now() + 60000;
    log('⏸ 연속 실패 6건: 알리오가 요청을 거부하는 듯합니다. 60초 쉬었다가 계속합니다.');
  }
}

function uniqueName(ctx, folder, name) {
  let set = ctx.names.get(folder);
  if (!set) {
    set = new Set();
    ctx.names.set(folder, set);
  }
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let n = 2;
  while (set.has(candidate.toLowerCase())) candidate = `${base} (${n++})${ext}`;
  set.add(candidate.toLowerCase());
  return candidate;
}

function record(ctx, unit, meta, path, size, status, note = '') {
  ctx.manifest.push({
    item: unit.item.name,
    organ: unit.organ.name,
    kind: KIND[unit.item.kind].label,
    title: meta?.title || '',
    date: meta?.date || '',
    dn: meta?.dn || '',
    path,
    size,
    status,
    note,
  });
}

/** 파일 하나를 받아 대기열에 넣는다. 성공·없음·실패를 집계한다. */
async function grab(ctx, queue, unit, task, folder, preferredName, meta) {
  await gate(ctx);
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { name, blob } = await fetchFile(task, ctx.signal);
      const fileName = uniqueName(ctx, folder, san(preferredName || name));
      const path = `${folder}/${fileName}`;
      await queue.push({ name: path, input: blob, lastModified: new Date() });
      ctx.stats.files++;
      ctx.stats.bytes += blob.size;
      ctx.streak = 0;
      record(ctx, unit, meta, path, blob.size, '성공');
      log(`✓ ${unit.organ.name} · ${unit.item.name} · ${fileName} (${fmtBytes(blob.size)})`);
      updateProgress(ctx);
      checkLimit(ctx);
      return true;
    } catch (e) {
      if (isAbort(e)) throw e;
      lastErr = e;
      if (e.status === 404 || e.code === 'NO_FILE' || e.status === 400) break;
      noteFailure(ctx);
      if (attempt === 0) await sleep(800);
      await gate(ctx);
    }
  }
  const reason = lastErr?.message || '실패';
  const missing = lastErr?.status === 404 || lastErr?.code === 'NO_FILE';
  const label = preferredName || task.name || task.kind;
  if (missing) ctx.stats.skip++;
  else {
    ctx.stats.fail++;
    ctx.failures.push({ unit, task, folder, preferredName, meta, reason });
  }
  record(ctx, unit, meta, `${folder}/${san(label)}`, 0, missing ? '없음' : '실패', reason);
  log(`${missing ? '−' : '✗'} ${unit.organ.name} · ${unit.item.name} · ${label} · ${reason}`);
  updateProgress(ctx);
  return false;
}

async function putText(ctx, queue, unit, folder, fileName, text, meta) {
  const name = uniqueName(ctx, folder, san(fileName));
  const path = `${folder}/${name}`;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  await queue.push({ name: path, input: blob, lastModified: new Date() });
  ctx.stats.files++;
  ctx.stats.bytes += blob.size;
  record(ctx, unit, meta, path, blob.size, '성공');
}

function skipUnit(ctx, unit, why) {
  ctx.stats.skip++;
  record(ctx, unit, null, `${san(unit.item.name)}/${san(unit.organ.name)}/`, 0, '없음', why);
  log(`− ${unit.organ.name} · ${unit.item.name} · ${why}`);
}

/** 수시·게시판형 글 목록(최신순). 범위 옵션에 따라 1건·연도·전체. */
async function listEntries(ctx, item, organ) {
  const { opts, signal } = ctx;
  const out = [];
  const maxPages = opts.range === 'latest' ? 1 : MAX_LIST_PAGES;
  let page = 1;
  let totalPage = 1;
  do {
    await gate(ctx);
    const r = await api('susi', { root: item.root, apba: organ.id, page }, { signal });
    totalPage = r.totalPage || 1;
    for (const e of r.items) {
      const y = yearOf(e.date);
      if (opts.range === 'years') {
        if (y && y > opts.to) continue;
        if (y && y < opts.from) return out;
      }
      out.push(e);
      if (opts.range === 'latest') return out;
    }
    page++;
  } while (page <= totalPage && page <= maxPages);
  if (opts.range === 'all' && totalPage > maxPages) {
    log(`ℹ ${organ.name} · ${item.name}: 글이 ${totalPage}쪽이라 앞 ${maxPages}쪽(${maxPages * 10}건)까지만 받습니다.`);
  }
  return out;
}

async function listRules(ctx, organ) {
  const out = [];
  let page = 1;
  let seen = 0;
  for (;;) {
    await gate(ctx);
    const r = await api('rules', { inst: organ.name, apba: organ.id, page }, { signal: ctx.signal });
    out.push(...r.items);
    seen += r.pageCount || 0;
    if (!r.pageCount || seen >= (r.totalCount || 0) || page >= 80) break;
    page++;
  }
  return out;
}

function boardTextFile(e, b, item, organ) {
  const lines = [
    `제목: ${e.title}`,
    `기관: ${organ.name} (${organ.id})`,
    `항목: ${item.name}`,
    `등록일: ${e.date}`,
    `알리오 번호: ${e.sub || e.dn || ''} / ${e.idx || ''}`,
    '',
  ];
  if (b.links?.length) {
    lines.push('[바깥 링크]');
    for (const l of b.links) lines.push(`${l.text ? l.text + ' ' : ''}${l.url}`);
    lines.push('');
  }
  if (b.attachments?.length) {
    lines.push('[첨부파일]');
    for (const a of b.attachments) lines.push(a.name);
    lines.push('');
  }
  lines.push('[본문]', b.text || '(본문 없음)');
  return lines.join('\r\n');
}

async function processUnit(unit, ctx, queue) {
  const { item, organ } = unit;
  const { opts, signal } = ctx;
  const folder = `${san(item.name)}/${san(organ.name)}`;

  if (item.kind === 'regular') {
    const rec = ctx.organMap.get(item.root)?.get(organ.id);
    if (!rec || !rec.dn) return skipUnit(ctx, unit, '공시번호 없음(미공시)');
    const meta = { title: item.name, date: rec.year ? `${rec.year}년${rec.quarter && rec.quarter !== '0' ? ` ${rec.quarter}분기` : ''}` : '', dn: rec.dn };
    if (opts.pdf) await grab(ctx, queue, unit, { kind: 'pdf', dn: rec.dn }, folder, `${san(organ.name)}_${san(item.name)}.pdf`, meta);
    if (opts.attach) for (const f of rec.files) await grab(ctx, queue, unit, { kind: 'file', f: f.id, d: rec.dn, name: f.name }, folder, f.name, meta);
    return;
  }

  if (item.kind === 'susi') {
    const entries = await listEntries(ctx, item, organ);
    if (!entries.length) return skipUnit(ctx, unit, '등록된 글 없음');
    const many = entries.length > 1 || opts.range !== 'latest';
    for (const e of entries) {
      if (signal.aborted) throw abortError();
      const prefix = many ? `${dateKey(e.date) || '날짜없음'}_` : '';
      const meta = { title: e.title, date: e.date, dn: e.dn };
      const hasDn = e.dn && !/^0+$/.test(e.dn);
      if (!hasDn) {
        ctx.stats.skip++;
        record(ctx, unit, meta, folder, 0, '없음', '공시번호 없음');
        log(`− ${organ.name} · ${item.name} · ${e.title} · 공시번호 없음`);
        continue;
      }
      if (opts.pdf && hasDn) await grab(ctx, queue, unit, { kind: 'pdf', dn: e.dn }, folder, `${prefix}${san(organ.name)}_${san(e.title || item.name, 80)}.pdf`, meta);
      if (opts.attach && hasDn) {
        await gate(ctx);
        let files = [];
        try {
          files = (await api('files', { dn: e.dn }, { signal })).files;
        } catch (err) {
          if (isAbort(err)) throw err;
          noteFailure(ctx);
          log(`✗ ${organ.name} · ${item.name} · 첨부 목록 실패 · ${err.message}`);
        }
        for (const f of files) await grab(ctx, queue, unit, { kind: 'file', f: f.id, d: e.dn, name: f.name }, folder, `${prefix}${f.name}`, meta);
      }
    }
    return;
  }

  if (item.kind === 'board') {
    const entries = await listEntries(ctx, item, organ);
    if (!entries.length) return skipUnit(ctx, unit, '등록된 글 없음');
    for (const e of entries) {
      if (signal.aborted) throw abortError();
      await gate(ctx);
      const meta = { title: e.title, date: e.date, dn: e.sub || e.dn };
      let b;
      try {
        b = await api('board', { rfn: e.rfn || item.root, apba: organ.id, dn: e.dn, idx: e.idx, table: e.table, idxName: e.idxName, bid: e.bid }, { signal });
        ctx.streak = 0;
      } catch (err) {
        if (isAbort(err)) throw err;
        noteFailure(ctx);
        ctx.stats.fail++;
        ctx.failures.push({ unit, task: null, reason: err.message, meta });
        record(ctx, unit, meta, folder, 0, '실패', `글 읽기 실패: ${err.message}`);
        log(`✗ ${organ.name} · ${item.name} · ${e.title} · 글 읽기 실패 · ${err.message}`);
        continue;
      }
      const prefix = `${dateKey(e.date) || '날짜없음'}_`;
      const base = san(e.title || item.name, 80);
      if (opts.text) {
        await putText(ctx, queue, unit, folder, `${prefix}${base}.txt`, boardTextFile(e, b, item, organ), meta);
        log(`✓ ${organ.name} · ${item.name} · ${prefix}${base}.txt (본문·링크 ${b.links?.length || 0}개)`);
      }
      if (opts.attach) {
        for (const a of b.attachments || []) {
          const task = a.kind === 'upload' ? { kind: 'upload', spath: a.spath, sfile: a.sfile, name: a.name } : { kind: 'fileno', no: a.no, name: a.name };
          await grab(ctx, queue, unit, task, folder, `${prefix}${a.name}`, meta);
        }
      }
      updateProgress(ctx);
    }
    return;
  }

  if (item.kind === 'rule') {
    const rules = await listRules(ctx, organ);
    if (!rules.length) return skipUnit(ctx, unit, '등록된 규정 없음');
    log(`· ${organ.name} · 내부규정 ${rules.length}건 목록 확보`);
    for (const r of rules) {
      if (signal.aborted) throw abortError();
      const meta = { title: r.title, date: r.date, dn: r.seq };
      await grab(ctx, queue, unit, { kind: 'rule', seq: r.seq, name: r.title }, folder, '', meta);
    }
  }
}

async function produceAll(items, organs, ctx, queue) {
  const { opts, signal } = ctx;
  const regular = items.filter((i) => i.kind === 'regular');
  if (regular.length) {
    log(`정기공시 ${regular.length}개 항목의 기관 목록(공시번호)을 조회합니다…`);
    await runLimited(regular, opts.concurrency, async (it) => {
      if (signal.aborted) return;
      try {
        const r = await api('organs', { root: it.root }, { signal });
        ctx.organMap.set(it.root, new Map(r.organs.map((o) => [o.id, o])));
      } catch (e) {
        if (isAbort(e)) return;
        log(`✗ ${it.name}: 기관 목록 조회 실패 (${e.message})`);
        ctx.organMap.set(it.root, new Map());
      }
    });
    if (signal.aborted) throw abortError();
  }
  const units = [];
  for (const it of items) for (const o of organs) units.push({ item: it, organ: o });
  ctx.stats.units = units.length;
  updateProgress(ctx);
  log(`── 시작: 기관 ${organs.length} × 항목 ${items.length} = ${units.length}단위 · 동시 ${opts.concurrency} ──`);
  await runLimited(units, opts.concurrency, async (u) => {
    if (signal.aborted) return;
    try {
      await processUnit(u, ctx, queue);
    } catch (e) {
      if (isAbort(e)) return;
      ctx.stats.fail++;
      ctx.failures.push({ unit: u, task: null, reason: e.message });
      record(ctx, u, null, `${san(u.item.name)}/${san(u.organ.name)}/`, 0, '실패', e.message);
      log(`✗ ${u.organ.name} · ${u.item.name} · ${e.message}`);
    } finally {
      ctx.stats.unitsDone++;
      updateProgress(ctx);
    }
  });
}

async function produceRetry(failures, ctx, queue) {
  const tasks = failures.filter((f) => f.task);
  const unitsOnly = failures.filter((f) => !f.task);
  ctx.stats.units = tasks.length + unitsOnly.length;
  updateProgress(ctx);
  log(`── 다시 받기: 파일 ${tasks.length}건, 단위 ${unitsOnly.length}건 ──`);
  await runLimited(tasks, ctx.opts.concurrency, async (f) => {
    if (ctx.signal.aborted) return;
    try {
      await grab(ctx, queue, f.unit, f.task, f.folder, f.preferredName, f.meta);
    } catch (e) {
      if (!isAbort(e)) log(`✗ ${f.unit.organ.name} · ${f.unit.item.name} · ${e.message}`);
    } finally {
      ctx.stats.unitsDone++;
      updateProgress(ctx);
    }
  });
  if (unitsOnly.length && !ctx.signal.aborted) {
    const regular = [...new Map(unitsOnly.filter((f) => f.unit.item.kind === 'regular').map((f) => [f.unit.item.root, f.unit.item])).values()];
    for (const it of regular) {
      try {
        const r = await api('organs', { root: it.root }, { signal: ctx.signal });
        ctx.organMap.set(it.root, new Map(r.organs.map((o) => [o.id, o])));
      } catch (e) {
        if (isAbort(e)) return;
        ctx.organMap.set(it.root, new Map());
      }
    }
    await runLimited(unitsOnly, ctx.opts.concurrency, async (f) => {
      if (ctx.signal.aborted) return;
      try {
        await processUnit(f.unit, ctx, queue);
      } catch (e) {
        if (isAbort(e)) return;
        ctx.stats.fail++;
        ctx.failures.push({ unit: f.unit, task: null, reason: e.message });
        log(`✗ ${f.unit.organ.name} · ${f.unit.item.name} · ${e.message}`);
      } finally {
        ctx.stats.unitsDone++;
        updateProgress(ctx);
      }
    });
  }
}

function csvBlob(rows) {
  const head = ['항목', '기관', '종류', '제목', '날짜', '공시·제출번호', '저장 경로', '크기(바이트)', '상태', '비고'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.map(q).join(',')];
  for (const r of rows) lines.push([r.item, r.organ, r.kind, r.title, r.date, r.dn, r.path, r.size, r.status, r.note].map(q).join(','));
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}

function setBusy(on) {
  state.running = on;
  $('#btnRun').disabled = on || !state.selItems.size || !state.selOrgans.size;
  $('#btnStop').disabled = !on;
  $('#btnRetry').disabled = on;
  $$('#step1 input, #step2 input, #step2 select, #step3 input, #step3 select').forEach((el) => {
    el.disabled = on;
  });
}

async function run(retryFailures = null) {
  if (state.running) return;
  const opts = readOptions();
  const items = state.items.filter((i) => state.selItems.has(i.root));
  const organs = state.organs.filter((o) => state.selOrgans.has(o.id));
  if (!retryFailures && (!items.length || !organs.length)) {
    log('⚠ 항목과 기관을 먼저 고르세요.');
    return;
  }
  if (!opts.pdf && !opts.attach && !opts.text) {
    log('⚠ 받을 내용을 하나 이상 고르세요.');
    return;
  }
  let sink;
  try {
    sink = await openSink(opts.saveMode);
  } catch (e) {
    if (isAbort(e)) {
      log('저장 위치 선택을 취소했습니다.');
      return;
    }
    log(`✗ 저장 위치를 열지 못했습니다: ${e.message}`);
    return;
  }

  state.abort = new AbortController();
  const ctx = {
    signal: state.abort.signal,
    opts,
    stats: { units: 0, unitsDone: 0, files: 0, fail: 0, skip: 0, bytes: 0 },
    streak: 0,
    pauseUntil: 0,
    names: new Map(),
    manifest: [],
    failures: [],
    organMap: new Map(),
    startedAt: Date.now(),
  };
  state.ctx = ctx;
  setBusy(true);
  $('#failBox').hidden = true;
  $('#bar').style.width = '0%';
  log(`저장 방식: ${sink.label}`);

  const queue = new AsyncQueue(opts.concurrency * 2);
  const producer = (async () => {
    try {
      if (retryFailures) await produceRetry(retryFailures, ctx, queue);
      else await produceAll(items, organs, ctx, queue);
    } catch (e) {
      if (!isAbort(e)) log(`✗ 작업 생성 중 오류: ${e.message}`);
    } finally {
      if (ctx.manifest.length) queue.pushNow({ name: '_수집목록.csv', input: csvBlob(ctx.manifest), lastModified: new Date() });
      if (ctx.failures.length) {
        queue.pushNow({ name: '_실패목록.csv', input: csvBlob(ctx.manifest.filter((r) => r.status === '실패')), lastModified: new Date() });
      }
      queue.close();
    }
  })();

  try {
    await sink.consume(queue.iterate());
    await producer;
    await sink.finish();
    const s = ctx.stats;
    const why = ctx.capped ? ' · 용량 상한으로 멈춤(받은 것까지 저장)' : ctx.signal.aborted ? ' · 중지됨(받은 것까지 저장)' : '';
    log(`■ 끝: 파일 ${s.files}개 (${fmtBytes(s.bytes)}) · 실패 ${s.fail} · 없음 ${s.skip} · ${fmtElapsed(Date.now() - ctx.startedAt)}${why}`);
  } catch (e) {
    state.abort.abort();
    queue.cancel();
    await producer.catch(() => {});
    log(`✗ 저장 중 오류: ${e.message}`);
  } finally {
    state.failures = ctx.failures;
    setBusy(false);
    updateProgress(ctx);
    renderFailures();
  }
}

function renderFailures() {
  const box = $('#failBox');
  const n = state.failures.length;
  box.hidden = n === 0;
  if (n) $('#failTitle').textContent = `실패 ${n}건`;
}

// ─────────────────────────────────────────────────────────────
// 이벤트·초기화
// ─────────────────────────────────────────────────────────────

function bindEvents() {
  $('#itemSearch').addEventListener('input', renderItems);
  $('#itemTree').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('input[data-root]')) {
      if (t.checked) state.selItems.add(t.dataset.root);
      else state.selItems.delete(t.dataset.root);
    } else if (t.matches('.grp-chk')) {
      const g = t.dataset.group;
      for (const it of visibleItems()) if (it.group === g) (t.checked ? state.selItems.add(it.root) : state.selItems.delete(it.root));
    }
    renderItems();
    updateSummary();
  });
  $('#itemAll').addEventListener('click', () => {
    for (const it of visibleItems()) state.selItems.add(it.root);
    renderItems();
    updateSummary();
  });
  $('#itemNone').addEventListener('click', () => {
    state.selItems.clear();
    renderItems();
    updateSummary();
  });

  ['#fType', '#fDept', '#fRegion'].forEach((s) => $(s).addEventListener('change', applyOrganFilter));
  $('#organSearch').addEventListener('input', applyOrganFilter);
  $('#organBody').addEventListener('change', (e) => {
    const t = e.target;
    if (!t.matches('input[data-id]')) return;
    if (t.checked) state.selOrgans.add(t.dataset.id);
    else state.selOrgans.delete(t.dataset.id);
    t.closest('tr').classList.toggle('on', t.checked);
    renderOrgans();
    updateSummary();
  });
  $('#organHead').addEventListener('change', (e) => {
    for (const o of state.filteredOrgans) (e.target.checked ? state.selOrgans.add(o.id) : state.selOrgans.delete(o.id));
    renderOrgans();
    updateSummary();
  });
  $('#organAll').addEventListener('click', () => {
    for (const o of state.filteredOrgans) state.selOrgans.add(o.id);
    renderOrgans();
    updateSummary();
  });
  $('#organNone').addEventListener('click', () => {
    state.selOrgans.clear();
    renderOrgans();
    updateSummary();
  });

  $$('input[name=range]').forEach((r) => r.addEventListener('change', updateSummary));
  $('#btnRun').addEventListener('click', () => run());
  $('#btnStop').addEventListener('click', () => {
    if (state.abort) {
      state.abort.abort();
      log('■ 중지 요청: 받던 파일까지 마무리하고 끝냅니다.');
    }
  });
  $('#btnRetry').addEventListener('click', () => {
    if (state.failures.length) run(state.failures.slice());
  });
  $('#btnFailCsv').addEventListener('click', () => {
    const rows = state.ctx?.manifest.filter((r) => r.status === '실패') || [];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(csvBlob(rows));
    a.download = '알리오_실패목록.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });
  $('#btnCopyLog').addEventListener('click', () => navigator.clipboard?.writeText($('#log').textContent));
  $('#btnClearLog').addEventListener('click', () => {
    state.logLines = [];
    $('#log').textContent = '';
  });

  if (!window.showDirectoryPicker) {
    $('#saveFolder').disabled = true;
    $('#folderNote').textContent = '(이 브라우저는 지원하지 않음)';
  }
  if (!window.showSaveFilePicker || forceBlob) $('#zipNote').textContent = '(메모리에 모은 뒤 저장)';
  else $('#zipNote').textContent = '(디스크에 바로 씀)';
}

// 항목·기관 목록: 정적 사본(public/data)을 먼저 쓰고, 7일 넘게 묵었으면 뒤에서 새로 받는다.
const STALE_MS = 7 * 86400000;

async function fetchStatic(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function loadStatic() {
  try {
    const [items, roster] = await Promise.all([fetchStatic('data/items.json'), fetchStatic('data/roster.json')]);
    if (!items?.items?.length || !roster?.organs?.length) return null;
    return { items, roster };
  } catch {
    return null;
  }
}

async function loadLive() {
  const [items, rosterRes] = await Promise.all([api('items'), api('roster').catch(() => null)]);
  let roster = rosterRes;
  if (!roster || !roster.complete) {
    const o = await api('organs', { root: '20201' });
    const organs = [...(roster?.organs ?? [])];
    const have = new Set(organs.map((x) => x.id));
    for (const x of o.organs) if (!have.has(x.id)) organs.push({ id: x.id, name: x.name, type: x.type, dept: x.dept, region: '' });
    organs.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    roster = { fetchedAt: new Date().toISOString(), complete: true, organs };
  }
  return { items, roster };
}

const ageOf = (d) => (d?.fetchedAt ? Date.now() - Date.parse(d.fetchedAt) : Infinity);
const isStale = (lists) => ageOf(lists.items) > STALE_MS || ageOf(lists.roster) > STALE_MS;

function applyLists(lists, first) {
  state.items = lists.items.items;
  state.organs = lists.roster.organs;
  if (first) loadSelection();
  const roots = new Set(state.items.map((i) => i.root));
  for (const r of [...state.selItems]) if (!roots.has(r)) state.selItems.delete(r);
  const ids = new Set(state.organs.map((o) => o.id));
  for (const id of [...state.selOrgans]) if (!ids.has(id)) state.selOrgans.delete(id);
  renderItems();
  fillOrganFilters();
  applyOrganFilter();
  updateSummary();
}

async function init() {
  bindEvents();
  setStatus('항목과 기관 목록을 불러오는 중…');
  try {
    let lists = await loadStatic();
    const fromStatic = !!lists;
    if (!lists) lists = await loadLive();
    applyLists(lists, true);
    const basis = fromStatic ? ` · 목록 기준일 ${dateKey(lists.roster.fetchedAt) || '?'}` : '';
    setStatus(`준비됨 · 공시 항목 ${state.items.length}개 · 기관 ${state.organs.length}개${basis}`);
    log(`항목 ${state.items.length}개, 기관 ${state.organs.length}개를 불러왔습니다. 1단계부터 차례로 고르세요.`);
    if (fromStatic && isStale(lists)) {
      loadLive()
        .then((fresh) => {
          applyLists(fresh, false);
          setStatus(`준비됨 · 공시 항목 ${state.items.length}개 · 기관 ${state.organs.length}개 · 방금 갱신`);
          log('항목·기관 목록을 알리오에서 새로 받아 갱신했습니다.');
        })
        .catch(() => {});
    }
  } catch (e) {
    setStatus(`목록을 불러오지 못했습니다: ${e.message}`, true);
    log(`✗ 초기화 실패: ${e.message}`);
  }
}

init();
