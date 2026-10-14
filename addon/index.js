// doom:bundle
var bundle_default = { schema: 2, engine: { bytes: 456114, sha256: "33aa16f84b0166fcc1ff150ee90f12e89593cacbd005fd3b7f35c88eecb01416", chunks: [{ path: "assets/engine/000.json", jsonBytes: 608165, decodedBytes: 456114, sha256: "33aa16f84b0166fcc1ff150ee90f12e89593cacbd005fd3b7f35c88eecb01416" }], abi: "doomgeneric-wasi-v2" }, iwad: { bytes: 4196020, sha256: "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771", edition: "doom-1.9-shareware", license: "LicenseRef-DOOM-shareware", feed: { url: "https://gist.githubusercontent.com/ralphbibera/1a077d178d8544746423ddd84a2ca1ef/raw/8a5669e288bfa19ba9d08aaa0ba8be34f02113ef/manifest.json", bytes: 1715, sha256: "90215e77c9623360d404489c88826a5310fd2c5f566cb23e09184a0246ae56e1" } }, source: { bytes: 3162496, sha256: "8466ba3eff807c0613f52e6f47d355c60137afb0cb1aace3e04fa992401aaee2", chunks: [{ path: "assets/source/000.json", jsonBytes: 4194317, decodedBytes: 3145728, sha256: "56656c3793233fd75955c1e9b599a8526b8a7a98d01c2716628eae1a23513e6b" }, { path: "assets/source/001.json", jsonBytes: 22373, decodedBytes: 16768, sha256: "1732dbbe3d8affd1220759c21beca651b9afc24e954563d12d3ee67e43b3f944" }], archive: "tar.gz", exportName: "hibi-doom-0.4.1-source.tar.gz" }, notices: { path: "LICENSES.md", bytes: 123460, sha256: "dfac4d66e55ef842a58d3eca17438d1bd4bce9afaed0e65f5954f12abae7f4bc" } };

// src/audio-scene.ts
var audioNotificationBudget = 256;
function record(raw, fields2) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length !== fields2.length || fields2.some((field) => !Object.hasOwn(raw, field)))
    throw new Error("Invalid Doom audio scene fields.");
  return raw;
}
function number(raw, limit = Number.MAX_SAFE_INTEGER, integral = true) {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > limit || integral && !Number.isSafeInteger(raw))
    throw new Error("Invalid Doom audio scene value.");
  return raw;
}
function parseAudioScene(raw) {
  const value = record(raw, ["epoch", "revision", "at", "voices", "music"]);
  const epoch = number(value.epoch);
  const revision = number(value.revision);
  const at = number(value.at, Number.MAX_SAFE_INTEGER, false);
  if (!Array.isArray(value.voices) || value.voices.length !== 8)
    throw new Error("Invalid Doom sound channels.");
  const voices = value.voices.map((raw2, channel) => {
    if (raw2 === null) return null;
    const voice = record(raw2, [
      "channel",
      "generation",
      "sample",
      "startedAt",
      "endsAt",
      "volume",
      "separation"
    ]);
    if (voice.channel !== channel)
      throw new Error("Invalid Doom sound channel order.");
    const startedAt = number(voice.startedAt, Number.MAX_SAFE_INTEGER, false);
    const endsAt = number(voice.endsAt, Number.MAX_SAFE_INTEGER, false);
    const generation = number(voice.generation);
    if (generation === 0 || endsAt <= startedAt || endsAt - startedAt > 6e4 || startedAt > at)
      throw new Error("Invalid Doom sound deadline.");
    return {
      channel,
      generation,
      sample: number(voice.sample, 4095),
      startedAt,
      endsAt,
      volume: number(voice.volume, 127),
      separation: number(voice.separation, 254)
    };
  });
  let music;
  if (value.music && typeof value.music === "object" && "kind" in value.music && value.music.kind === "stopped") {
    record(value.music, ["kind"]);
    music = { kind: "stopped" };
  } else {
    const state = record(value.music, [
      "kind",
      "generation",
      "score",
      "anchorAt",
      "offsetMs",
      "looping",
      "volume"
    ]);
    if (state.kind !== "playing" && state.kind !== "paused" || typeof state.looping !== "boolean")
      throw new Error("Invalid Doom music activity.");
    const generation = number(state.generation);
    const anchorAt = number(state.anchorAt, Number.MAX_SAFE_INTEGER, false);
    if (generation === 0 || anchorAt > at)
      throw new Error("Invalid Doom music anchor.");
    music = {
      kind: state.kind,
      generation,
      score: number(state.score, 4095),
      anchorAt,
      offsetMs: number(state.offsetMs, Number.MAX_SAFE_INTEGER, false),
      looping: state.looping,
      volume: number(state.volume, 127)
    };
  }
  return { epoch, revision, at, voices, music };
}
function musicPosition(music, at) {
  return music.offsetMs + (music.kind === "playing" ? Math.max(0, at - music.anchorAt) : 0);
}

// src/music.ts
var channelDefaults = () => ({
  program: 0,
  bank: 0,
  volume: 127,
  expression: 127,
  pan: 64,
  bend: 0,
  modulation: 0,
  sustain: false,
  soft: false
});
var ScoreState = class {
  channels = Array.from({ length: 16 }, channelDefaults);
  notes = /* @__PURE__ */ new Map();
  apply(event) {
    const channel = this.channels[event.channel];
    if (!channel) throw new Error("Invalid MUS channel.");
    if (event.kind === "on" && event.velocity > 0) {
      const note = {
        id: event.channel * 128 + event.key,
        channel: event.channel,
        key: event.key,
        velocity: event.velocity,
        program: channel.program,
        tick: event.tick,
        released: false
      };
      this.notes.set(note.id, note);
      return { kind: "start", note };
    }
    if (event.kind === "off" || event.kind === "on") {
      const id = event.channel * 128 + event.key;
      const note = this.notes.get(id);
      if (note && channel.sustain) {
        note.released = true;
        return { kind: "none" };
      }
      this.notes.delete(id);
      return { kind: "release", ids: [id] };
    }
    if (event.kind === "pitch") channel.bend = event.bend;
    else {
      switch (event.control) {
        case 0:
          channel.program = event.value;
          return { kind: "none" };
        case 1:
          channel.bank = event.value;
          return { kind: "none" };
        case 2:
          channel.modulation = event.value;
          break;
        case 3:
          channel.volume = event.value;
          break;
        case 4:
          channel.pan = event.value;
          break;
        case 5:
          channel.expression = event.value;
          break;
        case 8: {
          channel.sustain = event.value >= 64;
          if (channel.sustain) return { kind: "none" };
          const ids = [...this.notes.values()].filter((note) => note.channel === event.channel && note.released).map((note) => note.id);
          for (const id of ids) this.notes.delete(id);
          return { kind: "release", ids };
        }
        case 9:
          channel.soft = event.value >= 64;
          break;
        case 10:
        case 11:
        case 12:
        case 13: {
          const ids = [...this.notes.values()].filter((note) => note.channel === event.channel).map((note) => note.id);
          for (const id of ids) {
            const note = this.notes.get(id);
            if (event.control !== 10 && channel.sustain && note)
              note.released = true;
            else this.notes.delete(id);
          }
          return event.control === 10 ? { kind: "kill", ids } : channel.sustain ? { kind: "none" } : { kind: "release", ids };
        }
        case 14: {
          Object.assign(channel, {
            expression: 127,
            pan: 64,
            bend: 0,
            modulation: 0,
            sustain: false,
            soft: false
          });
          const ids = [...this.notes.values()].filter((note) => note.channel === event.channel && note.released).map((note) => note.id);
          for (const id of ids) this.notes.delete(id);
          return { kind: "release", ids };
        }
        default:
          return { kind: "none" };
      }
    }
    return { kind: "parameters", channel: event.channel };
  }
};
var musicVoiceLimit = 24;
var lookaheadSeconds = 0.12;
var MusicOutput = class {
  score = null;
  generation = null;
  state = new ScoreState();
  voices = /* @__PURE__ */ new Set();
  held = /* @__PURE__ */ new Map();
  gain;
  timer = null;
  index = 0;
  cycle = 0;
  anchor = 0;
  looping = false;
  context;
  bank;
  failed;
  constructor(context, destination, bank, failed) {
    this.context = context;
    this.bank = bank;
    this.failed = failed;
    this.gain = context.createGain();
    this.gain.connect(destination);
  }
  reconcile(scene, at) {
    if (scene.kind !== "playing") {
      this.stop();
      return;
    }
    const score = this.bank.scores.get(scene.score);
    if (!score) throw new Error("Doom music score is unavailable.");
    const position = musicPosition(scene, at) / 1e3;
    const expected = this.context.currentTime - this.anchor;
    if (this.generation !== scene.generation || this.score !== score || Math.abs(expected - position) > 0.25) {
      this.stop();
      this.score = score;
      this.generation = scene.generation;
      this.looping = scene.looping;
      const duration = score.durationMs / 1e3;
      const offset = scene.looping ? position % duration : Math.min(position, duration);
      this.cycle = scene.looping ? Math.floor(position / duration) : 0;
      this.anchor = this.context.currentTime - position;
      this.state = new ScoreState();
      this.index = 0;
      while (this.index < score.events.length) {
        const event = score.events[this.index];
        if (!event || event.tick / 140 > offset) break;
        this.state.apply(event);
        this.index++;
      }
      for (const note of this.state.notes.values())
        this.start(note, this.context.currentTime, true);
      this.schedule();
      this.timer = setInterval(() => {
        try {
          this.schedule();
        } catch (error) {
          this.failed(error);
        }
      }, 25);
    }
    this.gain.gain.setValueAtTime(scene.volume / 127, this.context.currentTime);
  }
  schedule() {
    const score = this.score;
    if (!score) return;
    const horizon = this.context.currentTime + lookaheadSeconds;
    const duration = score.durationMs / 1e3;
    let budget = 1024;
    while (budget-- > 0) {
      const event = score.events[this.index];
      if (!event) {
        const boundary = this.anchor + (this.cycle + 1) * duration;
        if (boundary > horizon) return;
        for (const voice of this.held.values()) this.release(voice, boundary);
        this.held.clear();
        if (!this.looping) {
          if (this.timer) clearInterval(this.timer);
          this.timer = null;
          return;
        }
        this.cycle++;
        this.index = 0;
        this.state = new ScoreState();
        continue;
      }
      const when = this.anchor + this.cycle * duration + event.tick / 140;
      if (when > horizon) return;
      this.index++;
      const change = this.state.apply(event);
      switch (change.kind) {
        case "start":
          this.start(change.note, Math.max(this.context.currentTime, when));
          break;
        case "kill":
        case "release":
          for (const id of change.ids) {
            const voice = this.held.get(id);
            if (voice)
              this.release(
                voice,
                Math.max(this.context.currentTime, when),
                change.kind === "kill"
              );
          }
          if (event.kind === "control" && event.control === 14)
            this.parameters(event.channel, when);
          break;
        case "parameters":
          this.parameters(
            change.channel,
            Math.max(this.context.currentTime, when)
          );
          break;
        case "none":
          break;
        default: {
          const unreachable = change;
          void unreachable;
        }
      }
    }
    throw new Error("Doom music exceeded its scheduling budget.");
  }
  start(note, when, restored = false) {
    const replaced = this.held.get(note.id);
    if (replaced) this.release(replaced, when, true);
    while (this.voices.size >= musicVoiceLimit) {
      const victim = [...this.voices].find((voice2) => voice2.released) ?? this.voices.values().next().value;
      if (!victim) break;
      this.destroy(victim);
    }
    const instrument = this.bank.instruments[note.channel === 15 ? 128 + Math.max(0, Math.min(46, note.key - 35)) : note.program];
    if (!instrument) throw new Error("Doom music instrument is unavailable.");
    const key = (instrument.fixedKey ?? note.key) + instrument.transpose;
    const frequency = Math.max(
      20,
      Math.min(12e3, 440 * 2 ** ((key - 69) / 12))
    );
    const context = this.context;
    const carrier = context.createOscillator();
    const modulator = context.createOscillator();
    const depth = context.createGain();
    const envelope = context.createGain();
    const level = context.createGain();
    const pan = context.createStereoPanner();
    const voice = {
      note,
      carrier,
      modulator,
      depth,
      envelope,
      level,
      pan,
      instrument,
      frequency,
      carrierStarted: false,
      modulatorStarted: false,
      released: false
    };
    this.voices.add(voice);
    this.held.set(note.id, voice);
    carrier.type = instrument.waveform;
    carrier.frequency.value = frequency;
    modulator.frequency.value = frequency * instrument.multiplier;
    modulator.connect(depth);
    depth.connect(carrier.frequency);
    carrier.connect(envelope);
    envelope.connect(level);
    level.connect(pan);
    pan.connect(this.gain);
    this.voiceParameters(voice, when);
    const percussion = note.channel === 15;
    envelope.gain.setValueAtTime(restored ? instrument.sustain : 0, when);
    if (!restored) {
      envelope.gain.linearRampToValueAtTime(1, when + instrument.attack);
      envelope.gain.exponentialRampToValueAtTime(
        Math.max(1e-3, percussion ? 1e-3 : instrument.sustain),
        when + instrument.attack + (percussion ? 0.16 : 0.1)
      );
    }
    carrier.onended = () => this.destroy(voice);
    carrier.start(when);
    voice.carrierStarted = true;
    modulator.start(when);
    voice.modulatorStarted = true;
    if (percussion) this.release(voice, when + 0.22);
  }
  voiceParameters(voice, when) {
    const channel = this.state.channels[voice.note.channel];
    if (!channel) throw new Error("Doom music channel is unavailable.");
    voice.level.gain.setValueAtTime(
      0.12 * voice.note.velocity / 127 * channel.volume / 127 * channel.expression / 127 * (channel.soft ? 0.7 : 1),
      when
    );
    voice.pan.pan.setValueAtTime((channel.pan - 64) / 64, when);
    voice.carrier.detune.setValueAtTime(channel.bend * 100, when);
    voice.modulator.detune.setValueAtTime(channel.bend * 100, when);
    voice.depth.gain.setValueAtTime(
      voice.frequency * voice.instrument.modulation * (0.15 + channel.modulation / 127 * 0.5),
      when
    );
  }
  parameters(channel, when) {
    for (const voice of this.voices)
      if (voice.note.channel === channel) this.voiceParameters(voice, when);
  }
  release(voice, when, immediate = false) {
    if (voice.released && !immediate) return;
    voice.released = true;
    if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id);
    voice.envelope.gain.cancelAndHoldAtTime(when);
    voice.envelope.gain.linearRampToValueAtTime(
      0,
      when + (immediate ? 5e-3 : voice.instrument.release)
    );
    voice.carrier.stop(
      when + (immediate ? 6e-3 : voice.instrument.release + 0.01)
    );
    voice.modulator.stop(
      when + (immediate ? 6e-3 : voice.instrument.release + 0.01)
    );
  }
  destroy(voice) {
    if (!this.voices.delete(voice)) return;
    if (this.held.get(voice.note.id) === voice) this.held.delete(voice.note.id);
    voice.carrier.onended = null;
    if (voice.carrierStarted) voice.carrier.stop();
    if (voice.modulatorStarted) voice.modulator.stop();
    for (const node of [
      voice.carrier,
      voice.modulator,
      voice.depth,
      voice.envelope,
      voice.level,
      voice.pan
    ])
      node.disconnect();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const voice of this.voices) this.destroy(voice);
    this.held.clear();
    this.score = null;
    this.generation = null;
  }
  dispose() {
    this.stop();
    this.gain.disconnect();
  }
};

