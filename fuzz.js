/* Copyright 2020 Record Replay Inc. */
const sample = require("lodash.sample");
const seedrandom = require("seedrandom");

const { log, logError } = require("./logger");
const ProtocolClient = require("./client");

let gClient, gSessionId;

const rng = seedrandom();

async function getLogpoints(location) {
  let results = [];
  gClient.addEventListener("Analysis.analysisResult", (stuff) => {
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

// Replay a recording making a random number of random decisions, like which logpoints to set and how many times to step
async function replayRecording(
  dispatchAddress,
  recordingId,
  url,
  seed = rng()
) {
  log(new Date(), "ReplayRecording Start RecordingId: ", recordingId);
  log("seed for this run: ", seed);
  seedrandom(seed, { global: true });

  const client = new ProtocolClient(dispatchAddress, {
    onError(e) {
      log(`Socket error ${e}`);
    },
    onClose() {
      log(`Socket closed`);
    },
  });

  // Automatically close any existing connection.
  if (gClient) {
    gClient.close();
  }
  gClient = client;

  client.addEventListener("Session.missingRegions", ({ regions }) => {
    // NOTE(dmiller): this was noisy and I don't think it would aid in debugging?
    //log(`MissingRegions ${JSON.stringify(regions)}`);
  });

  client.addEventListener("Session.unprocessedRegions", ({ regions }) => {
    // NOTE(dmiller): this was noisy and I don't think it would aid in debugging?
    //log(`UnprocessedRegions ${JSON.stringify(regions)}`);
  });

  let description;
  try {
    description = await client.sendCommand("Recording.getDescription", {
      recordingId,
    });
  } catch (e) {
    description = "<none>";
  }
  log(`StartProcess ${recordingId} ${JSON.stringify(description)}`);

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
  log("ReplayRecording HaveSessionId", sessionId);

  try {
    await client.sendCommand("Internal.labelTestSession", { sessionId, url });
  } catch (e) {
    logError("Error labeling test session", e);
    process.exit(1);
  }
  try {
    await client.sendCommand("Session.ensureProcessed", {}, sessionId);
  } catch (e) {
    logError("Error sending ensureProcessed");
    process.exit(1);
  }

  try {
    // sources are files that can have possible breakpoint locations in them
    let sources = [];
    client.addEventListener("Debugger.newSource", (source) => {
      sources.push(source);
    });
    await client.sendCommand("Debugger.findSources", {}, sessionId);

    if (sources.length === 0) {
      log("No sources, so nothing to do");
      process.exit(0);
    }
    // TODO(dmiller): select random # of sources, not just one
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

    // try to get a logpoint at a given lineLocation
    // if we can't, because there are no valid logpoints at that line
    // remove that linelocation and pick a different random one
    // if we've exhausted all possible line locations then give up
    let lineLocations = possibleBreakpoints.lineLocations;
    let chosenLogpoint;
    while (!chosenLogpoint) {
      if (lineLocations.length === 0) {
        log("Unable to find any valid line locations, exiting");
        process.exit(1);
      }
      const lineLocation = sample(lineLocations);
      log("lineLocation", JSON.stringify(lineLocation, null, 2));
      let logpoints = await getLogpoints({
        sourceId: sourceId,
        line: lineLocation.line,
        column: sample(lineLocation.columns),
      });
      log("Got logpoints", logpoints);

      if (logpoints.length === 0) {
        log("No logpoints found for lineLocation, skipping");
        // remove the fruitless lineLocation from the list of possible lineLocations to explore
        lineLocations = lineLocations.filter((l) => l !== lineLocation);
        continue;
      }
      //otherwise, we found some line locations. Pick one and keep going
      chosenLogpoint = sample(logpoints);
    }

    const logpoint = chosenLogpoint;
    log("chosen logpoint", JSON.stringify(logpoint, null, 2));
    const point = logpoint.point;
    // create a pause at the given logpoint
    // this is akin to advancing the debugger to that point in the execution
    const pauseObject = await client.sendCommand(
      "Session.createPause",
      { point },
      sessionId
    );

    // grab some variables that are in scope and try to expand it
    // TODO(dmiller): try previewing more objects
    const object = sample(pauseObject.data.objects);
    log("Got object to preview", JSON.stringify(object, null, 2));
    const objectId = object.objectId;
    const params = { object: objectId };
    const previewResult = await client.sendCommand(
      "Pause.getObjectPreview",
      params,
      sessionId,
      pauseObject.pauseId
    );
    log("Got object preview result", JSON.stringify(previewResult, null, 2));

    // from the place where we have paused, step over
    // TODO(dmiller): step a random # of times
    // TODO(dmiller): step in a random direction
    const stepResult = await client.sendCommand(
      "Debugger.findStepOverTarget",
      { point },
      sessionId
    );
    log("got a step over result", JSON.stringify(stepResult, null, 2));
  } catch (e) {
    logError("Encountered error interacting with recording", e);
  }

  await client.sendCommand("Recording.releaseSession", { sessionId });

  console.log(new Date(), "ReplayRecording Finished");
  client.close();
}

module.exports = { replayRecording };
