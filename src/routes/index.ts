import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import flowRoutes from '../modules/flows/flow.routes.js';

const router = Router();

// Health Check Endpoint
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/flows', flowRoutes);

export default router;
