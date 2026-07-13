// react-test-renderer ships no bundled type declarations and
// @types/react-test-renderer is deprecated for React 19, so we provide the
// minimal (untyped) surface used by hook/component unit tests here rather than
// pulling in an out-of-date type-only dependency. Test-only.
declare module 'react-test-renderer' {
  const TestRenderer: any;
  export const act: any;
  export const create: any;
  export default TestRenderer;
}
