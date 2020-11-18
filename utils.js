/* Copyright 2020 Record Replay Inc. */

const { logException } = require("./logger");

const InvalidCheckpointId = 0;
const FirstCheckpointId = 1;

const FirstCheckpointExecutionPoint = {
  checkpoint: FirstCheckpointId,
  progress: 0,
};

function assert(v, why = "") {
  if (!v) {
    ThrowError(`Assertion Failed: ${why}`);
  }
}

function ThrowError(msg) {
  const error = new Error(msg);
  logException(error);
  throw error;
}

function mapify(object) {
  const map = new Map();
  if (object) {
    for (const [key, value] of Object.entries(object)) {
      map.set(key, value);
    }
  }
  return map;
}

function binarySearch(start, end, callback) {
  while (start + 1 < end) {
    const mid = ((start + end) / 2) | 0;
    const rv = callback(mid);
    if (rv < 0) {
      end = mid;
    } else {
      start = mid;
    }
  }
  return start;
}

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function throttle(callback, time) {
  let scheduled = false;

  return () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      callback();
    }, time);
  };
}

function waitForTime(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class PromiseMap {
  constructor(callbacks) {
    this.callbacks = callbacks;
    this.map = new Map();
  }

  knownResult(keyInfo) {
    const key = this.callbacks.getKey(keyInfo);
    const info = this.map.get(key);
    if (info && "result" in info) {
      return { result: info.result };
    }
  }

  async waitForResult(keyInfo) {
    const key = this.callbacks.getKey(keyInfo);
    if (this.map.has(key)) {
      return this.map.get(key).promise;
    }
    let resolve;
    const promise = new Promise(r => (resolve = r));
    const info = { promise, resolve };
    this.map.set(key, info);

    if (this.callbacks.computeResult) {
      const result = await this.callbacks.computeResult(keyInfo);
      info.result = result;
      resolve(result);
    }
    return promise;
  }

  setResult(keyInfo, result) {
    const key = this.callbacks.getKey(keyInfo);
    const info = this.map.get(key);
    if (info) {
      info.result = result;
      if (info.resolve) {
        info.resolve(result);
      }
    } else {
      this.map.set(key, { promise: result, result });
    }
  }
}

// Bidirectional map between objects and integer IDs.
class IdMap {
  constructor() {
    this._idMap = [undefined];
    this._objectMap = new Map();
  }

  add(obj) {
    if (this._objectMap.has(obj)) {
      return this._objectMap.get(obj);
    }
    const id = this._idMap.length;
    this._idMap.push(obj);
    this._objectMap.set(obj, id);
    return id;
  }

  getId(obj) {
    return this._objectMap.get(obj) || 0;
  }

  getObject(id) {
    return this._idMap[id];
  }

  map(callback) {
    const rv = [];
    for (let i = 1; i < this._idMap.length; i++) {
      rv.push(callback(i));
    }
    return rv;
  }

  forEach(callback) {
    for (let i = 1; i < this._idMap.length; i++) {
      callback(i, this._idMap[i]);
    }
  }
}

// Map from keys to arrays of values.
class ArrayMap {
  constructor() {
    this.map = new Map();
  }

  add(key, value) {
    if (this.map.has(key)) {
      this.map.get(key).push(value);
    } else {
      this.map.set(key, [value]);
    }
  }
}

// Convert a line => columns ArrayMap into a lineLocations WRP object.
function finishLineLocations(lineLocations) {
  return [...lineLocations.map.entries()].map(([line, columns]) => {
    return { line, columns };
  });
}

// Whether the line/column in "a" precedes the line/column in "b"
function locationPrecedes(a, b) {
  if (a.line != b.line) {
    return a.line < b.line;
  }
  return a.column < b.column;
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

function hashGraphicsData(data) {
  return hashString(data).toString();
}

function formatManifest(manifest) {
  switch (manifest.kind) {
    case "applyMapper":
      return `applyMapper`;
    case "debuggerRequest":
    case "pauseRequest":
      if (manifest.request.type == "command") {
        return `debuggerCommand:${manifest.request.method}`;
      }
      return `debuggerRequest:${manifest.request.type}`;
    case "getHTMLSource":
      return `getHTMLSource`;
    case "hitLogpoint":
      return `HitLogpoint`;
  }
  return JSON.stringify(manifest);
}

function formatManifestResult(manifest, result) {
  let text = JSON.stringify(result);
  const length = text ? text.length : 0;
  const omitted = `Omitted:${length}`;
  switch (manifest.kind) {
    case "applyMapper":
    case "debuggerRequest":
    case "pauseRequest":
    case "getPauseData":
    case "getRecordingSummary":
    case "hitLogpoint":
    case "scanRecording":
    case "scannedPaintData":
    case "lastPausePaintData":
    case "findFrameSteps":
    case "findHits":
    case "getHTMLSource":
    case "getPossibleBreakpoints":
    case "getScopeValues":
    case "command":
      text = omitted;
      break;
    case "resume":
      text = JSON.stringify({ endpoint: result.endpoint, omitted });
      break;
    case "runToPoint":
      if (result.resumeData) {
        text = JSON.stringify({ ...result, resumeData: omitted });
      }
      break;
  }
  return { text, length };
}

// Execution Positions and Points
//
// Execution Positions describe a location within a function where execution can
// pause and the program state can be inspected. These are objects with the
// following properties.
//
// kind: One of the following strings.
//   EnterFrame: Pause at the beginning of a frame.
//   OnStep: Pause at a breakpoint location.
//   Break: Pause at a breakpoint location, with any frame index.
//   OnThrow: Pause when an exception is thrown.
//   OnPop: Pause when a frame exits normally.
//   OnUnwind: Pause when a frame unwinds with an exception.
// functionId: String ID of the function of interest.
// frameIndex: Index from the bottom of the frame of interest. Counting from
//   the bottom ensures that indexes are stable for a given frame throughout
//   its lifetime. This is not used for "Break" positions.
// offset: Integral offset within the function of the pause location. Only used
//   for "OnStep" and "Break" positions. Offsets must be in RPO / topological
//   order, ignoring loop backedges.
//
// Execution Points describe a specific point within the recording where
// execution can pause. These are objects with the following properties:
//
// checkpoint: The most recent checkpoint. Checkpoints are periodically created
//   when running and are a coarse way to divide up execution in the recording.
//   There are never frames on the stack when a checkpoint is created.
// progress: Value of the progress counter at the point. The progress counter
//   starts at zero and advances as code executes.
// position: If there are any frames on the stack at the point, description of
//   the topmost frame. This cannot have the "Break" kind.
//
// In order for this object to uniquely identify a point of execution within
// a recording, we must ensure that no position can execute twice with
// the same value for the progress counter. We do this by advancing the progress
// counter whenever a new frame is entered, and whenever a loop backedge is
// taken.

// Convert an execution point to a BigInt, such that points preceding each other
// are converted to bigints that are less than each other.
function pointToBigInt(point) {
  let rv = BigInt(0);
  let shift = 0;

  if (point.position) {
    addValue(point.position.offset || 0, 32);
    switch (point.position.kind) {
      case "EnterFrame":
        addValue(0, 3);
        break;
      case "OnStep":
        addValue(1, 3);
        break;
      case "OnThrow":
        addValue(2, 3);
        break;
      case "OnPop":
        addValue(3, 3);
        break;
      case "OnUnwind":
        addValue(4, 3);
        break;
      default:
        ThrowError(`Bad point ${JSON.stringify(point)}`);
    }
    // Deeper frames predate shallower frames with the same progress counter.
    addValue((1 << 24) - 1 - point.position.frameIndex, 24);
    // Points with positions are later than points with no position.
    addValue(1, 1);
  } else {
    addValue(0, 32 + 3 + 24 + 1);
  }

  addValue(point.progress, 48);

  // Subtract here so that the first point in the recording is 0 as reflected
  // in the protocol definition.
  addValue(point.checkpoint - FirstCheckpointId, 32);

  return rv;

  function addValue(v, nbits) {
    rv |= BigInt(v) << BigInt(shift);
    shift += nbits;
  }
}

// Convert a point BigInt back to the original point, except for the function
// (which is an arbitrary string and can't be embedded in the point).
function BigIntToPoint(n) {
  const offset = readValue(32);
  const kindValue = readValue(3);
  const indexValue = readValue(24);
  const hasPosition = readValue(1);
  const progress = readValue(48);
  const checkpoint = readValue(32) + FirstCheckpointId;

  if (!hasPosition) {
    return { checkpoint, progress };
  }

  let kind;
  switch (kindValue) {
    case 0:
      kind = "EnterFrame";
      break;
    case 1:
      kind = "OnStep";
      break;
    case 2:
      kind = "OnThrow";
      break;
    case 3:
      kind = "OnPop";
      break;
    case 4:
      kind = "OnUnwind";
      break;
  }

  const frameIndex = (1 << 24) - 1 - indexValue;
  return {
    checkpoint,
    progress,
    position: { kind, offset, frameIndex },
  };

  function readValue(nbits) {
    const mask = (BigInt(1) << BigInt(nbits)) - BigInt(1);
    const rv = Number(n & mask);
    n = n >> BigInt(nbits);
    return rv;
  }
}

function pointPrecedes(a, b) {
  return pointToBigInt(a) < pointToBigInt(b);
}

function pointEquals(a, b) {
  return pointToBigInt(a) == pointToBigInt(b);
}

// Map stringified points to the original point.
let gPointStrings = new Map();

// Get the stringified bigint to use for a point in the protocol.
function pointToString(p) {
  const rv = pointToBigInt(p).toString();
  gPointStrings.set(rv, p);
  return rv;
}

// Go from a stringified bigint back to the point. The resulting point might
// not have its position's functionId property set.
function stringToPointRaw(str) {
  const point = BigIntToPoint(BigInt(str));

  // If we've already stringified this point, get the function from the point
  // we used earlier, as it's expensive to compute directly.
  const seen = gPointStrings.get(str);
  if (seen) {
    assert(seen.checkpoint == point.checkpoint);
    assert(seen.progress == point.progress);
    if (seen.position) {
      assert(seen.position.kind == point.position.kind);
      assert((seen.position.offset || 0) == point.position.offset);
      assert(seen.position.frameIndex == point.position.frameIndex);
      point.position.functionId = seen.position.functionId;
    }
  }

  return point;
}

function positionToString({ kind, offset, functionId, frameIndex }) {
  return `${kind}:${offset}:${functionId}:${frameIndex}`;
}

function findClosestPoint(points, target, before, inclusive) {
  let best, nbest;
  const ntarget = pointToBigInt(target);
  for (const point of points) {
    const npoint = pointToBigInt(point);
    if (inclusive && npoint == ntarget) {
      return point;
    }
    if (before ? npoint < ntarget : npoint > ntarget) {
      if (!best || (before ? nbest < npoint : nbest > npoint)) {
        best = point;
        nbest = npoint;
      }
    }
  }
  return best;
}

// Log calls to fn, used for tracking down infinite loops...
function wrapLog(fn, name) {
  return (...args) => {
    console.log(`START ${name}`);
    try {
      return fn(...args);
    } finally {
      console.log(`END ${name}`);
    }
  };
}

// Progressively invoke callback on ranges of progress values with startProgress
// as an endpoint and decreasing from there. Continues until the callback
// returns a non-null value.
function scanProgressDecrease(startProgress, callback, limitProgress = 0) {
  let minProgress = Math.max(startProgress - 100, 0);
  let maxProgress = startProgress;
  while (true) {
    const rv = callback(minProgress, maxProgress);
    if (rv) {
      return rv;
    }
    assert(maxProgress >= limitProgress, "scanProgressDecrease no result");
    maxProgress = minProgress - 1;
    minProgress = Math.max(minProgress - 1000, 0);
  }
}

function scanProgressIncrease(startProgress, callback, limitProgress) {
  let minProgress = startProgress;
  let maxProgress = startProgress + 100;
  while (true) {
    const rv = callback(minProgress, maxProgress);
    if (rv) {
      return rv;
    }
    if (limitProgress) {
      assert(maxProgress < limitProgress, "scanProgressIncrease no result");
    }
    minProgress = maxProgress + 1;
    maxProgress += 1000;
  }
}

function babelIdentifierIsVariable(path) {
  // Babel identifiers can match on property names in addition to variables.
  // There doesn't seem to be a way to distinguish the two cases other than
  // looking at the context in which they are used.

  if (path.parent.type == "MemberExpression" && path.parent.property == path.node) {
    return false;
  }

  if (path.parent.type == "ObjectProperty" && path.parent.key == path.node) {
    return false;
  }

  if (!path.node.loc) {
    return false;
  }

  return true;
}

module.exports = {
  InvalidCheckpointId,
  FirstCheckpointId,
  FirstCheckpointExecutionPoint,
  assert,
  ThrowError,
  pointPrecedes,
  pointEquals,
  pointToString,
  stringToPointRaw,
  positionToString,
  findClosestPoint,
  binarySearch,
  formatManifest,
  formatManifestResult,
  mapify,
  PromiseMap,
  defer,
  throttle,
  waitForTime,
  hashString,
  hashGraphicsData,
  IdMap,
  ArrayMap,
  finishLineLocations,
  locationPrecedes,
  wrapLog,
  scanProgressDecrease,
  scanProgressIncrease,
  babelIdentifierIsVariable,
};
