// Node loader hook for the parity harnesses: the repo's package.json says
// "type": "commonjs", but the renderer's .js files are browser ES modules.
// Load anything under src/renderer/ as an ES module.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && url.includes('/src/renderer/') && url.endsWith('.js')) {
    return { format: 'module', source: fs.readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  return nextLoad(url, context);
}
