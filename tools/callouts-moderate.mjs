// Operator moderation for callouts. Runs against the SQLite file directly; there is no HTTP admin route.
//   bun tools/callouts-moderate.mjs list [--hidden] [--db path]
//   bun tools/callouts-moderate.mjs hide <id> [--db path]
//   bun tools/callouts-moderate.mjs show <id> [--db path]
// The posting mode itself is PLUGGED_CALLOUTS=open|premoderated|readonly|off (restart to apply).
import { Database } from 'bun:sqlite';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2), flag = name => { const i = args.indexOf(name); return i === -1 ? null : args.splice(i, 2)[1] ?? ''; };
const hiddenOnly = args.includes('--hidden') && args.splice(args.indexOf('--hidden'), 1);
const path = flag('--db') || process.env.PLUGGED_DB_PATH || fileURLToPath(new URL('../runtime/launches.sqlite', import.meta.url));
const [command, id] = args;
const db = new Database(path);
if (!db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='callouts'").get()) { console.log('No callouts table yet.'); process.exit(0); }
if (command === 'list') {
  const rows = db.query(`SELECT id, token, author, hidden, reports, created, text FROM callouts ${hiddenOnly ? 'WHERE hidden = 1' : ''} ORDER BY created DESC LIMIT 100`).all();
  for (const r of rows) console.log(`${r.id} ${r.hidden ? 'HIDDEN' : 'shown '} reports=${r.reports} ${new Date(r.created).toISOString()} ${r.token} ${r.author}\n  ${JSON.stringify(r.text)}`);
  console.log(`${rows.length} callout(s).`);
} else if ((command === 'hide' || command === 'show') && /^[0-9a-f-]{36}$/i.test(id ?? '')) {
  const changed = db.query('UPDATE callouts SET hidden = ? WHERE id = ?').run(command === 'hide' ? 1 : 0, id).changes;
  console.log(changed ? `${command === 'hide' ? 'Hidden' : 'Shown'}: ${id}` : `Not found: ${id}`);
  process.exit(changed ? 0 : 1);
} else {
  console.error('Usage: bun tools/callouts-moderate.mjs list [--hidden] | hide <id> | show <id> [--db path]');
  process.exit(2);
}
