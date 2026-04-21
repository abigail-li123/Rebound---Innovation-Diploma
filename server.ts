import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Log all API requests for diagnostics
  app.use('/api', (req, res, next) => {
    console.log(`[API ${req.method}] ${req.path} - ${new Date().toISOString()}`);
    next();
  });

  // --- API Routes ---

  app.get('/api/ping', (req, res) => {
    res.json({ 
      status: 'online', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'development'
    });
  });

  // Proxy to fetch assignments (via direct Manual Access Token)
  app.post('/api/canvas/sync-token', async (req, res) => {
    let { accessToken, canvasUrl } = req.body;
    if (!accessToken || !canvasUrl) {
      return res.status(400).json({ error: 'Missing token or URL' });
    }

    accessToken = accessToken.trim();
    canvasUrl = canvasUrl.trim();

    // Normalize URL
    try {
      // Ensure the URL has a protocol
      let targetUrl = canvasUrl;
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        targetUrl = 'https://' + targetUrl;
      }
      const url = new URL(targetUrl);
      // Construct base URL preserving protocol, hostname, port, and pathname (for subpath installs)
      // We trim trailing slashes to avoid issues when appending /api/v1/...
      let normalized = `${url.protocol}//${url.host}${url.pathname}`;
      if (normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      canvasUrl = normalized;
    } catch (e) {
      return res.status(400).json({ error: 'Invalid Canvas URL format. Please provide a valid URL like https://school.instructure.com' });
    }

    try {
      console.log(`Attempting Canvas sync for host: ${canvasUrl}`);
      const assignments = await fetchCanvasAssignments(canvasUrl, accessToken);
      res.json({ assignments });
    } catch (error: any) {
      const status = error.response?.status || 500;
      const message = error.response?.data?.errors?.[0]?.message || error.response?.data?.message || error.message;
      console.error('Manual sync error detailed:', message);
      res.status(status).json({ error: `Canvas Error: ${message}` });
    }
  });

  async function fetchCanvasAssignments(canvasUrl: string, accessToken: string) {
    // 1. Fetch Courses
    const coursesRes = await axios.get(`${canvasUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { enrollment_state: 'active', per_page: 50 }
    });

    const courses = Array.isArray(coursesRes.data) ? coursesRes.data : [];
    
    // 2. Fetch Assignments for each active course
    const coursePromises = courses
      .filter((c: any) => c && c.id && (c.name || c.course_code))
      .map(async (course: any) => {
        try {
          const assRes = await axios.get(`${canvasUrl}/api/v1/courses/${course.id}/assignments`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            // Removed bucket restriction to get more assignments, or we can use multiple buckets.
            // For a student who was absent, "overdue" and "future" are critical.
            params: { 
              "all_assignments": true,
              "order_by": "due_at",
              "include[]": "submission"
            }
          });
          
          // Filter to only include active, published assignments that likely appear in the Assignments tab
          return (assRes.data || [])
            .filter((a: any) => a.published && !a.locked_for_user)
            .map((a: any) => ({
              ...a,
              courseName: course.name || course.course_code
            }));
        } catch (e) {
          console.error(`Failed to fetch for course ${course.id}`);
          return [];
        }
      });

    const results = await Promise.all(coursePromises);
    const allAssignments = results.flat();
    return allAssignments;
  }

  // --- Vite Middleware ---
  if (process.env.NODE_ENV !== 'production') {
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
