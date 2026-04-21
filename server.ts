// server.ts
import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

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
  if (accessToken.startsWith('Bearer ')) {
    accessToken = accessToken.slice(7).trim();
  }
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
    let message = error.response?.data?.errors?.[0]?.message || error.response?.data?.message || error.message;
    
    if (status === 401) {
      message = 'Invalid or expired access token. Please re-generate your token in Canvas settings.';
    }
    
    console.error('Manual sync error detailed:', message);
    res.status(status).json({ error: `Canvas Error: ${message}` });
  }
});

async function fetchCanvasAssignments(canvasUrl: string, accessToken: string) {
  const commonHeaders = {
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'Rebound-Tactical-Planner/1.0 (Educational App)'
  };

  // 1. Fetch Courses
  const coursesRes = await axios.get(`${canvasUrl}/api/v1/courses`, {
    headers: commonHeaders,
    params: { enrollment_state: 'active', per_page: 50 },
    timeout: 10000
  });

  const courses = Array.isArray(coursesRes.data) ? coursesRes.data : [];
  
  // 2. Fetch Assignments for each active course
  const coursePromises = courses
    .filter((c: any) => c && c.id && (c.name || c.course_code))
    .map(async (course: any) => {
      try {
        const assRes = await axios.get(`${canvasUrl}/api/v1/courses/${course.id}/assignments`, {
          headers: commonHeaders,
          params: { 
            "all_assignments": true,
            "order_by": "due_at",
            "include[]": "submission"
          },
          timeout: 10000
        });
        
        return (assRes.data || [])
          .filter((a: any) => a.published && !a.locked_for_user)
          .map((a: any) => ({
            ...a,
            courseName: (course.name || course.course_code || 'Academic').split(':').pop()?.trim()
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

async function configureServer() {
  // Vite Middleware / Static Files setup
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

// Start server if not in Vercel/imported
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  configureServer().then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  });
}

export default app;
