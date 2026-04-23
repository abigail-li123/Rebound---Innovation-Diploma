// api/logic.ts
import express from 'express';
import axios from 'axios';
import { GoogleGenAI } from '@google/genai';

export const apiRouter = express.Router();

apiRouter.use(express.json());

apiRouter.get('/ping', (req, res) => {
  res.json({ 
    status: 'online', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    platform: process.env.VERCEL ? 'vercel' : 'standard'
  });
});

apiRouter.post('/canvas/sync-token', async (req, res) => {
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
    let targetUrl = canvasUrl;
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      targetUrl = 'https://' + targetUrl;
    }
    const url = new URL(targetUrl);
    let normalized = `${url.protocol}//${url.host}${url.pathname}`;
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    canvasUrl = normalized;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid Canvas URL format. Please provide a valid URL like https://school.instructure.com' });
  }

  try {
    console.log(`[API] Canvas Sync Initiated for: ${canvasUrl}`);
    const assignments = await fetchCanvasAssignments(canvasUrl, accessToken);
    res.json({ assignments });
  } catch (error: any) {
    const status = error.response?.status || 500;
    let message = error.response?.data?.errors?.[0]?.message || error.response?.data?.message || error.message;
    
    if (status === 401) {
      message = 'Invalid or expired access token. Please re-generate your token in Canvas settings.';
    }
    
    console.error('[API Error]', message);
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
    timeout: 8000 // Slightly tighter timeout for course list
  });

  const courses = Array.isArray(coursesRes.data) ? coursesRes.data : [];
  if (courses.length === 0) return [];

  // 2. Fetch Assignments for each active course
  const coursePromises = courses
    .filter((c: any) => c && c.id && (c.name || c.course_code))
    .slice(0, 10) // Further reduced to 10 courses for free tier stability
    .map(async (course: any) => {
      try {
        const assRes = await axios.get(`${canvasUrl}/api/v1/courses/${course.id}/assignments`, {
          headers: commonHeaders,
          params: { 
            "all_assignments": true,
            "order_by": "due_at",
            "include[]": "submission"
          },
          timeout: 8000
        });
        
        return (assRes.data || [])
          .filter((a: any) => a.published && !a.locked_for_user)
          .map((a: any) => ({
            ...a,
            courseName: (course.name || course.course_code || 'Academic').split(':').pop()?.trim()
          }));
      } catch (e) {
        console.error(`Failed to fetch course ${course.id}`);
        return [];
      }
    });

  const results = await Promise.all(coursePromises);
  return results.flat();
}
