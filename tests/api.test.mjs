// 중계 함수 점검. 로컬 서버(npm run dev) 또는 배포 주소를 대상으로 돈다.
//   node tests/api.test.mjs              → http://127.0.0.1:8787
//   node tests/api.test.mjs https://...  → 배포본
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const API = `${BASE}/api/alio`;
let pass = 0;
let fail = 0;

function ok(cond, label, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS ${label} ${extra}`);
  } else {
    fail++;
    console.log(`FAIL ${label} ${extra}`);
  }
}
const q = (p) => `${API}?${new URLSearchParams(p)}`;
const getJson = async (p) => {
  const r = await fetch(q(p));
  return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
};
const t0 = Date.now();
const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// 1. 항목
const items = await getJson({ op: 'items' });
ok(items.status === 200 && items.body?.count >= 90, 'items', `count=${items.body?.count} ${lap()}`);
const byKind = {};
for (const i of items.body?.items || []) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
console.log('  kinds:', JSON.stringify(byKind));
const names = (items.body?.items || []).map((i) => i.name);
ok(new Set(names).size === names.length, 'items 표시명 유일');

// 2. 기관 마스터
const roster = await getJson({ op: 'roster' });
ok(roster.status === 200 && roster.body?.complete && roster.body?.count >= 350, 'roster', `count=${roster.body?.count} total=${roster.body?.totalCount} ${lap()}`);
const kicox = (roster.body?.organs || []).find((o) => o.name === '한국산업단지공단');
ok(!!kicox && !!kicox.region, 'roster 산단공·지역', JSON.stringify(kicox));

// 3. 항목별 기관 목록(정기)
const organs = await getJson({ op: 'organs', root: '20201' });
ok(organs.status === 200 && organs.body?.count >= 350, 'organs 20201', `count=${organs.body?.count} ${lap()}`);
const k = (organs.body?.organs || []).find((o) => o.id === 'C0208');
ok(!!k?.dn, 'organs 공시번호', `dn=${k?.dn}`);
const o70401 = await getJson({ op: 'organs', root: '70401' });
const k7 = (o70401.body?.organs || []).find((o) => o.id === 'C0208');
ok(k7?.files?.length >= 1, 'organs 70401 첨부 파싱', JSON.stringify(k7?.files?.slice(0, 2)));

// 4. 수시 목록 + 첨부
const susi = await getJson({ op: 'susi', root: '43006', apba: 'C0208', page: 1 });
ok(susi.status === 200 && susi.body?.items?.length > 0, 'susi 43006', `n=${susi.body?.items?.length} totalPage=${susi.body?.totalPage} ${lap()}`);
const e = susi.body?.items?.[0];
const files = await getJson({ op: 'files', dn: e?.dn || '0' });
ok(files.status === 200, 'files', `n=${files.body?.count} ${JSON.stringify(files.body?.files?.[0])}`);

// 5. 게시판 글(감사원 지적사항)
const b1 = await getJson({ op: 'susi', root: 'B1220-P2200', apba: 'C0208', page: 1 });
const be = b1.body?.items?.[0];
const board = await getJson({ op: 'board', rfn: be?.rfn, apba: 'C0208', dn: be?.dn, idx: be?.idx, table: be?.table, idxName: be?.idxName, bid: be?.bid });
ok(board.status === 200 && board.body?.attachments?.length > 0, 'board B1220', `첨부=${board.body?.attachments?.length} 링크=${board.body?.links?.length} 본문=${board.body?.text?.length}자 ${lap()}`);
console.log('  본문 앞부분:', JSON.stringify(board.body?.text?.slice(0, 120)));

// 6. 내부규정 목록
const rules = await getJson({ op: 'rules', inst: '한국산업단지공단', apba: 'C0208', page: 1 });
ok(rules.status === 200 && rules.body?.totalCount > 100, 'rules', `total=${rules.body?.totalCount} n=${rules.body?.items?.length} ${JSON.stringify(rules.body?.items?.[0])} ${lap()}`);

// 7. 내려받기(스트리밍) — pdf / file / upload / rule(seq)
async function dl(params) {
  const r = await fetch(q({ op: 'download', ...params }));
  const buf = r.status === 200 ? await r.arrayBuffer() : null;
  let name = '';
  try {
    name = decodeURIComponent(r.headers.get('x-file-name') || '');
  } catch {
    name = r.headers.get('x-file-name') || '';
  }
  return { status: r.status, size: buf?.byteLength ?? 0, name, ct: r.headers.get('content-type'), body: buf ? null : await r.json().catch(() => null), head: buf ? Buffer.from(buf.slice(0, 4)).toString('latin1') : '' };
}
const pdf = await dl({ kind: 'pdf', dn: k.dn });
ok(pdf.status === 200 && pdf.size > 10000 && pdf.head === '%PDF', 'download pdf', `${pdf.name} ${pdf.size}B ${pdf.ct} ${lap()}`);
const f = k7?.files?.[0];
const big = await dl({ kind: 'file', f: f?.id, d: k7?.dn, name: f?.name });
ok(big.status === 200 && big.size > 1000000 && big.head === '%PDF', 'download file(3MB)', `${big.name} ${big.size}B ${lap()}`);
const a = board.body?.attachments?.[0];
const up = await dl(a?.kind === 'upload' ? { kind: 'upload', spath: a.spath, sfile: a.sfile, name: a.name } : { kind: 'fileno', no: a?.no, name: a?.name });
ok(up.status === 200 && up.size > 1000, 'download upload', `${up.name} ${up.size}B ${lap()}`);
const rseq = rules.body?.items?.[0]?.seq;
const rule = await dl({ kind: 'rule', seq: rseq });
ok(rule.status === 200 && rule.size > 1000 && rule.name, 'download rule(seq)', `${rule.name} ${rule.size}B ${lap()}`);

// 8. 오류 처리
const nf = await dl({ kind: 'pdf', dn: '0000000000000001' });
ok(nf.status === 404 && nf.body?.error === 'NO_FILE', 'download 없는 공시 → 404 JSON', JSON.stringify(nf.body));
const bad = await getJson({ op: 'organs', root: '../etc' });
ok(bad.status === 400, 'bad param → 400', JSON.stringify(bad.body));
const unknown = await getJson({ op: 'nope' });
ok(unknown.status === 404, 'unknown op → 404');
const cross = await fetch(q({ op: 'health' }), { headers: { 'sec-fetch-site': 'cross-site' } });
ok(cross.status === 403, 'cross-site → 403');

console.log(`\n합계: PASS ${pass} / FAIL ${fail} (${lap()})`);
process.exit(fail ? 1 : 0);