// src/audio.ts
function stereoWeights(volume, separation) {
  return {
    left: Math.min(255, Math.floor((254 - separation) * volume / 127)) / 255,
    right: Math.min(255, Math.floor(separation * volume / 127)) / 255
  };
}
var GameAudio = class {
  output = { kind: "waiting" };
  latest = null;
  activity = "paused";
  epoch = 0;
  generation = 0;
  muted = false;
  volume = 0.7;
  anchor = null;
  bank;
  changed;
  constructor(bank, changed = () => {
  }) {
    this.bank = bank;
    this.changed = changed;
  }
  get availability() {
    const output = this.output;
    if (output.kind === "open")
      return { kind: this.muted || this.volume === 0 ? "muted" : "enabled" };
    return output;
  }
  setActivity(activity2, epoch) {
    if (this.activity === activity2 && this.epoch === epoch) return;
    this.activity = activity2;
    this.epoch = epoch;
    this.generation++;
    this.latest = null;
    this.silence();
    if (activity2 === "running" && this.output.kind === "open") this.activate();
    else this.suspend();
  }
  activate() {
    let output = this.output;
    if (output.kind === "closed" || output.kind === "unavailable") return;
    try {
      if (output.kind === "waiting") {
        if (!navigator.userActivation.isActive) return;
        const context = new AudioContext({ latencyHint: "interactive" });
        try {
          const master = context.createGain();
          master.gain.value = this.muted ? 0 : this.volume;
          master.connect(context.destination);
          const music = new MusicOutput(
            context,
            master,
            this.bank,
            (error) => this.fail(error)
          );
          output = {
            kind: "open",
            context,
            master,
            music,
            effects: /* @__PURE__ */ new Map(),
            samples: /* @__PURE__ */ new Map()
          };
        } catch (error) {
          void context.close().catch(() => {
          });
          throw error;
        }
        this.output = output;
        const owned = output;
        context.onstatechange = () => {
          if (this.output === owned && context.state === "closed")
            this.fail(new Error("The Doom audio context closed unexpectedly."));
        };
        this.changed(this.availability);
      }
      if (this.activity !== "running" || this.muted || this.volume === 0) {
        this.suspend();
        return;
      }
      const current = output;
      const generation = this.generation;
      void current.context.resume().then(
        () => {
          if (this.output !== current) {
            void current.context.close().catch(() => {
            });
            return;
          }
          if (generation !== this.generation) {
            if (this.activity !== "running" || this.muted || this.volume === 0)
              this.suspend();
            return;
          }
          if (this.latest) {
            try {
              this.render(this.latest);
            } catch (error) {
              this.fail(error);
            }
          }
        },
        (error) => {
          if (this.output === current && generation === this.generation)
            this.fail(error);
        }
      );
    } catch (error) {
      this.fail(error);
    }
  }
  setPreference(muted, volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1)
      throw new Error("Invalid Doom audio volume.");
    const silenced = muted || volume === 0;
    const wasSilenced = this.muted || this.volume === 0;
    this.muted = muted;
    this.volume = volume;
    if (this.output.kind === "open")
      this.output.master.gain.setValueAtTime(
        silenced ? 0 : volume,
        this.output.context.currentTime
      );
    if (silenced !== wasSilenced) {
      this.generation++;
      this.silence();
      if (silenced) this.suspend();
      else this.activate();
    }
    this.changed(this.availability);
  }
  apply(scene) {
    if (this.activity !== "running" || scene.epoch !== this.epoch || this.output.kind === "closed" || this.output.kind === "unavailable")
      return;
    if (this.latest && (scene.revision < this.latest.revision || scene.at < this.latest.at))
      return;
    this.latest = scene;
    if (this.output.kind === "open" && this.output.context.state === "running" && !this.muted && this.volume > 0) {
      try {
        this.render(scene);
      } catch (error) {
        this.fail(error);
      }
    }
  }
  render(scene) {
    const output = this.output;
    if (output.kind !== "open" || this.activity !== "running" || scene.epoch !== this.epoch || this.muted || this.volume === 0)
      return;
    const now = output.context.currentTime;
    const predicted = this.anchor ? this.anchor.game + (now - this.anchor.audio) * 1e3 : scene.at;
    if (!this.anchor || Math.abs(predicted - scene.at) > 250)
      this.anchor = { game: scene.at, audio: now };
    const at = Math.max(
      scene.at,
      this.anchor.game + (now - this.anchor.audio) * 1e3
    );
    for (const [channel, effect] of output.effects) {
      const voice = scene.voices[channel];
      if (!voice || voice.generation !== effect.generation || voice.endsAt <= at)
        this.stopEffect(output, channel, effect);
    }
    for (const voice of scene.voices) {
      if (!voice || voice.endsAt <= at) continue;
      let effect = output.effects.get(voice.channel);
      if (!effect) {
        const data = this.bank.samples.get(voice.sample);
        if (!data) throw new Error("Doom sound sample is unavailable.");
        let buffer = output.samples.get(voice.sample);
        if (!buffer) {
          buffer = output.context.createBuffer(1, data.bytes.length, data.rate);
          const pcm = buffer.getChannelData(0);
          const bytes = new DataView(
            data.bytes.buffer,
            data.bytes.byteOffset,
            data.bytes.byteLength
          );
          for (let index = 0; index < data.bytes.length; index++)
            pcm[index] = (bytes.getUint8(index) - 128) / 128;
          output.samples.set(voice.sample, buffer);
        }
        const source = output.context.createBufferSource();
        source.buffer = buffer;
        const left = output.context.createGain();
        const right = output.context.createGain();
        const merger = output.context.createChannelMerger(2);
        source.connect(left);
        source.connect(right);
        left.connect(merger, 0, 0);
        right.connect(merger, 0, 1);
        merger.connect(output.master);
        effect = {
          generation: voice.generation,
          started: false,
          source,
          left,
          right,
          merger
        };
        output.effects.set(voice.channel, effect);
        this.parameters(effect, voice, now);
        const started = effect;
        source.onended = () => {
          if (output.effects.get(voice.channel) === started)
            this.stopEffect(output, voice.channel, started);
        };
        source.start(now, Math.max(0, at - voice.startedAt) / 1e3);
        effect.started = true;
      } else this.parameters(effect, voice, now);
    }
    output.music.reconcile(scene.music, at);
  }
  parameters(effect, voice, at) {
    const weights = stereoWeights(voice.volume, voice.separation);
    effect.left.gain.setValueAtTime(weights.left, at);
    effect.right.gain.setValueAtTime(weights.right, at);
  }
  stopEffect(output, channel, effect) {
    if (output.effects.get(channel) === effect) output.effects.delete(channel);
    effect.source.onended = null;
    if (effect.started) effect.source.stop();
    effect.source.disconnect();
    effect.left.disconnect();
    effect.right.disconnect();
    effect.merger.disconnect();
  }
  silence() {
    this.anchor = null;
    const output = this.output;
    if (output.kind !== "open") return;
    output.music.stop();
    for (const [channel, effect] of output.effects)
      this.stopEffect(output, channel, effect);
  }
  suspend() {
    const output = this.output;
    if (output.kind !== "open" || output.context.state === "closed") return;
    const generation = this.generation;
    void output.context.suspend().catch((error) => {
      if (this.output === output && generation === this.generation)
        this.fail(error);
    });
  }
  fail(error) {
    if (this.output.kind === "closed" || this.output.kind === "unavailable")
      return;
    const message = error instanceof Error ? error.message.slice(0, 200) : "Hibi could not play Doom sound.";
    this.closeOutput();
    this.output = { kind: "unavailable", message };
    this.changed(this.availability);
  }
  closeOutput() {
    this.generation++;
    this.latest = null;
    this.silence();
    const output = this.output;
    if (output.kind === "open") {
      output.context.onstatechange = null;
      output.music.dispose();
      output.master.disconnect();
      output.samples.clear();
      void output.context.close().catch(() => {
      });
    }
  }
  dispose() {
    if (this.output.kind === "closed") return;
    this.closeOutput();
    this.output = { kind: "closed" };
  }
};

