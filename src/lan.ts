import tls from "node:tls";
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { listenForPeers } from "./lan-beacon";
import { createDiscovery } from "./discovery";
import {
  ShareListener,
  shareRequest,
  interfaces,
  validateEndpoint,
  remoteCertificate,
  readJSON,
  json,
} from "./network";
import { fingerprint, type ShareIdentity } from "./identity";
import { Store } from "./store";
import { features, type Peer, type ShareEndpoint } from "./types";
import { ReturnChannel } from "./return-channel";
import { chunkSize } from "./files";
const hello = z.object({
  name: z.string().min(1).max(60),
  port: z.number().int().min(1).max(65535),
  protocol: z.number().int(),
  features: z.array(z.string().max(16)).max(32),
  version: z.string().max(32),
  clock: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 2)
    .optional(),
});
export function compatible(version: number, remote: string[]) {
  return version === 1 ? features.filter((x) => remote.includes(x)) : [];
}
type Candidate = {
  id: string;
  name: string;
  endpoint: ShareEndpoint;
  seen: number;
};
export function compareCode(a: string, b: string) {
  return createHash("sha256")
    .update([a, b].sort().join("|"))
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()
    .match(/.{4}/g)!
    .join(" ");
}
type Request = {
  id: string;
  cert: string;
  name: string;
  endpoint: ShareEndpoint;
  expires: number;
  code: string;
  attempt?: string;
};
export class Lan {
  id: string;
  nearby = new Map<string, Candidate>();
  online = new Map<
    string,
    { time: number; features: string[]; version: string }
  >();
  pending = new Map<string, Request>();
  private denied = new Map<string, Request>();
  diagnostics = "네트워크를 확인하고 있습니다.";
  address = "";
  port = 0;
  pairPort = 0;
  private server?: ShareListener;
  private bootstrap?: ShareListener;
  private bonjour?: ReturnType<typeof createDiscovery>;
  private browser: any;
  private beacon?: ReturnType<typeof listenForPeers>;
  private refreshBrowse?: () => void;
  private advertisedName = "";
  private rebuild = false;
  private generation = 0;
  private closed = false;
  private tick = 0;
  private timer?: NodeJS.Timeout;
  private probes = new Set<string>();
  private active = new Map<string, Set<AbortController>>();
  private reverse = new ReturnChannel();
  private direct = new Map<string, number>();
  private polling = new Map<string, AbortController>();
  constructor(
    public store: Store,
    private keys: ShareIdentity,
    private version: string,
    private route: (
      id: string,
      route: string,
      req: IncomingMessage,
    ) => Promise<unknown>,
    private changed: () => void,
    private testNetwork?: { address: string; port: number },
  ) {
    this.id = fingerprint(keys.cert);
  }
  get adapters() {
    return interfaces().filter((a) => !a.address.startsWith("127."));
  }
  publicInfo() {
    return {
      name: this.store.state.settings.name,
      port: this.port,
      protocol: 1,
      features: [...features, "return-channel"],
      version: this.version,
      clock: Math.max(
        this.store.state.stamp.clock,
        this.store.state.observed || 0,
      ),
    };
  }
  start() {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 1500);
  }
  async poll(force = false) {
    if (this.closed || this.rebuild) return;
    this.rebuild = true;
    try {
      const list = this.adapters,
        selected = this.store.state.settings.adapter;
      const chosen =
        this.testNetwork?.address ??
        (process.env.SYNC_VAULT_TEST_LOOPBACK === "1" &&
        !process.resourcesPath?.includes("app.asar") &&
        process.env.SYNC_VAULT_TEST_HOME
          ? "127.0.0.1"
          : (selected
              ? list.find((a) => a.name === selected)
              : (list.find(
                  (a) =>
                    !/(virtual|vethernet|vpn|loopback|tailscale)/i.test(a.name),
                ) ?? list[0])
            )?.address || "");
      if (
        chosen !== this.address ||
        (chosen &&
          (this.advertisedName !== this.store.state.settings.name ||
            !this.server))
      ) {
        await this.disconnect();
        if (this.closed) return;
        if (chosen) await this.bind(chosen);
        else
          this.diagnostics =
            "사용할 집 네트워크가 없습니다. Wi-Fi 또는 유선을 확인하세요.";
      }
      for (const [id, q] of this.nearby)
        if (Date.now() - q.seen > 120000) this.nearby.delete(id);
      for (const [id, q] of this.pending)
        if (Date.now() > q.expires) this.pending.delete(id);
      for (const [id, q] of this.denied)
        if (Date.now() > q.expires) this.denied.delete(id);
      if (++this.tick % 40 === 0 || force) this.refreshBrowse?.();
      if (force) this.beacon?.announce();
      if (this.server && (force || this.tick % 4 === 1))
        for (const p of this.store.state.peers) void this.probe(p);
    } catch (e) {
      this.diagnostics = (e as Error).message;
      await this.disconnect();
    } finally {
      this.rebuild = false;
      this.changed();
    }
  }
  private async bind(address: string) {
    const trusted = this.store.state.peers.map((p) => p.cert);
    this.server = new ShareListener(
      this.keys,
      trusted,
      false,
      async (req, res, remote) => {
        if (!this.store.state.peers.some((p) => p.id === remote.id))
          throw Error("미등록 기기");
        if (req.url === "/return/poll") {
          await readJSON(req);
          json(res, await this.reverse.poll(remote.id));
          return;
        }
        if (req.url === "/return/reply") {
          json(
            res,
            this.reverse.reply(remote.id, await readJSON(req, 1024 * 1024)),
          );
          return;
        }
        if (req.url === "/hello") {
          const info = hello.parse(await readJSON(req));
          this.record(remote.id, info, req.socket.remoteAddress!);
          json(res, this.publicInfo());
          return;
        }
        const result = await this.route(remote.id, req.url || "", req);
        if (!this.store.state.peers.some((p) => p.id === remote.id))
          throw Error("등록 해제");
        json(res, result ?? {});
      },
    );
    this.bootstrap = new ShareListener(
      this.keys,
      [],
      true,
      async (req, res, remote) => {
        if (remote.id === this.id) throw Error("내 기기");
        if (req.url === "/info") {
          await readJSON(req);
          // A legacy client opens /info only when the user starts a fresh pairing.
          if (
            this.denied.has(remote.id) &&
            !this.denied.get(remote.id)?.attempt
          )
            this.denied.delete(remote.id);
          json(res, this.publicInfo());
          return;
        }
        if (req.url !== "/register") throw Error("등록 경로 오류");
        const info = hello
          .extend({ attempt: z.string().uuid().optional() })
          .parse(await readJSON(req));
        if (!compatible(info.protocol, info.features).length)
          throw Error("호환되지 않는 버전");
        const endpoint = {
          address: req.socket.remoteAddress!,
          port: info.port,
        };
        validateEndpoint(endpoint);
        if (this.store.state.peers.some((p) => p.id === remote.id)) {
          json(res, { status: "approved" });
          return;
        }
        const denied = this.denied.get(remote.id);
        if (
          denied &&
          denied.expires > Date.now() &&
          denied.attempt === info.attempt
        ) {
          json(res, { status: "denied" }, info.attempt ? 200 : 403);
          return;
        }
        if (
          !this.pending.has(remote.id) ||
          this.pending.get(remote.id)?.attempt !== info.attempt
        ) {
          if (this.pending.size >= 8) throw Error("등록 요청이 많습니다.");
          this.pending.set(remote.id, {
            ...remote,
            attempt: info.attempt,
            name: info.name,
            endpoint,
            expires: Date.now() + 300000,
            code: compareCode(this.id, remote.id),
          });
          this.changed();
        }
        json(res, { status: "pending" });
      },
    );
    this.address = address;
    this.advertisedName = this.store.state.settings.name;
    const listen = async (s: ShareListener, p: number) => {
      try {
        return await s.listen(address, p);
      } catch (e) {
        if ((e as any).code !== "EADDRINUSE") throw e;
        return s.listen(address, 0);
      }
    };
    this.port = (
      await listen(this.server, this.testNetwork?.port ?? 49431)
    ).port;
    this.pairPort = (
      await listen(
        this.bootstrap,
        this.testNetwork ? this.testNetwork.port + 1 : 49432,
      )
    ).port;
    this.diagnostics = "직접 연결을 받을 수 있습니다.";
    if (address === "127.0.0.1") return;
    const observe = (
      id: string,
      name: string,
      host: string,
      pairPort: number,
      port: number,
    ) => {
      if (
        this.address !== address ||
        !/^[0-9a-f]{64}$/.test(id) ||
        id === this.id ||
        (this.nearby.size >= 100 && !this.nearby.has(id))
      )
        return;
      const endpoint = { address: host, port: pairPort };
      validateEndpoint(endpoint);
      this.nearby.set(id, { id, name, endpoint, seen: Date.now() });
      const peer = this.store.state.peers.find((p) => p.id === id);
      if (peer) {
        validateEndpoint({ address: host, port });
        void this.probe(peer, { address: host, port });
      }
      this.changed();
    };
    this.beacon = listenForPeers(
      address,
      {
        id: this.id,
        name: this.advertisedName,
        pairPort: this.pairPort,
        port: this.port,
      },
      (p, host) => observe(p.id, p.name, host, p.pairPort, p.port),
    );
    try {
      const bonjour = (this.bonjour = createDiscovery(address, () => {
        this.diagnostics =
          "자동 검색을 사용할 수 없습니다. IP·포트로 직접 연결하세요.";
        this.changed();
      }));
      const instance = randomUUID();
      const published = bonjour.publish({
        name: instance,
        host: instance + ".local",
        type: "sync-vault",
        port: this.pairPort,
        disableIPv6: true,
        txt: {
          id: this.id,
          name: this.store.state.settings.name,
          port: String(this.port),
        },
        probe: true,
      });
      const records = published.records.bind(published);
      published.records = () =>
        records().filter(
          (r: any) =>
            r.type !== "AAAA" && (r.type !== "A" || r.data === address),
        );
      const found = (s: any) => {
        try {
          observe(
            String(s.txt?.id),
            String(s.txt?.name ?? "").slice(0, 60),
            s.referer?.address,
            s.port,
            Number(s.txt?.port),
          );
        } catch {}
      };
      this.refreshBrowse = () => {
        this.browser?.stop();
        this.browser = bonjour.find({ type: "sync-vault" }, found);
        this.browser.on("txt-update", found);
        this.browser.on("down", (s: any) => {
          this.nearby.delete(s.txt?.id);
          this.changed();
        });
      };
      this.refreshBrowse();
    } catch {
      this.diagnostics = "자동 검색 실패. 직접 연결 주소를 사용하세요.";
    }
  }
  private record(id: string, info: z.infer<typeof hello>, address: string) {
    const p = this.store.state.peers.find((p) => p.id === id);
    if (!p) return;
    if (info.clock && info.clock > (this.store.state.observed || 0))
      this.store.state.observed = info.clock;
    const endpoint = { address, port: info.port };
    validateEndpoint(endpoint);
    const changed =
      p.endpoint.address !== address ||
      p.endpoint.port !== info.port ||
      p.name !== info.name ||
      Date.now() - p.seen > 60000;
    this.online.set(id, {
      time: Date.now(),
      features: compatible(info.protocol, info.features),
      version: info.version,
    });
    if (changed) {
      Object.assign(p, { endpoint, name: info.name, seen: Date.now() });
      this.store.save();
    }
    this.changed();
  }
  private async probe(p: Peer, endpoint = p.endpoint) {
    if (this.probes.has(p.id)) return;
    this.probes.add(p.id);
    const gen = this.generation;
    try {
      const info = hello.parse(
        await shareRequest(
          this.keys,
          endpoint,
          p.cert,
          "/hello",
          Buffer.from(JSON.stringify(this.publicInfo())),
          AbortSignal.timeout(3500),
        ),
      );
      if (gen === this.generation) {
        this.direct.set(p.id, Date.now());
        this.record(p.id, info, endpoint.address);
        if (info.features.includes("return-channel")) void this.pollReturn(p);
      }
    } catch {
    } finally {
      this.probes.delete(p.id);
    }
  }
  available(id: string) {
    const o = this.online.get(id);
    return !!o && Date.now() - o.time < 15000;
  }
  private async pollReturn(p: Peer) {
    if (this.polling.has(p.id) || this.closed) return;
    const c = new AbortController();
    this.polling.set(p.id, c);
    try {
      while (
        !c.signal.aborted &&
        this.store.state.peers.some((q) => q.id === p.id)
      ) {
        const packet: any = await shareRequest(
          this.keys,
          p.endpoint,
          p.cert,
          "/return/poll",
          Buffer.from("{}"),
          c.signal,
        );
        if (packet.request) {
          if (!this.store.state.peers.some((q) => q.id === p.id)) break;
          const reply = await this.reverse.execute(
            p.id,
            packet.request,
            this.route,
          );
          await shareRequest(
            this.keys,
            p.endpoint,
            p.cert,
            "/return/reply",
            Buffer.from(JSON.stringify(reply)),
            c.signal,
          );
        }
      }
    } catch {
    } finally {
      if (this.polling.get(p.id) === c) this.polling.delete(p.id);
    }
  }
  async send(id: string, route: string, body: any, signal?: AbortSignal) {
    const p = this.store.state.peers.find((p) => p.id === id);
    if (!p || !this.address) throw Error("등록 기기의 연결을 확인하세요.");
    const c = new AbortController();
    if (!this.active.has(id)) this.active.set(id, new Set());
    this.active.get(id)!.add(c);
    const combined = signal ? AbortSignal.any([signal, c.signal]) : c.signal;
    try {
      if (
        this.reverse.available(id) &&
        Date.now() - (this.direct.get(id) || 0) > 15000
      )
        return await this.reverse.request(id, route, body, combined);
      return await shareRequest(
        this.keys,
        p.endpoint,
        p.cert,
        route,
        Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)),
        combined,
        Buffer.isBuffer(body),
      );
    } finally {
      this.active.get(id)?.delete(c);
    }
  }
  async inspect(endpoint: ShareEndpoint) {
    validateEndpoint(endpoint);
    if (!this.server) throw Error("네트워크를 먼저 선택하세요.");
    // Bootstrap reads the public certificate only. Registration requires visual verification on both machines.
    const remote = await new Promise<{ id: string; cert: string }>(
      (resolve, reject) => {
        const s = tls.connect(
          {
            ...this.keys,
            host: endpoint.address,
            port: endpoint.port,
            rejectUnauthorized: false,
            minVersion: "TLSv1.3",
            servername: "sync-vault",
          },
          () => {
            try {
              resolve(remoteCertificate(s));
            } catch (e) {
              reject(e);
            } finally {
              s.destroy();
            }
          },
        );
        s.setTimeout(4000, () => s.destroy(Error("직접 연결 시간 초과")));
        s.on("error", reject);
      },
    );
    if (remote.id === this.id) throw Error("현재 기기입니다.");
    const info = hello.parse(
      await shareRequest(
        this.keys,
        endpoint,
        remote.cert,
        "/info",
        Buffer.from("{}"),
      ),
    );
    if (!compatible(info.protocol, info.features).length)
      throw Error("상대 앱을 업데이트하세요.");
    return {
      ...remote,
      endpoint: { address: endpoint.address, port: info.port },
      name: info.name,
      code: compareCode(this.id, remote.id),
      expires: Date.now() + 300000,
    };
  }
  async register(endpoint: ShareEndpoint, req: Request, signal: AbortSignal) {
    const attempt = randomUUID();
    for (let i = 0; i < 100 && Date.now() < req.expires; i++) {
      signal.throwIfAborted();
      const r: any = await shareRequest(
        this.keys,
        endpoint,
        req.cert,
        "/register",
        Buffer.from(JSON.stringify({ ...this.publicInfo(), attempt })),
        signal,
      );
      if (r.status === "denied")
        throw Error("상대 기기가 등록 요청을 거절했습니다.");
      if (r.status === "approved") {
        this.trust(req);
        return;
      }
      await new Promise((r) => setTimeout(r, 1800));
    }
    throw Error("등록 요청이 만료되었습니다.");
  }
  deny(id: string) {
    const req = this.pending.get(id);
    if (!req) return;
    this.pending.delete(id);
    if (this.denied.size >= 128)
      this.denied.delete(this.denied.keys().next().value!);
    this.denied.set(id, req);
    this.changed();
  }
  approve(id: string) {
    const req = this.pending.get(id);
    if (!req || req.expires < Date.now()) throw Error("만료된 요청입니다.");
    this.trust(req);
    this.pending.delete(id);
  }
  private trust(req: Request) {
    if (!this.store.state.peers.some((p) => p.id === req.id))
      this.store.state.peers.push({
        id: req.id,
        cert: req.cert,
        name: req.name,
        endpoint: req.endpoint,
        autoAccept: false,
        seen: Date.now(),
      });
    this.store.save();
    this.server?.trust(
      this.keys,
      this.store.state.peers.map((p) => p.cert),
    );
    this.changed();
    const p = this.store.state.peers.find((p) => p.id === req.id)!;
    void this.probe(p);
  }
  forget(id: string) {
    this.reverse.forget(id);
    this.polling.get(id)?.abort();
    this.direct.delete(id);
    for (const c of this.active.get(id) ?? []) c.abort();
    this.store.state.peers = this.store.state.peers.filter((p) => p.id !== id);
    for (const j of [
      ...this.store.state.outgoing,
      ...this.store.state.incoming,
    ])
      if (j.peer === id && j.state !== "완료") j.state = "취소";
    this.store.save();
    this.online.delete(id);
    this.pending.delete(id);
    this.server?.trust(
      this.keys,
      this.store.state.peers.map((p) => p.cert),
    );
    this.changed();
  }
  private async disconnect() {
    for (const c of this.polling.values()) c.abort();
    this.direct.clear();
    for (const p of this.store.state.peers) this.reverse.forget(p.id);
    this.generation++;
    this.address = "";
    this.port = 0;
    this.pairPort = 0;
    this.online.clear();
    this.nearby.clear();
    this.refreshBrowse = undefined;
    this.beacon?.close();
    this.beacon = undefined;
    this.browser?.stop();
    this.browser = undefined;
    this.bonjour?.destroy();
    this.bonjour = undefined;
    for (const set of this.active.values()) for (const c of set) c.abort();
    const servers = [this.server, this.bootstrap];
    this.server = undefined;
    this.bootstrap = undefined;
    await Promise.all(servers.map((s) => s?.close()));
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    await this.disconnect();
  }
}
export async function binary(req: IncomingMessage) {
  if (
    req.headers["content-type"] !== "application/octet-stream" ||
    req.headers["content-encoding"]
  )
    throw Error("잘못된 전송 형식");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const data of req) {
    length += data.length;
    if (length > chunkSize) throw Error("전송 조각 크기 초과");
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}
