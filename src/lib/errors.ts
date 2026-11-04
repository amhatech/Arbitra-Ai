export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorResponse(error: unknown, context: string): Response {
  if (error instanceof AppError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status },
    );
  }

  console.error(context, error);
  return Response.json(
    { error: "The request could not be completed.", code: "INTERNAL_ERROR" },
    { status: 500 },
  );
}
