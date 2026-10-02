/** An error carrying a stable problem `code` and the HTTP status it maps to. */
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | undefined;
  readonly extra: object | undefined;

  constructor(code: string, status: number, detail?: string, extra?: object) {
    super(detail ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
    this.extra = extra;
  }
}