// src/audio-bank.ts
function parsePcm(bytes, name = "sound") {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || data.getUint16(0, true) !== 3)
    throw new Error("Invalid Doom PCM header.");
  const rate = data.getUint16(2, true);
  const length = data.getUint32(4, true);
  if (rate !== 11025 && rate !== 22050 || length <= 48 || length > bytes.length - 8)
    throw new Error("Invalid Doom PCM extent or rate.");
  const samples = bytes.slice(24, 8 + length - 16);
  return {
    name,
    rate,
    bytes: samples,
    durationMs: samples.length * 1e3 / rate
  };
}
function parseMus(bytes, name = "music") {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || data.getUint32(0, true) !== 441668941)
    throw new Error("Invalid Doom MUS header.");
  const length = data.getUint16(4, true);
  const start = data.getUint16(6, true);
  const channels = data.getUint16(8, true);
  const instruments = data.getUint16(12, true);
  if (bytes.length > 65536 || channels > 15 || instruments > 256 || start < 16 + instruments * 2 || length === 0 || start > bytes.length - length)
    throw new Error("Invalid Doom MUS extent.");
  let position = start;
  let tick = 0;
  const end = start + length;
  const velocities = new Uint8Array(16).fill(127);
  const events = [];
  const read = () => {
    if (position >= end) throw new Error("Truncated Doom MUS event.");
    return data.getUint8(position++);
  };
  while (position < end) {
    if (events.length >= 32768)
      throw new Error("Doom MUS exceeds its event limit.");
    const descriptor = read();
    const channel = descriptor & 15;
    const kind = descriptor >> 4 & 7;
    switch (kind) {
      case 0:
        events.push({ kind: "off", tick, channel, key: read() & 127 });
        break;
      case 1: {
        const key = read();
        if (key & 128) velocities[channel] = read() & 127;
        events.push({
          kind: "on",
          tick,
          channel,
          key: key & 127,
          velocity: velocities.at(channel) ?? 127
        });
        break;
      }
      case 2:
        events.push({ kind: "pitch", tick, channel, bend: (read() - 128) / 64 });
        break;
      case 3: {
        const control = read();
        if (control < 10 || control > 14)
          throw new Error("Invalid Doom MUS system event.");
        events.push({ kind: "control", tick, channel, control, value: 0 });
        break;
      }
      case 4: {
        const control = read();
        const value = Math.min(127, read());
        if (control > 9) throw new Error("Invalid Doom MUS controller.");
        events.push({ kind: "control", tick, channel, control, value });
        break;
      }
      case 6:
        if (tick <= 0) throw new Error("Doom MUS has no positive duration.");
        return {
          name,
          bytes: bytes.slice(),
          events,
          durationTicks: tick,
          durationMs: tick * 1e3 / 140
        };
      default:
        throw new Error("Unknown Doom MUS event.");
    }
    if (descriptor & 128) {
      let delay = 0;
      for (let count = 0; ; count++) {
        if (count >= 4) throw new Error("Doom MUS delay exceeds its limit.");
        const byte = read();
        delay = delay * 128 + (byte & 127);
        if (!(byte & 128)) break;
      }
      tick += delay;
      if (tick > 140 * 60 * 10)
        throw new Error("Doom MUS exceeds its duration limit.");
    }
  }
  throw new Error("Doom MUS has no score-end event.");
}
function parseInstruments(bytes) {
  if (bytes.length !== 11908 || new TextDecoder().decode(bytes.subarray(0, 8)) !== "#OPL_II#")
    throw new Error("Invalid Doom GENMIDI bank.");
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const waveforms = [
    "sine",
    "triangle",
    "sawtooth",
    "square"
  ];
  return Array.from({ length: 175 }, (_, index) => {
    const at = 8 + index * 36;
    const modulator = at + 4;
    const carrier = at + 11;
    const attack = data.getUint8(carrier + 1) >> 4;
    const envelope = data.getUint8(carrier + 2);
    const multiplier = data.getUint8(modulator) & 15;
    return {
      fixedKey: data.getUint16(at, true) & 1 ? data.getUint8(at + 3) & 127 : null,
      transpose: data.getInt16(at + 18, true),
      waveform: waveforms[data.getUint8(carrier + 3) & 3] ?? "sine",
      modulation: (63 - (data.getUint8(modulator + 5) & 63)) / 63,
      multiplier: multiplier === 0 ? 0.5 : Math.min(8, multiplier),
      attack: 3e-3 + (15 - attack) * 3e-3,
      sustain: Math.max(0.06, 1 - (envelope >> 4) / 15),
      release: 0.04 + (15 - (envelope & 15)) * 8e-3
    };
  });
}
function parseAudioBank(iwad) {
  const data = new DataView(iwad.buffer, iwad.byteOffset, iwad.byteLength);
  if (iwad.length < 12 || data.getUint32(0, true) !== 1145132873)
    throw new Error("Invalid Doom audio IWAD.");
  const count = data.getUint32(4, true);
  const directory = data.getUint32(8, true);
  if (count > 4096 || directory > iwad.length - count * 16)
    throw new Error("Invalid Doom audio lump directory.");
  const samples = /* @__PURE__ */ new Map();
  const scores = /* @__PURE__ */ new Map();
  let instruments = null;
  const text = new TextDecoder("ascii", { fatal: true });
  for (let lump = 0; lump < count; lump++) {
    const at = directory + lump * 16;
    const offset = data.getUint32(at, true);
    const length = data.getUint32(at + 4, true);
    if (offset > iwad.length - length)
      throw new Error("Doom audio lump is outside its IWAD.");
    const name = text.decode(iwad.subarray(at + 8, at + 16)).replace(/\0.*$/, "").toUpperCase();
    const bytes = iwad.subarray(offset, offset + length);
    if (name.startsWith("DS")) samples.set(lump, parsePcm(bytes, name));
    else if (name.startsWith("D_")) scores.set(lump, parseMus(bytes, name));
    else if (name === "GENMIDI") instruments = parseInstruments(bytes);
  }
  if (samples.size !== 55 || scores.size !== 13 || !instruments)
    throw new Error("Doom audio bank is incomplete.");
  return { samples, scores, instruments };
}

// engine/pins.json
var pins_default = {
  schema: 1,
  engine: {
    bytes: 456114,
    sha256: "33aa16f84b0166fcc1ff150ee90f12e89593cacbd005fd3b7f35c88eecb01416",
    revision: "e257a09527062bfb986b6e5e0780839b6cbd5b71",
    license: "GPL-3.0-only",
    sourceLicense: "GPL-2.0-or-later AND GPL-3.0-or-later AND GPL-3.0-only"
  },
  iwad: {
    bytes: 4196020,
    sha256: "1d7d43be501e67d927e415e0b8f3e29c3bf33075e859721816f652a526cac771",
    edition: "doom-1.9-shareware",
    license: "LicenseRef-DOOM-shareware",
    feed: {
      url: "https://gist.githubusercontent.com/ralphbibera/1a077d178d8544746423ddd84a2ca1ef/raw/8a5669e288bfa19ba9d08aaa0ba8be34f02113ef/manifest.json",
      bytes: 1715,
      sha256: "90215e77c9623360d404489c88826a5310fd2c5f566cb23e09184a0246ae56e1"
    }
  },
  sdk: {
    version: "27.0",
    compiler: "20.1.8-wasi-sdk",
    sourceRevision: "fbdec30656d4099da5c7fd7e8275e4af777ca97e",
    arm64MacArchiveSha256: "055c3dc2766772c38e71a05d353e35c322c7b2c6458a36a26a836f9808a550f8"
  },
  wasiLibcRevision: "3f7eb4c7d6ede4dde3c4bffa6ed14e8d656fe93f",
  compilerRtRevision: "87f0227cb60147a26a1eeb4fb06e3b505e9c7261"
};

// package.json
var package_default = {
  name: "hibi-doom",
  version: "0.4.1",
  private: true,
  type: "module",
  license: "GPL-3.0-only",
  engines: {
    node: ">=24.0.0"
  },
  scripts: {
    check: "node scripts/check.mjs",
    build: "node scripts/build.mjs",
    "build:check": "node scripts/build.mjs --check",
    typecheck: "node scripts/typecheck.mjs",
    test: "node --test --test-concurrency=1 tests/model.test.mjs tests/input.test.mjs tests/audio.test.mjs tests/audio-owner.test.mjs tests/audio-worker.test.mjs tests/video.test.mjs tests/mouse-runtime.test.mjs tests/install.test.mjs tests/bundle.test.mjs tests/iwad.test.mjs tests/bundled-runtime.test.mjs",
    "test:hibi": "node --test tests/hibi.integration.test.mjs"
  }
};

