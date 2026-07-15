import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const handlers = ['api', 'ocr', 'enrich', 'reset'];

rmSync('dist', { recursive: true, force: true });

await Promise.all(
  handlers.map((h) =>
    build({
      entryPoints: [`src/handlers/${h}.ts`],
      outfile: `dist/${h}/index.mjs`,
      bundle: true,
      platform: 'node',
      target: 'node22',
      format: 'esm',
      minify: true,
      // Some transitive deps still use require(); give ESM bundles a shim.
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
    })
  )
);

console.log(`bundled: ${handlers.join(', ')}`);
