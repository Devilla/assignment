// Every failure the API can return is an ApiError with a stable machine-readable `code`.
// Clients should branch on `code`, never on `message`.
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, msg, details) => new ApiError(400, code, msg, details);
export const notFound = (code, msg, details) => new ApiError(404, code, msg, details);
export const conflict = (code, msg, details) => new ApiError(409, code, msg, details);
export const unprocessable = (code, msg, details) => new ApiError(422, code, msg, details);
