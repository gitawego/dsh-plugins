import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const compiledPath = join(root, '.client-build', 'index.js')
// client.bundle.js (NOT client.js): src/client.ts compiles to lib/client.js
// as the SERVER-side LSP client (manager.ts imports { createClient } from it);
// the browser bundle must not clobber that module.
const outputPath = join(root, 'lib', 'client.bundle.js')
const source = await readFile(compiledPath, 'utf8')
// The client entry id is the PACKAGE NAME (the host's boot graph keys bundles by
// package name; the bundle self-declares the same id so the loader can activate it).
const pkgName = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name
const wrapped = [
  `window.__ModuleLoader__.load({ id: "${pkgName}", factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
  source.replace(/\n?\/\/# sourceMappingURL=.*$/u, ''),
  'return module.exports; } });',
  '//# sourceMappingURL=client.bundle.js.map',
  '',
].join('\n')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, wrapped)

const rawMap = JSON.parse(await readFile(compiledPath + '.map', 'utf8'))
rawMap.file = 'client.bundle.js'
rawMap.sources = rawMap.sources.map((sourcePath) => `../src/client/${sourcePath.replace(/^\.\.\//u, '')}`)
await writeFile(outputPath + '.map', JSON.stringify(rawMap) + '\n')
await rm(join(root, '.client-build'), { recursive: true, force: true })
