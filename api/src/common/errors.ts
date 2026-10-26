import { HttpException } from '@nestjs/common';

/** Errors carry a stable machine code in `error`, e.g. `out_of_stock`. */
export const apiError = (statusCode: number, error: string, message: string) =>
  new HttpException({ statusCode, error, message }, statusCode);
