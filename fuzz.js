/* Copyright 2020 Record Replay Inc. */
const sample = require("lodash.sample");
const seedrandom = require("seedrandom");

const { log, logError } = require("./logger");
const ProtocolClient = require("./client");

let gClient, gSessionId;

const rng = seedrandom();

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
async function replayRecording(
  dispatchAddress,
  recordingId,
  url,
  seed = rng()
) {
  log(new Date(), "ReplayRecording Start", recordingId);
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
    const pauseObject = await client.sendCommand(
      "Session.createPause",
      { point },
      sessionId
    );

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

    // TODO(dmiller): step a random # of times
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
