const LOCATED_FRAME = /[a-z][\w+.-]*:\/\/|webpack-internal:/i
const EXTENSION_FRAME = /(?:chrome|moz|safari-web)-extension:\/\//

/** True only if the extension alone is on the stack, so the app had no part in the error. */
export function isExtensionOnlyStack(stack: string | undefined): boolean {
  if (stack === undefined) return false
  const located = stack
    .split('\n')
    .filter((line) => line.trim().startsWith('at ') && LOCATED_FRAME.test(line))
  return located.length > 0 && located.every((line) => EXTENSION_FRAME.test(line))
}

function callerStack(above: (...args: unknown[]) => void): string | undefined {
  const holder: { stack?: string } = {}
  Error.captureStackTrace?.(holder, above)
  return holder.stack
}

/**
 * Wallet extensions log their own failed requests with `console.error`, such as
 * Slush whenever a connection is declined, and Next's dev overlay reports those as
 * app errors. They go to `console.debug` instead, so they stay findable.
 */
export function quietExtensionErrors(
  target: Pick<Console, 'error' | 'debug'>,
  stack: (above: (...args: unknown[]) => void) => string | undefined = callerStack
): void {
  const error = target.error.bind(target)
  const debug = target.debug.bind(target)
  const wrapper = (...args: unknown[]): void => {
    if (isExtensionOnlyStack(stack(wrapper))) debug(...args)
    else error(...args)
  }
  target.error = wrapper
}
