import { env } from 'cloudflare:workers';
import { serveLiteIndividualPdf } from '../../../server/lite-handler';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => serveLiteIndividualPdf(request, env);
