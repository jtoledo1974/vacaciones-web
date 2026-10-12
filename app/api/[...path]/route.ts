import { env } from 'cloudflare:workers';
import { sitesAuthenticator } from '../../../server/auth';
import { D1Repository } from '../../../server/repository';
import { Service, principal, ApiError } from '../../../server/service';
export const dynamic = 'force-dynamic';
const reply = (value: any, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function serve(request: Request) {
    try {
        const url = new URL(request.url), path = url.pathname.slice(5).split('/');
        const bindings = env as any;
        if (!bindings.DB)
            return reply({ error: 'El almacenamiento todavía no está disponible' }, 503);
    const user = await sitesAuthenticator.authenticate(request);
        const repo = new D1Repository(bindings.DB);
    const actor = await principal(repo, user, bindings.SUPERADMIN_EMAILS ?? '');
        const service = new Service(repo, actor);
        if (request.method === 'GET') {
            if (path[0] === 'session')
            return reply({ principal: actor, identity: user ? { subject: user.subject } : null });
            if (path[0] === 'index')
                return reply(await service.list());
            if (path[0] === 'campaign' && path[1])
                return reply(await service.view(path[1]));
            if (path[0] === 'admin')
                return reply(await service.admin());
            if (path[0] === 'backup')
                return reply(await service.backup());
            throw new ApiError('Ruta no encontrada', 404);
        }
        if (request.method !== 'POST')
            throw new ApiError('Método no permitido', 405);
        if (!user)
            throw new ApiError('Inicia sesión para modificar datos', 401);
        if (request.headers.get('origin') !== url.origin)
            throw new ApiError('Origen de la operación no válido', 403);
        if (!request.headers.get('content-type')?.startsWith('application/json'))
            throw new ApiError('Usa contenido JSON', 415);
        const text = await request.text();
        if (text.length > 5000000)
            throw new ApiError('Solicitud demasiado grande', 413);
        let b;
        try {
            b = JSON.parse(text);
        }
        catch {
            throw new ApiError('Contenido JSON no válido');
        }
        if (path[0] === 'initialize')
            return reply(await service.init());
        if (path[0] === 'campaigns')
            return reply(await service.createCampaigns(b.year, b.copyYear ?? null));
        if (path[0] === 'campaign' && path[1])
            return reply(await service.mutate(path[1], b));
        if (path[0] === 'users')
            return reply(await service.configureUser(b));
    if (path[0] === 'teams')
        return reply(await service.team(b));
        if (path[0] === 'restore')
            return reply(await service.restore(b.backup, b.revision));
        throw new ApiError('Ruta no encontrada', 404);
    }
    catch (e: any) {
        const status = e.status ?? 500;
        return reply({ error: status === 500 ? 'No se pudo guardar la operación. Tus cambios anteriores siguen protegidos.' : e.message }, status);
    }
}
export const GET = serve;
export const POST = serve;
