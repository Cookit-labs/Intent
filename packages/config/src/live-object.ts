/**
 * An object whose properties are read from `read()` at the moment they are
 * accessed, not when the object was made.
 *
 * Lets a constant that used to be fixed at startup (`stellarNetwork`, the USDC
 * issuer, the chain descriptor) follow the network of the request that is
 * running, without changing the dozens of places that read its fields.
 */
export function liveObject<T extends object>(read: () => T): T {
  return new Proxy({} as T, {
    get: (_target, prop) => Reflect.get(read(), prop),
    has: (_target, prop) => Reflect.has(read(), prop),
    ownKeys: () => Reflect.ownKeys(read()),
    getOwnPropertyDescriptor: (_target, prop) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(read(), prop)
      return descriptor === undefined ? undefined : { ...descriptor, configurable: true }
    },
  })
}
