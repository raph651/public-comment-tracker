import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';

const rootDir = process.cwd();
const srcFile = path.join(rootDir, 'src', 'app.ts');
const outFile = path.join(rootDir, 'docs', 'app.js');

const tsSource = fs.readFileSync(srcFile, 'utf8');

const stripTypes = (module as unknown as {
  stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string;
}).stripTypeScriptTypes;

if (typeof stripTypes !== 'function') {
  throw new Error('Node.js 22.6+ required for native stripTypeScriptTypes compilation.');
}

const jsOutput = stripTypes(tsSource, { mode: 'strip' });
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, jsOutput, 'utf8');
console.log(`Built ${path.relative(rootDir, outFile)} (${jsOutput.length} bytes)`);
