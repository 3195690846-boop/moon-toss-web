import {SERVICE, CONTROL, NOTIFY, VERSION, encode, Decoder, Round} from './protocol.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uuid = () => crypto.randomUUID();
const state = {
  session: uuid(),
  cups: new Map(),
  active: null,
  busy: false,
  tearingDown: false,
  mounted: false,
  lines: [],
};

const panel = () => document.querySelector('#ble-panel');
const q = selector => panel()?.querySelector(selector);
const slotEl = slot => panel()?.querySelector(`[data-slot="${slot}"]`);
const field = (slot, name, value) => {
  const element = slotEl(slot)?.querySelector(`[data-value="${name}"]`);
  if (element) element.textContent = value;
};
const log = message => {
  state.lines.push(`${new Date().toLocaleTimeString()} ${message}`);
  const element = q('#ble-log');
  if (element) element.textContent = state.lines.slice(-100).join('\n');
};
const outcome = (result, hint) => {
  const resultEl = q('#ble-result');
  const hintEl = q('#ble-hint');
  if (resultEl) resultEl.textContent = result;
  if (hintEl) hintEl.textContent = hint;
};
const setFace = (slot, value) => {
  const element = slotEl(slot)?.querySelector('[data-value="face"]');
  if (!element) return;
  const label = {flat: '平面朝上', rounded: '凸面朝上', moving: '运动中'}[value] || '杯面待检测';
  element.className = `ble-face ${value || ''}`;
  element.setAttribute('aria-label', label);
  field(slot, 'faceLabel', label);
};

function updateControls() {
  const root = panel();
  if (!root) return;
  root.querySelectorAll('[data-ble-action]').forEach(button => {
    const cup = state.cups.get(button.closest('[data-slot]')?.dataset.slot);
    const action = button.dataset.bleAction;
    button.disabled = state.busy || (action === 'connect' ? Boolean(cup) : !cup?.ready);
  });
  const single = q('#ble-single');
  const dual = q('#ble-dual');
  const disconnect = q('#ble-disconnect');
  if (single) single.disabled = state.busy || ![...state.cups.values()].some(cup => cup.ready);
  if (dual) dual.disabled = state.busy || !['A', 'B'].every(slot => state.cups.get(slot)?.ready);
  if (disconnect) disconnect.disabled = state.busy || state.cups.size === 0;
}

function renderCup(cup) {
  const status = cup.status || {};
  const role = cup.hello?.payload?.role || '?';
  field(cup.slot, 'identity', `${cup.device?.name || ''} / ${cup.hello?.deviceId || ''}`);
  field(cup.slot, 'sensor', `${status.sensorModel || cup.hello?.payload?.sensorModel || '未知'} / ${status.sensorReady === true ? '就绪' : '未就绪'}`);
  const hex = value => Number.isInteger(value) && value >= 0 && value <= 255
    ? `0x${value.toString(16).toUpperCase().padStart(2, '0')}` : '—';
  field(cup.slot, 'chip', status.whoAmI == null ? '—' : `${hex(status.whoAmI)} / 预期 ${((status.sensorModel || cup.hello?.payload?.sensorModel) === 'MPU6050') ? '0x68' : ((status.sensorModel || cup.hello?.payload?.sensorModel) === 'MPU6500' ? '0x70' : '0x12')}`);
  field(cup.slot, 'address', status.i2cAddress == null ? '—' : `${hex(status.i2cAddress)}${status.sensorReady ? '' : '（最后尝试）'}`);
  field(cup.slot, 'state', {idle: '待机', armed: '等待投掷', moving: '运动中', settled: '已落稳', calibrating: '标定中', error: '传感器异常'}[status.state] || '连接中');
  field(cup.slot, 'cal', `${role} / ${['未标定', '仅平面完成', '仅凸面完成', '两面完成'][status.calibrationMask] || '未标定'}`);
  const vector = value => Array.isArray(value) ? value.map(number => Number(number).toFixed(3)).join(' / ') : '—';
  field(cup.slot, 'accel', vector(status.accelG));
  field(cup.slot, 'gyro', vector(status.gyroDps));
  field(cup.slot, 'age', `${status.sampleAgeMs == null ? '无有效快照' : `设备快照年龄 ${status.sampleAgeMs} ms`}${status.sampleClipped ? ' · 超量程' : ''}`);
  const badge = slotEl(cup.slot)?.querySelector('[data-value="state"]');
  if (badge) badge.textContent = {idle: '待机', armed: '等待投掷', moving: '运动中', settled: '已落稳', calibrating: '标定中', error: '传感器异常'}[status.state] || '已连接';
}

