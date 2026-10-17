import { createApp } from '../src/server.js';

// Vercel calls this file. createApp() does not listen.
// src/server.js calls start() only when it is the process entry (npm start).
const app = createApp();

export default app;
