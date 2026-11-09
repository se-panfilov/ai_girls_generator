import { nodeTestConfig } from '../../configs/vitest.config.mjs';
import viteConfig from './vite.config.mjs';

export default nodeTestConfig({ root: viteConfig.root, resolve: viteConfig.resolve });
