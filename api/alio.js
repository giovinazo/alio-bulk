/**
 * 알리오(www.alio.go.kr) 중계 함수 — Vercel Node.js 런타임, 웹 표준 핸들러.
 *
 * 브라우저는 교차 출처 제한 때문에 알리오를 직접 부를 수 없으므로, 이 함수가
 * 허용된 조회·내려받기 경로만 알리오에 그대로 전달한다. 파일은 저장하지 않고
 * 스트리밍으로 흘려보낸다(버셀 함수의 4.5MB 응답 한도는 스트리밍 응답에는 적용되지 않는다).
 *
 * 조회(op):   items · roster · organs · susi · files · board · rules
 * 내려받기:   download&kind=pdf|file|dfile|rule|upload|fileno
 *
 * 알리오 호출 규약은 alio-crawler / alio-mcp 의 alio_core 와 같다.
 */

const BASE = 'https://www.alio.go.kr';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JSON_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
};
const RETRIABLE = new Set([429, 500, 502, 503, 504]);

// 허용 값 형식. 알리오로 나가는 값은 전부 이 검사를 거친다.
const RE = {
  digits: /^\d{1,24}$/,
  root: /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/,
  apba: /^[A-Za-z0-9]{1,12}$/,
  page: /^\d{1,4}$/,
  divis: /^(K1[1-5]00)?$/,
  token: /^[A-Za-z0-9_-]{0,40}$/,
  name: /^[^<>]{1,100}$/,
  spath: /^\/[^<>"'?#\s]{0,300}$/,
  fname: /^[^/\\]{1,255}$/,
};

const CACHE_LONG = 'public, s-maxage=86400, stale-while-revalidate=604800';
const CACHE_MID = 'public, s-maxage=3600, stale-while-revalidate=86400';
const CACHE_SHORT = 'public, s-maxage=300, stale-while-revalidate=3600';

class ParamError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const clean = (v) => {
  const s = str(v);
  return ['null', 'none', 'undefined'].includes(s.toLowerCase()) ? '' : s;
};

function json(data, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache },
  });
}

function param(url, key, re, { required = true, def = '' } = {}) {
  const raw = url.searchParams.get(key);
  const v = (raw === null ? def : raw).trim();
  if (!v) {
    if (required) throw new ParamError(`${key} 값이 필요합니다`);
    return '';
  }
  if (re && !re.test(v)) throw new ParamError(`${key} 값이 올바르지 않습니다`);
  return v;
}

/** 알리오 호출. 429·5xx·네트워크 오류는 retries 만큼 다시 시도한다. */
async function upstream(path, { method = 'GET', body, headers = {}, timeoutMs = 30000, retries = 2, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    const onAbort = () => ctrl.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const resp = await fetch(BASE + path, {
        method,
        headers: { 'User-Agent': UA, ...headers },
        body,
        signal: ctrl.signal,
        redirect: 'manual',
      });
      if (!RETRIABLE.has(resp.status) || attempt === retries) return resp;
      lastErr = new Error(`알리오 응답 HTTP ${resp.status}`);
      await resp.arrayBuffer().catch(() => {});
    } catch (err) {
      lastErr = err;
      if (signal?.aborted || attempt === retries) throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    await sleep(500 * 2 ** attempt + Math.random() * 300);
  }
  throw lastErr;
}

