export async function prepareTogether<A, B>(first: (signal: AbortSignal) => Promise<A>, second: (signal: AbortSignal) => Promise<B>): Promise<[A, B]> {
  const controller = new AbortController()
  const run = async <T>(work: (signal: AbortSignal) => Promise<T>) => {
    try { return await work(controller.signal) }
    catch (error) { controller.abort(error); throw error }
  }
  const [a, b] = await Promise.allSettled([run(first), run(second)])
  if (a.status === 'rejected') throw a.reason
  if (b.status === 'rejected') throw b.reason
  return [a.value, b.value]
}
