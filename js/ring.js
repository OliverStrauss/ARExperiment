// Instrument ring: pick a note's instrument by spinning a ring of labels around
// it (pure JS). ← → spin, ↵ or a second click commits, Esc cancels, and after
// `timeout` seconds without input the current choice is committed.

import { INSTRUMENTS } from './instruments.js';

export class InstrumentRing {
  constructor(choices = INSTRUMENTS, timeout = 4) {
    this.choices = choices;
    this.timeout = timeout;
    this.noteId = null;
    this.index = 0;
    this.deadline = 0;
  }

  get isOpen() {
    return this.noteId != null;
  }

  get current() {
    return this.choices[this.index];
  }

  open(noteId, current, now) {
    this.noteId = noteId;
    this.index = Math.max(0, this.choices.indexOf(current));
    this.deadline = now + this.timeout;
  }

  spin(dir, now) {
    if (!this.isOpen) return null;
    const n = this.choices.length;
    this.index = (((this.index + dir) % n) + n) % n;
    this.deadline = now + this.timeout;
    return this.current;
  }

  /** @returns { noteId, instrument } to store, or null if closed */
  commit() {
    if (!this.isOpen) return null;
    const res = { noteId: this.noteId, instrument: this.current };
    this.noteId = null;
    return res;
  }

  cancel() {
    this.noteId = null;
  }

  expired(now) {
    return this.isOpen && now >= this.deadline;
  }

  /** 'ring' message payload. */
  view() {
    if (!this.isOpen) return { open: false };
    return { open: true, noteId: this.noteId, choices: this.choices, index: this.index, deadline: this.deadline, timeout: this.timeout };
  }
}
