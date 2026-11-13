// Client netcode core: handshake, tick clock, own-ship prediction and
// reconciliation. No DOM and no sockets, so the browser client, the headless
// bots and the virtual-time tests all run this same class.
//
// Tick numbering: state[T] = step(state[T − 1], input[T]). The client runs
// ahead of the server, so that input[T] reaches the server before the server
// simulates tick T.

import { CONSTANTS_HASH, SHIP_LENGTH, TICK_MS } from '../shared/constants.ts';
import { TWO_PI } from '../shared/math.ts';
import {
  INPUT_REDUNDANCY,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeHello,
  encodeInput,
} from '../shared/protocol.ts';
import type { RejectReason, SnapshotMessage, WelcomeMessage } from '../shared/protocol.ts';
import { NEUTRAL_INPUT, quantiseControls, shipStatesEqual, stepShip } from '../shared/sim/ship.ts';
import type { Controls, Input, ShipState } from '../shared/sim/ship.ts';
import type { Transport } from '../shared/transport.ts';

export interface ClientTuning {
  /** Ticks of slack the client aims to give its inputs on a steady link. */
  baseLeadTicks: number;
  /**
   * Extra slack at the start. The first round-trip figure is a single
   * sample, so begin generously and let the tick clock settle down to the
   * target; beginning short would make the first inputs late.
   */
  initialExtraLeadTicks: number;
  /** The slack never grows past this, however jittery the link. */
  maxLeadTicks: number;
  /** The tick clock runs at most this fraction fast or slow to hold the slack. */
  maxRateAdjust: number;
  /** Rate change per tick of slack error. */
  rateGain: number;
  /** Slack errors smaller than this are left alone. */
  leadDeadbandTicks: number;
  /** How many slack reports the jitter estimate looks back over. */
  leadWindow: number;
  /** After a stall longer than this many ticks the client skips ahead instead of catching up. */
  maxTicksPerUpdate: number;
  /** Half-life of the visual offset left by a correction. */
  offsetHalfLifeMs: number;
  /** Corrections larger than this are shown at once instead of smoothed. */
  snapDistance: number;
}

export const DEFAULT_TUNING: ClientTuning = {
  baseLeadTicks: 2,
  initialExtraLeadTicks: 2,
  maxLeadTicks: 6,
  maxRateAdjust: 0.05,
  rateGain: 1 / 60,
  leadDeadbandTicks: 0.15,
  leadWindow: 90,
  maxTicksPerUpdate: 8,
  offsetHalfLifeMs: 35,
  snapDistance: 5 * SHIP_LENGTH,
};

/** Ticks kept normal at the end of a stall; the ones before them are skipped. */
const TICKS_KEPT_AFTER_STALL = 2;

/** Prediction history, in ticks. About 17 seconds. */
const HISTORY_SIZE = 1024;

/** Marks a history entry whose input was never sent. */
const NOT_SENT = -1;

export type ClientStatus = 'connecting' | 'playing' | 'rejected' | 'closed';

export interface CorrectionEvent {
  timeMs: number;
  /** The client's tick when the correction was applied. */
  tick: number;
  /** The server tick whose state differed from the prediction. */
  ackTick: number;
  /** How far the predicted present position moved, in world units. */
  distance: number;
  /** True when the ship died or respawned: a jump the server intended. */
  teleport: boolean;
}

export interface SnapshotEvent {
  timeMs: number;
  serverTick: number;
  /** Input slack the server reported, in ticks. NaN when it had no sample. */
  inputLead: number;
  missedInputs: number;
}

/** What to draw for the own ship right now. */
export interface ShipView {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  speed: number;
  boosting: boolean;
  alive: boolean;
}

export interface ClientOptions {
  transport: Transport;
  /** Milliseconds from any fixed origin. Must not go backwards. */
  now: () => number;
  /**
   * The controls to apply at the given tick. Called once per tick, just
   * before it is simulated. A player's device returns its current state; a
   * bot or a test returns a script.
   */
  controls: (tick: number) => Controls;
  tuning?: Partial<ClientTuning>;
  onCorrection?: (event: CorrectionEvent) => void;
  onSnapshot?: (event: SnapshotEvent) => void;
}

interface Arrival {
  timeMs: number;
  data: Uint8Array;
}

function shortestArc(from: number, to: number): number {
  let delta = to - from;
  if (delta > TWO_PI / 2) delta -= TWO_PI;
  else if (delta < -TWO_PI / 2) delta += TWO_PI;
  return delta;
}

export class ClientCore {
  status: ClientStatus = 'connecting';
  rejectReason: RejectReason | null = null;
  closeReason: string | null = null;
  playerId = -1;

  /** The newest predicted tick and the ship's predicted state at it. */
  tick = 0;
  state: ShipState | null = null;

