// Official LSP server catalog — the config-driven defaults for the plugin.
// Every entry is the official language server for its language (never a linter
// standing in for a type-checker). Users override via the `lsp` settings
// namespace (per-server `servers` map).

export interface CatalogServer {
  id: string
  /** Default spawn command. Overridable per-server. */
  command: string[]
  /** File extensions that route to this server. */
  extensions: string[]
  /** Marker files used for project-root detection (NearestRoot). */
  rootMarkers: string[]
  /** Explicit languageId override; otherwise derived from language.ts. */
  languageId?: string
  /** Opt-in managed install when the binary is missing. */
  autoDownload?: boolean
  /** Download strategy for autoDownload. */
  download?: 'npm' | 'github-release' | 'go-install'
}

export const DEFAULT_SERVERS: Record<string, CatalogServer> = {
  typescript: {
    id: 'typescript',
    command: ['typescript-language-server', '--stdio'],
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    rootMarkers: ['package-lock.json', 'bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock'],
    autoDownload: true,
    download: 'npm',
  },
  kotlin: {
    id: 'kotlin',
    command: ['kotlin-lsp'],
    extensions: ['.kt', '.kts'],
    rootMarkers: [
      'settings.gradle.kts',
      'settings.gradle',
      'gradlew',
      'gradlew.bat',
      'build.gradle.kts',
      'build.gradle',
      'pom.xml',
    ],
    autoDownload: true,
    download: 'github-release',
  },
  gopls: {
    id: 'gopls',
    command: ['gopls'],
    extensions: ['.go'],
    rootMarkers: ['go.work', 'go.mod', 'go.sum'],
    autoDownload: true,
    download: 'go-install',
  },
  'rust-analyzer': {
    id: 'rust-analyzer',
    command: ['rust-analyzer'],
    extensions: ['.rs'],
    rootMarkers: ['Cargo.toml'],
  },
  clangd: {
    id: 'clangd',
    command: ['clangd', '--background-index', '--clang-tidy'],
    extensions: ['.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    rootMarkers: ['compile_commands.json'],
  },
  pyright: {
    id: 'pyright',
    command: ['pyright-langserver', '--stdio'],
    extensions: ['.py'],
    rootMarkers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg'],
    autoDownload: true,
    download: 'npm',
  },
  'ruby-lsp': {
    id: 'ruby-lsp',
    command: ['ruby-lsp'],
    extensions: ['.rb', '.rake', '.gemspec', '.ru'],
    rootMarkers: ['Gemfile'],
  },
  'elixir-ls': {
    id: 'elixir-ls',
    command: ['elixir-ls'],
    extensions: ['.ex', '.exs'],
    rootMarkers: ['mix.exs'],
  },
  zls: {
    id: 'zls',
    command: ['zls'],
    extensions: ['.zig', '.zon'],
    rootMarkers: ['build.zig', 'build.zig.zon'],
  },
}
