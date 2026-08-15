/**
 * Normalization: convert backend-specific responses into the portable
 * `WebSearchSource` shape (url always, title/snippet/publishedAt optional),
 * dedupe by url, cap snippet length, and enforce maxResults (setting truncated).
 */
import type { WebSearchSource } from '@deepseek-ai/dsh-web'

/** A backend-native source before normalization. */
export interface RawSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

export interface NormalizedResult {
  sources: WebSearchSource[]
  truncated: boolean
}

/**
 * Parse the `text` payload returned by the Parallel MCP endpoint. It wraps a
 * JSON string with `results[]` items `{url,title,publish_date,excerpts}`.
 * Prefers the first non-empty excerpt as the snippet.
 */
export function parseParallelText(text: string): RawSource[] {
  let parsed: any
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const results = Array.isArray(parsed?.results) ? parsed.results : []
  const out: RawSource[] = []
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || r.url.length === 0) continue
    const source: RawSource = { url: r.url }
    if (typeof r.title === 'string' && r.title.length > 0) source.title = r.title
    const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter((e: any) => typeof e === 'string' && e.length > 0) : []
    if (excerpts.length > 0) source.snippet = excerpts[0] as string
    if (typeof r.publish_date === 'string' && r.publish_date.length > 0) source.publishedAt = r.publish_date
    out.push(source)
  }
  return out
}

/**
 * Parse the Exa MCP text payload into sources. Exa returns a prose block with
 * fields like `Title:`, `URL:`, `Published:`. We split on `URL:` markers
 * to emit one source per detected URL.
 */
export function parseExaText(text: string): RawSource[] {
  const out: RawSource[] = []
  if (!text) return out
  const lines = text.split('\n')
  let current: RawSource | undefined
  let lastTitle: string | undefined
  for (const rawLine of lines) {
    const line = rawLine.trim()
    const lower = line.toLowerCase()
    if (lower.startsWith('url:')) {
      if (current) out.push(current)
      current = { url: line.slice(4).trim() }
      if (lastTitle && lastTitle.toLowerCase() !== 'n/a') {
        current.title = lastTitle
      }
      lastTitle = undefined
    } else if (lower.startsWith('title:')) {
      lastTitle = line.slice(6).trim()
    } else if (lower.startsWith('published:')) {
      const v = line.slice(10).trim()
      if (current && v && v.toLowerCase() !== 'n/a') current.publishedAt = v
    }
  }
  if (current) {
    if (lastTitle && !current.title && lastTitle.toLowerCase() !== 'n/a') current.title = lastTitle
    out.push(current)
  }
  if (out.length === 0) {
    const m = text.match(/https?:\/\/[^\s\n\u201d]+/)
    if (m && m[0]) out.push({ url: m[0] })
  }
  return out
}

/**
 * Parse an Anthropic-style /v1/messages response into sources. Reads
 * `web_search_tool_result` blocks; each `web_search_result` item becomes a
 * source (url + title). `encrypted_content` is opaque and ignored.
 */
export function parseLlmResponse(body: any): RawSource[] {
  const blocks = Array.isArray(body?.content) ? body.content : []
  const out: RawSource[] = []
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result') continue
    const items = Array.isArray(block.content) ? block.content : []
    for (const item of items) {
      if (item?.type !== 'web_search_result') continue
      if (typeof item.url !== 'string' || item.url.length === 0) continue
      const source: RawSource = { url: item.url }
      if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title
      if (typeof item.page_age === 'string' && item.page_age.length > 0) source.publishedAt = item.page_age
      // MiniMax (and other Anthropic-compatible servers) return plaintext
      // `content` on each result; opencode Go returns opaque encrypted_content.
      if (typeof item.content === 'string' && item.content.length > 0) source.snippet = item.content
      out.push(source)
    }
  }
  return out
}

/**
 * Deduplicate by url (first wins), cap snippet length, and truncate to
 * maxResults (flagging truncated).
 */
export function dedupeAndCap(raw: RawSource[], maxResults: number, snippetMaxChars: number): NormalizedResult {
  const seen = new Set<string>()
  const sources: WebSearchSource[] = []
  for (const r of raw) {
    if (seen.has(r.url)) continue
    seen.add(r.url)
    const source: WebSearchSource = {
      url: r.url,
      ...(r.title ? { title: r.title } : {}),
      ...(r.snippet ? { snippet: r.snippet.length > snippetMaxChars ? r.snippet.slice(0, snippetMaxChars) : r.snippet } : {}),
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
    }
    sources.push(source)
  }
  const truncated = maxResults > 0 && sources.length > maxResults
  return {
    sources: truncated ? sources.slice(0, maxResults) : sources,
    truncated,
  }
}

/**
 * Parse an OpenAI-compatible /chat/completions response into sources. Native
 * web-search providers vary: some return results in `message.tool_calls` /
 * `message.web_search`, others as a `search_context`/cited JSON string in
 * content. We extract any array of {url,title,snippet} items we can find.
 */
export function parseOpenAiResponse(body: any): RawSource[] {
  const out: RawSource[] = []
  const choice = Array.isArray(body?.choices) ? body.choices[0] : undefined
  const message = choice?.message
  // 1) message.web_search (OpenAI-style structured results)
  const ws = message?.web_search
  if (ws && Array.isArray(ws.results)) {
    for (const item of ws.results) {
      if (!item || typeof item.url !== 'string' || item.url.length === 0) continue
      const source: RawSource = { url: item.url }
      if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title
      if (typeof item.snippet === 'string' && item.snippet.length > 0) source.snippet = item.snippet
      out.push(source)
    }
  }
  // 2) cited JSON string in content (some compatible servers)
  if (out.length === 0 && typeof message?.content === 'string' && message.content.includes('"url"')) {
    try {
      const first = message.content.match(/{[^}]*}"?url"?\s*:/s)
      const parsed = JSON.parse(message.content.slice(message.content.indexOf('['), message.content.lastIndexOf(']') + 1))
      if (Array.isArray(parsed)) {
        for (const item of parsed) builder(out, item)
      } else if (parsed && Array.isArray(parsed.results)) {
        for (const item of parsed.results) builder(out, item)
      }
    } catch {
      /* ignore unparseable */
    }
  }
  return out
}

function builder(out: RawSource[], item: any): void {
  if (!item || typeof item.url !== 'string' || item.url.length === 0) return
  const source: RawSource = { url: item.url }
  if (typeof item.title === 'string' && item.title.length > 0) source.title = item.title
  if (typeof item.snippet === 'string' && item.snippet.length > 0) source.snippet = item.snippet
  out.push(source)
}