function resetCupView(slot) {
  ['identity', 'sensor', 'chip', 'address', 'cal', 'accel', 'gyro', 'age'].forEach(name => field(slot, name, '—'));
  field(slot, 'state', '未连接');
  setFace(slot, '');
  const badge = slotEl(slot)?.querySelector('[data-value="state"]');
  if (badge) badge.textContent = '未连接';
}

class Cup {
  constructor(slot) {
    this.slot = slot;
    this.decoder = new Decoder();
    this.pending = new Map();
    this.id = 0;
    this.sequence = -1;
    this.writeChain = Promise.resolve();
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({filters: [{namePrefix: 'MoonToss-'}], optionalServices: [SERVICE]});
    if (state.cups.get(this.slot) !== this) throw new Error('连接操作已取消');
    if ([...state.cups.values()].some(cup => cup !== this && cup.device?.id === this.device.id)) throw new Error('两栏不能选择同一枚设备');
    this.device.addEventListener('gattserverdisconnected', () => {
      if (state.cups.get(this.slot) === this) disconnectAll('设备断连，请重新连接并开始新一轮');
    });
    const server = await this.device.gatt.connect();
    this.ownsGatt = true;
    const service = await server.getPrimaryService(SERVICE);
    this.control = await service.getCharacteristic(CONTROL);
    this.notify = await service.getCharacteristic(NOTIFY);
    this.notify.addEventListener('characteristicvaluechanged', event => {
      try {
        const message = this.decoder.feed(event.target.value);
        if (message) this.receive(message);
      } catch (error) {
        log(`${this.slot}: ${error.message}`);
        if (state.active) state.active.reject(error);
      }
    });
    const hello = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
      this.helloTimer = setTimeout(() => reject(new Error('未收到固件 hello')), 10000);
    });
    hello.catch(() => {});
    try {
      await this.notify.startNotifications();
      await hello;
    } catch (error) {
      this.helloReject?.(error);
      await hello.catch(() => {});
      throw error;
    } finally {
      clearTimeout(this.helloTimer);
    }
    if (!['0.2.0-icm20602', '0.2.1-icm20602', '0.2.2-icm20602', '0.3.0-mpu6050', '0.3.1-mpu6xxx', '0.3.2-mpu6xxx'].includes(this.hello.payload?.firmwareVersion)) {
      throw new Error('请使用受支持的 ICM-20602 或 MPU6050 专用固件');
    }
    const expectedModel = this.hello.payload.firmwareVersion === '0.3.0-mpu6050' ? 'MPU6050' : 'ICM-20602';
    if(['0.3.1-mpu6xxx','0.3.2-mpu6xxx'].includes(this.hello.payload.firmwareVersion) ? !['MPU6050','MPU6500','MPU6xxx-unidentified'].includes(this.hello.payload.sensorModel) : this.hello.payload.sensorModel !== expectedModel) throw new Error('固件版本与传感器声明不匹配');
    if ([...state.cups.values()].some(cup => cup !== this && cup.hello?.deviceId === this.hello.deviceId)) throw new Error('两枚设备身份重复');
    await this.command('open_session', {}, null, message => message.type === 'session_ack' && message.payload?.status === 'accepted');
    this.ready = true;
    await this.refresh();
    renderCup(this);
  }

  receive(message) {
    if (message.protocolVersion !== VERSION || !Number.isSafeInteger(message.seq)) return;
    if (message.type === 'hello') {
      if (!message.deviceId || !Number.isSafeInteger(message.bootId) || message.bootId <= 0) return;
      if (this.hello && (message.deviceId !== this.hello.deviceId || message.bootId !== this.hello.bootId)) {
        disconnectAll('设备身份或启动编号变化，本轮已取消');
        return;
      }
      if (message.seq <= this.sequence) return;
      this.hello = message;
      this.helloResolve?.(message);
    }
    if (message.seq <= this.sequence) return;
    if (!this.hello || message.deviceId !== this.hello.deviceId || message.bootId !== this.hello.bootId) return;
    if (message.sessionId && message.sessionId !== state.session) return;
    this.sequence = message.seq;
    if (message.type === 'status' || message.type === 'imu_sample') {
      this.status = {...this.status, ...message.payload};
      renderCup(this);
    }
    log(`${this.slot}: ${message.type} ${JSON.stringify(message.payload)}`);
    const pending = this.pending.get(message.requestId);
    if (message.type === 'error') {
      const error = new Error(`${this.slot}: ${message.payload?.message || '设备错误'}`);
      if (pending) pending.reject(error);
      else if (state.active) state.active.reject(error);
    } else if (pending?.accept(message)) pending.resolve(message);
    if (state.active && message.roundId === state.active.round.id) {
      const result = state.active.round.accept(this.slot, message);
      if (state.active.round.enabled && message.type === 'face_unknown' && message.payload?.reason === 'moving') setFace(this.slot, 'moving');
      if (state.active.round.faces.has(this.slot)) setFace(this.slot, state.active.round.faces.get(this.slot));
      if (result) state.active.resolve(result);
    }
  }

  async command(type, payload = {}, roundId = null, accept = () => true, timeout = 20000) {
    if (!this.device?.gatt.connected || !this.hello) throw new Error(`${this.slot}: 尚未连接`);
    const requestId = uuid();
    const message = {protocolVersion: VERSION, type, deviceId: this.hello.deviceId, bootId: this.hello.bootId, sessionId: state.session, requestId, payload};
    if (roundId) message.roundId = roundId;
    let timer;
    const reply = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${this.slot}: ${type} 回执超时`)), timeout);
      this.pending.set(requestId, {accept, resolve, reject});
    });
    reply.catch(() => {});
    const frames = encode(message, ++this.id);
    const write = this.writeChain.then(async () => {
      for (const frame of frames) {
        if (this.control.writeValueWithResponse) await this.control.writeValueWithResponse(frame);
        else await this.control.writeValue(frame);
        await sleep(25);
      }
    });
    this.writeChain = write.catch(() => {});
    try {
      await write;
      return await reply;
    } finally {
      clearTimeout(timer);
      this.pending.delete(requestId);
    }
  }

  refresh() { return this.command('get_status', {}, null, message => message.type === 'status'); }

  close() {
    clearTimeout(this.helloTimer);
    this.helloReject?.(new Error('已断开'));
    this.ready = false;
    for (const pending of this.pending.values()) pending.reject(new Error('连接已关闭'));
    this.pending.clear();
    if (this.ownsGatt) this.device?.gatt?.disconnect();
  }
}

function disconnectAll(reason = '已断开设备') {
  if (state.tearingDown) return;
  state.tearingDown = true;
  state.active?.reject(new Error(reason));
  const current = [...state.cups.values()];
  state.cups.clear();
  current.forEach(cup => cup.close());
  state.session = uuid();
  ['A', 'B'].forEach(resetCupView);
  outcome(reason, '重新连接后需要新建轮次；已保存的标定仍在设备中。');
  state.tearingDown = false;
  updateControls();
}

async function operate(action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try {
    await action();
  } catch (error) {
    outcome('操作未完成', error.message);
    log(error.message);
  } finally {
    state.busy = false;
    updateControls();
  }
}

async function runRound(dual) {
  const selected = dual ? ['A', 'B'].map(slot => state.cups.get(slot)) : [[...state.cups.values()].find(cup => cup.ready)];
  if (selected.some(cup => !cup?.ready)) throw new Error('请连接所需筊杯');
  for (const cup of selected) {
    await cup.refresh();
    if (!cup.status?.sensorReady || cup.status.calibrationMask !== 3) throw new Error(`${cup.slot} 杯需要传感器就绪且两面标定完成`);
    if (cup.status.state !== 'idle') throw new Error(`${cup.slot} 杯尚未待机，请断开重连后重试`);
  }
  if (dual && selected.some(cup => cup.hello.payload.role !== cup.slot)) throw new Error('请先将两枚分别设为角色 A 和 B');
  const round = new Round(uuid(), state.session, Object.fromEntries(selected.map(cup => [cup.slot, cup.hello])));
  let resolve, reject;
  const result = new Promise((yes, no) => { resolve = yes; reject = no; });
  result.catch(() => {});
  state.active = {round, resolve, reject};
  let timer;
  try {
    outcome('正在准备本轮', '收到所有设备的开轮回执后，才会提示移动。');
    const replies = await Promise.allSettled(selected.map(cup => cup.command('round_begin', {}, round.id, message => message.type === 'round_ack' && message.payload?.status === 'accepted')));
    const failed = replies.find(reply => reply.status === 'rejected');
    if (failed) throw failed.reason;
    if (!state.active || state.active.round !== round || selected.some(cup => !cup.ready)) throw new Error('本轮连接已失效');
    round.enabled = true;
    selected.forEach(cup => setFace(cup.slot, ''));
    outcome('现在移动筊杯，再放稳', '先在桌面轻轻翻转验证；装壳固定和防护验证完成后再做真实投掷。');
    timer = setTimeout(() => reject(new Error('本轮超时，未收齐有效朝向')), 28000);
    const value = await result;
    outcome(value, value.startsWith('圣筊') ? '传统解释为应允、肯定。' : value.startsWith('笑筊') ? '传统解释为笑而未决，可澄清问题后再问。' : '传统解释为未获应允、暂缓。');
  } finally {
    clearTimeout(timer);
    round.enabled = false;
    const ends = await Promise.allSettled(selected.filter(cup => cup.ready).map(cup => cup.command('round_end', {reason: 'complete_or_cancel'}, round.id, message => message.type === 'round_end_ack', 10000)));
    if (ends.some(reply => reply.status === 'rejected')) disconnectAll('轮次关闭未确认，请重连后重试');
    if (state.active?.round === round) state.active = null;
  }
}

function bind() {
  const root = panel();
  if (!root || root.dataset.bound === 'true') return;
  root.dataset.bound = 'true';
  root.querySelectorAll('[data-ble-action]').forEach(button => button.addEventListener('click', () => operate(async () => {
    const slot = button.closest('[data-slot]').dataset.slot;
    const action = button.dataset.bleAction;
    if (action === 'connect') {
      const cup = new Cup(slot);
      state.cups.set(slot, cup);
      try {
        await cup.connect();
        outcome('设备已连接', '先确认传感器就绪，再分别标定两面。');
      } catch (error) {
        state.cups.delete(slot);
        cup.close();
        throw error;
      }
      return;
    }
    const cup = state.cups.get(slot);
    if (action === 'status') {
      await cup.refresh();
      return;
    }
    if (!cup.status?.sensorReady) throw new Error('传感器未就绪，请检查接线、芯片身份和启动日志');
    if (action === 'role') {
      await cup.command('set_role', {role: slot}, null, message => message.type === 'role_ack' && message.payload?.status === 'applied');
    } else {
      const label = action === 'flat' ? '平面' : '凸面';
      outcome(`${slot} 杯${label}标定中`, '请保持对应面朝上并放稳，等待设备保存回执。');
      await cup.command('calibrate', {face: action}, null, message => message.type === 'calibration_ack' && message.payload?.status === 'applied');
      outcome(`${slot} 杯${label}标定已保存`, '另一面也标定完成后，即可开始检测。');
    }
    await cup.refresh();
  })));
  q('#ble-single')?.addEventListener('click', () => operate(() => runRound(false)));
  q('#ble-dual')?.addEventListener('click', () => operate(() => runRound(true)));
  q('#ble-disconnect')?.addEventListener('click', () => disconnectAll());
  updateControls();
}

export function mountBle() {
  const root = panel();
  if (!root) return;
  const support = q('#ble-support');
  if (navigator.bluetooth && window.isSecureContext) {
    if (support) support.textContent = '浏览器支持蓝牙：点击连接后选择 MoonToss 设备；设备状态以实际回执为准。';
  } else {
    if (support) support.textContent = '当前浏览器不能调用 BLE。iPhone 请在 Bluefy 中打开本页；Safari 只支持数字体验。';
    root.querySelectorAll('[data-ble-action="connect"]').forEach(button => { button.hidden = true; });
  }
  bind();
  for (const cup of state.cups.values()) renderCup(cup);
  updateControls();
  state.mounted = true;
}

window.addEventListener('pagehide', () => disconnectAll());
