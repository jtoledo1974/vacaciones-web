import { env } from 'cloudflare:workers';
import { sitesAuthenticator } from '../../../server/auth';
import { D1Repository } from '../../../server/repository';
import { Service, principal, ApiError } from '../../../server/service';
import {documentation} from '../../../server/documentation';
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
            if(path[0]==='election'&&path[1]&&path[2]==='options')return reply(await service.election().options(path[1],url.searchParams.getAll('selected')));
            if(path[0]==='help'){
                const documents=documentation(actor.role);
                if(!path[1])return reply(documents);
                const doc=documents.find(d=>d.id===path[1]);
                if(!doc)throw new ApiError('Documento no disponible',404);
                return new Response(doc.content,{headers:{'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="${doc.filename}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
            }
            if (path[0] === 'session')
            return reply({ principal: actor, identity: user ? { subject: user.subject } : null });
            if (path[0] === 'index')
                return reply(await service.list());
            if (path[0] === 'campaign' && path[1])
                return reply(url.searchParams.get('published')==='1'?await service.publishedView(path[1]):await service.view(path[1]));
            if (path[0] === 'admin')
                return reply(await service.admin());
        if (path[0] === 'backup'){
            const backup=await service.backup();
            if(url.searchParams.get('download')==='1')return new Response(JSON.stringify(backup,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="vacaciones-copia-${new Date().toISOString().slice(0,10)}.json"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
            return reply(backup);
        }
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
            return reply(await service.createCampaigns(b.year, b.copyYear ?? null, b.rosterYear===undefined?'latest':b.rosterYear));
        if(path[0]==='simulations'&&path[1])return reply(await service.createSimulation(path[1],b));
        if(path[0]==='election'&&path[1]){await service.election().mutate(path[1],b);return reply(await service.view(path[1]));}
        if (path[0] === 'campaign' && path[1])
            return reply(await service.mutate(path[1], b));
        if (path[0] === 'users')
            return reply(await service.configureUser(b));
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


