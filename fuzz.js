/* Copyright 2020 Record Replay Inc. */

const {log} = require("./logger");
const ProtocolClient = require("./client");

let gClient, gSessionId;

async function getLogpoints(location) {
  // Analysis.addRandomPoints

  const analysis = await gClient.sendCommand("Analysis.createAnalysis", {
    mapper: `
    const { point, time, pauseId } = input;
    return [{
      key: point,
      value: { time, pauseId, point }
    }];`,
    effectful: true,
  });

  await gClient.sendCommand("Analysis.addLocation", {location});
  await gClient.sendCommand("Analysis.runAnalysis");
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

    const positions = await client.sendCommand(
      "Debugger.getPossibleBreakpoints",
      {sourceId: sources[0].sourceId},
      sessionId
    );

    await getLogpoints({sourceId: sources[0].sourceId, line: 35, column: 6});

    console.log(JSON.stringify(positions, null, 2));
  } catch (e) {
    console.error(e);
  }

  await client.sendCommand("Recording.releaseSession", {sessionId});

  console.log(new Date(), "ReplayRecording Finished");
  client.close();
}

module.exports = {replayRecording};
