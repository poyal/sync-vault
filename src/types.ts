export type ShareEndpoint = { address: string; port: number };
export type Peer = {
  id: string;
  name: string;
  cert: string;
  endpoint: ShareEndpoint;
  autoAccept: boolean;
  seen: number;
};
export type Stamp = { clock: number; origin: string };
export interface Settings {
  name: string;
  adapter: string;
  receive: string;
  paused: boolean;
  text: boolean;
  image: boolean;
  files: boolean;
  login: boolean;
  updates: boolean;
  smallBytes: number;
  smallCount: number;
  releaseFolder: string;
}
export type Entry = { name: string; size: number; dir: boolean; hash: string };
export type Source = Entry & { source: string; modified: number };
export type Offer = { id: string; entries: Entry[]; stamp?: Stamp };
export type Outgoing = {
  id: string;
  peer: string;
  entries: Source[];
  stamp?: Stamp;
  cancelPending?: boolean;
  state: string;
  done: number;
  total: number;
  error?: string;
};
export type Incoming = {
  id: string;
  peer: string;
  root: string;
  staging: string;
  offer: Offer;
  state: string;
  paths: Record<string, string>;
  received?: Record<number, number>;
  finished?: number;
  error?: string;
};
export const features = ["text", "image", "html", "files", "resume"] as const;
export function newer(a: Stamp, b: Stamp) {
  return a.clock > b.clock || (a.clock === b.clock && a.origin > b.origin);
}
export const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
