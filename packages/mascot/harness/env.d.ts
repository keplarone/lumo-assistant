declare module 'virtual:lumo-reference' {
  // The reference factory is plain JS taking the three namespace; typed loosely on purpose.
  export function createLumoFactory(three: unknown): { Lumo: new (opts?: Record<string, unknown>) => any; STATES: Record<string, unknown>; PALETTE: Record<string, number> };
}
declare module 'three-r149' {
  const three: any;
  export = three;
}
