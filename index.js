const {replayRecording} = require("./fuzz");

const recordingId = "941c5405-1b40-4a32-b42f-485afc08aa24";
const url = "http://firebugs.dev";
const dispatchAddress = "https://dispatch.replay.io";

replayRecording(dispatchAddress, recordingId, url);
