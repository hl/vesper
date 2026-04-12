export class VesperError extends Error {
  constructor(
    message: string,
    public readonly code: number = 1,
  ) {
    super(message);
    this.name = "VesperError";
  }
}

export function exitWithError(message: string, code = 1): never {
  process.stderr.write(`[vesper] ${message}\n`);
  process.exit(code);
}