  /** The newest server tick received and the server's state at it. */
  ackTick = -1;
  ackState: ShipState | null = null;

  /** Smoothed round trip in milliseconds, measured from input acknowledgements. */
  rttMs = 0;
  /** Smoothed input slack the server reports, in ticks. */
  leadTicks = 0;
  /** The slack currently aimed for. */
  targetLeadTicks: number;
  /** Tick clock rate. 1 is real time. */
  rate = 1;

  readonly counters = {
    inputsSent: 0,
    snapshots: 0,
    corrections: 0,
    teleports: 0,
    missedInputs: 0,
    skippedTicks: 0,
    resyncs: 0,
  };

  private readonly transport: Transport;
  private readonly now: () => number;
  private readonly tuning: ClientTuning;
  private readonly onCorrection: ((event: CorrectionEvent) => void) | undefined;
  private readonly onSnapshot: ((event: SnapshotEvent) => void) | undefined;

  private readonly controls: (tick: number) => Controls;
  private readonly inbox: Arrival[] = [];

  // Prediction history, indexed by tick modulo HISTORY_SIZE.
  private readonly historyTick = new Int32Array(HISTORY_SIZE).fill(-1);
  private readonly historyInput: Input[] = new Array<Input>(HISTORY_SIZE).fill(NEUTRAL_INPUT);
  private readonly historyState: (ShipState | null)[] = new Array<ShipState | null>(
    HISTORY_SIZE,
  ).fill(null);
  private readonly historySentAtMs = new Float64Array(HISTORY_SIZE);

  private previousState: ShipState | null = null;
  private lastSentInput: Input = NEUTRAL_INPUT;
  private accumulatorMs = 0;
  private lastUpdateMs = 0;

  private readonly leadSamples: number[] = [];
  private jitterTicks = 0;
  private haveLead = false;
  private haveRtt = false;

  // What is left of past corrections, added to the drawn ship and decayed.
  private offsetX = 0;
  private offsetY = 0;
  private offsetZ = 0;
  private offsetYaw = 0;
  private offsetPitch = 0;
  private offsetRoll = 0;

  constructor(options: ClientOptions) {
    this.transport = options.transport;
    this.now = options.now;
    this.controls = options.controls;
    this.tuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.targetLeadTicks = this.tuning.baseLeadTicks;
    this.onCorrection = options.onCorrection;
    this.onSnapshot = options.onSnapshot;

    this.transport.onMessage((data) => {
      // Stamp arrivals now; they are handled in order on the next update.
      this.inbox.push({ timeMs: this.now(), data });
    });
    this.transport.onClose((reason) => {
      if (this.status !== 'rejected') this.status = 'closed';
      this.closeReason = reason;
    });
    this.transport.onOpen(() => {
      this.transport.send(
        encodeHello({
          protocolVersion: PROTOCOL_VERSION,
          constantsHash: CONSTANTS_HASH,
          clientTimeMs: this.now(),
        }),
        'reliable',
      );
    });
  }

  /** Runs every tick that is due and handles arrivals. Call once per frame. */
  update(): void {
    const now = this.now();
    // Ticks first: after a stall the prediction has to cover the gap before
    // the snapshots that arrived during it can be compared with anything.
    if (this.status === 'playing') this.runDueTicks(now);
    const wasPlaying = this.status === 'playing';
    for (const arrival of this.inbox) this.handle(arrival);
    this.inbox.length = 0;
    if (!wasPlaying && this.status === 'playing') this.runDueTicks(now);
  }

  private runDueTicks(now: number): void {
    const elapsed = Math.max(0, now - this.lastUpdateMs);
    this.lastUpdateMs = now;
    this.decayOffsets(elapsed);

    this.accumulatorMs += elapsed * this.rate;
    let due = Math.floor(this.accumulatorMs / TICK_MS);
    this.accumulatorMs -= due * TICK_MS;

    if (due > this.tuning.maxTicksPerUpdate) {
      // A stall. The server has already simulated most of these ticks with
      // our last input, so predict the same and do not send them.
      const skipped = due - TICKS_KEPT_AFTER_STALL;
      for (let i = 0; i < skipped; i++) this.advance(this.lastSentInput, false, now);
      this.counters.skippedTicks += skipped;
      due = TICKS_KEPT_AFTER_STALL;
    }
    for (let i = 0; i < due; i++) {
      // Quantise first, then predict from the quantised value that is sent.
      this.advance(quantiseControls(this.controls(this.tick + 1)), true, now);
    }
  }

