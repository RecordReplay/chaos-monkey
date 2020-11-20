const { replayRecording } = require("./fuzz");

const recordingId = "6e1ea523-2d3f-441c-b7e1-75adb8b35bbc";
const url = "http://firebugs.dev";
const dispatchAddress = "https://dispatch.replay.io";

replayRecording(dispatchAddress, recordingId, url);