// src/bundle.ts
var sourceExportName = `hibi-doom-${package_default.version}-source.tar.gz`;
var maxChunk = 3 * 1024 * 1024;
var maxArtifact = 16 * 1024 * 1024;
var hashPattern = /^[0-9a-f]{64}$/;
function record2(value, fields2) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Doom bundle metadata.");
  const object2 = value;
  if (Object.keys(object2).length !== fields2.length || fields2.some((field) => !Object.hasOwn(object2, field)))
    throw new Error("Unexpected Doom bundle fields.");
  return object2;
}
function size(value, max) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max)
    throw new Error("Invalid Doom bundle size.");
  return value;
}
function hash(value) {
  if (typeof value !== "string" || !hashPattern.test(value))
    throw new Error("Invalid Doom bundle digest.");
  return value;
}
function artifact(input, role) {
  const extra = role === "engine" ? ["abi"] : ["archive", "exportName"];
  const value = record2(input, ["bytes", "sha256", "chunks", ...extra]);
  const bytes = size(value.bytes, maxArtifact);
  if (!Array.isArray(value.chunks) || value.chunks.length === 0 || value.chunks.length > 6)
    throw new Error("Invalid Doom bundle chunks.");
  const chunks = value.chunks.map((input2, index) => {
    const chunk = record2(input2, ["path", "jsonBytes", "decodedBytes", "sha256"]);
    const decodedBytes = size(chunk.decodedBytes, maxChunk);
    const jsonBytes = size(chunk.jsonBytes, 5 * 1024 * 1024);
    if (chunk.path !== `assets/${role}/${String(index).padStart(3, "0")}.json` || jsonBytes !== 4 * Math.ceil(decodedBytes / 3) + 13)
      throw new Error("Invalid Doom chunk path or encoded size.");
    return Object.freeze({
      path: chunk.path,
      jsonBytes,
      decodedBytes,
      sha256: hash(chunk.sha256)
    });
  });
  if (chunks.reduce((sum, chunk) => sum + chunk.decodedBytes, 0) !== bytes)
    throw new Error("Doom chunk sizes do not match the artifact.");
  return {
    bytes,
    sha256: hash(value.sha256),
    chunks: Object.freeze(chunks),
    value
  };
}
function parseBundle(input) {
  const value = record2(input, ["schema", "engine", "iwad", "source", "notices"]);
  const engine = artifact(value.engine, "engine");
  const iwad = record2(value.iwad, [
    "bytes",
    "sha256",
    "edition",
    "license",
    "feed"
  ]);
  const feed = record2(iwad.feed, ["url", "bytes", "sha256"]);
  const source = artifact(value.source, "source");
  const notices = record2(value.notices, ["path", "bytes", "sha256"]);
  if (value.schema !== 2 || engine.value.abi !== "doomgeneric-wasi-v2" || engine.bytes > 1024 * 1024 || iwad.edition !== pins_default.iwad.edition || iwad.bytes !== pins_default.iwad.bytes || iwad.sha256 !== pins_default.iwad.sha256 || iwad.license !== pins_default.iwad.license || feed.url !== pins_default.iwad.feed.url || feed.bytes !== pins_default.iwad.feed.bytes || feed.sha256 !== pins_default.iwad.feed.sha256 || source.value.archive !== "tar.gz" || source.value.exportName !== sourceExportName || notices.path !== "LICENSES.md")
    throw new Error("Unsupported Doom bundle.");
  const common = ({ bytes, sha256: sha2562, chunks }) => ({
    bytes,
    sha256: sha2562,
    chunks
  });
  return Object.freeze({
    schema: 2,
    engine: Object.freeze({ ...common(engine), abi: "doomgeneric-wasi-v2" }),
    iwad: Object.freeze({
      ...pins_default.iwad,
      feed: Object.freeze({ ...pins_default.iwad.feed })
    }),
    source: Object.freeze({
      ...common(source),
      archive: "tar.gz",
      exportName: sourceExportName
    }),
    notices: Object.freeze({
      path: "LICENSES.md",
      bytes: size(notices.bytes, 512 * 1024),
      sha256: hash(notices.sha256)
    })
  });
}
async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function readPackageFile(path, expectedBytes, base, signal, fetchFile = fetch) {
  signal.throwIfAborted();
  const url = new URL(path, base);
  const directory = new URL(".", base);
  if (!/^(assets\/(engine|source)\/\d{3}\.json|LICENSES\.md)$/.test(path) || url.protocol !== directory.protocol || url.host !== directory.host || !url.pathname.startsWith(directory.pathname))
    throw new Error("Doom resource is outside its installed package.");
  const response = await fetchFile(url, {
    signal,
    credentials: "omit",
    redirect: "error"
  });
  if (!response.ok || !response.body)
    throw new Error(
      "The installed Doom package is incomplete. Reinstall the addon."
    );
  const length = response.headers.get("content-length");
  if (length !== null && Number(length) !== expectedBytes) {
    await response.body.cancel().catch(() => {
    });
    throw new Error("Doom package resource size does not match.");
  }
  const reader = response.body.getReader();
  const result = new Uint8Array(expectedBytes);
  let offset = 0;
  const abort = () => {
    void reader.cancel().catch(() => {
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      if (chunk.value.byteLength > expectedBytes - offset)
        throw new Error("Doom package resource exceeds its size limit.");
      result.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }
    if (offset !== expectedBytes)
      throw new Error("Doom package resource is truncated.");
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {
    });
    reader.releaseLock();
  }
}
async function loadArtifact(artifact2, base, signal, fetchFile = fetch) {
  const output = new Uint8Array(artifact2.bytes);
  let offset = 0;
  for (const chunk of artifact2.chunks) {
    const raw = await readPackageFile(
      chunk.path,
      chunk.jsonBytes,
      base,
      signal,
      fetchFile
    );
    const value = record2(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
      ["base64"]
    );
    const encoded = value.base64;
    if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(chunk.decodedBytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
      throw new Error("Invalid Doom resource encoding.");
    const decoded = atob(encoded);
    if (decoded.length !== chunk.decodedBytes || btoa(decoded) !== encoded)
      throw new Error("Noncanonical Doom resource encoding.");
    const bytes = Uint8Array.from(
      decoded,
      (character) => character.charCodeAt(0)
    );
    if (await sha256(bytes) !== chunk.sha256)
      throw new Error("Doom resource chunk digest does not match.");
    signal.throwIfAborted();
    output.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (await sha256(output) !== artifact2.sha256)
    throw new Error("Doom artifact digest does not match.");
  signal.throwIfAborted();
  return output;
}

// src/input.ts
var keys = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "backward",
  ArrowDown: "backward",
  KeyA: "strafeLeft",
  ArrowLeft: "turnLeft",
  KeyD: "strafeRight",
  ArrowRight: "turnRight",
  Comma: "strafeLeft",
  Period: "strafeRight",
  KeyF: "fire",
  Space: "use",
  ShiftLeft: "run",
  ShiftRight: "run",
  Enter: "enter",
  Escape: "escape",
  Tab: "map"
};
var GameInput = class {
  sources = /* @__PURE__ */ new Map();
  taps = /* @__PURE__ */ new Map();
  origin = null;
  fraction = 0;
  turn = 0;
  epoch = 0;
  press(code, repeat) {
    const action = keys[code];
    if (action) this.pressSource(`key:${code}`, action, repeat);
  }
  release(code) {
    return this.sources.delete(`key:${code}`);
  }
  pressSource(source, action, repeat = false) {
    if (repeat || this.sources.has(source)) return;
    const alreadyHeld = [...this.sources.values()].includes(action);
    this.sources.set(source, action);
    if (!alreadyHeld) this.taps.set(source, action);
  }
  pointerPress(button) {
    const action = button === 0 ? "fire" : button === 2 ? "use" : null;
    if (!action) return false;
    this.pressSource(`pointer:${button}`, action);
    return true;
  }
  pointerRelease(button) {
    return this.sources.delete(`pointer:${button}`);
  }
  pointerButtons(buttons) {
    for (const [button, mask] of [
      [0, 1],
      [2, 2]
    ]) {
      if (buttons & mask) this.pointerPress(button);
      else this.pointerRelease(button);
    }
  }
  get pointerHeld() {
    return [...this.sources.keys()].some(
      (source) => source.startsWith("pointer:")
    );
  }
  point(pointer, x, canvasWidth) {
    if (!Number.isFinite(x) || !Number.isFinite(canvasWidth) || canvasWidth <= 0) {
      this.resetOrigin();
      return;
    }
    const previous = this.origin;
    this.origin = { pointer, x };
    if (!previous || previous.pointer !== pointer) return;
    const delta = (x - previous.x) * 640 / canvasWidth * 8;
    const scaled = Math.max(-2048, Math.min(2048, delta)) + this.fraction;
    const whole = Math.trunc(scaled);
    this.fraction = scaled - whole;
    this.turn = Math.max(-2048, Math.min(2048, this.turn + whole));
  }
  resetOrigin() {
    this.origin = null;
    this.fraction = 0;
  }
  clearPointer() {
    for (const source of /* @__PURE__ */ new Set([
      ...this.sources.keys(),
      ...this.taps.keys()
    ])) {
      if (source.startsWith("pointer:")) {
        this.sources.delete(source);
        this.taps.delete(source);
      }
    }
    this.resetOrigin();
    this.turn = 0;
    this.epoch++;
  }
  clear() {
    this.sources.clear();
    this.taps.clear();
    this.resetOrigin();
    this.turn = 0;
    this.epoch++;
  }
  take() {
    const held = [...new Set(this.sources.values())];
    const taps = [...new Set(this.taps.values())];
    const turn = this.turn;
    this.taps.clear();
    this.turn = 0;
    return { held, taps, turn };
  }
};

// src/runtime.ts
function parseEngineBytes(input) {
  if (!(input instanceof Uint8Array) || input.byteLength !== pins_default.engine.bytes || ![0, 97, 115, 109, 1, 0, 0, 0].every((byte, index) => input[index] === byte))
    throw new Error("Invalid bundled Doom engine.");
  return input;
}
function parseIwadBytes(input) {
  if (!(input instanceof Uint8Array) || input.byteLength !== pins_default.iwad.bytes || new TextDecoder().decode(input.subarray(0, 4)) !== "IWAD")
    throw new Error("Invalid Doom shareware data.");
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const count = view.getInt32(4, true);
  const directory = view.getInt32(8, true);
  if (count !== 1264 || directory < 12 || directory > input.byteLength - count * 16)
    throw new Error("Invalid Doom IWAD directory.");
  const maps = [];
  for (let index = 0; index < count; index++) {
    const offset = directory + index * 16;
    const start = view.getInt32(offset, true);
    const bytes = view.getInt32(offset + 4, true);
    if (start < 0 || bytes < 0 || start > input.byteLength - bytes)
      throw new Error("Doom IWAD lump is outside its resource.");
    const name = new TextDecoder().decode(input.subarray(offset + 8, offset + 16)).replace(/\0.*$/, "");
    if (/^E\dM\d$/.test(name)) maps.push(name);
  }
  if (maps.join(",") !== "E1M1,E1M2,E1M3,E1M4,E1M5,E1M6,E1M7,E1M8,E1M9")
    throw new Error("Unsupported Doom shareware episode.");
  return input;
}
async function validateGame(engineInput, iwadInput) {
  const engine = Uint8Array.from(parseEngineBytes(engineInput));
  const iwad = Uint8Array.from(parseIwadBytes(iwadInput));
  if (await sha256(engine) !== pins_default.engine.sha256 || await sha256(iwad) !== pins_default.iwad.sha256)
    throw new Error(
      "The installed Doom artifacts do not match. Reinstall the addon."
    );
  return { engine, iwad };
}

// src/iwad.ts
var maxTextBytes = 1024 * 1024;
var partBytes = 516096;
var partCount = 9;
var hashPattern2 = /^[0-9a-f]{64}$/;
var manifestUrl = new URL(pins_default.iwad.feed.url);
var baseUrl = new URL(".", manifestUrl);
function record3(value, fields2) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Doom shareware feed.");
  const object2 = value;
  if (Object.keys(object2).length !== fields2.length || fields2.some((field) => !Object.hasOwn(object2, field)))
    throw new Error("Unexpected Doom shareware feed fields.");
  return object2;
}
function parseIwadManifest(input) {
  const value = record3(input, [
    "schema",
    "edition",
    "bytes",
    "sha256",
    "encoding",
    "license",
    "parts",
    "terms"
  ]);
  if (value.schema !== 1 || value.edition !== pins_default.iwad.edition || value.bytes !== pins_default.iwad.bytes || value.sha256 !== pins_default.iwad.sha256 || value.encoding !== "base64" || value.license !== pins_default.iwad.license || !Array.isArray(value.parts) || value.parts.length !== partCount || !Array.isArray(value.terms) || value.terms.length !== 2 || value.terms[0] !== "shareware-debian-terms.txt" || value.terms[1] !== "shareware-netbsd-terms.txt")
    throw new Error("Unsupported Doom shareware feed.");
  return Object.freeze(
    value.parts.map((input2, index) => {
      const part = record3(input2, ["path", "bytes", "sha256"]);
      const expectedBytes = Math.min(
        partBytes,
        pins_default.iwad.bytes - index * partBytes
      );
      if (part.path !== `doom1-part-${String(index).padStart(2, "0")}.json` || part.bytes !== expectedBytes || typeof part.sha256 !== "string" || !hashPattern2.test(part.sha256))
        throw new Error("Invalid Doom shareware part path, size, or digest.");
      return Object.freeze({
        path: part.path,
        bytes: expectedBytes,
        sha256: part.sha256
      });
    })
  );
}
function decodeBase64(encoded, expectedBytes) {
  if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(expectedBytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
    throw new Error("Invalid Doom shareware encoding.");
  const decoded = atob(encoded);
  if (decoded.length !== expectedBytes || btoa(decoded) !== encoded)
    throw new Error("Noncanonical Doom shareware encoding.");
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
async function verifiedIwad(encoded) {
  const bytes = decodeBase64(encoded, pins_default.iwad.bytes);
  if (await sha256(bytes) !== pins_default.iwad.sha256)
    throw new Error("Doom shareware data digest does not match.");
  parseIwadBytes(bytes);
  return bytes;
}
function validResponseUrl(input, path) {
  const url = new URL(input);
  const expected = new URL(path, baseUrl);
  const prefix = baseUrl.pathname.replace(/[^/]+\/$/, "");
  const remainder = url.pathname.slice(prefix.length).split("/");
  return url.origin === expected.origin && url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.startsWith(prefix) && remainder.length === 2 && /^[0-9a-f]{40}$/.test(remainder[0] ?? "") && remainder[1] === path;
}
async function downloadIwad({
  network,
  signal,
  progress = () => {
  },
  current = () => {
  }
}) {
  const check = () => {
    signal.throwIfAborted();
    current();
  };
  const text = async (path, expectedBytes) => {
    check();
    const result = await network.getText({ url: new URL(path, baseUrl).href });
    check();
    if (!result.ok)
      throw new Error(
        `Doom could not download its shareware data (${result.code}). Check your connection, then close and reopen the game.`
      );
    const response = result.value;
    if (response.status !== 200 || !validResponseUrl(response.url, path) || response.text.includes("\0") || expectedBytes > maxTextBytes || new TextEncoder().encode(response.text).byteLength !== expectedBytes)
      throw new Error(
        "Doom shareware response exceeds its bounds or has an unexpected address or status."
      );
    return response.text;
  };
  const manifest = await text("manifest.json", pins_default.iwad.feed.bytes);
  if (await sha256(new TextEncoder().encode(manifest)) !== pins_default.iwad.feed.sha256)
    throw new Error("Doom shareware manifest digest does not match.");
  check();
  const parts = parseIwadManifest(JSON.parse(manifest));
  const output = new Uint8Array(pins_default.iwad.bytes);
  const encodedParts = [];
  let offset = 0;
  progress({
    kind: "downloading",
    completedBytes: 0,
    totalBytes: pins_default.iwad.bytes
  });
  for (const part of parts) {
    const raw = await text(part.path, 4 * Math.ceil(part.bytes / 3) + 14);
    const value = record3(JSON.parse(raw), ["base64"]);
    const bytes = decodeBase64(value.base64, part.bytes);
    if (await sha256(bytes) !== part.sha256)
      throw new Error("Doom shareware part digest does not match.");
    check();
    output.set(bytes, offset);
    offset += bytes.byteLength;
    if (typeof value.base64 !== "string")
      throw new Error("Invalid shareware encoding.");
    encodedParts.push(value.base64);
    progress({
      kind: "downloading",
      completedBytes: offset,
      totalBytes: pins_default.iwad.bytes
    });
  }
  progress({ kind: "verifying" });
  if (offset !== pins_default.iwad.bytes || await sha256(output) !== pins_default.iwad.sha256)
    throw new Error("Doom shareware data digest does not match.");
  parseIwadBytes(output);
  check();
  return { bytes: output, base64: encodedParts.join("") };
}
var IwadCache = class {
  generation = 0;
  handle = null;
  pendingWrite = Promise.resolve();
  storage;
  network;
  constructor(context) {
    this.storage = context.storage;
    this.network = context.host.network;
  }
  open() {
    this.handle ??= this.storage.global("iwad-cache", 1);
    return this.handle;
  }
  write(handle, value, current) {
    const writing = this.pendingWrite.catch(() => {
    }).then(() => {
      current();
      return handle.set(value);
    });
    this.pendingWrite = writing;
    return writing;
  }
  async load(signal, progress) {
    const generation = this.generation;
    const current = () => {
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new Error(
          "Cached game data was cleared. Close and reopen the game."
        );
    };
    progress({ kind: "checking" });
    let handle = null;
    try {
      handle = await this.open();
    } catch {
    }
    current();
    let snapshot = null;
    try {
      snapshot = handle?.snapshot() ?? null;
    } catch {
    }
    if (snapshot?.status === "ready" && snapshot.value !== null) {
      try {
        const cache = record3(snapshot.value, [
          "schema",
          "bytes",
          "sha256",
          "base64"
        ]);
        if (cache.schema !== 1 || cache.bytes !== pins_default.iwad.bytes || cache.sha256 !== pins_default.iwad.sha256)
          throw new Error("Cached Doom shareware metadata does not match.");
        const bytes = await verifiedIwad(cache.base64);
        current();
        return { bytes, source: "cache", persistent: true };
      } catch (error) {
        current();
        if (!(error instanceof Error)) throw error;
      }
    }
    const game = await downloadIwad({
      network: this.network,
      signal,
      progress,
      current
    });
    current();
    let persistent = false;
    if (handle && (snapshot?.status === "ready" || snapshot?.status === "missing")) {
      try {
        persistent = (await this.write(
          handle,
          {
            schema: 1,
            bytes: pins_default.iwad.bytes,
            sha256: pins_default.iwad.sha256,
            base64: game.base64
          },
          current
        )).status === "saved";
      } catch {
      }
    }
    current();
    return { bytes: game.bytes, source: "download", persistent };
  }
  async clear() {
    this.generation++;
    const handle = await this.open();
    const result = await this.write(handle, null, () => {
    });
    if (result.status !== "saved")
      throw new Error(
        "Hibi could not clear cached game data. Close the game and try again."
      );
  }
};

// src/model.ts
var width = 640;
var height = 400;
var frameBytes = width * height * 4;
function object(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid Doom payload.");
  return input;
}
function fields(value, names) {
  if (Object.keys(value).length !== names.length || names.some((name) => !Object.hasOwn(value, name)))
    throw new Error("Unexpected Doom payload fields.");
}
function integer(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0)
    throw new Error("Invalid Doom frame cursor.");
  return input;
}
function requestId(input) {
  const id = integer(input);
  if (id === 0) throw new Error("Invalid Doom worker request.");
  return id;
}
function activity(input) {
  if (input !== "running" && input !== "paused")
    throw new Error("Invalid Doom activity.");
  return input;
}
function parseFrameUpdate(input) {
  const value = object(input);
  const sequence = integer(value.sequence);
  const elapsedMs = integer(value.elapsedMs);
  const gameTics = integer(value.gameTics);
  const audio = parseAudioScene(value.audio);
  if (value.kind === "unchanged" || value.kind === "paused") {
    fields(value, ["kind", "sequence", "elapsedMs", "gameTics", "audio"]);
    return { kind: value.kind, sequence, elapsedMs, gameTics, audio };
  }
  fields(value, [
    "kind",
    "sequence",
    "elapsedMs",
    "gameTics",
    "audio",
    "width",
    "height",
    "pixels"
  ]);
  if (value.kind !== "frame" || value.width !== width || value.height !== height || !(value.pixels instanceof Uint8Array) || value.pixels.byteLength !== frameBytes)
    throw new Error("Invalid Doom RGBA frame.");
  return {
    kind: "frame",
    sequence,
    elapsedMs,
    gameTics,
    audio,
    width,
    height,
    pixels: value.pixels
  };
}
function parseWorkerReply(input) {
  const value = object(input);
  const id = requestId(value.id);
  switch (value.kind) {
    case "ready":
      fields(value, ["id", "kind", "engine"]);
      if (value.engine !== "doom")
        throw new Error("Invalid Doom worker readiness.");
      return { id, kind: "ready", engine: "doom" };
    case "activity":
      fields(value, ["id", "kind", "activity", "epoch"]);
      return {
        id,
        kind: "activity",
        activity: activity(value.activity),
        epoch: integer(value.epoch)
      };
    case "update":
      fields(value, ["id", "kind", "update"]);
      return { id, kind: "update", update: parseFrameUpdate(value.update) };
    case "error":
      fields(value, ["id", "kind", "message"]);
      if (typeof value.message !== "string" || value.message.length === 0 || value.message.length > 500)
        throw new Error("Invalid Doom worker failure.");
      return { id, kind: "error", message: value.message };
    default:
      throw new Error("Invalid Doom worker reply.");
  }
}
function parseAudioNotice(input) {
  if (!input || typeof input !== "object" || !("kind" in input) || input.kind !== "audio")
    return null;
  const value = object(input);
  fields(value, ["kind", "audio"]);
  return { kind: "audio", audio: parseAudioScene(value.audio) };
}

// src/session.ts
var GameSession = class {
  worker;
  nextId = 0;
  pending = /* @__PURE__ */ new Map();
  failure = null;
  timeoutMs;
  events;
  constructor(worker, timeoutMs = 15e3, events = {}) {
    this.worker = worker;
    this.timeoutMs = timeoutMs;
    this.events = events;
    worker.addEventListener("message", this.receive);
    worker.addEventListener("error", this.workerError);
    worker.addEventListener("messageerror", this.workerError);
  }
  get disposed() {
    return this.worker === null;
  }
  request(input, transfer = []) {
    const worker = this.worker;
    if (!worker)
      return Promise.reject(
        this.failure ?? new Error("Doom session ended. Close and reopen the game.")
      );
    if (this.pending.size >= 2 || [...this.pending.values()].some((entry) => entry.kind === input.kind))
      return Promise.reject(new Error("Doom already has a pending request."));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.dispose(
          new Error("Doom stopped responding. Close and reopen the game.")
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        kind: input.kind,
        notifications: 0,
        resolve,
        reject,
        timer
      });
      try {
        worker.postMessage({ id, ...input }, transfer);
      } catch (error) {
        this.dispose(
          error instanceof Error ? error : new Error("Hibi could not send Doom input.")
        );
      }
    });
  }
  dispose(error = new Error("Doom session ended.")) {
    const worker = this.worker;
    if (!worker) return;
    this.worker = null;
    this.failure = error;
    worker.removeEventListener("message", this.receive);
    worker.removeEventListener("error", this.workerError);
    worker.removeEventListener("messageerror", this.workerError);
    worker.terminate();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.events.disposed?.(error);
  }
  workerError = () => {
    this.dispose(
      new Error("The Doom worker failed. Close and reopen the game.")
    );
  };
  receive = (event) => {
    try {
      const notice = parseAudioNotice(event.data);
      if (notice) {
        const operation = this.pending.values().next().value;
        if (!operation)
          throw new Error(
            "Doom returned audio without an outstanding operation."
          );
        if (++operation.notifications > audioNotificationBudget)
          throw new Error("Doom exceeded its sound notification budget.");
        this.events.audio?.(notice.audio);
        return;
      }
      const reply = parseWorkerReply(event.data);
      const entry = this.pending.get(reply.id);
      if (!entry) throw new Error("Doom returned an unexpected request ID.");
      if (reply.kind === "error") {
        this.dispose(new Error(reply.message));
        return;
      }
      if (entry.kind === "startup" && reply.kind !== "ready" || entry.kind === "activity" && reply.kind !== "activity" || entry.kind === "frame" && reply.kind !== "update")
        throw new Error("Doom returned an unexpected response.");
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      entry.resolve(reply);
    } catch (error) {
      this.dispose(
        error instanceof Error ? error : new Error("Invalid Doom worker response.")
      );
    }
  };
};

