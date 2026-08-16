/** Minimal LSP wire types used by dsh-lsp tools and the manager surface. */
export interface Position {
  line: number
  character: number
}

export interface Range {
  start: Position
  end: Position
}

export interface Diagnostic {
  range: Range
  severity?: number
  code?: string | number
  source?: string
  message: string
}
