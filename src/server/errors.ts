// errors.ts — the API error type. Thrown anywhere below a route, mapped to
// the contract's { error: { code, message } } shape by the express error
// handler. One class, no hierarchy — the contract has codes, not taxonomies.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const validation = (msg: string) => new ApiError(400, 'VALIDATION', msg);
export const notFound = (msg: string) => new ApiError(404, 'NOT_FOUND', msg);
