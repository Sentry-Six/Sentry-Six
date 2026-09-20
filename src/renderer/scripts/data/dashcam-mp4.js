/**
 * Tesla Dashcam MP4 Parser
 * Parses MP4 files and extracts SEI metadata from Tesla dashcam footage.
 */
class DashcamMP4 {
    constructor(buffer) {
        this.buffer = buffer;
        this.view = new DataView(buffer);
        this._config = null;
    }

    // MP4 Box Navigation
    /** Read only boxes fully contained in their parent; malformed sizes must not loop. */
    boxes(start, end) {
        this.requireBytes(start, end - start, this.view.byteLength, 'box range');
        const boxes = [];
        for (let pos = start; pos < end;) {
            this.requireBytes(pos, 8, end, 'box header');
            let size = this.view.getUint32(pos);
            const type = this.readAscii(pos + 4, 4);
            const headerSize = size === 1 ? 16 : 8;
            this.requireBytes(pos, headerSize, end, `${type} header`);
            if (size === 1) {
                size = this.readUint64(pos + 8);
            } else if (size === 0) {
                size = end - pos;
            }
            if (size < headerSize) throw new Error(`Invalid ${type} box size`);
            this.requireBytes(pos, size, end, `${type} box`);
            boxes.push({ type, start: pos + headerSize, end: pos + size, size: size - headerSize });
            pos += size;
        }
        return boxes;
    }

    findBox(start, end, name) {
        const box = this.boxes(start, end).find(box => box.type === name);
        if (box) return box;
        throw new Error(`Box "${name}" not found`);
    }

