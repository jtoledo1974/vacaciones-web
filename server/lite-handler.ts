import { renderIndividualCalendarPdf } from './individual-calendar-pdf.ts';
import { D1Repository } from './repository';
import { Service, principal } from './service';
import { liteSummary, pdfFilename, renderLiteHtml, renderLitePdf, type LiteIndex } from './lite';

type LiteBindings = { DB?: D1Database };

const headers = {
  'Cache-Control': 'no-store',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
};

function guarded(fn: (request: Request, bindings: LiteBindings) => Promise<Response>) {
  return (request: Request, bindings: LiteBindings) =>
    fn(request, bindings).catch(
      (e: { status?: number; message?: string }) =>
        (console.error(e), 0) ||
        new Response(e?.status ? (e.message ?? '') : 'No se pudo cargar la consulta', {
          status: e?.status ?? 500,
          headers,
        }),
    );
}

/** Anonymous, read-only access to live campaigns: the same data as public consultation. */
async function load(request: Request, bindings: LiteBindings) {
  const repo = new D1Repository(bindings.DB!);
  const service = new Service(repo, await principal(repo, null, ''));
  const campaigns = (await service.list()).campaigns.filter((c) => c.scope_key === 'live');
  const index: LiteIndex = campaigns.map((c) => ({ team: c.team_id, year: Number(c.year) }));
  const url = new URL(request.url);
  const team = url.searchParams.get('equipo'),
    year = Number(url.searchParams.get('year'));
  const campaign = team && campaigns.find((c) => c.team_id === team && Number(c.year) === year);
  const summary = campaign ? liteSummary(await service.view(campaign.id)) : null;
  return { index, summary, campaignId: campaign?.id ?? null, requested: !!team };
}

export const serveLite = guarded(async (request: Request, bindings: LiteBindings) => {
  if (!bindings.DB) return new Response('El almacenamiento todavía no está disponible', { status: 503, headers });
  const { index, summary, requested } = await load(request, bindings);
  const message =
    requested && !summary ? 'No hay campaña para ese equipo y ejercicio.' : summary ? '' : 'Elige equipo:';
  return new Response(renderLiteHtml(index, summary, message), {
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });
});

export const serveLitePdf = guarded(async (request: Request, bindings: LiteBindings) => {
  if (!bindings.DB) return new Response('El almacenamiento todavía no está disponible', { status: 503, headers });
  const { summary } = await load(request, bindings);
  if (!summary) return new Response('Campaña no encontrada', { status: 404, headers });
  return new Response(renderLitePdf(summary), {
    headers: {
      ...headers,
      'Content-Type': 'application/pdf',
      // Inline: the browser shows it; the user decides whether to save or share it.
      'Content-Disposition': `inline; filename="${pdfFilename(summary)}"`,
    },
  });
});

/** Public read-only individual PDF. Uses the visible projection, never raw awards. */
export const serveLiteIndividualPdf = guarded(async (request: Request, bindings: LiteBindings) => {
  if (!bindings.DB) return new Response('El almacenamiento todavía no está disponible', { status: 503, headers });
  const { summary, campaignId } = await load(request, bindings);
  if (!summary || !campaignId) return new Response('Campaña no encontrada', { status: 404, headers });
  const code = new URL(request.url).searchParams.get('cta') ?? '';
  if (!summary.members.some((m) => m.code === code))
    return new Response('Selecciona un controlador válido de la campaña', { status: 400, headers });
  const repo = new D1Repository(bindings.DB);
  const service = new Service(repo, await principal(repo, null, ''));
  const { config } = await service.load(campaignId);
  return new Response(renderIndividualCalendarPdf(summary, code, config), {
    headers: {
      ...headers,
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="calendario-${summary.team}-${code.replace(/[^A-Za-z0-9_-]/g, '_')}-${summary.year}.pdf"`,
    },
  });
});