  /**
   * The own ship as it should be drawn now: between the last two predicted
   * ticks, plus whatever is left of earlier corrections.
   */
  view(): ShipView | null {
    const current = this.state;
    if (!current) return null;
    const previous = this.previousState;
    const jumped =
      !previous || previous.spawnSeq !== current.spawnSeq || previous.alive !== current.alive;
    const from = jumped ? current : previous;
    const alpha = this.accumulatorMs / TICK_MS;
    return {
      x: from.x + (current.x - from.x) * alpha + this.offsetX,
      y: from.y + (current.y - from.y) * alpha + this.offsetY,
      z: from.z + (current.z - from.z) * alpha + this.offsetZ,
      yaw: from.yaw + shortestArc(from.yaw, current.yaw) * alpha + this.offsetYaw,
      pitch: from.pitch + (current.pitch - from.pitch) * alpha + this.offsetPitch,
      roll: from.roll + (current.roll - from.roll) * alpha + this.offsetRoll,
      speed: from.speed + (current.speed - from.speed) * alpha,
      boosting: current.boostTicks > 0,
      alive: current.alive,
    };
  }

  /** The predicted state the client holds for a tick, if it still has it. */
  predictedAt(tick: number): ShipState | null {
    const slot = tick & (HISTORY_SIZE - 1);
    return this.historyTick[slot] === tick ? (this.historyState[slot] ?? null) : null;
  }

  close(): void {
    this.transport.close();
  }

  private handle(arrival: Arrival): void {
    const message = decodeServerMessage(arrival.data);
    if (!message) return;
    if (message.type === 'welcome') {
      if (this.status === 'connecting') this.start(message, arrival.timeMs);
    } else if (message.type === 'reject') {
      this.status = 'rejected';
      this.rejectReason = message.reason;
    } else if (this.status === 'playing') {
      this.reconcile(message, arrival.timeMs);
    }
  }

  private start(welcome: WelcomeMessage, arrivedAtMs: number): void {
    this.playerId = welcome.playerId;
    this.rttMs = Math.max(0, arrivedAtMs - welcome.clientTimeMs);
    this.status = 'playing';
    this.lastUpdateMs = arrivedAtMs;
    this.accumulatorMs = 0;
    this.alignTo(welcome.serverTick, welcome.ship, NEUTRAL_INPUT);
  }

  /**
   * Places the tick clock ahead of the server and predicts up to it. Between
   * the given server tick and our first input the server repeats `assumed`,
   * so the prediction does the same.
   */
  private alignTo(serverTick: number, ship: ShipState, assumed: Input): void {
    const ahead =
      Math.ceil(this.rttMs / TICK_MS) +
      Math.ceil(this.targetLeadTicks) +
      this.tuning.initialExtraLeadTicks;
    this.historyTick.fill(-1);
    this.tick = serverTick;
    this.state = ship;
    this.previousState = ship;
    this.store(serverTick, assumed, ship, NOT_SENT);
    this.lastSentInput = assumed;
    for (let i = 0; i < ahead; i++) this.advance(assumed, false, 0);
    // Slack reports from before this moment describe the old alignment.
    this.leadSamples.length = 0;
    this.haveLead = false;
    this.rate = 1;
  }

  private advance(input: Input, send: boolean, nowMs: number): void {
    const state = this.state;
    if (!state) return;
    this.tick += 1;
    this.previousState = state;
    this.state = stepShip(state, input);
    this.store(this.tick, input, this.state, send ? nowMs : NOT_SENT);
    if (!send) return;

    const inputs: Input[] = [input];
    for (let back = 1; back < INPUT_REDUNDANCY; back++) {
      const slot = (this.tick - back) & (HISTORY_SIZE - 1);
      if (this.historyTick[slot] !== this.tick - back) break;
      inputs.push(this.historyInput[slot] ?? NEUTRAL_INPUT);
    }
    this.transport.send(encodeInput(this.tick, inputs), 'droppable');
    this.lastSentInput = input;
    this.counters.inputsSent += 1;
  }

  private store(tick: number, input: Input, state: ShipState, sentAtMs: number): void {
    const slot = tick & (HISTORY_SIZE - 1);
    this.historyTick[slot] = tick;
    this.historyInput[slot] = input;
    this.historyState[slot] = state;
    this.historySentAtMs[slot] = sentAtMs;
  }

