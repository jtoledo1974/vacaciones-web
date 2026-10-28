import type { Service } from '../server/service.ts';

// Every import is previewed first; tests that only seed a roster confirm the report as is.
export async function importRoster(service: Pick<Service, 'mutate'>, cid: string, body: Record<string, unknown>) {
  const review = await service.mutate(cid, { ...body, action: 'preview_import_roster' });
  return service.mutate(cid, { reviewToken: review.reviewToken, acceptViolations: true, ...body });
}
