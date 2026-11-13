import { env } from 'cloudflare:workers';
import { serveVaPdf } from '../../../server/lite-handler';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => serveVaPdf(request, env);
