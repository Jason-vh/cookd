/**
 * A stopwatch for the work that is allowed to be slow.
 *
 * Building a kitchen is the one place in the renderer that may block, which is
 * exactly why nobody notices when it stops being reasonable about it. The
 * timings are printed in development only; in a production build the branch is
 * constant and the whole thing folds away.
 */
export function timed<T>(label: string, work: () => T): T {
  if (!import.meta.env.DEV) return work();
  const start = performance.now();
  const result = work();
  console.info(`[perf] ${label} ${(performance.now() - start).toFixed(1)}ms`);
  return result;
}