  private reconcile(snapshot: SnapshotMessage, arrivedAtMs: number): void {
    if (snapshot.serverTick <= this.ackTick) return;
    this.ackTick = snapshot.serverTick;
    this.ackState = snapshot.ship;
    this.counters.snapshots += 1;
    this.counters.missedInputs += snapshot.missedInputs;

    const slot = snapshot.serverTick & (HISTORY_SIZE - 1);
    const known = this.historyTick[slot] === snapshot.serverTick;
    this.measure(
      snapshot,
      arrivedAtMs,
      known ? (this.historySentAtMs[slot] ?? NOT_SENT) : NOT_SENT,
    );
    this.onSnapshot?.({
      timeMs: arrivedAtMs,
      serverTick: snapshot.serverTick,
      inputLead: snapshot.inputLead,
      missedInputs: snapshot.missedInputs,
    });

    const before = this.state;
    if (!before) return;

    if (snapshot.serverTick >= this.tick || !known) {
      // The server has caught up with or passed the prediction, or the tick
      // has left the history. Start again from the server's state.
      this.counters.resyncs += 1;
      this.alignTo(snapshot.serverTick, snapshot.ship, this.lastSentInput);
      this.finishCorrection(before, snapshot.serverTick, arrivedAtMs);
      return;
    }

    const predicted = this.historyState[slot];
    if (predicted && shipStatesEqual(predicted, snapshot.ship)) return;

    // Rewind to the server's state and replay every input sent since.
    this.historyState[slot] = snapshot.ship;
    let state = snapshot.ship;
    let previous = snapshot.ship;
    for (let tick = snapshot.serverTick + 1; tick <= this.tick; tick++) {
      const replaySlot = tick & (HISTORY_SIZE - 1);
      previous = state;
      state = stepShip(state, this.historyInput[replaySlot] ?? NEUTRAL_INPUT);
      this.historyState[replaySlot] = state;
    }
    this.previousState = previous;
    this.state = state;
    this.finishCorrection(before, snapshot.serverTick, arrivedAtMs);
  }

  private finishCorrection(before: ShipState, ackTick: number, timeMs: number): void {
    const after = this.state;
    if (!after) return;
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    const dz = before.z - after.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const teleport = before.spawnSeq !== after.spawnSeq || before.alive !== after.alive;

    if (teleport || distance > this.tuning.snapDistance) {
      this.offsetX = this.offsetY = this.offsetZ = 0;
      this.offsetYaw = this.offsetPitch = this.offsetRoll = 0;
    } else {
      // Keep drawing the ship where it was, and let the difference fade.
      this.offsetX += dx;
      this.offsetY += dy;
      this.offsetZ += dz;
      this.offsetYaw += shortestArc(after.yaw, before.yaw);
      this.offsetPitch += before.pitch - after.pitch;
      this.offsetRoll += before.roll - after.roll;
    }

    if (teleport) this.counters.teleports += 1;
    else this.counters.corrections += 1;
    this.onCorrection?.({ timeMs, tick: this.tick, ackTick, distance, teleport });
  }

  private decayOffsets(elapsedMs: number): void {
    const keep = Math.pow(0.5, elapsedMs / this.tuning.offsetHalfLifeMs);
    this.offsetX *= keep;
    this.offsetY *= keep;
    this.offsetZ *= keep;
    this.offsetYaw *= keep;
    this.offsetPitch *= keep;
    this.offsetRoll *= keep;
  }

  /** Updates the round-trip estimate and steers the tick clock. */
  private measure(snapshot: SnapshotMessage, arrivedAtMs: number, sentAtMs: number): void {
    const lead = snapshot.inputLead;
    if (Number.isNaN(lead)) return;

    // The input for this tick left at sentAtMs, waited `lead` ticks at the
    // server, and its result has now come back.
    if (sentAtMs !== NOT_SENT) {
      const sample = Math.max(0, arrivedAtMs - sentAtMs - lead * TICK_MS);
      this.rttMs = this.haveRtt ? this.rttMs + 0.1 * (sample - this.rttMs) : sample;
      this.haveRtt = true;
    }

    const tuning = this.tuning;
    this.leadSamples.push(lead);
    if (this.leadSamples.length > tuning.leadWindow) this.leadSamples.shift();
    this.leadTicks = this.haveLead ? this.leadTicks + 0.1 * (lead - this.leadTicks) : lead;
    this.haveLead = true;

    // Jitter: how far the worst recent report fell below the typical one.
    // It rises at once and falls slowly, so one bad moment is remembered.
    let sum = 0;
    let low = Infinity;
    for (const sample of this.leadSamples) {
      sum += sample;
      if (sample < low) low = sample;
    }
    const spread = sum / this.leadSamples.length - low;
    this.jitterTicks = Math.max(spread, this.jitterTicks * 0.999);

    this.targetLeadTicks = Math.min(
      tuning.maxLeadTicks,
      Math.max(tuning.baseLeadTicks, tuning.baseLeadTicks + this.jitterTicks),
    );
    const error = this.targetLeadTicks - this.leadTicks;
    const adjust =
      Math.abs(error) < tuning.leadDeadbandTicks
        ? 0
        : Math.max(-tuning.maxRateAdjust, Math.min(tuning.maxRateAdjust, error * tuning.rateGain));
    this.rate = 1 + adjust;
  }
}
