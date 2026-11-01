// Serve exactly the files uploaded to Pages, including local Three.js modules
// and compressed geometry. Run npm run bake && npm run build first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] || process.env.PORT || 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer from 0 to 65535.');
if (!fs.existsSync(path.join(root, 'generated/manifest.json'))) throw new Error('No release build found. Run npm run bake && npm run build first.');
const server = await startServer(port, root);
console.log(`Serving the Pages build at http://localhost:${server.port}/`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
