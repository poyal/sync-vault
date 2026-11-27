import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
const route = z
  .string()
  .regex(
    /^\/(?:clip|offer|finish|cancel|release\/(?:index|part)|part\/[a-f0-9-]{36}\/\d{1,5}\/(?:\d{1,16}|replace|status|finish))$/,
  );
const envelope = z
  .object({
    token: z.string().uuid(),
    route,
    binary: z.boolean(),
    body: z.string().max(63 * 1024 ** 2),
  })
  .strict();
type Envelope = z.infer<typeof envelope>;
type Item = {
  peer: string;
  request: Envelope;
  delivered: boolean;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};
export class ReturnChannel {
  private jobs = new Map<string, Item>();
  private live = new Map<string, number>();
  private waiters = new Map<string, () => void>();
  available(id: string) {
    return Date.now() - (this.live.get(id) || 0) < 20000;
  }
  request(peer: string, url: string, body: any, signal: AbortSignal) {
    route.parse(url);
    signal.throwIfAborted();
    if (this.jobs.size >= 24) throw Error("응답 대기 중인 작업이 많습니다.");
    const token = randomUUID(),
      binary = Buffer.isBuffer(body);
    const packet: Envelope = {
      token,
      route: url,
      binary,
      body: binary ? body.toString("base64") : JSON.stringify(body),
    };
    return new Promise<any>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        clearTimeout(deliveryTimer);
        signal.removeEventListener("abort", abort);
        this.jobs.delete(token);
      };
      const abort = () => {
        done();
        reject(Error("기기 연결이 중단되었습니다."));
      };
      const timer = setTimeout(abort, 90000);
      const deliveryTimer = setTimeout(() => {
        if (!this.jobs.get(token)?.delivered) abort();
      }, 8000);
      signal.addEventListener("abort", abort, { once: true });
      this.jobs.set(token, {
        peer,
        request: packet,
        delivered: false,
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.waiters.get(peer)?.();
    });
  }
  async poll(peer: string) {
    this.live.set(peer, Date.now());
    const next = () =>
      [...this.jobs.values()].find((j) => j.peer === peer && !j.delivered);
    if (!next())
      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(t);
          this.waiters.delete(peer);
          resolve();
        };
        this.waiters.get(peer)?.();
        const t = setTimeout(wake, 3500);
        this.waiters.set(peer, wake);
      });
    this.live.set(peer, Date.now());
    const j = next();
    if (!j) return { request: null };
    j.delivered = true;
    return { request: j.request };
  }
  reply(peer: string, raw: any) {
    const token = z.string().uuid().parse(raw.token),
      j = this.jobs.get(token);
    if (j && j.peer === peer) {
      if (raw.ok === true) j.resolve(raw.value);
      else j.reject(Error("상대 기기가 전송을 처리하지 못했습니다."));
    }
    return {};
  }
  async execute(
    peer: string,
    raw: unknown,
    handler: (id: string, r: string, q: IncomingMessage) => Promise<unknown>,
  ) {
    const p = envelope.parse(raw);
    const bytes = Buffer.from(p.body, p.binary ? "base64" : "utf8");
    const req = Readable.from([bytes]) as IncomingMessage;
    req.headers = {
      "content-type": p.binary
        ? "application/octet-stream"
        : "application/json",
      "content-length": String(bytes.length),
    };
    try {
      return {
        token: p.token,
        ok: true,
        value: await handler(peer, p.route, req),
      };
    } catch {
      return { token: p.token, ok: false };
    }
  }
  forget(peer: string) {
    this.live.delete(peer);
    this.waiters.get(peer)?.();
    for (const job of this.jobs.values())
      if (job.peer === peer) job.reject(Error("연결이 종료되었습니다."));
  }
}
