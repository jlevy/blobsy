declare module 'marked-terminal' {
  export function markedTerminal(options?: {
    width?: number;
    reflowText?: boolean;
  }): Record<string, unknown>;
}
