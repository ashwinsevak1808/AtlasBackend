import { Router } from 'express';
import authRoutes from '../modules/auth/auth.routes.js';
import flowRoutes from '../modules/flows/flow.routes.js';
import subscriberRoutes from '../modules/subscribers/subscriber.routes.js';

const router = Router();

// Health Check Endpoint
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.use('/auth', authRoutes);
router.use('/flows', flowRoutes);
router.use('/subscribers', subscriberRoutes);

export default router;
