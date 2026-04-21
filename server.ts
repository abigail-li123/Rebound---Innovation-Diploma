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

  // --- API Routes ---

  // Get Canvas Auth URL
  app.get('/api/auth/canvas/url', (req, res) => {
    const { canvasUrl } = req.query;
    const clientId = process.env.CANVAS_CLIENT_ID;
    const host = req.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/auth/canvas/callback`;

    if (!clientId) {
      return res.status(500).json({ error: 'CANVAS_CLIENT_ID not configured' });
    }

    const baseUrl = (canvasUrl as string) || process.env.CANVAS_DEFAULT_URL || 'https://canvas.instructure.com';
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      // No specific scope often works for general data or needs 'url:get|/api/v1/courses' etc
    });

    const authUrl = `${baseUrl}/login/oauth2/auth?${params.toString()}`;
    res.json({ url: authUrl });
  });

  // Canvas OAuth Callback
  app.get('/auth/canvas/callback', (req, res) => {
    const { code } = req.query;
    
    res.send(`
      <html>
        <body style="font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; background: #f8fafc;">
          <div style="text-align: center; padding: 2rem; background: white; border-radius: 1.5rem; shadow: 0 10px 15px -3px rgba(0,0,0,0.1);">
            <script>
              if (window.opener) {
                window.opener.postMessage({ type: 'CANVAS_AUTH_SUCCESS', code: '${code}' }, '*');
                window.close();
              } else {
                window.location.href = '/';
              }
            </script>
            <h2 style="margin-bottom: 0.5rem;">Authentication Successful</h2>
            <p style="color: #64748b;">Syncing your academic quests... This window will close automatically.</p>
          </div>
        </body>
      </html>
    `);
  });

  // Proxy to fetch assignments (via OAuth code)
  app.post('/api/canvas/sync', async (req, res) => {
    const { code, canvasUrl } = req.body;
    const clientId = process.env.CANVAS_CLIENT_ID;
    const clientSecret = process.env.CANVAS_CLIENT_SECRET;
    const host = req.get('host');
    const protocol = host?.includes('localhost') ? 'http' : 'https';
    const redirectUri = `${protocol}://${host}/auth/canvas/callback`;

    if (!clientId || !clientSecret) {
      return res.status(500).json({ error: 'Server not configured for Canvas OAuth' });
    }

    try {
      // 1. Exchange code for token
      const tokenRes = await axios.post(`${canvasUrl}/login/oauth2/token`, {
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code: code
      });

      const accessToken = tokenRes.data.access_token;
      const assignments = await fetchCanvasAssignments(canvasUrl, accessToken);
      res.json({ assignments });
    } catch (error: any) {
      console.error('Sync error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to sync with Canvas' });
    }
  });

  // Proxy to fetch assignments (via direct Manual Access Token)
  app.post('/api/canvas/sync-token', async (req, res) => {
    const { accessToken, canvasUrl } = req.body;
    if (!accessToken || !canvasUrl) {
      return res.status(400).json({ error: 'Missing token or URL' });
    }

    try {
      const assignments = await fetchCanvasAssignments(canvasUrl, accessToken);
      res.json({ assignments });
    } catch (error: any) {
      console.error('Manual sync error:', error.response?.data || error.message);
      res.status(500).json({ error: 'Failed to sync with Canvas using provided token' });
    }
  });

  async function fetchCanvasAssignments(canvasUrl: string, accessToken: string) {
    // 1. Fetch Courses
    const coursesRes = await axios.get(`${canvasUrl}/api/v1/courses`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { enrollment_state: 'active' }
    });

    // 2. Fetch Assignments for each active course
    let allAssignments: any[] = [];
    const coursePromises = (coursesRes.data || [])
      .filter((c: any) => c.id && (c.name || c.course_code))
      .map(async (course: any) => {
        try {
          const assRes = await axios.get(`${canvasUrl}/api/v1/courses/${course.id}/assignments`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            // Removed bucket restriction to get more assignments, or we can use multiple buckets.
            // For a student who was absent, "overdue" and "future" are critical.
            params: { 
              "all_assignments": true,
              "order_by": "due_at" 
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
    allAssignments = results.flat();
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
