import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  breaks: true,
  typographer: false,
})

markdown.validateLink = (href: string) => {
  if (href.startsWith('#')) return true
  try {
    const url = new URL(href)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

markdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  const token = tokens[index]!
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noopener noreferrer nofollow')
  return renderer.renderToken(tokens, index, options)
}

markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index]?.content ?? '')

export function renderSecureMarkdown(content: string): string {
  return markdown.render(content)
}