async function postJson(path, payload, opts = {}) {
  const resp = await upstream(path, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { ...JSON_HEADERS, ...(opts.headers || {}) },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  if (resp.status !== 200) throw new Error(`알리오 응답 HTTP ${resp.status}`);
  return resp.json();
}

async function getJson(path, opts = {}) {
  const resp = await upstream(path, { timeoutMs: opts.timeoutMs, signal: opts.signal });
  if (resp.status !== 200) throw new Error(`알리오 응답 HTTP ${resp.status}`);
  return resp.json();
}

/** 동시성 제한 반복. */
async function runLimited(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/** "101@파일명.pdf|102@파일명2.pdf" → [{id, name}] ("@" 하나뿐이면 빈 목록). */
function parseFiles(s) {
  if (!s) return [];
  const out = [];
  for (const partRaw of String(s).split('|')) {
    const part = partRaw.trim();
    const at = part.indexOf('@');
    if (at === -1) {
      if (part) out.push({ id: '', name: part });
      continue;
    }
    const id = part.slice(0, at).trim();
    const name = part.slice(at + 1).trim();
    if (id && name) out.push({ id, name });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────
// 조회
// ─────────────────────────────────────────────────────────────

/** 항목 종류: regular(정기) · susi(수시 보고서형) · board(게시판형·외부연계) · rule(내부규정) */
function classify(item) {
  const root = str(item.reportNos || item.mcd).split(',')[0].trim();
  if (root === '21110') return 'rule';
  const dtype = Number(item.disclosureType);
  if (dtype === 9) return 'board';
  if (dtype === 4) return str(item.reportYn).toUpperCase() === 'Y' ? 'susi' : 'board';
  return 'regular';
}

async function opItems() {
  const data = await postJson('/item/formList.json', {}, { headers: { Referer: `${BASE}/item/itemList.do` } });
  const list = Array.isArray(data?.data) ? data.data : [];
  const items = [];
  for (const it of list) {
    const root = str(it.reportNos || it.mcd).split(',')[0].trim();
    if (!root) continue;
    items.push({
      root,
      name: str(it.scdnm) || str(it.mcdnm) || root,
      group: str(it.lcdnm),
      mid: str(it.nmcdnm),
      sub: str(it.mcdnm),
      kind: classify(it),
      dtype: Number(it.disclosureType) || 0,
      reportYn: str(it.reportYn).toUpperCase(),
      reportNos: str(it.reportNos),
    });
  }
  // 표시명이 겹치면 뒤에 항목 번호를 붙여 구분한다.
  const counts = new Map();
  for (const i of items) counts.set(i.name, (counts.get(i.name) || 0) + 1);
  for (const i of items) if (counts.get(i.name) > 1) i.name = `${i.name}(${i.root})`;
  return json({ fetchedAt: new Date().toISOString(), count: items.length, items }, 200, CACHE_MID);
}

/** 기관 마스터(유형·부처·지역). 10건씩 36쪽이라 병렬로 모은다. */
async function opRoster() {
  const body = (pageNo) => ({ apbaType: [], jidtDptm: [], area: [], apba_id: '', pageNo });
  const first = await postJson('/organ/findOrganApbaList.json', body(1));
  const node = first?.data?.organList ?? {};
  const rows = [...(Array.isArray(node) ? node : node?.result ?? [])];
  const totalPage = Math.min(Number(node?.page?.totalPage ?? 1) || 1, 200);
  const totalCount = Number(node?.page?.totalCount ?? 0) || 0;
  const pages = [];
  for (let p = 2; p <= totalPage; p++) pages.push(p);
  await runLimited(pages, 6, async (p) => {
    try {
      const d = await postJson('/organ/findOrganApbaList.json', body(p));
      const n = d?.data?.organList ?? {};
      rows.push(...(Array.isArray(n) ? n : n?.result ?? []));
    } catch {
      /* 일부 쪽 실패는 complete=false 로 알린다 */
    }
  });
  const byId = new Map();
  for (const o of rows) {
    const id = str(o?.apbaId);
    const name = str(o?.apbaNa);
    if (!id || !name || byId.has(id)) continue;
    byId.set(id, {
      id,
      name,
      type: clean(o.typeNa),
      dept: clean(o.jidtNa),
      region: clean(o.addrCd),
      parent: clean(o.parnApbaNa),
    });
  }
  const organs = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const complete = totalCount > 0 && organs.length >= totalCount;
  return json(
    { fetchedAt: new Date().toISOString(), count: organs.length, totalCount, complete, organs },
    200,
    complete ? CACHE_LONG : 'no-store'
  );
}

/** 항목별 기관 목록(정기공시는 공시번호·첨부 포함). */
async function opOrgans(url) {
  const root = param(url, 'root', RE.root);
  const d = await postJson('/item/itemOrganListJung.json', {
    reportFormRootNo: root,
    apbaType: [],
    jidtDptm: [],
    area: [],
    apba_id: '',
    pageNo: 1,
  });
  if (d?.status && d.status !== 'success') {
    return json({ error: 'ALIO', message: clean(d.message) || '알리오가 목록을 주지 않았습니다' }, 502);
  }
  const node = d?.data?.organList ?? [];
  const list = Array.isArray(node) ? node : node?.result ?? [];
  const organs = list
    .map((o) => ({
      id: str(o.apbaId),
      name: str(o.apbaNa),
      type: clean(o.typeNa),
      dept: clean(o.jidtNa),
      dn: str(o.disclosureNo),
      sub: str(o.submissionNo),
      year: str(o.critYyyy),
      quarter: str(o.critQuar),
      files: parseFiles(o.files),
    }))
    .filter((o) => o.id && o.name);
  return json({ root, count: organs.length, organs }, 200, CACHE_SHORT);
}

/** 수시·게시판형 자료 목록 1쪽(10건). 최신순. */
async function opSusi(url) {
  const root = param(url, 'root', RE.root);
  const apba = param(url, 'apba', RE.apba, { required: false });
  const page = Number(param(url, 'page', RE.page, { required: false, def: '1' })) || 1;
  const d = await postJson(
    '/item/itemReportListSusi.json',
    {
      pageNo: page,
      apbaId: apba,
      apbaType: '',
      reportFormRootNo: root,
      search_word: '',
      search_flag: 'title',
      bid_type: '',
      enfc_istt: '',
    },
    { headers: { 'X-Requested-With': '' } }
  );
  const data = d?.data ?? {};
  const items = (Array.isArray(data.result) ? data.result : []).map((v) => ({
    title: str(v.title),
    date: str(v.idate),
    dn: str(v.disclosureNo),
    sub: str(v.submissionNo),
    rfn: str(v.reportFormNo),
    table: str(v.tableName),
    idxName: str(v.idxName),
    idx: str(v.idx),
    gbn: str(v.reportGbn),
    bid: str(v.bidType),
  }));
  return json(
    {
      root,
      apba,
      page,
      totalPage: Number(data?.page?.totalPage ?? 0) || 0,
      totalCount: Number(data?.page?.totalCount ?? 0) || items.length,
      items,
    },
    200,
    CACHE_SHORT
  );
}

/** 보고서형 공시의 부속 첨부 목록. */
async function opFiles(url) {
  const dn = param(url, 'dn', RE.digits);
  const d = await getJson(`/item/itemReportFiles.json?disclosureNo=${dn}`);
  const files = (Array.isArray(d?.data) ? d.data : [])
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      id: str(f.fileNo),
      name: str(f.orcpFileNa) || str(f.saveFileNa) || `file_${str(f.fileNo)}`,
      sub: str(f.submissionNo),
      type: str(f.fileType),
    }))
    .filter((f) => f.id);
  return json({ dn, count: files.length, files }, 200, CACHE_SHORT);
}

const PAT_DOWNATTACH = /downAttachFile\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
const PAT_FILENO = /<a[^>]*\bhref=["'][^"']*?\/download\/download\.json\?fileNo=(\d+)["'][^>]*>([^<]+)<\/a>/g;
const PAT_EXTERNAL = /<a[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>([^<]*)<\/a>/g;

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 게시판 글 본문을 줄 구조를 살려 평문으로. */
function boardText(html) {
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const bodyStart = s.search(/<body[^>]*>/i);
  if (bodyStart !== -1) s = s.slice(bodyStart);
  s = s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/dt|\/dd|\/table)\b[^>]*>/gi, '\n');
  s = s.replace(/<\/t[dh]>/gi, '\t');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const lines = s
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean);
  if (lines[0] && /^ALIO\s*:/.test(lines[0])) lines.shift();
  return lines.join('\n').slice(0, 20000);
}

