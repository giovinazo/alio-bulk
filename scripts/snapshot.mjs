// 항목·기관 목록을 정적 JSON 으로 저장한다(첫 화면이 중계 함수를 기다리지 않도록).
// 배포 전에 한 번 돌린다:  node scripts/snapshot.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const { GET } = await import('../api/alio.js');
const outDir = new URL('../public/data/', import.meta.url);
await mkdir(outDir, { recursive: true });

for (const op of ['items', 'roster']) {
  const res = await GET(new Request(`http://local/api/alio?op=${op}`));
  const body = await res.json();
  if (res.status !== 200 || (op === 'roster' && !body.complete)) {
    throw new Error(`${op} 실패: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  await writeFile(new URL(`${op}.json`, outDir), JSON.stringify(body));
  console.log(`${op}: ${body.count}건 → public/data/${op}.json (${body.fetchedAt})`);
}
