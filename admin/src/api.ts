export interface Admin {
  id: string;
  email: string;
  name: string;
  role: 'superadmin' | 'company_admin';
  company_id: string | null;
}

export class ApiFail extends Error {
  constructor(message: string, public status: number, public details?: { path: string; message: string }[]) {
    super(message);
  }
}

let csrf = '';
export const setCsrf = (t: string) => (csrf = t);

export async function api<T = any>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-csrf-token': csrf },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiFail(
      'No se pudo conectar con el servidor. Revisa tu conexión y que la API esté en ejecución (npm run dev:api, puerto 10000).',
      0,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const d = data?.error?.details;
    const code: string | undefined = data?.error?.code;
    // Sesión vencida fuera del login: volver a la pantalla de acceso.
    if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('fc-session-expired'));
    // Algunos endpoints (p. ej. sincronizar contenido) devuelven `error` como texto, no como objeto.
    const serverMsg: string | undefined = typeof data?.error === 'string' ? data.error : data?.error?.message;
    throw new ApiFail(describe(res.status, code, serverMsg, path, d), res.status, d);
  }
  return data as T;
}

/** Mensaje específico según el estado HTTP, el código del servidor y la ruta. */
function describe(status: number, code: string | undefined, serverMsg: string | undefined, path: string, details: any): string {
  const fields = Array.isArray(details) ? ` Campos: ${details.map((x: any) => `${x.path || 'dato'} (${x.message})`).join('; ')}.` : '';
  if (path === '/auth/login') {
    if (status === 401) return 'Correo o contraseña incorrectos. Revisa que el correo y la contraseña estén bien escritos.';
    if (status === 429 && code === 'locked') return 'Cuenta bloqueada 15 minutos por demasiados intentos fallidos. Espera o pide restablecer la contraseña (npm run admin:password).';
    if (status === 429) return 'Demasiados intentos de inicio de sesión desde esta red. Espera un minuto e inténtalo de nuevo.';
    if (status === 400) return 'Escribe un correo válido y tu contraseña.';
  }
  switch (status) {
    case 400: return `Datos inválidos: ${serverMsg ?? 'revisa el formulario'}.${fields}`;
    case 401: return 'Tu sesión expiró. Vuelve a iniciar sesión.';
    case 403: return serverMsg?.includes('CSRF') ? 'La sesión de seguridad no es válida. Recarga la página e inicia sesión de nuevo.' : `No tienes permiso para esta acción. ${serverMsg ?? ''}`.trim();
    case 404: return serverMsg && serverMsg !== 'No encontrado' ? serverMsg : 'No se encontró el elemento (puede pertenecer a otra empresa o haber cambiado).';
    case 409: return serverMsg ?? 'Conflicto: ya existe un registro con esos datos.';
    case 413: return 'Los datos enviados son demasiado grandes.';
    case 422: return serverMsg ?? 'No se pudo procesar la solicitud.';
    case 429: return 'Demasiadas solicitudes. Espera un momento e inténtalo de nuevo.';
    case 500: return 'Error interno del servidor. Revisa la consola de la API para más detalle.';
    case 502:
    case 503:
    case 504: return `La API no responde (error ${status}). Verifica que esté en ejecución en el puerto 10000 (npm run dev:api) y que la base de datos esté disponible.`;
    default: return serverMsg ?? `Error inesperado (${status}).`;
  }
}
