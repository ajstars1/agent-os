const LIMIT = 1900

// Posts to the Discord webhook if one is configured; a missing webhook is not an error.
export const notify = async (text: string): Promise<boolean> => {
  const url = process.env.DISCORD_WEBHOOK_URL
  if (!url) return false
  const chunks: string[] = []
  let rest = text
  while (rest.length > LIMIT) {
    const cut = rest.lastIndexOf('\n', LIMIT) > 0 ? rest.lastIndexOf('\n', LIMIT) : LIMIT
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  chunks.push(rest)
  for (const content of chunks) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    })
    if (!res.ok) return false
  }
  return true
}
