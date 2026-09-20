/** esbuild inlines `*.html` imports as strings at build time (see scripts/build.mjs). */
declare module '*.html' {
  const html: string;
  export default html;
}
