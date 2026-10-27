import consultation from '../docs/CONSULTA.md?raw';
import management from '../docs/GESTION.md?raw';
import readme from '../README.md?raw';
import validation from '../VALIDACION.md?raw';
import deployment from '../DESPLIEGUE.md?raw';
import election from '../docs/ELECCION.md?raw';
import { helpDocuments, type HelpDocument } from './docs-policy';
const documents: HelpDocument[] = [
  { id: 'consulta', title: 'Consultar vacaciones', audience: 'public', filename: 'CONSULTA.md', content: consultation },
  { id: 'gestion', title: 'Guía de administración', audience: 'admin', filename: 'GESTION.md', content: management },
  {
    id: 'eleccion',
    title: 'Elección por turnos: requisitos',
    audience: 'admin',
    filename: 'ELECCION.md',
    content: election,
  },
  { id: 'readme', title: 'Documentación del proyecto', audience: 'admin', filename: 'README.md', content: readme },
  {
    id: 'validacion',
    title: 'Validación y límites',
    audience: 'admin',
    filename: 'VALIDACION.md',
    content: validation,
  },
  { id: 'despliegue', title: 'Despliegue y acceso', audience: 'admin', filename: 'DESPLIEGUE.md', content: deployment },
];
export function documentation(role: string) {
  return helpDocuments(role, documents);
}
