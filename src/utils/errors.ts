import type { NextFunction, Request, RequestHandler, Response } from 'express';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'No autenticado') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'No autorizado') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'No encontrado') => new HttpError(404, 'not_found', msg);
export const conflict = (msg: string) => new HttpError(409, 'conflict', msg);

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Detecta violaciones de unicidad/FK de Postgres para devolver 409 en lugar de 500. */
export function mapDbError(e: any): HttpError | null {
  const code = e?.code ?? e?.cause?.code;
  if (code === '23505') return conflict('Ya existe un registro con esos datos');
  if (code === '23503') return badRequest('Referencia inválida (entidad inexistente o de otra empresa)');
  if (code === '23514') return badRequest('Valor no permitido por las reglas de datos');
  return null;
}
