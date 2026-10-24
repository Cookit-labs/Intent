import type { JSX as ReactJSX } from 'react'

/**
 * React 19 dropped the global `JSX` namespace in favour of `React.JSX`. Every
 * component here names its return type `JSX.Element`, so the global name is
 * kept as an alias rather than rewritten at each call site.
 */
declare global {
  namespace JSX {
    type Element = ReactJSX.Element
    type ElementClass = ReactJSX.ElementClass
    type IntrinsicElements = ReactJSX.IntrinsicElements
  }
}
