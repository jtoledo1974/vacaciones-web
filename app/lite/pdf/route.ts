import { env } from 'cloudflare:workers';
import { serveLitePdf } from '../../../server/lite-handler';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => serveLitePdf(request, env);
