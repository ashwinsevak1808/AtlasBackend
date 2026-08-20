import express, { type Application, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

import routes from './src/routes/index.js';
import { errorHandler } from './src/middleware/error-handler.js';
import { generalLimiter } from './src/middleware/rate-limit.js';
import { apiResponse } from './src/utils/api-response.js';
import { config } from './src/config/env.js';


const app: Application = express();

/* Cloud Run terminates TLS and forwards, so req.ip is the proxy without this.
   Sessions, audit rows and the rate limiter all key on it. */
app.set('trust proxy', 1);

// Security Middleware
app.use(helmet());

/* An allowlist rather than a single origin, so preview deployments and local
   development work without editing this file. Requests with no Origin — the
   Next.js proxy, curl, health probes — are allowed through; CORS is a browser
   mechanism and blocking them here would only break the proxy. */
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} is not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie', 'x-atlas-key'],
}));

/* Auth bodies are small. A cap stops a large payload being parsed before any
   handler gets a chance to reject it. */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

import { setupSwagger } from './src/config/swagger.js';

// Health check endpoints for Cloud Run / Load Balancer probes
app.get(['/', '/health', '/api/health'], (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', message: 'Atlas Backend API Server Running' });
});

// Swagger OpenAPI Documentation UI
setupSwagger(app);

// Logging
app.use(morgan('dev'));


// Rate Limiting — see src/middleware/rate-limit.ts for the auth-specific ones.
app.use('/api/', generalLimiter);

// API Routes
app.use('/api', routes);

// 404 Handler
app.use((_req: Request, res: Response) => {
  return apiResponse(res, 404, 'Endpoint not found', null, false);
});


// Global Error Handler
app.use(errorHandler);

export default app;
