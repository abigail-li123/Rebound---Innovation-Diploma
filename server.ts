// server.ts
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { apiRouter } from './api/logic.js';

dotenv.config();

console.log('[Diagnostic] Env Keys:', Object.keys(process.env).filter(k => k.includes('API') || k.includes('KEY') || k.includes('GEMINI') || k.includes('GOOGLE')));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json());

// Log all API requests for diagnostics
app.use('/api', (req, res, next) => {
  console.log(`[API ${req.method}] ${req.path} - ${new Date().toISOString()}`);
  next();
});

// Mount the API Router
app.use('/api', apiRouter);

async function configureServer() {
  if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }
}

// Start server if not in Vercel environment
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  configureServer().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
}

export default app;
