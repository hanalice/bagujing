export const formatBreadcrumbCategoryName = (name: string, head = 2, tail = 2) => {
  const normalized = (name ?? '').trim()
  if (!normalized) return ''

  const chars = Array.from(normalized)
  if (chars.length <= head + tail) return normalized

  const headPart = chars.slice(0, head).join('')
  const tailPart = chars.slice(Math.max(chars.length - tail, head), chars.length).join('')
  return `${headPart}…${tailPart}`
}
