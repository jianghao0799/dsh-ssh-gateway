import { readFile, writeFile } from 'node:fs/promises';
const base = new URL('./', import.meta.url);
const source = await readFile(new URL('client.source.js', base), 'utf8');
await writeFile(new URL('client.js', base), source);
console.log('Built local Harness SSH workspace client');
