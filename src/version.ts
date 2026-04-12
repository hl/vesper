declare const VESPER_VERSION: string | undefined;

export const VERSION = typeof VESPER_VERSION !== "undefined" ? VESPER_VERSION : "dev";
