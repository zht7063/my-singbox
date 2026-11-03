// The shipped TUI never connects to React DevTools. Ink's optional development
// entry is excluded at build time instead of adding an unused runtime peer.
export const terminalBuildOptions = {
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{
    name: 'exclude-ink-devtools',
    setup(build) {
      build.onResolve({ filter: /^\.\/devtools\.js$/ }, (args) => {
        if (/[/\\]node_modules[/\\]ink[/\\]build[/\\]/.test(args.importer))
          return { path: 'ink-devtools-disabled', namespace: 'terminal-release' };
      });
      build.onLoad({ filter: /.*/, namespace: 'terminal-release' }, () => ({ contents: 'export {};', loader: 'js' }));
    },
  }],
};
