/* Copyright 2020 Record Replay Inc. */
// TODO(dmiller): log all of the choices we made so we could reproduce this replay if we wanted to
const sample = require("lodash.sample");
const seedrandom = require("seedrandom");

const { log, logError } = require("./logger");
const ProtocolClient = require("./client");

let gClient, gSessionId;

const rng = seedrandom();
const seed2 = rng();
log("seed for this run: ", seed2);
seedrandom(seed2, { global: true });

async function getLogpoints(location) {
  // Analysis.addRandomPoints
  let results = [];
  gClient.addEventListener("Analysis.analysisResult", (stuff) => {
    //    log(`got analysis result ${JSON.stringify(stuff, null, 2)}`);
    results.push(...stuff.results.map((r) => r.value));
  });

  const { analysisId } = await gClient.sendCommand("Analysis.createAnalysis", {
    mapper: `
    const { point, time, pauseId } = input;
    return [{
      key: point,
      value: { time, pauseId, point }
    }];`,
    effectful: true,
  });

  await gClient.sendCommand("Analysis.addLocation", {
    location,
    analysisId,
    sessionId: gSessionId,
  });
  await gClient.sendCommand("Analysis.runAnalysis", { analysisId });

  return results;
}

// Completely replay a recording in a new session.
async function replayRecording(dispatchAddress, recordingId, url) {
  console.log(new Date(), "ReplayRecording Start", recordingId);

  const client = new ProtocolClient(dispatchAddress, {
    onError(e) {
      log(`Socket error ${e}`);
    },
    onClose() {
      log(`Socket closed`);
    },
  });

  console.log("Got client");

  // Automatically close any existing connection.
  if (gClient) {
    gClient.close();
  }
  gClient = client;

  client.addEventListener("Session.missingRegions", ({ regions }) => {
    log(`MissingRegions ${JSON.stringify(regions)}`);
  });

  client.addEventListener("Session.unprocessedRegions", ({ regions }) => {
    log(`UnprocessedRegions ${JSON.stringify(regions)}`);
  });

  console.log("added event listeners");

  let description;
  try {
    description = await client.sendCommand("Recording.getDescription", {
      recordingId,
    });
  } catch (e) {
    description = "<none>";
  }
  log(`StartProcess ${recordingId} ${JSON.stringify(description)}`);
  log("Got description");

  let sessionId;
  try {
    const response = await client.sendCommand("Recording.createSession", {
      recordingId,
    });
    sessionId = response.sessionId;
    gSessionId = sessionId;
  } catch (e) {
    logError("Error creating session, stopping", e);
    process.exit(1);
  }
  console.log(new Date(), "ReplayRecording HaveSessionId", sessionId);

  await client.sendCommand("Internal.labelTestSession", { sessionId, url });
  await client.sendCommand("Session.ensureProcessed", {}, sessionId);

  // get all the recording JS
  // get all the breakable locations
  // adding logpoints at random locations
  // seeking to logpoints randomly
  // step randomly through the code
  // expand objects (aka load properties) randomly

  try {
    let sources = [];
    client.addEventListener("Debugger.newSource", (source) => {
      sources.push(source);
    });
    await client.sendCommand("Debugger.findSources", {}, sessionId);
    console.log(sources);

    if (sources.length === 0) {
      log("No sources, so nothing to do");
      process.exit(0);
    }
    // TODO(dmiller): select random # of sources
    let source = sample(sources);

    let sourceId = source.sourceId;
    const possibleBreakpoints = await client.sendCommand(
      "Debugger.getPossibleBreakpoints",
      { sourceId: sourceId },
      sessionId
    );

    log(
      "Got possible breakpoints",
      JSON.stringify(possibleBreakpoints, null, 2)
    );

    const lineLocation = sample(possibleBreakpoints.lineLocations);
    log("linelocation", JSON.stringify(lineLocation, null, 2));
    let logpoints = await getLogpoints({
      sourceId: sourceId,
      line: lineLocation.line,
      column: sample(lineLocation.columns),
    });
    log("Got logpoints", logpoints);

    // TODO take a random one of these logpoints
    if (logpoints.length === 0) {
      log("No logpoints found for lineLocation, stopping");
      process.exit(0);
    }
    const logpoint = sample(logpoints);
    log("chosen logpoint", JSON.stringify(logpoint, null, 2));
    const point = logpoint.point;
    const pauseObject = await client.sendCommand(
      "Session.createPause",
      { point },
      sessionId
    );
    // TODO from the pause try fetching some objects
    log("got a pause object", JSON.stringify(pauseObject, null, 2));
    const stepResult = await client.sendCommand(
      "Debugger.findStepOverTarget",
      { point },
      sessionId
    );
    log("got a step over result", JSON.stringify(stepResult, null, 2));
  } catch (e) {
    logError("Encountered error doing stuff", e);
  }

  await client.sendCommand("Recording.releaseSession", { sessionId });

  console.log(new Date(), "ReplayRecording Finished");
  client.close();
}

module.exports = { replayRecording };
