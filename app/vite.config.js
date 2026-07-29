import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  },
  build: {
    // The remaining chunks above the default 500kB warning are single
    // third-party vendor bundles, each already isolated as far as this
    // build can take it: @neo4j-nvl's graph engine + its CoSE-Bilkent
    // layout Web Worker only load when Graph Explorer or a row's "Graph"
    // modal is actually opened (dynamic import, see App.jsx/GraphView.jsx);
    // neo4j-driver loads at sign-in but now as its own cacheable chunk
    // (manualChunks below) instead of inline with app code. None of the
    // three split further without swapping to a different library, which
    // is out of scope for a bundling change - the number here just stops
    // Vite re-flagging a state we've already deliberately isolated. The
    // entry chunk actually downloaded on first load is ~40kB; watch that
    // one, not this limit, for real regressions.
    chunkSizeWarningLimit: 1800,
    rollupOptions: {
      output: {
        // Split large, independently-cacheable vendor code out of the main
        // entry chunk. react/react-dom/react-router-dom change far less
        // often than app code; neo4j-driver is large enough on its own to
        // be worth its own chunk. @neo4j-nvl and jszip already land in
        // their own chunks automatically since they're only reachable via
        // dynamic import() (see App.jsx's lazy() routes and backup.js).
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // Exact top-level package match (node_modules/<pkg>/) - a loose
          // substring check here would also catch unrelated packages whose
          // path happens to contain "react", e.g. @neo4j-nvl/react.
          const pkgMatch = id.match(/node_modules\/([^/]+)\//);
          const pkg = pkgMatch && pkgMatch[1];
          if (pkg === 'react' || pkg === 'react-dom' || pkg === 'react-router-dom' || pkg === 'scheduler') {
            return 'vendor-react';
          }
          if (pkg === 'neo4j-driver' || pkg === 'neo4j-driver-lite') {
            return 'vendor-neo4j-driver';
          }
          return undefined;
        }
      }
    }
  }
});
