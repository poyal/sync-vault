import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { z } from "zod";
import { development, service } from "./channel";
const udpPort = development ? 49436 : 49433;
const protocol = service + "-discovery/1";
const endpoint = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(60),
  pairPort: z.number().int().min(1).max(65535),
  port: z.number().int().min(1).max(65535),
});
const packet = endpoint
  .extend({ service: z.literal(protocol), query: z.boolean() })
  .strict();
type Advert = z.infer<typeof endpoint>;
function number(address: string) {
  return address.split(".").reduce((n, b) => (n << 8) | Number(b), 0) >>> 0;
}
export function listenForPeers(
  address: string,
  self: Advert,
  found: (peer: Advert, address: string) => void,
) {
  const nic = Object.values(networkInterfaces())
    .flat()
    .find((n) => n?.address === address && n.family === "IPv4");
  if (!nic) return;
  const mask = number(nic.netmask),
    network = (number(address) & mask) >>> 0;
  if (mask >= 0xfffffffe) return;
  const broadcast = (network | ~mask) >>> 0;
  const destination = [24, 16, 8, 0]
    .map((n) => (broadcast >>> n) & 255)
    .join(".");
  const listener = createSocket({ type: "udp4", reuseAddr: true }),
    sender = createSocket("udp4");
  const make = (query: boolean) =>
    Buffer.from(JSON.stringify({ ...self, service: protocol, query }));
  const query = make(true),
    reply = make(false);
  let active = true,
    ready = false,
    windowStart = 0,
    replies = 0;
  function announce() {
    if (active && ready) sender.send(query, udpPort, destination, () => {});
  }
  for (const socket of [listener, sender]) {
    socket.on("error", () => {}); // mDNS and manual pairing remain independent.
    socket.on("message", (bytes, from) => {
      if (
        !active ||
        bytes.length > 900 ||
        !bytes.length ||
        isIP(from.address) !== 4 ||
        (number(from.address) & mask) >>> 0 !== network ||
        from.address === address
      )
        return;
      try {
        const peer = packet.parse(JSON.parse(bytes.toString("utf8")));
        if (peer.id === self.id) return;
        found(peer, from.address);
        if (peer.query && ready && socket === listener) {
          const now = Date.now();
          if (now - windowStart >= 1000) {
            windowStart = now;
            replies = 0;
          }
          if (replies++ < 12)
            sender.send(reply, from.port, from.address, () => {});
        }
      } catch {
        /* unrelated broadcast */
      }
    });
  }
  listener.bind(udpPort, "0.0.0.0");
  sender.bind(0, address, () => {
    if (!active) return;
    try {
      sender.setBroadcast(true);
      ready = true;
      announce();
    } catch {
      ready = false;
    }
  });
  const repeat = setInterval(announce, 4500);
  return {
    announce,
    close() {
      active = false;
      clearInterval(repeat);
      for (const socket of [sender, listener]) {
        try {
          socket.close();
        } catch (e) {
          if (
            (e as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING"
          )
            throw e;
        }
      }
    },
  };
}
