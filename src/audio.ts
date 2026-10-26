// Procedural audio: electric motor whine, tyre squeal, bumps, crashes, start lights, crowd.
export class Sfx {
  ctx: AudioContext | null = null;
  master!: GainNode;
  noiseBuf!: AudioBuffer;
  motors: { o1: OscillatorNode; o2: OscillatorNode; o3: OscillatorNode; f: BiquadFilterNode; g: GainNode }[] = [];
  squeal!: { g: GainNode; f: BiquadFilterNode };
  refuel!: { g: GainNode };
  crowd!: GainNode;
  muted = false;

  init(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    this.ctx = ctx;
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    this.master = ctx.createGain(); this.master.gain.value = 0.7; this.master.connect(comp);
    const len = ctx.sampleRate * 2;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    for (let i = 0; i < 4; i++) {
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
      const o2 = ctx.createOscillator(); o2.type = 'square';
      const o3 = ctx.createOscillator(); o3.type = 'sine';
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200; f.Q.value = 3;
      const g = ctx.createGain(); g.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      const g3 = ctx.createGain(); g3.gain.value = 0.25;
      o1.connect(f); o2.connect(g2); g2.connect(f); o3.connect(g3); g3.connect(g); f.connect(g); g.connect(this.master);
      o1.start(); o2.start(); o3.start();
      this.motors.push({ o1, o2, o3, f, g });
    }
    const sq = this.loopNoise(); const sf = ctx.createBiquadFilter(); sf.type = 'bandpass'; sf.frequency.value = 2600; sf.Q.value = 9;
    const sg = ctx.createGain(); sg.gain.value = 0; sq.connect(sf); sf.connect(sg); sg.connect(this.master);
    this.squeal = { g: sg, f: sf };
    const rf = this.loopNoise(); const rff = ctx.createBiquadFilter(); rff.type = 'bandpass'; rff.frequency.value = 500; rff.Q.value = 2;
    const rg = ctx.createGain(); rg.gain.value = 0; rf.connect(rff); rff.connect(rg); rg.connect(this.master);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 7; const lg = ctx.createGain(); lg.gain.value = 250; lfo.connect(lg); lg.connect(rff.frequency); lfo.start();
    this.refuel = { g: rg };
    const cr = this.loopNoise(); const cf = ctx.createBiquadFilter(); cf.type = 'bandpass'; cf.frequency.value = 900; cf.Q.value = 0.6;
    this.crowd = ctx.createGain(); this.crowd.gain.value = 0.018; cr.connect(cf); cf.connect(this.crowd); this.crowd.connect(this.master);
  }

  loopNoise(): AudioBufferSourceNode {
    const s = this.ctx!.createBufferSource(); s.buffer = this.noiseBuf; s.loop = true; s.loopStart = Math.random(); s.start(0, Math.random()); return s;
  }

  setMuted(m: boolean): void { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05); }

  /** i: motor slot, v speed, thr throttle, vol 0..1 (distance attenuation) */
  motor(i: number, v: number, thr: number, vol: number): void {
    if (!this.ctx) return;
    const m = this.motors[i]; const t = this.ctx.currentTime;
    const f = 55 + v * 13 + thr * 30;
    m.o1.frequency.setTargetAtTime(f, t, 0.03);
    m.o2.frequency.setTargetAtTime(f * 2.01, t, 0.03);
    m.o3.frequency.setTargetAtTime(f * 6, t, 0.03);
    m.f.frequency.setTargetAtTime(500 + v * 90 + thr * 900, t, 0.05);
    const g = (v > 0.2 || thr > 0.05 ? 0.025 + thr * 0.06 + v * 0.0035 : 0) * vol;
    m.g.gain.setTargetAtTime(g, t, 0.04);
  }
  tyre(amount: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.squeal.g.gain.setTargetAtTime(Math.min(0.12, amount * 0.12), t, 0.05);
    this.squeal.f.frequency.setTargetAtTime(2200 + amount * 900, t, 0.1);
  }
  refuelling(on: boolean): void { if (this.ctx) this.refuel.g.gain.setTargetAtTime(on ? 0.12 : 0, this.ctx.currentTime, 0.08); }
  crowdLevel(x: number): void { if (this.ctx) this.crowd.gain.setTargetAtTime(x, this.ctx.currentTime, 0.4); }

  burst(dur: number, freq: number, q: number, vol: number, sweepTo?: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const s = ctx.createBufferSource(); s.buffer = this.noiseBuf; s.start(t, Math.random());
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(this.master); s.stop(t + dur + 0.05);
  }
  tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', slideTo?: number): void {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  bump(p: number): void { this.burst(0.12, 300, 1.2, 0.25 + p * 0.5); this.tone(110, 0.12, 0.2 + p * 0.3, 'triangle', 60); }
  crash(): void { this.burst(0.6, 1800, 0.8, 0.5, 300); this.burst(0.35, 4000, 3, 0.25); this.tone(180, 0.3, 0.2, 'square', 50); }
  click(): void { this.burst(0.04, 3000, 4, 0.35); this.tone(1400, 0.04, 0.08, 'square'); }
  light(): void { this.tone(520, 0.28, 0.25, 'square'); }
  go(): void { this.tone(1040, 0.6, 0.3, 'square'); this.crowdLevel(0.06); setTimeout(() => this.crowdLevel(0.02), 2500); }
  beep(): void { this.tone(880, 0.12, 0.15, 'sine'); setTimeout(() => this.tone(660, 0.14, 0.15, 'sine'), 140); }
  good(): void { this.tone(660, 0.1, 0.15, 'triangle'); setTimeout(() => this.tone(990, 0.16, 0.15, 'triangle'), 90); }
  bad(): void { this.tone(300, 0.18, 0.18, 'sawtooth', 180); }
  fanfare(): void { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.3, 0.2, 'triangle'), i * 140)); this.crowdLevel(0.09); setTimeout(() => this.crowdLevel(0.02), 4000); }
}