// src/source-export.ts
var SourceExport = class {
  state = { kind: "idle" };
  io;
  source;
  base;
  changed;
  fetchFile;
  constructor(io, source, base, changed, fetchFile = fetch) {
    this.io = io;
    this.source = source;
    this.base = base;
    this.changed = changed;
    this.fetchFile = fetchFile;
  }
  set(state) {
    this.state = state;
    this.changed(state);
  }
  get disposed() {
    return this.state.kind === "disposed";
  }
  dispose() {
    if (this.state.kind === "disposed") return;
    if (this.state.kind === "loading") this.state.abort.abort();
    if (this.state.kind === "writing" || this.state.kind === "cleanup")
      void this.io.cancel(this.state.handle).catch(() => {
      });
    this.state = { kind: "disposed" };
  }
  async save() {
    if (!["idle", "saved", "failed"].includes(this.state.kind)) return;
    const abort = new AbortController();
    this.set({ kind: "loading", abort });
    let handle = null;
    let terminal = { kind: "idle" };
    try {
      const bytes = await loadArtifact(
        this.source,
        this.base,
        abort.signal,
        this.fetchFile
      );
      if (this.disposed) return;
      this.set({ kind: "choosing" });
      const selected = await this.io.selectExport({
        suggestedName: this.source.exportName,
        extension: "gz"
      });
      if (selected.ok && selected.value) handle = selected.value.handle;
      if (this.disposed) return;
      if (!selected.ok)
        throw new Error(
          selected.code === "busy" ? "Finish the current file operation, then save the source again." : selected.code === "conflict" ? "A file already exists at this destination. Choose another name." : "Hibi could not choose a source destination. Try again."
        );
      if (!selected.value) return;
      this.set({ kind: "writing", handle: selected.value.handle });
      const written = await this.io.writeExport(selected.value.handle, bytes);
      if (this.disposed) return;
      if (!written.ok)
        throw new Error(
          written.code === "conflict" ? "A file already exists at this destination. Choose another name." : written.code === "busy" ? "Finish the current file operation, then save the source again." : "Hibi could not save the source. Choose another destination."
        );
      terminal = { kind: "saved" };
    } catch (error) {
      terminal = {
        kind: "failed",
        message: error instanceof Error ? error.message : "The source could not be saved."
      };
    } finally {
      if (handle) {
        if (!this.disposed) this.set({ kind: "cleanup", handle });
        await this.io.cancel(handle).catch(() => {
        });
      }
      if (!this.disposed) this.set(terminal);
    }
  }
};

