import { fileURLToPath } from 'node:url';

import { nodePackageConfig } from '../../configs/vite.config.mjs';

export default nodePackageConfig({ root: fileURLToPath(new URL('.', import.meta.url)), namespace: 'seethrough-bundle', modules: ['index', 'cli', 'runner'] });