    requireBytes(start, size, end, label) {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0 || start > end || size > end - start) {
            throw new Error(`Truncated or invalid ${label}: exceeds containing range`);
        }
    }

    readUint64(pos) {
        const value = this.view.getUint32(pos) * 0x100000000 + this.view.getUint32(pos + 4);
        if (!Number.isSafeInteger(value)) throw new Error('Unsupported MP4 size or offset exceeds safe integer range');
        return value;
    }

    tableEntries(box, stride, header = 8) {
        this.requireBytes(box.start, header, box.end, `${box.type} table`);
        const count = this.view.getUint32(box.start + header - 4);
        this.requireBytes(box.start + header, count * stride, box.end, `${box.type} entries`);
        return count;
    }

    /** Find mdat box and return content location */
    findMdat() {
        const mdat = this.findBox(0, this.view.byteLength, 'mdat');
        return { offset: mdat.start, size: mdat.size };
    }

    // Video Configuration
    /** Get video configuration (lazy-loaded) */
    getConfig() {
        if (this._config) return this._config;

        const top = this.boxes(0, this.view.byteLength);
        const moov = this.findBox(0, this.view.byteLength, 'moov');
        this._mdats = top.filter(box => box.type === 'mdat');
        const tracks = this.boxes(moov.start, moov.end).filter(box => box.type === 'trak');
        const media = tracks.map(trak => this.findBox(trak.start, trak.end, 'mdia'));
        const mdia = media.find(mdia => {
            const hdlr = this.findBox(mdia.start, mdia.end, 'hdlr');
            this.requireBytes(hdlr.start, 12, hdlr.end, 'hdlr');
            return this.readAscii(hdlr.start + 8, 4) === 'vide';
        });
        if (!mdia) throw new Error('Unsupported MP4: no video track');
        const minf = this.findBox(mdia.start, mdia.end, 'minf');
        const stbl = this.findBox(minf.start, minf.end, 'stbl');
        const stsd = this.findBox(stbl.start, stbl.end, 'stsd');
        this.requireBytes(stsd.start, 8, stsd.end, 'stsd');
        const entries = this.boxes(stsd.start + 8, stsd.end);
        if (this.view.getUint32(stsd.start + 4) !== 1 || entries.length !== 1) throw new Error('Unsupported video sample descriptions');
        const entry = entries[0];
        const configName = { avc1: 'avcC', hvc1: 'hvcC', av01: 'av1C' }[entry.type];
        if (!configName) throw new Error(`Unsupported video sample entry ${entry.type}`);
        this.requireBytes(entry.start, 78, entry.end, `${entry.type} sample entry`);
        const description = this.findBox(entry.start + 78, entry.end, configName);
        const o = description.start;
        this.requireBytes(o, entry.type === 'avc1' ? 7 : entry.type === 'hvc1' ? 23 : 4, description.end, configName);
        if (this.view.getUint8(o) !== (entry.type === 'av01' ? 0x81 : 1)) throw new Error(`Unsupported ${configName} version`);
        let codec = entry.type, sps = null, pps = null, lengthSize = 4;
        if (entry.type === 'avc1') {
            codec = `avc1.${this.hex(this.view.getUint8(o + 1))}${this.hex(this.view.getUint8(o + 2))}${this.hex(this.view.getUint8(o + 3))}`;
            lengthSize = (this.view.getUint8(o + 4) & 3) + 1;
            let p = o + 6;
            const readSets = count => {
                let first = null;
                for (let i = 0; i < count; i++) {
                    this.requireBytes(p, 2, description.end, 'AVC parameter set length');
                    const length = this.view.getUint16(p); p += 2;
                    this.requireBytes(p, length, description.end, 'AVC parameter set');
                    if (i === 0) first = new Uint8Array(this.buffer.slice(p, p + length));
                    p += length;
                }
                return first;
            };
            sps = readSets(this.view.getUint8(o + 5) & 31);
            this.requireBytes(p, 1, description.end, 'AVC PPS count');
            pps = readSets(this.view.getUint8(p++));
        } else if (entry.type === 'hvc1') {
            lengthSize = (this.view.getUint8(o + 21) & 3) + 1;
        }

        const mdhd = this.findBox(mdia.start, mdia.end, 'mdhd');
        this.requireBytes(mdhd.start, 1, mdhd.end, 'mdhd');
        const mdhdVersion = this.view.getUint8(mdhd.start);
        if (mdhdVersion > 1) throw new Error('Unsupported mdhd version');
        const timescaleOffset = mdhd.start + (mdhdVersion === 1 ? 20 : 12);
        this.requireBytes(timescaleOffset, 4, mdhd.end, 'mdhd timescale');
        const timescale = this.view.getUint32(timescaleOffset);
        if (!timescale) throw new Error('Invalid media timescale');
        this._samples = this.sampleIndex(stbl);
        this._otherSamples = entry.type === 'av01' ? media.filter(other => other !== mdia).flatMap(other => {
            const otherMinf = this.findBox(other.start, other.end, 'minf');
            return this.sampleIndex(this.findBox(otherMinf.start, otherMinf.end, 'stbl'));
        }) : [];
        const durations = this.sampleTiming(this.findBox(stbl.start, stbl.end, 'stts'), this._samples.length);
        const ctts = this.boxes(stbl.start, stbl.end).find(box => box.type === 'ctts');
        const offsets = ctts ? this.sampleTiming(ctts, this._samples.length) : null;
        let ticks = 0;
        for (let i = 0; i < this._samples.length; i++) {
            this._samples[i].timestamp = (ticks + (offsets ? offsets[i] : 0)) * 1000 / timescale;
            ticks += durations[i];
            if (!Number.isSafeInteger(ticks)) throw new Error('Invalid sample timing overflow');
            durations[i] = durations[i] * 1000 / timescale;
        }
        this._config = {
            width: this.view.getUint16(entry.start + 24),
            height: this.view.getUint16(entry.start + 26),
            codec, sampleEntry: entry.type, sps, pps, lengthSize, timescale, durations,
            description: new Uint8Array(this.buffer.slice(description.start, description.end))
        };
        return this._config;
    }

    /** Bound all expanded counts by real sample bytes before allocating timing arrays. */
    sampleIndex(stbl) {
        const tables = this.boxes(stbl.start, stbl.end);
        const sizes = this.findBox(stbl.start, stbl.end, 'stsz');
        this.requireBytes(sizes.start, 12, sizes.end, 'stsz');
        const fixedSize = this.view.getUint32(sizes.start + 4);
        const count = this.view.getUint32(sizes.start + 8);
        const mediaBytes = this._mdats.reduce((sum, box) => sum + box.size, 0);
        if (count > mediaBytes / (fixedSize || 1)) throw new Error('Invalid sample count exceeds media bytes');
        if (!fixedSize) this.tableEntries(sizes, 4, 12);
        const offsets = tables.filter(box => box.type === 'stco' || box.type === 'co64');
        if (offsets.length !== 1) throw new Error('Unsupported sample chunk offset tables');
        const offsetTable = offsets[0];
        const stride = offsetTable.type === 'co64' ? 8 : 4;
        const chunkCount = this.tableEntries(offsetTable, stride);
        const stsc = this.findBox(stbl.start, stbl.end, 'stsc');
        const entryCount = this.tableEntries(stsc, 12);
        const runs = [];
        for (let i = 0; i < entryCount; i++) {
            const p = stsc.start + 8 + i * 12;
            const first = this.view.getUint32(p), samples = this.view.getUint32(p + 4);
            if (!first || first > chunkCount || (i === 0 && first !== 1) || (i > 0 && first <= runs[i - 1].first)
                || !samples || samples > count || this.view.getUint32(p + 8) !== 1) throw new Error('Invalid or unsupported sample chunk mapping');
            runs.push({ first, samples });
        }
        if (chunkCount && !runs.length) throw new Error('Invalid empty sample chunk mapping');
        const samples = [];
        let run = 0;
        for (let chunk = 1; chunk <= chunkCount; chunk++) {
            if (run + 1 < runs.length && chunk >= runs[run + 1].first) run++;
            const p = offsetTable.start + 8 + (chunk - 1) * stride;
            let offset = stride === 8 ? this.readUint64(p) : this.view.getUint32(p);
            if (runs[run].samples > count - samples.length) throw new Error('Invalid chunk sample count');
            for (let j = 0; j < runs[run].samples; j++) {
                const size = fixedSize || this.view.getUint32(sizes.start + 12 + samples.length * 4);
                if (!size || !this._mdats.some(box => offset >= box.start && offset <= box.end && size <= box.end - offset)) throw new Error('Invalid sample extent outside mdat');
                samples.push({ offset, size });
                offset += size;
            }
        }
        if (samples.length !== count) throw new Error('Invalid sample count does not match chunks');
        const ordered = [...samples].sort((a, b) => a.offset - b.offset);
        for (let i = 1; i < ordered.length; i++) {
            if (ordered[i].offset < ordered[i - 1].offset + ordered[i - 1].size) throw new Error('Invalid overlapping samples');
        }
        return samples;
    }

    sampleTiming(box, sampleCount) {
        const count = this.tableEntries(box, 8);
        const version = this.view.getUint8(box.start);
        if (version > (box.type === 'ctts' ? 1 : 0)) throw new Error('Unsupported sample timing version');
        const values = [];
        for (let i = 0; i < count; i++) {
            const pos = box.start + 8 + i * 8;
            const repeat = this.view.getUint32(pos);
            const value = version === 1 ? this.view.getInt32(pos + 4) : this.view.getUint32(pos + 4);
            if (!repeat || repeat > sampleCount - values.length) throw new Error('Invalid sample timing count');
            for (let j = 0; j < repeat; j++) values.push(value);
        }
        if (values.length !== sampleCount) throw new Error('Invalid sample timing count');
        return values;
    }

    records(start, end, lengthSize) {
        const records = [];
        for (let pos = start; pos < end;) {
            this.requireBytes(pos, lengthSize, end, 'NAL record length');
            let length = 0;
            for (let i = 0; i < lengthSize; i++) length = length * 256 + this.view.getUint8(pos++);
            if (!length) throw new Error('Invalid zero-length NAL record');
            this.requireBytes(pos, length, end, 'NAL record');
            records.push(new Uint8Array(this.buffer.slice(pos, pos + length)));
            pos += length;
        }
        return records;
    }

    isPictureMarker(nal) {
        return nal.length === 3 && nal[0] === 0x61 && nal[1] === 0x01 && nal[2] === 0x80;
    }

    av1Telemetry(SeiMetadata, messages) {
        // Only the converter's first, unreferenced mdat contains AVC telemetry records.
        const carrier = this._mdats[0];
        if (!carrier || this._mdats.length < 2) throw new Error('Unsupported AV1 telemetry carrier: missing first mdat');
        if ([...this._samples, ...this._otherSamples].some(sample => sample.offset < carrier.end)) throw new Error('Invalid AV1 sample references telemetry carrier');
        const groups = [];
        let pending = null, pendingRecords = false;
        for (const nal of this.records(carrier.start, carrier.end, 4)) {
            if (this.isPictureMarker(nal)) {
                if (groups.length >= this._samples.length) throw new Error('Invalid AV1 carrier marker count');
                groups.push(pending);
                pending = null;
                pendingRecords = false;
            } else {
                if (nal[0] !== 6 || nal[1] !== 5 || !this.seiPayload(nal)) throw new Error('Invalid AV1 carrier record');
                pending = this.decodeSei(nal, SeiMetadata);
                if (SeiMetadata && !pending) throw new Error('Invalid AV1 telemetry protobuf');
                if (pending && messages) messages.push(pending);
                pendingRecords = true;
            }
        }
        if (pendingRecords || groups.length !== this._samples.length) throw new Error('Invalid AV1 carrier marker count');
        return groups;
    }

    // Frame Parsing
    /** Parse video frames with SEI metadata */
    parseFrames(SeiMetadata) {
        return this.readFrames(SeiMetadata);
    }

    readFrames(SeiMetadata, messages) {
        const config = this.getConfig();
        const frames = [];
        const av1 = config.sampleEntry === 'av01' ? this.av1Telemetry(SeiMetadata, messages) : null;
        let currentSps = config.sps, currentPps = config.pps;
        const markerCounts = [];
        let hasCompatibility = false;
        for (const sample of this._samples) {
            let sei = av1 ? av1[frames.length] : null, data = null, keyframe = false, markers = 0;
            if (av1) data = new Uint8Array(this.buffer.slice(sample.offset, sample.offset + sample.size));
            else for (const nal of this.records(sample.offset, sample.offset + sample.size, config.lengthSize)) {
                if (config.sampleEntry === 'avc1') {
                    const type = nal[0] & 31;
                    if (type === 7) currentSps = nal;
                    else if (type === 8) currentPps = nal;
                    else if (type === 6) {
                        const decoded = this.decodeSei(nal, SeiMetadata);
                        if (decoded) { sei = decoded; if (messages) messages.push(decoded); }
                    }
                    else if (type === 5 || type === 1) { if (!data) data = nal; keyframe ||= type === 5; }
                } else {
                    if (nal.length < 2) throw new Error('Invalid HEVC NAL record header');
                    const type = (nal[0] >> 1) & 63;
                    if (this.isPictureMarker(nal)) markers++;
                    else if (nal[0] === 0x61 && nal[1] === 0x01) throw new Error('Invalid HEVC carrier picture marker');
                    else if (nal[0] === 0x66 && nal[1] === 0x01) {
                        const original = DashcamMP4.concat(Uint8Array.of(6, 5), nal.subarray(2));
                        if (!this.seiPayload(original)) throw new Error('Invalid HEVC compatibility record');
                        sei = this.decodeSei(original, SeiMetadata);
                        if (SeiMetadata && !sei) throw new Error('Invalid HEVC telemetry protobuf');
                        if (sei && messages) messages.push(sei);
                        hasCompatibility = true;
                    } else if (type <= 31) { if (!data) data = nal; keyframe ||= type >= 16 && type <= 23; }
                }
            }
            if (!data) throw new Error('Invalid video sample: missing picture');
            markerCounts.push(markers);
            frames.push({ index: frames.length, timestamp: sample.timestamp, duration: config.durations[frames.length],
                keyframe, data, sei, sps: currentSps, pps: currentPps });
        }
        if (config.sampleEntry === 'hvc1' && (hasCompatibility || markerCounts.some(Boolean)) && markerCounts.some(count => count !== 1)) throw new Error('Invalid HEVC carrier picture marker count');
        return frames;
    }

    // SEI Extraction
    /** Extract all SEI messages for CSV export */
    extractSeiMessages(SeiMetadata) {
        const messages = [];
        this.readFrames(SeiMetadata, messages);
        return messages;
    }

    /** Decode SEI NAL unit to protobuf message */
    decodeSei(nal, SeiMetadata) {
        const payload = this.seiPayload(nal);
        if (!SeiMetadata || !payload) return null;
        try {
            return SeiMetadata.decode(payload);
        } catch {
            return null;
        }
    }

    seiPayload(nal) {
        if (nal.length < 6 || (nal[0] & 31) !== 6 || nal[1] !== 5 || nal[nal.length - 1] !== 0x80) return null;
        const rbsp = this.stripEmulationBytes(nal.subarray(1));
        let i = 1, size = 0;
        while (i < rbsp.length && rbsp[i] === 255) { size += 255; i++; }
        if (i >= rbsp.length) return null;
        size += rbsp[i++];
        if (size !== rbsp.length - i - 1) return null;
        const prefix = i;
        while (i < rbsp.length && rbsp[i] === 0x42) i++;
        if (i === prefix || rbsp[i++] !== 0x69 || i >= rbsp.length - 1) return null;
        return rbsp.subarray(i, rbsp.length - 1);
    }

    /** Strip H.264 emulation prevention bytes */
    stripEmulationBytes(data) {
        const out = [];
        let zeros = 0;
        for (const byte of data) {
            if (zeros >= 2 && byte === 0x03) { zeros = 0; continue; }
            out.push(byte);
            zeros = byte === 0 ? zeros + 1 : 0;
        }
        return Uint8Array.from(out);
    }

    // Utilities
    readAscii(start, len) {
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(this.view.getUint8(start + i));
        return s;
    }

    hex(n) { return n.toString(16).padStart(2, '0'); }

    /** Concatenate Uint8Arrays */
    static concat(...arrays) {
        const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
        let offset = 0;
        for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
        return result;
    }
}

window.DashcamMP4 = DashcamMP4;

// Tesla Dashcam Helpers
(function () {
    let SeiMetadata = null;
    let enumFields = null;

    /** Initialize protobuf by loading the .proto file */
    async function initProtobuf(protoPath = 'proto/dashcam.proto') {
        if (SeiMetadata) return { SeiMetadata, enumFields };

        if (!window.protobuf) throw new Error('protobuf.js not loaded');
        const response = await fetch(protoPath);
        if (!response.ok) {
            throw new Error(`Failed to fetch proto (${response.status} ${response.statusText}): ${protoPath}`);
        }
        const root = protobuf.parse(await response.text(), { keepCase: true }).root;
        SeiMetadata = root.lookupType('SeiMetadata');
        enumFields = {
            gearState: SeiMetadata.lookup('Gear'),
            autopilotState: SeiMetadata.lookup('AutopilotState'),
            gear_state: SeiMetadata.lookup('Gear'),
            autopilot_state: SeiMetadata.lookup('AutopilotState')
        };
        return { SeiMetadata, enumFields };
    }

    window.DashcamHelpers = {
        initProtobuf
    };
})();
