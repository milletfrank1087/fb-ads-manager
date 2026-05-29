const Database = require('better-sqlite3');
const db = new Database('../data/dashboard.db', { readonly: true });
const ids = [
  '958603880058999_1491649575621290',
  '958603880058999_1321158319966418',
  '958603880058999_1527769515419763',
  '958603880058999_4397463993843124',
];
console.log('Deleted-target IDs status:');
for (const id of ids) {
  const r = db.prepare('SELECT id, deleted FROM comments WHERE id = ?').get(id);
  console.log('  ' + id + ' => ' + (r ? ('deleted=' + r.deleted) : 'ABSENT'));
}
const kept = '958603880058999_897176359943515';
const k = db.prepare('SELECT id, deleted FROM comments WHERE id = ?').get(kept);
console.log('Kept #5 ' + kept + ' => ' + (k ? ('deleted=' + k.deleted) : 'ABSENT'));
const tot = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE deleted=0').get().n;
const del = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE deleted=1').get().n;
console.log('Totals: active=' + tot + ' deleted=' + del);
