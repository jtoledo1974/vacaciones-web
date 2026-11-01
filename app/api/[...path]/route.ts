import { renderIndividualCalendarPdf } from '../../../server/individual-calendar-pdf';
import {
  notificationSettings,
  updateSubscription,
  dispatchNotifications,
  sendTestPush,
} from '../../../server/notifications';
import { env, waitUntil } from 'cloudflare:workers';
import { federatedAuthenticator } from '../../../server/auth';
import { D1Repository } from '../../../server/repository';
import { databaseDiagnostics, logServerFailure } from '../../../server/database-diagnostics';
import { storageDiagnostics, backupTableDiagnostics } from '../../../server/storage-diagnostics';
import { Service, principal, ApiError, advanceExpiredTurns } from '../../../server/service';
import { resolveControllerPreview } from '../../../server/controller-preview';
import { documentation } from '../../../server/documentation';
import { liteSummary, pdfFilename, renderLitePdf } from '../../../server/lite';
import { XLSM_TYPE } from '../../../server/hr-xlsx';
import { masterSeniority } from '../../../server/master-seniority';
import { loadVaQuotas, vaQuotas } from '../../../server/va-quotas';
import { myVa, vaCensus, vaLinkAccount } from '../../../server/va-census';
import { importVaExternal, vaExternalPeople } from '../../../server/va-external';
import { vaElectionView, mutateVaElection, importVaElection, advanceVaElections } from '../../../server/va-election';
import { localAdminEnabled, localAdminLogin, localAdminLogout } from '../../../server/local-admin';
import { approveCli, revokeCli, pairCli, joinCli, cliPairingStatus } from '../../../server/cli-auth';
import { backupManifest, backupPage } from '../../../server/backup-v2';
import { previewCleanup, applyCleanup } from '../../../server/cleanup';
import { exportCampaignDiagnostic } from '../../../server/campaign-diagnostic';
export const dynamic = 'force-dynamic';
const reply = (value: any, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
async function serve(request: Request) {
  const started = performance.now();
  const requestId = crypto.randomUUID();
  const family = new URL(request.url).pathname.split('/')[2];
  const knownFamilies = [
    'diagnostics',
    'auth-config',
    'session',
    'revision',
    'index',
    'campaign',
    'election',
    'notifications',
    'local-admin',
    'cli-auth',
    'va',
    'hr',
    'users',
    'people',
    'restore',
    'backup',
    'backup-v2',
    'cleanup',
  ];
  const route = '/api/' + (knownFamilies.includes(family) ? family : 'other');
  const context = { requestId, route, method: request.method };
  let phase = 'binding';
  try {
    const url = new URL(request.url),
      path = url.pathname.slice(5).split('/');
    const bindings = env as any;
    if (!bindings.DB) {
      logServerFailure(new Error('Missing database binding'), context, 'binding', performance.now() - started);
      return reply({ error: 'El almacenamiento todavía no está disponible', requestId }, 503);
    }
    const repo = new D1Repository(bindings.DB, context);
    if (path[0] === 'cli-auth' && ['join', 'logout'].includes(path[1]) && request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/json'))
        throw new ApiError('Usa contenido JSON', 415);
      const text = await request.text();
      if (text.length > 8192) throw new ApiError('Solicitud demasiado grande', 413);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        throw new ApiError('Contenido JSON no válido');
      }
      return reply(
        path[1] === 'join' ? await joinCli(request, repo, body?.code) : await revokeCli(request, repo, body?.code),
      );
    }
    if (path[0] === 'local-admin' && request.method === 'POST') {
      if (path[1] === 'login') return localAdminLogin(request, bindings, repo);
      if (path[1] === 'logout') return localAdminLogout(request, bindings, repo);
    }
    if (path[0] === 'notifications' && path[1] === 'dispatch' && request.method === 'POST') {
      const secret = bindings.NOTIFICATIONS_DISPATCH_SECRET;
      if (!secret || request.headers.get('Authorization') !== 'Bearer ' + secret)
        return reply({ error: 'No autorizado' }, 403);
      // Lists whose wait ran out choose first, so their notices go out in this same run.
      const expired = await advanceExpiredTurns(repo).catch(() => ({ applied: 0, errors: 1 }));
      const vaExpired = await advanceVaElections(repo).catch(() => ({ applied: 0, errors: 1 }));
      return reply({ ...(await dispatchNotifications(repo, bindings)), expired, vaExpired });
    }
    phase = 'authentication';
    const user = await federatedAuthenticator(bindings.FIREBASE_PROJECT_ID ?? '', bindings, repo).authenticate(request);
    phase = 'authorization';
    const actor = await principal(repo, user, bindings.SUPERADMIN_EMAILS ?? '');
    phase = 'handler';
    if (path[0] === 'diagnostics' && path[1] === 'database' && path.length === 2 && request.method === 'GET') {
      const result = await databaseDiagnostics(repo, actor, context);
      return reply(result, result.ok ? 200 : 503);
    }
    if (path[0] === 'diagnostics' && path[1] === 'storage' && path.length === 2 && request.method === 'GET') {
      const result = await storageDiagnostics(repo, actor, context, Number(url.searchParams.get('offset') ?? 0));
      return reply(result, result.ok ? 200 : 503);
    }
    if (path[0] === 'diagnostics' && path[1] === 'backup' && path.length === 2 && request.method === 'GET') {
      const result = await backupTableDiagnostics(repo, actor, context, url.searchParams.get('table') ?? '');
      return reply(result, result.ok ? 200 : 503);
    }
    const service = new Service(repo, actor);
    const previewCode = url.searchParams.get('verComo');
    if (previewCode !== null && (!path[1] || !['campaign', 'election'].includes(path[0])))
      throw new ApiError('La vista previa solo está disponible para campañas y elecciones', 400);
    const preview = previewCode !== null ? await resolveControllerPreview(repo, actor, path[1], previewCode) : null;
    const effectiveService = preview ? new Service(repo, preview.actor) : service;
    if (preview && request.method === 'POST' && (path[0] !== 'election' || !preview.writable))
      throw new ApiError('La campaña real es de solo lectura en la vista previa', 403);
    if (request.method === 'GET') {
      if (path[0] === 'backup-v2' && path.length === 1) return reply(await backupManifest(repo, actor));
      if (path[0] === 'cleanup' && path.length === 1)
        return reply(await previewCleanup(repo, actor, Date.now(), url.searchParams.get('mode') ?? undefined));
      if (path[0] === 'va' && path[1] === 'external' && path.length === 2)
        return reply(await vaExternalPeople(repo, actor));
      if (path[0] === 'va' && path[1] === 'election' && path.length === 3)
        return reply(await vaElectionView(repo, actor, Number(path[2])));
      if (path[0] === 'cli-auth' && path[1] === 'status')
        return reply(await cliPairingStatus(request, repo, user, actor, url.searchParams.get('pairing') ?? ''));
      if (path[0] === 'auth-config')
        return reply({
          localAdminEnabled: localAdminEnabled(bindings),
          firebase:
            bindings.FIREBASE_PROJECT_ID && bindings.FIREBASE_API_KEY
              ? {
                  projectId: bindings.FIREBASE_PROJECT_ID,
                  apiKey: bindings.FIREBASE_API_KEY,
                  authDomain: bindings.FIREBASE_AUTH_DOMAIN ?? bindings.FIREBASE_PROJECT_ID + '.firebaseapp.com',
                  appId: bindings.FIREBASE_APP_ID ?? undefined,
                }
              : null,
        });
      if (path[0] === 'notifications') return reply(await notificationSettings(repo, actor, bindings));
      if (path[0] === 'va' && path[1] === 'census' && path.length === 2) return reply(await vaCensus(repo, actor));
      if (path[0] === 'va' && path[1] === 'me' && path.length === 2) {
        const team = url.searchParams.get('equipo'),
          code = url.searchParams.get('persona');
        return reply(await myVa(repo, actor, team && code ? { team, code } : undefined));
      }
      if (path[0] === 'va' && path[1] === 'quotas' && path.length === 2)
        return reply(await vaQuotas(repo, actor, Number(url.searchParams.get('year'))));
      if (path[0] === 'revision') {
        const rows = await repo.all("SELECT revision FROM app_state WHERE id='main'");
        return reply({ revision: rows[0]?.revision ?? 0 });
      }
      if (path[0] === 'election' && path[1] && path[2] === 'availability')
        return reply(await effectiveService.election().availability(path[1]));
      if (path[0] === 'election' && path[1] && path[2] === 'impact') {
        const raw = url.searchParams.get('choices'),
          version = Number(url.searchParams.get('version'));
        if (!raw || raw.length > 10000 || !Number.isSafeInteger(version) || version < 0)
          throw new ApiError('Indica las adjudicaciones y versión de campaña válidas', 400);
        let choices: unknown;
        try {
          choices = JSON.parse(raw);
        } catch {
          throw new ApiError('Previsualización inválida', 400);
        }
        return reply(
          await effectiveService
            .election()
            .previewImpact(path[1], choices as { member_id: string; cycle_date: string }[], version),
        );
      }
      if (path[0] === 'election' && path[1] && path[2] === 'options') {
        const rawJoint = url.searchParams.get('joint');
        let jointEntries: undefined | { member_id: string; dates: string[] }[];
        if (rawJoint !== null) {
          if (rawJoint.length > 15000) throw new ApiError('Consulta demasiado grande', 413);
          try {
            jointEntries = JSON.parse(rawJoint);
          } catch {
            throw new ApiError('Selección conjunta inválida');
          }
        }
        return reply(
          await effectiveService.election().options(path[1], url.searchParams.getAll('selected'), jointEntries),
        );
      }
      if (path[0] === 'help') {
        const documents = documentation(actor.role);
        if (!path[1]) return reply(documents);
        const doc = documents.find((d) => d.id === path[1]);
        if (!doc) throw new ApiError('Documento no disponible', 404);
        return new Response(doc.content, {
          headers: {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${doc.filename}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'personal-simulation' && path[1]) return reply(await service.personalSimulation().view(path[1]));
      if (path[0] === 'session')
        return reply({
          principal: actor,
          identity: user ? { provider: user.provider, subject: user.subject, email: user.email } : null,
        });
      if (path[0] === 'index') return reply(await service.list());
      if (path[0] === 'stats') return reply(await service.stats());
      if (path[0] === 'campaign' && path[1] && path[2] === 'diagnostic' && path.length === 3) {
        if (preview) throw new ApiError('El diagnóstico no está disponible en vista de controlador', 403);
        const diagnostic = await exportCampaignDiagnostic(repo, actor, path[1]);
        const name = `diagnostico-${String(diagnostic.payload.team).replace(/[^a-z0-9_-]/gi, '_')}-${diagnostic.payload.year}.json`;
        return new Response(JSON.stringify(diagnostic), {
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Disposition': `attachment; filename="${name}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'campaign' && path[1] && path[2] === 'individual-pdf') {
        // Only the projected, visible awards may be included, including for simulations.
        const summary = liteSummary(await effectiveService.view(path[1]));
        const code = url.searchParams.get('cta') ?? '';
        if (!summary.members.some((m) => m.code === code))
          throw new ApiError('Selecciona un controlador válido de la campaña', 400);
        const { config } = await effectiveService.load(path[1]);
        return new Response(renderIndividualCalendarPdf(summary, code, config), {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="calendario-${summary.team}-${code.replace(/[^A-Za-z0-9_-]/g, '_')}-${summary.year}.pdf"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'campaign' && path[1] && path[2] === 'pdf') {
        // Authenticated variant of /lite/pdf: also covers simulations the viewer may read.
        const summary = liteSummary(await effectiveService.view(path[1]));
        return new Response(renderLitePdf(summary), {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${pdfFilename(summary)}"`,
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
            Expires: '0',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'campaign' && path[1])
        return reply(
          url.searchParams.get('published') === '1'
            ? await effectiveService.publishedView(path[1])
            : await effectiveService.view(path[1]),
        );
      if (path[0] === 'hr' && path[1] === 'global' && path[3] === 'xlsm') {
        const { name, bytes, open } = await service.exportHrGlobal(Number(path[2]));
        return new Response(bytes, {
          headers: {
            'Content-Type': XLSM_TYPE,
            'Content-Disposition': `attachment; filename="${name}"`,
            'X-Equipos-Abiertos': open.join(','),
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'hr' && path[1] && path[2] === 'xlsm') {
        const { name, bytes } = await service.exportHrTeam(path[1]);
        return new Response(bytes, {
          headers: {
            'Content-Type': XLSM_TYPE,
            'Content-Disposition': `attachment; filename="${name}"`,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (path[0] === 'hr' && path[1]) return reply(await service.hrStatus(path[1]));
      if (path[0] === 'admin') return reply(await service.admin());
      if (path[0] === 'backup') {
        const backup = await service.backup();
        if (url.searchParams.get('download') === '1')
          return new Response(JSON.stringify(backup, null, 2), {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              'Content-Disposition': `attachment; filename="vacaciones-copia-${new Date().toISOString().slice(0, 10)}.json"`,
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            },
          });
        return reply(backup);
      }
      throw new ApiError('Ruta no encontrada', 404);
    }
    if (request.method !== 'POST') throw new ApiError('Método no permitido', 405);
    if (!user) throw new ApiError('Inicia sesión para modificar datos', 401);
    if (request.headers.get('origin') !== url.origin) throw new ApiError('Origen de la operación no válido', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new ApiError('Usa contenido JSON', 415);
    const text = await request.text();
    if (text.length > 5000000) throw new ApiError('Solicitud demasiado grande', 413);
    let b;
    try {
      b = JSON.parse(text);
    } catch {
      throw new ApiError('Contenido JSON no válido');
    }
    if (path[0] === 'backup-v2' && path[1] === 'page' && path.length === 2)
      return reply(await backupPage(repo, actor, b));
    if (path[0] === 'cleanup' && path.length === 1) return reply(await applyCleanup(repo, actor, b));
    if (path[0] === 'notifications' && b.action === 'test')
      return reply(await sendTestPush(repo, actor, b.endpoint, bindings));
    if (path[0] === 'cli-auth' && path[1] === 'approve')
      return reply(await approveCli(request, repo, user, actor, b.pairing));
    if (path[0] === 'cli-auth' && path[1] === 'pair') return reply(await pairCli(request, repo, user, actor, b.code));
    if (path[0] === 'notifications') return reply(await updateSubscription(repo, actor, b, bindings));
    if (path[0] === 'initialize') return reply(await service.init());
    if (path[0] === 'campaigns')
      return reply(
        await service.createCampaigns(b.year, b.copyYear ?? null, b.rosterYear === undefined ? 'latest' : b.rosterYear),
      );
    if (path[0] === 'personal-simulation' && path[1])
      return reply(await service.personalSimulation().mutate(path[1], b));
    if (path[0] === 'simulations' && path[1])
      return reply(
        b.action === 'delete' ? await service.deleteSimulation(path[1], b) : await service.createSimulation(path[1], b),
      );
    if (path[0] === 'election' && path[1]) {
      const changed = await effectiveService.election().mutate(path[1], b);
      // The dashboard immediately advances queued automatic turns; do not
      // solve the full cycle table for their throwaway intermediate views.
      const autoDrainEnabled =
        !['election_undo', 'election_redo', 'pause', 'link_account', 'resolve_tie'].includes(b.action) &&
        !String(b.action).startsWith('reconstruction_');
      const view = await effectiveService.view(path[1], {
        skipAvailabilityForPendingAutomatic: autoDrainEnabled,
      });
      // The election is committed and its response prepared before any push work.
      if (changed?.changed && view.campaign.scope_key === 'live') {
        try {
          waitUntil(
            dispatchNotifications(repo, bindings, path[1])
              .then((result) => {
                if (result.errors) console.warn('Notification dispatcher reported errors', result.errors);
              })
              .catch(() => console.warn('Notification background dispatch failed')),
          );
        } catch {
          /* Cron retry handles an unavailable background scheduler. */
        }
      }
      return reply(view);
    }
    if (path[0] === 'campaign' && path[1]) return reply(await service.mutate(path[1], b));
    if (path[0] === 'hr' && b.action === 'template') return reply(await service.uploadHrTemplate(b.year, b.data));
    if (path[0] === 'hr' && path[1] && b.action === 'names') return reply(await service.saveHrNames(path[1], b.names));
    if (path[0] === 'users')
      return reply(await (b.action === 'delete' ? service.deleteUser(b) : service.configureUser(b)));
    if (path[0] === 'va' && path[1] === 'account' && path.length === 2)
      return reply(await vaLinkAccount(repo, actor, b));
    if (path[0] === 'va' && path[1] === 'external' && path.length === 2)
      return reply(await importVaExternal(repo, actor, b));
    if (path[0] === 'va' && path[1] === 'election' && path.length === 3)
      return reply(await mutateVaElection(repo, actor, Number(path[2]), b));
    if (path[0] === 'va' && path[1] === 'census' && path.length === 3)
      return reply(await importVaElection(repo, actor, Number(path[2]), b));
    if (path[0] === 'va' && path[1] === 'quotas' && path.length === 2) return reply(await loadVaQuotas(repo, actor, b));
    if (path[0] === 'people' && path[1] === 'seniority' && path.length === 2)
      return reply(await masterSeniority(repo, actor, b));
    if (path[0] === 'restore') return reply(await service.restore(b.backup, b.revision));
    throw new ApiError('Ruta no encontrada', 404);
  } catch (e: any) {
    const status = e.status ?? 500;
    if (status >= 500) logServerFailure(e, context, phase, performance.now() - started);
    return reply(
      {
        error:
          status === 500 ? 'No se pudo guardar la operación. Tus cambios anteriores siguen protegidos.' : e.message,
        ...(status >= 500 ? { requestId } : {}),
      },
      status,
    );
  }
}
export const GET = serve;
export const POST = serve;
