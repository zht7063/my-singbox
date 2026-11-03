// The shipped TUI never connects to React DevTools. Ink's optional development
// entry is excluded at build time instead of adding an unused runtime peer.
export const terminalBuildOptions = {
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'terminal-runtime-options',
    setup(build) {
      build.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => {
        if (/[/\\]node_modules[/\\]ink[/\\]build[/\\]/.test(args.importer))
          return { path: 'ink-devtools-disabled', namespace: 'terminal-release' };
      });
      // Ink 6 suppresses all live frames when CI variables are present, even in
      // a real terminal. The TUI validates stdin/stdout TTYs before rendering.
      build.onResolve({ filter: /^is-in-ci$/ }, (args) => {
        if (/[/\\]node_modules[/\\]ink[/\\]build[/\\]/.test(args.importer))
          return { path: 'ink-terminal-mode', namespace: 'terminal-release' };
      });
      build.onLoad({ filter: /.*/, namespace: 'terminal-release' }, (args) => ({
        contents: args.path === 'ink-terminal-mode'
          ? 'export default !process.stdin.isTTY || !process.stdout.isTTY;'
          : 'export {};',
        loader: 'js',
      }));
    },
  }],
};
