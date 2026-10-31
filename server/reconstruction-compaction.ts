import { originalEventCopiesMatchSQL } from './audit-context.ts';

// SQL equivalent of reconstruction.sessionEvent, applied ONLY to originalEvents.
// origin/applied/undone, availability checkpoints and top-level impact are untouched.
// Uses SQLite JSON processing: no full session crosses the D1/Worker boundary.
export const compactSessionSQL = (document: string) => `json_set(${document}, '$.originalEvents', json((
  SELECT json_group_array(json(json_set(e.value,
    '$.after', json(json_remove(coalesce(json_extract(e.value,'$.after'),'{}'), '$.impact')),
    '$.before', json_object(
      'format', json_extract(e.value,'$.before.format'),
      'state', json(json_extract(e.value,'$.before.state')),
      'awards', json('[]'), 'requests', json('[]'),
      'preferences', json((SELECT json_group_array(json(p.value))
        FROM json_each(e.value,'$.before.preferences') p
        WHERE json_extract(p.value,'$.member_id') IN (SELECT value FROM json_each(e.value,'$.participants'))))
    )
  ))) FROM json_each(${document}, '$.originalEvents') e
)))`;
// Avoid normalizing unfamiliar or malformed versions. No broad snapshot rewrite.
export const compactableSessionSQL = (document: string) => `json_valid(${document})
  AND json_type(${document}, '$.originalEvents')='array'
  AND NOT EXISTS (SELECT 1 FROM json_each(${document}, '$.originalEvents') e
    WHERE json_type(e.value,'$.before.preferences') IS NOT 'array'
       OR json_type(e.value,'$.participants') IS NOT 'array'
       OR json_type(e.value,'$.before.state') IS NOT 'object'
       OR json_type(e.value,'$.before.awards') IS NOT 'array'
       OR json_type(e.value,'$.before.requests') IS NOT 'array'
       OR NOT (${originalEventCopiesMatchSQL('e.value')}))`;