/** 게시판형 글의 첨부·외부링크·본문. */
async function opBoard(url) {
  const rfn = param(url, 'rfn', RE.root);
  const apba = param(url, 'apba', RE.apba);
  const dn = param(url, 'dn', RE.digits, { required: false });
  const idx = param(url, 'idx', RE.token, { required: false });
  const table = param(url, 'table', RE.token, { required: false });
  const idxName = param(url, 'idxName', RE.token, { required: false });
  const bid = param(url, 'bid', RE.token, { required: false });
  const q = new URLSearchParams({
    disclosureNo: dn,
    apbaId: apba,
    nowcode: rfn,
    reportFormNo: rfn,
    table_name: table,
    idx_name: idxName,
    idx,
    reportGbn: 'N',
    bid_type: bid,
  });
  const resp = await upstream(`/item/itemBoard${rfn}.do?${q}`, { timeoutMs: 30000 });
  if (resp.status !== 200) return json({ error: 'ALIO', message: `알리오 응답 HTTP ${resp.status}` }, 502);
  const html = await resp.text();
  const attachments = [];
  const seen = new Set();
  for (const m of html.matchAll(PAT_DOWNATTACH)) {
    const [, spath, sfile, dfile] = m;
    const key = `u|${spath}|${sfile}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push({ kind: 'upload', spath, sfile, name: decodeEntities(dfile) || sfile });
  }
  for (const m of html.matchAll(PAT_FILENO)) {
    const key = `f|${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    attachments.push({ kind: 'fileno', no: m[1], name: decodeEntities(m[2].trim()) || `file_${m[1]}` });
  }
  const links = [];
  const seenLinks = new Set();
  for (const m of html.matchAll(PAT_EXTERNAL)) {
    const link = m[1].replace(/&amp;/g, '&');
    if (link.includes('alio.go.kr') || seenLinks.has(link)) continue;
    seenLinks.add(link);
    links.push({ url: link, text: decodeEntities(m[2]).replace(/\s+/g, ' ').trim().slice(0, 80) });
  }
  return json({ rfn, apba, attachments, links, text: boardText(html) }, 200, CACHE_SHORT);
}

/** 내부규정 목록 1쪽(10건). 기관명 검색은 부분 일치라(예: 한국도로공사 → 한국도로공사서비스(주)까지)
 *  apba 를 주면 그 기관의 규정만 남긴다. pageCount 는 거르기 전 건수(쪽 넘김 판단용). */
async function opRules(url) {
  const inst = param(url, 'inst', RE.name);
  const apba = param(url, 'apba', RE.apba, { required: false });
  const divis = param(url, 'divis', RE.divis, { required: false });
  const page = Number(param(url, 'page', RE.page, { required: false, def: '1' })) || 1;
  const q = new URLSearchParams({ type: 'apbaNa', word: inst, pageNo: String(page), divis });
  const d = await getJson(`/occasional/findRuleList.json?${q}`);
  const data = d?.data ?? {};
  const rows = Array.isArray(data.result) ? data.result : [];
  const items = rows
    .filter((r) => !apba || str(r.apbaId) === apba)
    .map((r) => ({
      seq: str(r.seq),
      title: str(r.title),
      divis: clean(r.insdRuleDivis),
      date: str(r.idate),
      organ: str(r.pname),
    }));
  return json(
    { inst, apba, divis, page, totalCount: Number(data?.totalCnt ?? 0) || 0, pageCount: rows.length, items },
    200,
    CACHE_SHORT
  );
}

/** 규정 상세에서 .zip 을 뺀 최신 파일(fileNo 최대) 하나. */
async function latestRuleFile(seq) {
  const d = await getJson(`/occasional/findRuleDtl.json?seq=${seq}`, { timeoutMs: 15000 });
  const bFiles = str(d?.data?.bFiles);
  const files = [];
  for (const entryRaw of bFiles.split(',')) {
    const entry = entryRaw.trim();
    const bar = entry.indexOf('|');
    if (bar === -1) continue;
    const no = entry.slice(0, bar).trim();
    const name = entry.slice(bar + 1).trim();
    if (!/^\d+$/.test(no) || name.toLowerCase().endsWith('.zip')) continue;
    files.push({ no, name });
  }
  if (!files.length) return null;
  return files.reduce((a, b) => (Number(b.no) > Number(a.no) ? b : a));
}

// ─────────────────────────────────────────────────────────────
// 내려받기(스트리밍)
// ─────────────────────────────────────────────────────────────

const MIME = {
  pdf: 'application/pdf',
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  zip: 'application/zip',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
};

function contentTypeFor(name) {
  const ext = name.toLowerCase().split('.').pop();
  return MIME[ext] || 'application/octet-stream';
}

/** Content-Disposition 에서 파일명. 알리오는 두 형식을 섞어 쓴다:
 *  filename=%ED%95%9C...+%EC%88%98.pdf (따옴표 없음, 공백은 +)
 *  filename="2021%EB%85%84 ...pdf"      (따옴표, 공백은 그대로) */
function filenameFrom(cd) {
  if (!cd) return '';
  let m = cd.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim());
    } catch {
      return m[1].trim();
    }
  }
  m = cd.match(/filename\s*=\s*"([^"]+)"/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  m = cd.match(/filename\s*=\s*([^;]+)/);
  if (m) {
    const v = m[1].trim().replace(/\+/g, ' ');
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return '';
}

