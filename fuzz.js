/* Copyright 2020 Record Replay Inc. */

const { log, logError } = require("./logger");
const ProtocolClient = require("./client");

let gClient, gSessionId;

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

  // Automatically close any existing connection.
  if (gClient) {
    gClient.close();
  }
  gClient = client;

  client.addEventListener("Session.missingRegions", ({regions}) => {
    log(`MissingRegions ${JSON.stringify(regions)}`);
  });

  client.addEventListener("Session.unprocessedRegions", ({regions}) => {
    log(`UnprocessedRegions ${JSON.stringify(regions)}`);
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

  const {sessionId} = await client.sendCommand("Recording.createSession", {
    recordingId,
  });
  gSessionId = sessionId;

  console.log(new Date(), "ReplayRecording HaveSessionId", sessionId);

  await client.sendCommand("Internal.labelTestSession", {sessionId, url});
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

    // TODO(dmiller): what if there are zero sources??
    // TODO(dmiller): select random # of sources
    let firstSourceId = sources[0].sourceId;
    const possibleBreakpoints = await client.sendCommand(
      "Debugger.getPossibleBreakpoints",
      { sourceId: firstSourceId },
      sessionId
    );

    log(
      "Got possible breakpoints",
      JSON.stringify(possibleBreakpoints, null, 2)
    );
    let results = await getLogpoints({
      sourceId: firstSourceId,
      line: 65,
      column: 43,
    });
    log("Got logpoints for pos 65:43", results);

    // TODO take a random one of these logpoints
    const point = '1622592768293829581448683112628352';
    const pauseObject = await client.sendCommand("Session.createPause", { point }, sessionId);
    // TODO from the pause try fetching some objects
    log("got a pause object", JSON.stringify(pauseObject, null, 2));
    const stepResult = await client.sendCommand("Debugger.findStepOverTarget", { point }, sessionId);
    log("got a step over result", JSON.stringify(stepResult, null, 2));
  } catch (e) {
    logError("Encountered error doing stuff", e);
  }

  await client.sendCommand("Recording.releaseSession", {sessionId});

  console.log(new Date(), "ReplayRecording Finished");
  client.close();
}

module.exports = {replayRecording};
