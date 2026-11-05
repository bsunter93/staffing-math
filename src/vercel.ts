/** Entry point for Vercel. `npm run build` bundles this into api/index.mjs. */
import { handleFetch } from './fetch';

export default { fetch: handleFetch };