function encodePathPart(s) {
  // 비ASCII·공백만 퍼센트 인코딩(이미 인코딩된 %XX 는 그대로 둔다)
  return s.replace(/[^\x21-\x7e]|[ ]/g, (c) => encodeURIComponent(c));
}

async function opDownload(url, request) {
  const kind = param(url, 'kind', /^(pdf|file|dfile|rule|upload|fileno)$/);
  let path = '';
  let hint = param(url, 'name', RE.fname, { required: false });
  switch (kind) {
    case 'pdf': {
      const dn = param(url, 'dn', RE.digits);
      path = `/download/pdf.json?disclosureNo=${dn}`;
      break;
    }
    case 'file': {
      const f = param(url, 'f', RE.digits);
      const d = param(url, 'd', RE.digits);
      path = `/download/file.json?f=${f}&d=${d}`;
      break;
    }
    case 'dfile': {
      const name = param(url, 'fileName', RE.fname);
      const sub = param(url, 'sub', RE.digits);
      path = `/download/dfile.json?${new URLSearchParams({ fileName: name, submissionNo: sub })}`;
      hint = hint || name;
      break;
    }
    case 'rule': {
      let no = param(url, 'no', RE.digits, { required: false });
      if (!no) {
        const seq = param(url, 'seq', RE.digits);
        const latest = await latestRuleFile(seq);
        if (!latest) return json({ error: 'NO_FILE', message: '규정에 첨부된 파일이 없습니다' }, 404);
        no = latest.no;
        hint = latest.name || hint;
      }
      path = `/download/rulefiledown.json?fileNo=${no}`;
      break;
    }
    case 'upload': {
      const spath = param(url, 'spath', RE.spath);
      const sfile = param(url, 'sfile', RE.fname);
      if (spath.includes('..') || sfile.includes('..')) throw new ParamError('경로가 올바르지 않습니다');
      path = `/upload${encodePathPart(spath)}${spath.endsWith('/') ? '' : '/'}${encodePathPart(sfile)}`;
      hint = hint || sfile;
      break;
    }
    case 'fileno': {
      const no = param(url, 'no', RE.digits);
      path = `/download/download.json?fileNo=${no}`;
      break;
    }
    default:
      throw new ParamError('kind 값이 올바르지 않습니다');
  }

  const resp = await upstream(path, { timeoutMs: 60000, retries: 1, signal: request.signal });
  if (resp.status === 404) return json({ error: 'NO_FILE', message: '알리오에 파일이 없습니다(404)' }, 404);
  if (resp.status !== 200) return json({ error: 'ALIO', message: `알리오 응답 HTTP ${resp.status}` }, 502);

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('json') || ct.includes('text/html')) {
    // 파일 대신 오류 안내가 온 경우(예: "해당 공시가 없습니다")
    const text = await resp.text();
    let message = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    try {
      message = str(JSON.parse(text)?.message) || message;
    } catch {
      /* JSON 아님 */
    }
    return json({ error: 'NO_FILE', message: message || '파일이 아닌 응답' }, 404);
  }

  const name = filenameFrom(resp.headers.get('content-disposition')) || hint || `download_${Date.now()}.bin`;
  const headers = new Headers({
    'Content-Type': contentTypeFor(name),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-File-Name': encodeURIComponent(name),
    'Cache-Control': 'private, no-store',
  });
  const len = resp.headers.get('content-length');
  if (len && /^\d+$/.test(len)) headers.set('Content-Length', len);
  return new Response(resp.body, { status: 200, headers });
}

