'use strict';

const crypto = require('crypto');

function removeEmulationPreventionBytes(buffer) {
  const output = [];
  let zeros = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index];
    if (zeros >= 2 && byte === 0x03) {
      if (index + 1 >= buffer.length || buffer[index + 1] > 0x03) return null;
      zeros = 0;
      continue;
    }
    if (zeros >= 2 && byte <= 0x02) return null;
    output.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(output);
}

function readSeiField(rbsp, state) {
  let value = 0;
  while (state.cursor < rbsp.length && rbsp[state.cursor] === 0xff) {
    value += 0xff;
    state.cursor += 1;
  }
  if (state.cursor >= rbsp.length) return null;
  value += rbsp[state.cursor];
  state.cursor += 1;
  return value;
}

function teslaPayload(h264Sei) {
  if (!Buffer.isBuffer(h264Sei) || h264Sei.length < 5 || h264Sei[0] !== 0x06) return null;
  const rbsp = removeEmulationPreventionBytes(h264Sei.subarray(1));
  if (!rbsp) return null;
  const state = { cursor: 0 };
  if (rbsp[0] !== 5) return null;
  const payloadType = readSeiField(rbsp, state);
  const payloadSize = readSeiField(rbsp, state);
  if (payloadType !== 5 || payloadSize === null || payloadSize > rbsp.length - state.cursor) return null;
  const payloadEnd = state.cursor + payloadSize;
  if (payloadEnd !== rbsp.length - 1 || rbsp[payloadEnd] !== 0x80) return null;
  const payload = rbsp.subarray(state.cursor, payloadEnd);
  let marker = 0;
  while (marker < payload.length && payload[marker] === 0x42) marker += 1;
  if (marker === 0 || marker >= payload.length || payload[marker] !== 0x69) return null;
  return payload.subarray(marker + 1);
}

function fingerprint(payload) {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

module.exports = { teslaPayload, fingerprint };
