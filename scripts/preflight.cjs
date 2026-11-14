const fs = require('node:fs');
for (const f of ['Dockerfile','compose.yaml','render.yaml','migrations/001_initial.sql','src/main.ts','scripts/migrate.cjs','scripts/import_ai_news.py']) {
 if (!fs.existsSync(f)) {console.error('MISSING',f);process.exitCode=1;} else console.log('OK',f);
}
if (fs.existsSync('.env')) console.log('WARNING: .env exists locally; .gitignore excludes it.');
