// api/index.ts
import express from 'express';
import { apiRouter } from './logic.js';

const app = express();
app.use(express.json());

// Main API entry point
app.use('/api', apiRouter);

// Export for Vercel
export default app;