// ─────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────

export async function GET(request) {
  const url = new URL(request.url);
  // 다른 사이트에 끼워 넣어 쓰는 것은 막는다(같은 사이트·직접 호출만 허용).
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'FORBIDDEN', message: '다른 사이트에서는 부를 수 없습니다' }, 403);
  }
  const op = (url.searchParams.get('op') || url.pathname.split('/').filter(Boolean).pop() || '').trim();
  try {
    switch (op) {
      case 'items':
        return await opItems();
      case 'roster':
        return await opRoster();
      case 'organs':
        return await opOrgans(url);
      case 'susi':
        return await opSusi(url);
      case 'files':
        return await opFiles(url);
      case 'board':
        return await opBoard(url);
      case 'rules':
        return await opRules(url);
      case 'download':
        return await opDownload(url, request);
      case 'health':
        return json({ ok: true, time: new Date().toISOString() });
      default:
        return json({ error: 'NOT_FOUND', message: `알 수 없는 요청: ${op || '(없음)'}` }, 404);
    }
  } catch (err) {
    if (err instanceof ParamError) return json({ error: 'BAD_REQUEST', message: err.message }, 400);
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || /timeout/i.test(String(err?.message))) {
      return json({ error: 'TIMEOUT', message: '알리오 응답이 늦어 중단했습니다' }, 504);
    }
    return json({ error: 'UPSTREAM', message: String(err?.message || err) }, 502);
  }
}

export const config = { maxDuration: 300 };
