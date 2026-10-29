import { Router } from 'express';
import type { AppDeps } from '../app-types';
import { adminController } from '../controllers/adminController';
import { authController } from '../controllers/authController';
import { publicController } from '../controllers/publicController';
import { companyScope, limiter, publicGate, requireAdmin, requirePublicSession, requireSuperadmin } from '../middleware/security';
import { asyncHandler as h } from '../utils/errors';

export function publicRouter(deps: AppDeps) {
  const r = Router({ mergeParams: true });
  const c = publicController(deps);
  const { windowMs, sessions, chat } = deps.cfg.rate;
  const auth = requirePublicSession(deps);

  // El slug identifica la empresa; CORS y orígenes se resuelven por empresa.
  r.use('/:slug', publicGate(deps));
  r.post('/:slug/sessions', limiter(windowMs, sessions), h(c.createSession));
  r.get('/:slug/config', auth, h(c.config));
  r.post('/:slug/events', auth, h(c.event));
  r.post('/:slug/chat', limiter(windowMs, chat), auth, h(c.chat));
  r.post('/:slug/handoffs', auth, h(c.createHandoff));
  r.post('/:slug/handoffs/:id/whatsapp-click', auth, h(c.whatsappClick));
  return r;
}

export function adminRouter(deps: AppDeps) {
  const r = Router();
  const a = adminController(deps);
  const au = authController(deps);
  const guard = requireAdmin(deps);
  const sup = requireSuperadmin;

  r.post('/auth/login', limiter(deps.cfg.rate.windowMs, deps.cfg.rate.login), h(au.login));
  r.post('/auth/logout', guard, h(au.logout));
  r.get('/auth/me', guard, au.me);

  r.get('/admins', guard, sup, h(a.listAdmins));
  r.post('/admins', guard, sup, h(a.createAdmin));
  r.patch('/admins/:id', guard, sup, h(a.updateAdmin));

  r.get('/companies', guard, h(a.listCompanies));
  r.post('/companies', guard, sup, h(a.createCompany));

  const co = Router({ mergeParams: true });
  co.use(guard, companyScope(deps));
  co.get('/', h(a.getCompany));
  co.patch('/', h(a.updateCompany));
  co.post('/content/sync', h(a.syncContent));
  co.get('/content', h(a.contentSummary));
  co.get('/live', h(a.live));
  co.get('/setup', h(a.setup));
  co.get('/llm-usage', h(a.llmUsage));

  co.get('/origins', h(a.listOrigins));
  co.post('/origins', h(a.createOrigin));
  co.patch('/origins/:id', h(a.setOriginActive));
  co.delete('/origins/:id', h(a.deleteOrigin));

  co.get('/advisors', h(a.listAdvisors));
  co.post('/advisors', h(a.createAdvisor));
  co.patch('/advisors/:id', h(a.updateAdvisor));
  co.post('/phones', h(a.createPhone));
  co.patch('/phones/:id', h(a.updatePhone));
  co.delete('/phones/:id', h(a.deletePhone));

  co.get('/portfolios', h(a.listPortfolios));
  co.post('/portfolios', h(a.createPortfolio));
  co.patch('/portfolios/:id', h(a.updatePortfolio));

  co.get('/buttons', h(a.listButtons));
  co.post('/buttons', h(a.createButton));
  co.patch('/buttons/:id', h(a.updateButton));

  co.get('/handoffs', h(a.handoffs));
  co.get('/events', h(a.events));
  co.get('/metrics', h(a.metrics));
  co.get('/audit', h(a.audit));

  r.use('/companies/:companyId', co);
  return r;
}
