// Thin wrapper for Cloudflare Workers.
// React Router's build outputs the fetch handler as a named export
// (entry.module.default), but wrangler needs `export default { fetch }`.
import { entry } from './build/server/index.js';
export default entry.module.default;
