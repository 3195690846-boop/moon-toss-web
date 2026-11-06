export const SERVICE = '0000fd50-0000-1000-8000-00805f9b34fb';
export const CONTROL = '00000001-0000-1001-8001-00805f9b07d0';
export const NOTIFY = '00000002-0000-1001-8001-00805f9b07d0';
export const VERSION = '0.1-hw1';

export function encode(message, id) {
  const data = new TextEncoder().encode(JSON.stringify(message));
  if (!data.length || data.length > 768) throw new Error('消息长度超限');
  const count = Math.ceil(data.length / 12);
  return Array.from({length: count}, (_, part) => {
    const body = data.slice(part * 12, (part + 1) * 12);
    const frame = new Uint8Array(8 + body.length);
    frame.set([0x4d, 1, id & 255, (id >>> 8) & 255, part, count, data.length & 255, data.length >>> 8]);
    frame.set(body, 8);
    return frame;
  });
}

export class Decoder {
  reset() { this.pending = null; }
  feed(frame, now = performance.now()) {
    try {
      const bytes = frame instanceof DataView ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : new Uint8Array(frame);
      if (bytes.length < 9 || bytes.length > 20 || bytes[0] !== 0x4d || bytes[1] !== 1) throw new Error('无效蓝牙帧');
      const id = bytes[2] | bytes[3] << 8;
      const part = bytes[4];
      const count = bytes[5];
      const total = bytes[6] | bytes[7] << 8;
      if (!total || total > 768 || count !== Math.ceil(total / 12) || part >= count || bytes.length !== 8 + Math.min(12, total - part * 12)) throw new Error('蓝牙帧长度不匹配');
      if (part === 0) this.pending = {id, count, total, next: 0, began: now, data: new Uint8Array(total)};
      const pending = this.pending;
      if (!pending || pending.id !== id || pending.count !== count || pending.total !== total || pending.next !== part || now - pending.began > 5000) throw new Error('蓝牙帧丢失、乱序或超时');
      pending.data.set(bytes.subarray(8), part * 12);
      pending.next++;
      if (pending.next !== count) return null;
      const message = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(pending.data));
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('消息不是对象');
      this.reset();
      return message;
    } catch (error) {
      this.reset();
      throw error;
    }
  }
}

export class Round {
  constructor(id, session, identities) {
    this.id = id;
    this.session = session;
    this.identities = identities;
    this.moved = new Set();
    this.faces = new Map();
    this.enabled = false;
    this.done = false;
  }
  accept(slot, message) {
    const identity = this.identities[slot];
    if (!this.enabled || this.done || !identity || message.deviceId !== identity.deviceId || message.bootId !== identity.bootId || message.sessionId !== this.session || message.roundId !== this.id) return null;
    if (message.type === 'face_unknown' && message.payload?.reason === 'moving') this.moved.add(slot);
    if (message.type === 'face_stable' && this.moved.has(slot) && message.payload?.stable === true && ['flat', 'rounded'].includes(message.payload.face) && !this.faces.has(slot)) this.faces.set(slot, message.payload.face);
    if (this.faces.size !== Object.keys(this.identities).length) return null;
    this.done = true;
    const faces = [...this.faces.values()];
    if (faces.length === 1) return faces[0] === 'flat' ? '平面朝上' : '凸面朝上';
    if (faces.length !== 2) throw new Error('只支持一枚检测或两枚组合');
    return faces[0] !== faces[1] ? '圣筊 · 一平一凸' : faces[0] === 'flat' ? '笑筊 · 两平' : '阴筊 · 两凸';
  }
}
