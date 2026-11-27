/**
 * baby-monitor-worklet.js — the baby monitor's ear (baby-monitor.js): the microphone's sound averaged down to
 * 16 kHz (from the device's own rate) and handed on a tenth of a second (1,600 samples) at a time. An AudioWorklet
 * module of its own file, as the page's rules (its Content-Security-Policy) load scripts only from its own files.
 */
class BabyMonitorTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / 16000;
    this.need = this.step;
    this.sum = 0;
    this.n = 0;
    this.out = new Float32Array(1600);
    this.at = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.sum += ch[i];
        this.n++;
        this.need -= 1;
        if (this.need <= 0) {
          this.out[this.at++] = this.sum / this.n;
          this.sum = 0;
          this.n = 0;
          this.need += this.step;
          if (this.at === this.out.length) {
            this.port.postMessage(this.out.slice());
            this.at = 0;
          }
        }
      }
    }
    return true;
  }
}
registerProcessor("baby-monitor-tap", BabyMonitorTap);