// src/style.css
var style_default = ".hibi-doom {\n  height: 100%;\n  min-height: 0;\n  display: flex;\n  flex-direction: column;\n  color: var(--ink);\n  background: var(--background);\n}\n.hibi-doom-controls {\n  padding: 8px 12px;\n  flex: 0 0 auto;\n  flex-wrap: wrap;\n}\n.hibi-doom-volume {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  font-size: var(--text-sm);\n}\n.hibi-doom-volume input {\n  width: 80px;\n}\n.hibi-doom-audio-status {\n  margin: 0;\n  padding: 4px 12px;\n  font-size: var(--text-sm);\n  color: var(--muted);\n}\n.hibi-doom-legal {\n  flex: 0 0 auto;\n  padding: 4px 12px;\n  font-size: var(--text-sm);\n  color: var(--muted);\n}\n.hibi-doom-legal span {\n  flex: 1;\n}\n.hibi-doom-cache-warning {\n  margin: 0;\n  padding: 4px 12px;\n  font-size: var(--text-sm);\n}\n.hibi-doom-controls span {\n  flex: 1;\n  font-size: var(--text-sm);\n  color: var(--muted);\n}\n.hibi-doom-screen {\n  flex: 1;\n  min-height: 0;\n  position: relative;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  overflow: hidden;\n  background: #000;\n}\n.hibi-doom-screen canvas {\n  display: block;\n  width: 100%;\n  height: 100%;\n  object-fit: contain;\n  image-rendering: pixelated;\n}\n.hibi-doom-screen canvas:focus-visible {\n  outline: 2px solid var(--accent);\n  outline-offset: -2px;\n}\n.hibi-doom-message {\n  position: absolute;\n  inset: 0;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  justify-content: center;\n  gap: 12px;\n  padding: 24px;\n  background: var(--background);\n  color: var(--ink);\n  text-align: center;\n}\n.hibi-doom-message p {\n  max-width: 48rem;\n}\n.hibi-doom-paused {\n  position: absolute;\n  bottom: 16px;\n  padding: 8px 12px;\n  background: var(--surface);\n  color: var(--ink);\n  border-radius: var(--radius-control);\n  pointer-events: none;\n}\n.hibi-doom-licenses {\n  height: 100%;\n  overflow: auto;\n  padding: 16px;\n  color: var(--ink);\n}\n.hibi-doom-notices {\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  font-family: var(--font-mono);\n  font-size: var(--text-sm);\n}\n";

