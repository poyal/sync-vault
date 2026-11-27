import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Lan } from "./lan";
import { validateOffer, Receiver, chunkSize } from "./files";
import type { History } from "./history";
import type { Shelf } from "./shelf";
import type { Store } from "./store";
import type { Pull, Entry } from "./types";
import type { Clips } from "./clipboard";
import { inside } from "./shelf";

const token = z.string().min(1).max(18000),
  integer = z.number().int().nonnegative().safe();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowSchema = z.object({
  id: token,
  name: z.string().max(180),
  dir: z.boolean(),
  size: integer,
});
const listSchema = z.object({
  rows: rowSchema.array().max(60),
  next: integer.nullable(),
});
const clipList = z
  .array(
    z.object({
      id: z.string().uuid(),
      time: integer,
      kind: z.enum(["text", "image"]),
      preview: z.string().max(160),
      thumb: z
        .string()
        .max(32000)
        .regex(/^[A-Za-z0-9+/=]+$/)
        .optional(),
    }),
  )
  .max(50);

export class Vault {
  readonly active = new Map<string, AbortController>();
  private epoch = 0;
  private peerEpoch = new Map<string, number>();
  private revoking = new Set<string>();
  private generation(peer: string) {
    return this.epoch + ":" + (this.peerEpoch.get(peer) || 0);
  }
  private retries = new Map<string, number>();
  constructor(
    private store: Store,
    private lan: Lan,
    readonly shelf: Shelf,
    readonly history: History,
    private clips: Clips,
    private receiver: Receiver,
    private changed: () => void,
    private redact: (peer?: string) => void,
  ) {
    lan.onPeerLock = (id) => this.invalidate(id);
  }
  check(peer: string) {
    if (this.clips.locked) throw Error("이 기기의 화면이 잠겼습니다.");
    if (peer === this.lan.id) return;
    if (
      this.revoking.has(peer) ||
      !this.store.state.peers.some((p) => p.id === peer)
    )
      throw Error("등록이 해제된 기기입니다.");
    if (!this.lan.available(peer)) throw Error("상대 기기가 오프라인입니다.");
    const info = this.lan.online.get(peer);
    if (!info?.features.includes("vault")) throw Error("상대 앱 업데이트 필요");
    if (info.locked) throw Error("상대 기기의 화면이 잠겼습니다.");
  }
  invalidate(peer?: string) {
    if (peer) this.peerEpoch.set(peer, (this.peerEpoch.get(peer) || 0) + 1);
    else ++this.epoch;
    this.redact(peer);
    this.shelf.clear(peer);
    for (const p of this.store.state.pulls)
      if (!peer || p.peer === peer) this.active.get(p.id)?.abort();
    this.changed();
  }
  async forget(peer: string, notify = true) {
    this.revoking.add(peer);
    this.invalidate(peer);
    try {
      if (notify && this.lan.available(peer))
        await this.lan
          .send(peer, "/vault/unlink", {}, AbortSignal.timeout(1500))
          .catch(() => {});
      for (const p of this.store.state.pulls)
        if (p.peer === peer && p.state !== "완료")
          await this.action(p.id, "cancel");
      this.lan.forget(peer);
    } finally {
      this.revoking.delete(peer);
    }
  }
  announce(locked: boolean) {
    const state = this.lan.access(locked);
    if (locked) this.invalidate();
    for (const p of this.store.state.peers)
      if (this.lan.online.get(p.id)?.features.includes("vault"))
        void this.lan
          .send(p.id, "/vault/access", state, AbortSignal.timeout(3500))
          .catch(() => {});
  }
  async serve(peer: string, route: string, body: any): Promise<unknown> {
    if (route === "/vault/unlink") {
      await this.forget(peer, false);
      return {};
    }
    if (route === "/vault/access") {
      const access = z
        .object({
          locked: z.boolean(),
          accessSession: z.string().uuid(),
          accessSeq: integer,
        })
        .parse(body);
      this.lan.updateAccess(peer, access);
      this.changed();
      return {};
    }
    const epoch = this.generation(peer);
    const guard = () => {
      this.check(peer);
      if (epoch !== this.generation(peer))
        throw Error("공유 상태가 변경되었습니다.");
    };
    guard();
    let result: unknown;
    if (route === "/vault/history" || route === "/vault/clip") {
      if (this.store.state.settings.paused && peer !== this.lan.id)
        throw Error("클립보드 기록 공유가 꺼져 있습니다.");
      result =
        route === "/vault/history"
          ? this.history.list()
          : await this.history
              .get(z.string().uuid().parse(body.id))
              .then((clip) => ({
                ...clip,
                stamp: { ...clip.stamp, origin: this.lan.id },
              }));
    } else if (route === "/vault/list") {
      const q = z
        .object({ id: token.or(z.literal("")), offset: integer })
        .parse(body);
      result = await this.shelf.list(q.id, q.offset);
    } else if (route === "/vault/manifest") {
      const q = z
        .object({ job: z.string().uuid(), item: token, offset: integer })
        .parse(body);
      result = await this.shelf.manifest(peer, q.job, q.item, q.offset, guard);
    } else if (route === "/vault/release") {
      const q = z
        .object({ job: z.string().uuid(), verify: z.boolean() })
        .parse(body);
      await this.shelf.release(peer, q.job, q.verify, guard);
      result = {};
    } else if (route === "/vault/part") {
      const q = z
        .object({ job: z.string().uuid(), index: integer, offset: integer })
        .parse(body);
      result = await this.shelf.part(peer, q.job, q.index, q.offset);
    } else throw Error("지원하지 않는 요청입니다.");
    guard();
    if (
      (route === "/vault/history" || route === "/vault/clip") &&
      peer !== this.lan.id &&
      this.store.state.settings.paused
    )
      throw Error("클립보드 기록 공유가 꺼져 있습니다.");
    return result;
  }
  private async request(
    peer: string,
    route: string,
    body: unknown,
    signal?: AbortSignal,
  ) {
    this.check(peer);
    const epoch = this.generation(peer);
    const value =
      peer === this.lan.id
        ? await this.serve(peer, route, body)
        : await this.lan.send(peer, route, body, signal);
    this.check(peer);
    signal?.throwIfAborted();
    if (epoch !== this.generation(peer))
      throw Error("공유 상태가 변경되었습니다.");
    if (value && typeof value.problem === "string") throw Error(value.problem);
    return value;
  }
  async list(peer: string, id: string, offset: number) {
    return listSchema.parse(
      await this.request(peer, "/vault/list", { id, offset }),
    );
  }
  async records(peer: string) {
    return clipList.parse(await this.request(peer, "/vault/history", {}));
  }
  async copy(peer: string, id: string) {
    const epoch = this.generation(peer),
      clip = await this.request(peer, "/vault/clip", { id });
    await this.clips.copySelected(peer, clip, () => {
      this.check(peer);
      if (epoch !== this.generation(peer)) throw Error("다시 선택해 주세요.");
    });
  }
  enqueue(peer: string, item: string, name: string) {
    this.check(peer);
    if (peer === this.lan.id) throw Error("상대 기기를 선택하세요.");
    const existing = this.store.state.pulls.find(
      (p) =>
        p.peer === peer &&
        p.item === item &&
        !["취소", "완료", "오류"].includes(p.state),
    );
    if (existing) return existing.id;
    const p: Pull = {
      id: randomUUID(),
      peer,
      item: token.parse(item),
      name: z.string().min(1).max(180).parse(name),
      state: "대기",
    };
    this.store.state.pulls.push(p);
    this.store.save();
    this.changed();
    this.pump();
    return p.id;
  }
  async action(id: string, op: string) {
    const p = this.store.state.pulls.find((p) => p.id === id);
    if (!p || p.state === "완료") return;
    if (op === "cancel") {
      p.state = "취소";
      this.active.get(id)?.abort();
      await this.receiver.cancel(p.peer, id).catch(() => {});
    } else if (op === "retry" && p.state !== "취소") {
      this.check(p.peer);
      p.state = "대기";
      p.error = "";
      this.retries.delete(id);
    }
    this.store.save();
    this.changed();
    this.pump();
  }
  pump() {
    for (const p of this.store.state.pulls) {
      if (this.active.size >= 2) break;
      if (
        !["대기", "준비 중", "수신 중", "재연결 대기"].includes(p.state) ||
        this.active.has(p.id) ||
        (this.retries.get(p.id) || 0) > Date.now()
      )
        continue;
      try {
        this.check(p.peer);
      } catch {
        continue;
      }
      const ctl = new AbortController();
      this.active.set(p.id, ctl);
      void this.receive(p, ctl.signal)
        .then(() => {
          p.state = "완료";
          p.error = "";
        })
        .catch(async (e) => {
          await this.request(
            p.peer,
            "/vault/release",
            { job: p.id, verify: false },
            AbortSignal.timeout(1500),
          ).catch(() => {});
          if (p.state === "취소") return;
          const transient =
            ctl.signal.aborted ||
            /ECONN|ETIMEDOUT|EPIPE|ENET|시간 초과|오프라인|잠겼|공유 상태가 변경|전송을 다시 준비|socket/i.test(
              msg(e),
            );
          p.state = transient ? "재연결 대기" : "오류";
          p.error =
            (e as NodeJS.ErrnoException).code === "ENOSPC"
              ? "받을 드라이브의 여유 공간이 부족합니다. 공간을 확보하고 재시도하세요."
              : msg(e);
          this.retries.set(p.id, Date.now() + 2000);
        })
        .finally(() => {
          this.active.delete(p.id);
          this.store.save();
          this.changed();
        });
    }
  }
  private async receive(p: Pull, signal: AbortSignal) {
    const req = (route: string, b: object) =>
      this.request(p.peer, "/vault/" + route, { job: p.id, ...b }, signal);
    const existing = this.store.state.incoming.find(
      (j) => j.id === p.id && j.peer === p.peer,
    );
    if (existing?.state === "완료") return;
    p.state = "준비 중";
    this.changed();
    const entries: Entry[] = [];
    for (;;) {
      const r = await req("manifest", { item: p.item, offset: entries.length });
      if (r.preparing) {
        await wait(200);
        continue;
      }
      if (
        !Array.isArray(r.entries) ||
        !r.entries.length ||
        r.entries.length > 40 ||
        !Number.isInteger(r.total) ||
        r.total > 8000
      )
        throw Error("잘못된 원본 목록입니다.");
      entries.push(...r.entries);
      if (entries.length === r.total) break;
      if (entries.length > r.total) throw Error("원본 목록이 변경되었습니다.");
    }
    const offer = validateOffer({ id: p.id, entries });
    const rootName = p.name.normalize("NFC");
    if (offer.entries.some((e) => e.name.split("/")[0] !== rootName))
      throw Error("선택한 원본과 파일 목록이 다릅니다.");
    if (
      existing &&
      JSON.stringify(existing.offer.entries) !== JSON.stringify(offer.entries)
    )
      throw Error("원본이 변경되었습니다. 목록을 새로고침하세요.");
    if (
      inside(this.shelf.root, this.store.state.settings.receive) ||
      inside(this.store.state.settings.receive, this.shelf.root)
    )
      throw Error("공유 폴더와 다른 수신 위치를 선택하세요.");
    try {
      await this.receiver.offer(p.peer, offer, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOSPC") throw e;
      throw Error(
        "받을 폴더를 사용할 수 없습니다. 저장 위치와 남은 공간을 확인한 후 재시도하세요.",
      );
    }
    p.state = "수신 중";
    this.changed();
    for (const [i, e] of entries.entries()) {
      signal.throwIfAborted();
      if (e.dir) continue;
      const status = (await this.receiver.part(
        p.peer,
        p.id,
        i,
        "status",
        {},
      )) as { complete: boolean; offset: number };
      if (status.complete) continue;
      let offset = status.offset;
      if (offset > e.size) throw Error("임시 파일 크기를 확인할 수 없습니다.");
      while (offset < e.size) {
        const result = await req("part", { index: i, offset });
        if (
          typeof result.data !== "string" ||
          result.data.length > Math.ceil(chunkSize / 3) * 4
        )
          throw Error("잘못된 파일 조각입니다.");
        const bytes = Buffer.from(result.data, "base64");
        if (
          !bytes.length ||
          bytes.length !== Math.min(chunkSize, e.size - offset)
        )
          throw Error("파일 길이가 일치하지 않습니다.");
        await this.receiver.part(p.peer, p.id, i, String(offset), bytes);
        offset += bytes.length;
        this.changed();
      }
      await this.receiver.part(p.peer, p.id, i, "finish", {});
    }
    this.check(p.peer);
    signal.throwIfAborted();
    await req("release", { verify: true });
    await this.receiver.finish(p.peer, p.id);
  }
}
