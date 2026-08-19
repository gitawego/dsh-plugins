// Build the browser bundle.
//
// Unlike a TS/React client, dsh-ui-mobile's client is authored directly as a
// plain browser bundle (src/client/index.js) because it is dependency-free and
// has no JSX — keeping it free of the client/package build collisions the repo
// AGENT warns about. This step regenerates the published lib/client.js from the
// source so `pnpm build` always emits an up-to-date artifact.
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const sourcePath = join(root, 'src', 'client', 'index.js')
const outputPath = join(root, 'lib', 'client.js')

const source = await readFile(sourcePath, 'utf8')
if (!source.includes('window.__ModuleLoader__.load')) {
  throw new Error('ui-mobile: src/client/index.js must call window.__ModuleLoader__.load')
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, source + '\n//# sourceMappingURL=client.js.map\n')
