import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

// The browser module system wraps ONE entry file in a `factory(require)` whose
// `require` only answers the host's external specifiers (react and friends).
// The section is written as several modules — the controller is testable without
// a DOM — so the compiled client is bundled into one self-contained file rather
// than shipped as the modules its source is written as.
const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const entry = join(root, 'src', 'client', 'index.tsx')
const outputPath = join(root, 'lib', 'client.js')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  // The host page provides these; bundling a copy would give the section its own
  // React instance, which breaks hooks and context.
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  logLevel: 'silent',
})
const source = result.outputFiles[0].text
const pkgName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name

const wrapped = [
  `window.__ModuleLoader__.load({ id: "${pkgName}", factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped)
await rm(join(root, '.client-build'), { recursive: true, force: true })