// src/index.tsx
var disposed = (owner) => owner.state.kind === "disposed";
var bundle = parseBundle(bundle_default);
var packageBase = new URL(import.meta.url);
var create = (sdk) => {
  const React = sdk.React;
  const ui = sdk.ui;
  if (!React || !ui) throw new Error("Doom requires Hibi's UI capability.");
  const { useEffect, useRef, useState } = React;
  const { Button, ControlRow, Panel, PanelMessage } = ui;
  const cleanups = /* @__PURE__ */ new Set();
  function SkullIcon({ size: size2 = 24, strokeWidth = 2 }) {
    return /* @__PURE__ */ React.createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: size2,
        height: size2,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true"
      },
      /* @__PURE__ */ React.createElement("path", { d: "m12.5 17-.5-1-.5 1h1z" }),
      /* @__PURE__ */ React.createElement("path", { d: "M15 22a1 1 0 0 0 1-1v-1a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20v1a1 1 0 0 0 1 1z" }),
      /* @__PURE__ */ React.createElement("circle", { cx: "15", cy: "12", r: "1" }),
      /* @__PURE__ */ React.createElement("circle", { cx: "9", cy: "12", r: "1" })
    );
  }
  function DoomTab({
    openLicenses,
    visible,
    close,
    cache
  }) {
    const canvas = useRef(null);
    const input = useRef(new GameInput());
    const capture = useRef(null);
    const audio = useRef(null);
    const lifetime = useRef(null);
    const wake = useRef(() => {
    });
    const [display, setDisplay] = useState({
      kind: "loading",
      abort: new AbortController(),
      progress: { kind: "checking" }
    });
    const [paused, setPaused] = useState(false);
    const [availability, setAvailability] = useState({
      kind: "waiting"
    });
    const [muted, setMuted] = useState(false);
    const [volume, setVolume] = useState(0.7);
    const [canvasFocused, setCanvasFocused] = useState(false);
    const [focused, setFocused] = useState(document.hasFocus());
    const [documentVisible, setDocumentVisible] = useState(
      document.visibilityState === "visible"
    );
    const desired = display.kind === "ready" && visible && focused && documentVisible && canvasFocused && !paused ? "running" : "paused";
    const activity2 = useRef(desired);
    activity2.current = desired;
    function releaseCapture() {
      const pointer = capture.current;
      capture.current = null;
      const element = canvas.current;
      if (pointer !== null && element?.hasPointerCapture(pointer))
        element.releasePointerCapture(pointer);
      input.current.resetOrigin();
    }
    function releaseInput() {
      releaseCapture();
      input.current.clear();
      activity2.current = "paused";
      audio.current?.setActivity("paused", input.current.epoch);
      wake.current();
    }
    useEffect(() => {
      const owner = {
        state: {
          kind: "loading",
          abort: new AbortController(),
          progress: { kind: "checking" }
        },
        audio: null
      };
      lifetime.current = owner;
      setDisplay(owner.state);
      const blur = () => {
        releaseInput();
        setFocused(false);
      };
      const focus = () => setFocused(true);
      const visibility = () => {
        const shown = document.visibilityState === "visible";
        if (!shown) releaseInput();
        setDocumentVisible(shown);
      };
      const dispose = () => {
        if (disposed(owner)) return;
        const previous = owner.state;
        owner.state = { kind: "disposed" };
        releaseInput();
        if (previous.kind === "loading") previous.abort.abort();
        if (previous.kind === "starting" || previous.kind === "ready")
          previous.session.dispose();
        owner.audio?.dispose();
        if (audio.current === owner.audio) audio.current = null;
        window.removeEventListener("blur", blur);
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", visibility);
        cleanups.delete(dispose);
      };
      cleanups.add(dispose);
      window.addEventListener("blur", blur);
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visibility);
      void startGame(owner);
      return dispose;
    }, []);
    useEffect(() => {
      if (visible && display.kind === "ready" && document.visibilityState === "visible")
        canvas.current?.focus();
    }, [visible, display.kind]);
    useEffect(() => {
      if (desired === "paused") {
        releaseCapture();
        input.current.clear();
      }
      audio.current?.setActivity(desired, input.current.epoch);
      wake.current();
    }, [desired]);
    useEffect(() => {
      if (display.kind !== "ready") return;
      const session = display.session;
      let canceled = false;
      let timer;
      let releaseWait;
      let acknowledged = {
        activity: "paused",
        epoch: input.current.epoch
      };
      let after = 0;
      const wait = (milliseconds) => new Promise((resolve) => {
        releaseWait = resolve;
        if (milliseconds !== void 0)
          timer = setTimeout(resolve, milliseconds);
      });
      const wakeLoop = () => {
        clearTimeout(timer);
        timer = void 0;
        const release = releaseWait;
        releaseWait = void 0;
        release?.();
      };
      wake.current = wakeLoop;
      const run = async () => {
        try {
          while (!canceled && !session.disposed) {
            const desiredActivity = activity2.current;
            if (acknowledged.activity !== desiredActivity || acknowledged.epoch !== input.current.epoch) {
              const epoch2 = input.current.epoch;
              const reply2 = await session.request({
                kind: "activity",
                activity: desiredActivity,
                epoch: epoch2
              });
              if (canceled) break;
              if (reply2.kind !== "activity" || reply2.activity !== desiredActivity || reply2.epoch !== epoch2)
                throw new Error(
                  "Doom could not change activity. Close and reopen the game."
                );
              acknowledged = { activity: desiredActivity, epoch: epoch2 };
              continue;
            }
            if (desiredActivity === "paused") {
              await wait();
              continue;
            }
            const startedAt = performance.now();
            const epoch = input.current.epoch;
            const reply = await session.request({
              kind: "frame",
              activity: "running",
              epoch,
              ...input.current.take(),
              after
            });
            if (canceled) break;
            if (epoch !== input.current.epoch || activity2.current !== "running")
              continue;
            if (reply.kind !== "update")
              throw new Error(
                "Doom returned an invalid frame. Close and reopen the game."
              );
            const update = reply.update;
            audio.current?.apply(update.audio);
            if (update.kind === "frame") {
              const element = canvas.current;
              const drawing = element?.getContext("2d", { alpha: false });
              if (!element || !drawing)
                throw new Error(
                  "Hibi could not display the game. Close and reopen the game."
                );
              drawing.putImageData(
                new ImageData(
                  new Uint8ClampedArray(update.pixels),
                  width,
                  height
                ),
                0,
                0
              );
              after = update.sequence;
              element.dataset.sequence = String(update.sequence);
              element.dataset.gameTime = String(update.elapsedMs);
              element.dataset.gameTics = String(update.gameTics);
            }
            await wait(Math.max(0, 16 - (performance.now() - startedAt)));
          }
        } catch (error) {
          if (!canceled && lifetime.current?.state.kind !== "disposed")
            setDisplay({
              kind: "failed",
              message: error instanceof Error ? error.message : "Doom could not run. Close and reopen the game."
            });
        } finally {
          session.dispose();
        }
      };
      void run();
      return () => {
        canceled = true;
        releaseCapture();
        input.current.clear();
        audio.current?.dispose();
        wakeLoop();
        session.dispose();
      };
    }, [display]);
    async function startGame(owner) {
      if (owner.state.kind !== "loading") return;
      const abort = owner.state.abort;
      try {
        const engineBytes = await loadArtifact(
          bundle.engine,
          packageBase,
          abort.signal
        );
        const data = await cache.load(abort.signal, (progress) => {
          if (owner.state.kind !== "loading" || abort.signal.aborted) return;
          owner.state = { kind: "loading", abort, progress };
          setDisplay(owner.state);
        });
        const { engine, iwad } = await validateGame(engineBytes, data.bytes);
        abort.signal.throwIfAborted();
        if (disposed(owner)) return;
        const gameAudio = new GameAudio(parseAudioBank(iwad), (state) => {
          if (!disposed(owner)) setAvailability(state);
        });
        owner.audio = gameAudio;
        audio.current = gameAudio;
        gameAudio.setPreference(muted, volume);
        const session = new GameSession(
          new Worker(new URL("./doom.worker.js", import.meta.url), {
            type: "module"
          }),
          15e3,
          {
            audio: (scene) => gameAudio.apply(scene),
            disposed: (error) => {
              gameAudio.dispose();
              if (owner.state.kind === "starting" || owner.state.kind === "ready") {
                owner.state = { kind: "failed", message: error.message };
                setDisplay(owner.state);
              }
            }
          }
        );
        owner.state = { kind: "starting", session };
        setDisplay(owner.state);
        const reply = await session.request({ kind: "startup", engine, iwad }, [
          engine.buffer,
          iwad.buffer
        ]);
        if (disposed(owner)) return;
        if (reply.kind !== "ready")
          throw new Error("Doom could not start. Close and reopen the game.");
        setPaused(false);
        owner.state = {
          kind: "ready",
          session,
          dataSource: data.source,
          persistent: data.persistent
        };
        setDisplay(owner.state);
      } catch (error) {
        owner.audio?.dispose();
        if (owner.state.kind === "starting" || owner.state.kind === "ready")
          owner.state.session.dispose();
        if (!disposed(owner)) {
          owner.state = {
            kind: "failed",
            message: error instanceof Error ? error.message : "Doom could not start. Close and reopen the game."
          };
          setDisplay(owner.state);
        }
      }
    }
    function keyboard(event, down) {
      if (!down && input.current.release(event.code)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.code === "Tab" && event.shiftKey) return;
      if (!keys[event.code] || event.metaKey || event.altKey || activity2.current !== "running")
        return;
      event.preventDefault();
      event.stopPropagation();
      if (down) {
        if (event.code === "Escape" && !event.repeat) {
          releaseCapture();
          input.current.clear();
          audio.current?.setActivity("running", input.current.epoch);
          wake.current();
        }
        input.current.press(event.code, event.repeat);
        if (event.nativeEvent.isTrusted) audio.current?.activate();
      }
    }
    function resumeInteraction() {
      if (display.kind !== "ready" || !visible || !document.hasFocus() || document.visibilityState !== "visible")
        return false;
      setPaused(false);
      canvas.current?.focus();
      activity2.current = "running";
      audio.current?.setActivity("running", input.current.epoch);
      wake.current();
      return true;
    }
    function pointerDown(event) {
      if (event.pointerType !== "mouse" || event.button !== 0 && event.button !== 2 || !resumeInteraction())
        return;
      event.preventDefault();
      event.stopPropagation();
      input.current.point(
        event.pointerId,
        event.clientX,
        event.currentTarget.getBoundingClientRect().width
      );
      input.current.pointerButtons(event.buttons);
      capture.current = event.pointerId;
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        capture.current = null;
        input.current.clearPointer();
        audio.current?.setActivity(activity2.current, input.current.epoch);
        wake.current();
      }
      if (event.nativeEvent.isTrusted) audio.current?.activate();
    }
    function cancelPointer(pointer) {
      if (capture.current !== pointer) return;
      releaseCapture();
      input.current.clearPointer();
      audio.current?.setActivity(activity2.current, input.current.epoch);
      wake.current();
    }
    return /* @__PURE__ */ React.createElement(
      "section",
      {
        className: "hibi-doom",
        "aria-label": "Doom game",
        "data-state": display.kind,
        "data-data-source": display.kind === "ready" ? display.dataSource : void 0,
        "data-cache-persistent": display.kind === "ready" ? String(display.persistent) : void 0
      },
      /* @__PURE__ */ React.createElement(ControlRow, { className: "hibi-doom-controls" }, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: display.kind !== "ready",
          onClick: () => {
            if (paused) {
              setPaused(false);
              canvas.current?.focus();
              audio.current?.activate();
            } else {
              releaseInput();
              setPaused(true);
            }
          }
        },
        paused ? "Resume" : "Pause"
      ), /* @__PURE__ */ React.createElement("span", null, "Move the mouse to aim. W/S move, A/D strafe, left click fires, and right click uses. Arrows turn, F/Space are alternatives, and Enter selects. Shift+Tab leaves the game."), /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: display.kind !== "ready",
          onClick: () => {
            const next = !muted;
            setMuted(next);
            audio.current?.setPreference(next, volume);
            audio.current?.activate();
          }
        },
        muted ? "Unmute" : "Mute"
      ), /* @__PURE__ */ React.createElement("label", { className: "hibi-doom-volume" }, "Volume", /* @__PURE__ */ React.createElement(
        "input",
        {
          "aria-label": "Doom volume",
          type: "range",
          min: "0",
          max: "100",
          value: Math.round(volume * 100),
          disabled: display.kind !== "ready",
          onChange: (event) => {
            const next = Number(event.currentTarget.value) / 100;
            setVolume(next);
            audio.current?.setPreference(muted, next);
            audio.current?.activate();
          }
        }
      )), /* @__PURE__ */ React.createElement(
        Button,
        {
          variant: "ghost",
          onClick: () => {
            releaseInput();
            audio.current?.dispose();
            close();
          }
        },
        "Close game"
      )),
      /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-screen" }, /* @__PURE__ */ React.createElement(
        "canvas",
        {
          ref: canvas,
          width,
          height,
          tabIndex: display.kind === "ready" ? 0 : -1,
          "aria-label": "Doom canvas",
          onFocus: () => {
            input.current.resetOrigin();
            setCanvasFocused(true);
          },
          onBlur: () => {
            releaseInput();
            setCanvasFocused(false);
          },
          onClick: (event) => {
            if (resumeInteraction() && event.nativeEvent.isTrusted)
              audio.current?.activate();
          },
          onPointerDown: pointerDown,
          onPointerMove: (event) => {
            if (event.pointerType === "mouse" && activity2.current === "running") {
              if (capture.current === event.pointerId)
                input.current.pointerButtons(event.buttons);
              input.current.point(
                event.pointerId,
                event.clientX,
                event.currentTarget.getBoundingClientRect().width
              );
              if (capture.current === event.pointerId && !input.current.pointerHeld)
                releaseCapture();
            }
          },
          onPointerEnter: (event) => {
            if (capture.current === null) input.current.resetOrigin();
            if (event.pointerType === "mouse" && activity2.current === "running")
              input.current.point(
                event.pointerId,
                event.clientX,
                event.currentTarget.getBoundingClientRect().width
              );
          },
          onPointerLeave: () => {
            if (capture.current === null) input.current.resetOrigin();
          },
          onPointerUp: (event) => {
            if (event.pointerType !== "mouse" || capture.current !== event.pointerId)
              return;
            event.preventDefault();
            event.stopPropagation();
            input.current.pointerButtons(event.buttons);
            if (!input.current.pointerHeld) releaseCapture();
          },
          onPointerCancel: (event) => cancelPointer(event.pointerId),
          onLostPointerCapture: (event) => cancelPointer(event.pointerId),
          onContextMenu: (event) => {
            if (display.kind === "ready" && activity2.current === "running" && event.button === 2) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
          onKeyDown: (event) => keyboard(event, true),
          onKeyUp: (event) => keyboard(event, false)
        }
      ), display.kind !== "ready" && /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-message" }, /* @__PURE__ */ React.createElement(
        PanelMessage,
        {
          icon: "",
          title: display.kind === "failed" ? "Could not play Doom" : display.kind === "starting" ? "Starting Doom..." : display.kind === "loading" && display.progress.kind === "downloading" ? "Downloading Doom shareware..." : display.kind === "loading" && display.progress.kind === "verifying" ? "Verifying Doom shareware..." : "Loading Doom...",
          role: display.kind === "failed" ? "alert" : "status",
          loading: display.kind === "starting" || display.kind === "loading"
        },
        display.kind === "failed" ? display.message : display.kind === "loading" && display.progress.kind === "downloading" ? `${Math.floor(display.progress.completedBytes / display.progress.totalBytes * 100)}% downloaded. The unchanged shareware episode is saved for offline play.` : "The first Play downloads the shareware episode automatically. Later games use verified cached data."
      )), display.kind === "ready" && desired === "paused" && visible && /* @__PURE__ */ React.createElement("div", { className: "hibi-doom-paused", "aria-live": "polite" }, "Paused. Click the game to resume.")),
      display.kind === "ready" && /* @__PURE__ */ React.createElement(
        "p",
        {
          className: "hibi-doom-audio-status",
          role: "status",
          "data-audio": availability.kind
        },
        availability.kind === "unavailable" ? `Sound is unavailable. ${availability.message}` : availability.kind === "waiting" ? "Click or press a game key for sound." : availability.kind === "muted" ? "Sound is muted." : "Sound is on. Music uses an approximate synthesizer."
      ),
      display.kind === "ready" && !display.persistent && /* @__PURE__ */ React.createElement("p", { className: "hibi-doom-cache-warning", role: "status" }, "The game is ready, but Hibi could not save its data. Connect again next time."),
      /* @__PURE__ */ React.createElement(ControlRow, { className: "hibi-doom-legal" }, /* @__PURE__ */ React.createElement("span", null, "Doom engine. Copyright id Software, Simon Howard, and contributors. GNU GPL version 3 only. No warranty. Redistribution permitted under GPL."), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: openLicenses }, "License and source"))
    );
  }
  function LicensesTab({
    context,
    close,
    cache
  }) {
    const [notices, setNotices] = useState(null);
    const [noticeFailure, setNoticeFailure] = useState(null);
    const [exportState, setExportState] = useState({
      kind: "idle"
    });
    const exporter = useRef(null);
    const [cacheState, setCacheState] = useState("idle");
    const mounted = useRef(false);
    useEffect(() => {
      const abort = new AbortController();
      mounted.current = true;
      const source = new SourceExport(
        context.host.selectedIo,
        bundle.source,
        packageBase,
        setExportState
      );
      exporter.current = source;
      const dispose = () => {
        abort.abort();
        mounted.current = false;
        source.dispose();
        exporter.current = null;
        cleanups.delete(dispose);
      };
      cleanups.add(dispose);
      void (async () => {
        try {
          const bytes = await readPackageFile(
            bundle.notices.path,
            bundle.notices.bytes,
            packageBase,
            abort.signal
          );
          if (await sha256(bytes) !== bundle.notices.sha256)
            throw new Error("The installed license notices do not match.");
          abort.signal.throwIfAborted();
          setNotices(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch (error) {
          if (!abort.signal.aborted)
            setNoticeFailure(
              error instanceof Error ? error.message : "The license notices could not be read."
            );
        }
      })();
      return dispose;
    }, [context]);
    const busy = exportState.kind === "loading" || exportState.kind === "choosing" || exportState.kind === "writing" || exportState.kind === "cleanup";
    return /* @__PURE__ */ React.createElement(
      "section",
      {
        className: "hibi-doom-licenses",
        "aria-label": "Doom license and source"
      },
      /* @__PURE__ */ React.createElement(Panel, null, /* @__PURE__ */ React.createElement("h2", null, "Doom license and source"), /* @__PURE__ */ React.createElement("p", null, "The Doom engine is copyright id Software, Simon Howard, and contributors. Hibi Doom project code and the bundled engine use GNU GPL version 3 only and come with absolutely no warranty. You may redistribute them under that license."), /* @__PURE__ */ React.createElement("p", null, "Doom 1.9 shareware data is downloaded from a separate public feed on first Play. Its separate id Software terms require unchanged data and free distribution."), /* @__PURE__ */ React.createElement("p", null, "The complete corresponding source and dependency notices are included in this addon. Save the archive to inspect or rebuild this version without repository access."), /* @__PURE__ */ React.createElement("p", null, "The source archive contains code and build inputs. It contains no shareware data. Cached game data stays on this device after removal of the addon. Clear it here to require a download on the next Play."), /* @__PURE__ */ React.createElement(ControlRow, null, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: busy,
          onClick: () => void exporter.current?.save()
        },
        "Save corresponding source"
      ), /* @__PURE__ */ React.createElement(Button, { variant: "ghost", onClick: close }, "Close license")), /* @__PURE__ */ React.createElement("p", { role: exportState.kind === "failed" ? "alert" : "status" }, exportState.kind === "failed" ? exportState.message : exportState.kind === "saved" ? "The corresponding source was saved." : busy ? "Preparing or saving corresponding source..." : "Source export creates a new file."), /* @__PURE__ */ React.createElement(ControlRow, null, /* @__PURE__ */ React.createElement(
        Button,
        {
          disabled: cacheState === "clearing",
          onClick: () => {
            setCacheState("clearing");
            void cache.clear().then(
              () => {
                if (mounted.current) setCacheState("cleared");
              },
              () => {
                if (mounted.current) setCacheState("failed");
              }
            );
          }
        },
        "Clear cached game data"
      ), /* @__PURE__ */ React.createElement("span", { role: cacheState === "failed" ? "alert" : "status" }, cacheState === "cleared" ? "Cached game data was cleared. Close and reopen the game to download it again." : cacheState === "failed" ? "Hibi could not clear cached game data. Close the game and try again." : cacheState === "clearing" ? "Clearing cached game data..." : "Clearing cached data does not end a running game.")), noticeFailure ? /* @__PURE__ */ React.createElement(PanelMessage, { icon: "", title: "Could not read notices", role: "alert" }, noticeFailure) : notices ? /* @__PURE__ */ React.createElement("section", { "aria-label": "Complete license notices" }, /* @__PURE__ */ React.createElement("pre", { className: "hibi-doom-notices" }, notices)) : /* @__PURE__ */ React.createElement(PanelMessage, { icon: "", title: "Loading notices...", loading: true }))
    );
  }
  return {
    start(context) {
      const cache = new IwadCache(context);
      context.styles.register("game", style_default);
      const licenses = context.views.register({
        id: "licenses",
        label: "Doom license and source",
        location: "tab",
        lifetime: "session",
        Content: (props) => /* @__PURE__ */ React.createElement(LicensesTab, { context, cache, ...props })
      });
      const openLicenses = () => {
        licenses.open({ id: "licenses", focus: true });
      };
      const view = context.views.register({
        id: "game",
        label: "Doom",
        location: "tab",
        lifetime: "session",
        Content: (props) => /* @__PURE__ */ React.createElement(DoomTab, { openLicenses, cache, ...props })
      });
      context.commands.register({
        id: "licenses",
        label: "Doom license and source",
        menu: { location: "app" },
        run: openLicenses
      });
      context.commands.register({
        id: "play",
        label: "Play Doom",
        menu: { location: "app" },
        run: () => {
          view.open({ id: "game", focus: true });
        }
      });
      context.toolbar.register({
        id: "play",
        label: "Play Doom",
        location: "titlebar",
        tooltip: "Play Doom",
        icon: SkullIcon,
        commandId: "play"
      });
    },
    stop() {
      for (const dispose of [...cleanups]) dispose();
    }
  };
};
var src_default = create;
export {
  src_default as default
};
