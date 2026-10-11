import type { PageInfo } from '../../shared/api/api-types'

// Refresh only the already displayed window, keeping cursor pagination and filters.
export async function refreshLoadedIndex<T extends { id: string }>(
  fetch: (cursor: string) => Promise<{ messages: T[]; page: PageInfo }>,
  previous: T[], previousPage: PageInfo,
) {
  let result = await fetch('')
  const messages = [...result.messages]
  let pages = 1
  while (messages.length < previous.length && result.page.hasMore && result.page.nextCursor && pages < 10) {
    result = await fetch(result.page.nextCursor)
    messages.push(...result.messages); pages++
  }
  if (messages.length < previous.length && result.page.hasMore && pages === 10) {
    const seen = new Set(messages.map(({ id }) => id))
    messages.push(...previous.filter(({ id }) => !seen.has(id)))
    return { messages, page: previousPage }
  }
  return { messages, page: result.page }
}
