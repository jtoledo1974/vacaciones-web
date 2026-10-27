import { env } from 'cloudflare:workers';
import { serveLite } from '../../server/lite-handler';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => serveLite(request, env);
